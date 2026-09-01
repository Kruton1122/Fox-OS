"""Fox OS terminal PTY WebSocket side listener.

Waitress (HTTP) does not speak WebSockets. When allow_terminal is true, Fox OS
starts this asyncio listener on 127.0.0.1 only. Reverse-proxy /ws/terminal to it
(see nginx-foxos.conf / README).
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import pty
import signal
import struct
import termios
import threading
from typing import Any, Callable, Optional

log = logging.getLogger("foxos.terminal_ws")

_thread: Optional[threading.Thread] = None
_loop: Optional[asyncio.AbstractEventLoop] = None
_server: Any = None
_lock = threading.Lock()


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    rows = max(1, min(int(rows), 512))
    cols = max(1, min(int(cols), 512))
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def _shell_argv() -> list[str]:
    shell = os.environ.get("SHELL") or "/bin/bash"
    if os.path.isfile(shell) and os.access(shell, os.X_OK):
        return [shell]
    for candidate in ("/bin/bash", "/bin/sh"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return [candidate]
    return ["/bin/sh"]


async def _pty_session(websocket: Any, allow_check: Callable[[], bool]) -> None:
    if not allow_check():
        await websocket.close(4403, "terminal disabled (allow_terminal=false)")
        return

    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")

    master, slave = pty.openpty()
    _set_winsize(master, 24, 80)

    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            os.setsid()
            try:
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            except OSError:
                pass
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            argv = _shell_argv()
            os.execvpe(argv[0], argv, env)
        except Exception:
            os._exit(127)

    os.close(slave)
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()

    async def pty_to_ws() -> None:
        while not stop.is_set():
            try:
                chunk = await loop.run_in_executor(None, os.read, master, 8192)
            except OSError:
                break
            if not chunk:
                break
            try:
                await websocket.send(chunk)
            except Exception:
                break

    async def ws_to_pty() -> None:
        try:
            async for message in websocket:
                if not allow_check():
                    await websocket.close(4403, "terminal disabled")
                    break
                if isinstance(message, bytes):
                    try:
                        os.write(master, message)
                    except OSError:
                        break
                    continue
                text = message if isinstance(message, str) else str(message)
                if text.startswith("{") and '"type"' in text:
                    try:
                        msg = json.loads(text)
                    except json.JSONDecodeError:
                        msg = None
                    if isinstance(msg, dict) and msg.get("type") == "resize":
                        try:
                            _set_winsize(
                                master,
                                int(msg.get("rows") or 24),
                                int(msg.get("cols") or 80),
                            )
                        except (TypeError, ValueError, OSError):
                            pass
                        continue
                try:
                    os.write(master, text.encode("utf-8", errors="replace"))
                except OSError:
                    break
        except Exception:
            pass

    t1 = asyncio.create_task(pty_to_ws())
    t2 = asyncio.create_task(ws_to_pty())
    try:
        await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop.set()
        for t in (t1, t2):
            t.cancel()
        try:
            os.close(master)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            for _ in range(40):
                wpid, _status = os.waitpid(pid, os.WNOHANG)
                if wpid != 0:
                    break
                await asyncio.sleep(0.05)
            else:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
        except ChildProcessError:
            pass
        try:
            await websocket.close()
        except Exception:
            pass


def start_terminal_ws(
    *,
    host: str = "127.0.0.1",
    port: int = 8766,
    allow_check: Callable[[], bool],
) -> bool:
    """Start background WebSocket+PTY server. Returns True if started (or already running)."""
    global _thread, _loop, _server
    with _lock:
        if _thread and _thread.is_alive():
            return True
        if not allow_check():
            log.info("terminal WS not started (allow_terminal=false)")
            return False

        ready = threading.Event()
        error: list[BaseException] = []

        def _run() -> None:
            global _loop, _server
            try:
                from websockets.asyncio.server import serve
            except ImportError as e:
                error.append(e)
                ready.set()
                return

            async def _main() -> None:
                global _server

                async def handler(websocket):
                    await _pty_session(websocket, allow_check)

                bind_host = host if host in ("127.0.0.1", "::1", "localhost") else "127.0.0.1"
                async with serve(handler, bind_host, port, max_size=2_000_000) as server:
                    _server = server
                    log.info(
                        "terminal PTY WebSocket on ws://%s:%s (proxy /ws/terminal here)",
                        bind_host,
                        port,
                    )
                    ready.set()
                    await asyncio.Future()

            loop = asyncio.new_event_loop()
            _loop = loop
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(_main())
            except OSError as e:
                error.append(e)
                ready.set()
            except Exception as e:
                error.append(e)
                ready.set()
            finally:
                try:
                    loop.close()
                except Exception:
                    pass

        _thread = threading.Thread(target=_run, name="foxos-terminal-ws", daemon=True)
        _thread.start()
        if not ready.wait(timeout=5.0):
            log.error("terminal WS failed to become ready in time")
            return False
        if error:
            log.error("terminal WS failed: %s", error[0])
            return False
        return True


def stop_terminal_ws() -> None:
    global _thread, _loop, _server
    with _lock:
        loop = _loop
        if loop and loop.is_running():
            loop.call_soon_threadsafe(loop.stop)
        _server = None
        _loop = None
        _thread = None
