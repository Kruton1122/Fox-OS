#!/usr/bin/env python3
"""Fox OS — clickable web desktop for headless Linux servers."""
from __future__ import annotations

import configparser
import json
import mimetypes
import os
import platform
import pwd
import shutil
import socket
import subprocess
import threading
import re
import tempfile
import uuid
import time
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, abort, after_this_request, jsonify, request, send_file, send_from_directory

VERSION = "3.3.0"

NETWORK_FS = frozenset({
    "cifs", "smb3", "smb2", "nfs", "nfs4", "fuse.sshfs", "fuse.rclone",
    "fuse.davfs2", "fuse.curlftpfs",
})

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
EXAMPLE_CONFIG = ROOT / "config.example.json"
STATIC = ROOT / "static"
DATA = ROOT / "data"
NOTES_PATH = DATA / "notes.json"
DESKTOP_PATH = DATA / "desktop.json"
WALLPAPERS_DIR = DATA / "wallpapers"
TRASH_DIR = DATA / "trash"
TRASH_FILES = TRASH_DIR / "files"
TRASH_MANIFEST = TRASH_DIR / "manifest.json"

WALLPAPER_EXT = frozenset({".png", ".jpg", ".jpeg", ".webp", ".svg"})
BROWSER_BINS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable")

app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")


@app.after_request
def _security_headers(resp):
    """Fox OS is the frame parent (/embed/* embeds others); do not allow being framed."""
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    return resp


def _default_config() -> dict:
    home = str(Path.home())
    return {
        "port": 8765,
        "host": "127.0.0.1",
        "title": "Fox OS",
        "wallpaper": "wallpaper.png",
        "roots": [{"id": "home", "label": "Home", "path": home, "kind": "local", "icon": "🏠"}],
        "default_root": "home",
        "allow_write": True,
        "write_roots": ["home"],
        "services": [],
        "services_auto": True,
        "discover_desktop_apps": True,
        "discover_docker": True,
        "allow_service_control": False,
        "allow_docker_control": False,
        "apps": [],
        "links": [],
        "quick_access": [],
        "embed_map": {},
        # Upload size cap for /api/files/upload (megabytes). 0 = unlimited (not recommended).
        "max_upload_mb": 512,
        # Soft-delete to data/trash (Explorer Recycle Bin). permanent=true still hard-deletes.
        "trash_enabled": True,
        "trash_max_items": 200,
        "trash_max_mb": 1024,
        "trash_max_age_days": 30,
        # Opt-in: launch system Chromium on the *server* display (kiosk). Default false.
        "allow_system_browser": False,
        # Opt-in: in-app PTY terminal (xterm.js ↔ WebSocket). Default false — shell as Fox OS user.
        "allow_terminal": False,
        # Side WebSocket listener (Waitress cannot do WS). Bound to 127.0.0.1 only.
        "terminal_ws_port": 8766,
        # Deprecated (v3.2.0 Wetty plan): ignored by Terminal app; kept for config compatibility.
        "terminal_embed": "",
        "terminal_url": "",
    }


def load_config() -> dict:
    path = CONFIG_PATH if CONFIG_PATH.exists() else EXAMPLE_CONFIG
    if not path.exists():
        return _default_config()
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    # Fill missing keys from defaults (portable installs)
    base = _default_config()
    for k, v in base.items():
        if k not in data:
            data[k] = v
    # Expand ~ in root paths
    for r in data.get("roots") or []:
        if isinstance(r.get("path"), str):
            r["path"] = str(Path(r["path"]).expanduser())
    return data


CFG = load_config()
DATA.mkdir(parents=True, exist_ok=True)
WALLPAPERS_DIR.mkdir(parents=True, exist_ok=True)
TRASH_DIR.mkdir(parents=True, exist_ok=True)
TRASH_FILES.mkdir(parents=True, exist_ok=True)

# Upload size cap (Flask/Werkzeug reject oversized bodies before handler runs)
_max_mb = CFG.get("max_upload_mb", 512)
try:
    _max_mb_f = float(_max_mb)
except (TypeError, ValueError):
    _max_mb_f = 512.0
if _max_mb_f and _max_mb_f > 0:
    app.config["MAX_CONTENT_LENGTH"] = int(_max_mb_f * 1024 * 1024)

# Discovered network mounts (id -> Path), merged into roots_map at request time
_EPHEMERAL: dict[str, Path] = {}
_EPHEMERAL_LOCK = threading.Lock()

_TRASH_LOCK = threading.Lock()

# CPU % sample state (threaded request workers)
_cpu_prev: tuple[float, float] | None = None  # (idle, total)
_cpu_lock = threading.Lock()


def roots_map() -> dict[str, Path]:
    out = {}
    for r in CFG.get("roots", []):
        p = Path(r["path"]).resolve()
        out[r["id"]] = p
    with _EPHEMERAL_LOCK:
        for rid, p in _EPHEMERAL.items():
            if rid not in out:
                out[rid] = p
    return out


def write_allowed(root_id: str) -> bool:
    if not CFG.get("allow_write", False):
        return False
    with _EPHEMERAL_LOCK:
        ephemeral = root_id in _EPHEMERAL and root_id not in {r["id"] for r in CFG.get("roots", [])}
    if ephemeral:
        return False
    return root_id in set(CFG.get("write_roots") or [])



def _default_desktop() -> dict:
    return {
        "wallpaper": None,  # None = use CFG wallpaper / static fallback
        "wallpaper_source": "static",  # static | data
        "show_widgets": True,
        "icon_size": "md",  # sm | md | lg
        "accent": "",  # optional CSS color for titlebar accent
    }


_DESKTOP_LOCK = threading.Lock()


def load_desktop() -> dict:
    base = _default_desktop()
    if not DESKTOP_PATH.exists():
        return dict(base)
    try:
        with open(DESKTOP_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return dict(base)
    except (OSError, json.JSONDecodeError):
        return dict(base)
    out = dict(base)
    for k, v in data.items():
        if k in base or k in ("wallpaper", "wallpaper_source", "show_widgets", "icon_size", "accent"):
            out[k] = v
    return out


def save_desktop(data: dict) -> dict:
    cur = load_desktop()
    for k, v in data.items():
        if k in ("wallpaper", "wallpaper_source", "show_widgets", "icon_size", "accent"):
            cur[k] = v
    with _DESKTOP_LOCK:
        DESKTOP_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = DESKTOP_PATH.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cur, f, indent=2)
            f.write("\n")
        tmp.replace(DESKTOP_PATH)
    return cur


def _safe_wallpaper_name(name: str) -> str:
    name = (name or "").strip().replace("\\", "/").split("/")[-1]
    if not name or name in (".", "..") or ".." in name:
        raise ValueError("bad wallpaper name")
    if Path(name).suffix.lower() not in WALLPAPER_EXT:
        raise ValueError("unsupported wallpaper type")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", name):
        raise ValueError("bad wallpaper name")
    return name


def resolve_wallpaper() -> dict:
    """Return current wallpaper metadata for the UI."""
    desk = load_desktop()
    wp = desk.get("wallpaper")
    src = desk.get("wallpaper_source") or "static"
    if wp and src == "data":
        try:
            name = _safe_wallpaper_name(str(wp))
            path = (WALLPAPERS_DIR / name).resolve()
            path.relative_to(WALLPAPERS_DIR.resolve())
            if path.is_file():
                return {
                    "name": name,
                    "source": "data",
                    "url": f"/api/wallpaper/file?source=data&name={name}",
                }
        except ValueError:
            pass
    # static: desktop override or CFG
    name = None
    if wp and src == "static":
        name = str(wp)
    if not name:
        name = CFG.get("wallpaper") or "wallpaper.png"
    # sanitize to basename under STATIC
    name = Path(str(name)).name
    wp_path = STATIC / name
    if not wp_path.is_file():
        for cand in ("wallpaper.png", "wallpaper.jpg", "wallpaper.webp", "wallpaper.default.svg"):
            if (STATIC / cand).is_file():
                name = cand
                break
        else:
            return {"name": None, "source": "static", "url": None}
    return {
        "name": name,
        "source": "static",
        "url": f"/api/wallpaper/file?source=static&name={name}",
    }


def _unique_child(dest_dir: Path, preferred_name: str) -> Path:
    candidate = dest_dir / preferred_name
    if not candidate.exists():
        return candidate
    stem = Path(preferred_name).stem
    suffix = Path(preferred_name).suffix
    for i in range(1, 1000):
        alt = dest_dir / f"{stem} ({i}){suffix}"
        if not alt.exists():
            return alt
    raise OSError("could not find unique name")


def copy_path_safe(src_root: str, src_rel: str, dest_root: str, dest_dir_rel: str) -> dict:
    if not write_allowed(dest_root):
        raise PermissionError("destination read-only")
    src = resolve_safe(src_root, src_rel)
    dest_dir = resolve_safe(dest_root, dest_dir_rel or "")
    if not src.exists():
        raise FileNotFoundError("source missing")
    if src_rel in ("", ".", None):
        raise ValueError("cannot copy root")
    if not dest_dir.is_dir():
        raise ValueError("destination not a directory")
    # prevent copying a directory into itself
    if src.is_dir():
        try:
            dest_dir.resolve().relative_to(src.resolve())
            raise ValueError("cannot copy folder into itself")
        except ValueError as e:
            if "into itself" in str(e):
                raise
    dest = _unique_child(dest_dir, src.name)
    # ensure dest stays in jail
    resolve_safe(dest_root, str(dest.relative_to(roots_map()[dest_root])).replace("\\", "/"))
    if src.is_dir():
        shutil.copytree(src, dest, dirs_exist_ok=False)
    else:
        shutil.copy2(src, dest)
    out_rel = str(dest.relative_to(roots_map()[dest_root])).replace("\\", "/")
    return {"ok": True, "root": dest_root, "path": out_rel, "name": dest.name}


def move_path_safe(src_root: str, src_rel: str, dest_root: str, dest_dir_rel: str) -> dict:
    if not write_allowed(src_root):
        raise PermissionError("source read-only")
    if not write_allowed(dest_root):
        raise PermissionError("destination read-only")
    src = resolve_safe(src_root, src_rel)
    dest_dir = resolve_safe(dest_root, dest_dir_rel or "")
    if not src.exists():
        raise FileNotFoundError("source missing")
    if src_rel in ("", ".", None):
        raise ValueError("cannot move root")
    if src == roots_map()[src_root]:
        raise ValueError("cannot move root")
    if not dest_dir.is_dir():
        raise ValueError("destination not a directory")
    if src.is_dir():
        try:
            dest_dir.resolve().relative_to(src.resolve())
            raise ValueError("cannot move folder into itself")
        except ValueError as e:
            if "into itself" in str(e):
                raise
    dest = _unique_child(dest_dir, src.name)
    resolve_safe(dest_root, str(dest.relative_to(roots_map()[dest_root])).replace("\\", "/"))
    shutil.move(str(src), str(dest))
    out_rel = str(dest.relative_to(roots_map()[dest_root])).replace("\\", "/")
    return {"ok": True, "root": dest_root, "path": out_rel, "name": dest.name}


def _sanitize_http_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("url required")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("only http(s) URLs allowed")
    if not parsed.netloc:
        raise ValueError("bad url")
    # Rebuild without credentials / fragment noise for argv safety
    path = parsed.path or "/"
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{parsed.scheme}://{parsed.netloc}{path}{query}"


def _find_system_browser() -> str | None:
    for name in BROWSER_BINS:
        path = shutil.which(name)
        if path:
            return path
    return None


def _prune_ephemeral() -> None:
    """Drop discovered mounts whose paths no longer exist (removable/rotating shares)."""
    with _EPHEMERAL_LOCK:
        dead = [rid for rid, p in _EPHEMERAL.items() if not p.exists()]
        for rid in dead:
            del _EPHEMERAL[rid]


def resolve_safe(root_id: str, rel: str = "") -> Path:
    """Resolve path under an allowed root; raise ValueError if escape."""
    roots = roots_map()
    if root_id not in roots:
        raise ValueError("unknown root")
    base = roots[root_id]
    if not base.exists():
        raise ValueError("root missing")
    rel = (rel or "").replace("\\", "/").lstrip("/")
    parts = [p for p in rel.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise ValueError("path traversal")
    target = (base.joinpath(*parts)).resolve()
    try:
        target.relative_to(base)
    except ValueError as e:
        raise ValueError("outside root") from e
    return target


def file_entry(path: Path, base: Path) -> dict:
    try:
        st = path.stat()
    except OSError:
        return {"name": path.name, "error": "stat failed"}
    is_dir = path.is_dir()
    rel = str(path.relative_to(base)) if path != base else ""
    mime, _ = mimetypes.guess_type(str(path)) if not is_dir else (None, None)
    ext = path.suffix.lower().lstrip(".") if not is_dir else ""
    return {
        "name": path.name or path.as_posix(),
        "path": rel.replace("\\", "/"),
        "is_dir": is_dir,
        "size": 0 if is_dir else st.st_size,
        "mtime": int(st.st_mtime),
        "mtime_iso": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
        "mode": oct(st.st_mode)[-3:],
        "mime": mime,
        "ext": ext,
        "type_label": _type_label(is_dir, ext, mime),
    }


def _type_label(is_dir: bool, ext: str, mime: str | None) -> str:
    if is_dir:
        return "File folder"
    if mime:
        if mime.startswith("image/"):
            return f"{ext.upper()} image" if ext else "Image"
        if mime.startswith("video/"):
            return "Video"
        if mime.startswith("audio/"):
            return "Audio"
        if mime.startswith("text/"):
            return "Text document"
        if "pdf" in mime:
            return "PDF document"
    if not ext:
        return "File"
    return f"{ext.upper()} file"


def _mount_meta(path: Path) -> dict:
    """Return fstype/source/network for a path via findmnt."""
    meta = {"fstype": None, "source": None, "network": False, "mounted": path.exists()}
    if not path.exists():
        return meta
    code, out, _ = _run(["findmnt", "-T", str(path), "-no", "FSTYPE,SOURCE"], timeout=3)
    if code == 0 and out.strip():
        parts = out.strip().split(None, 1)
        fstype = parts[0] if parts else None
        source = parts[1] if len(parts) > 1 else None
        meta["fstype"] = fstype
        meta["source"] = source
        meta["network"] = bool(fstype and (fstype in NETWORK_FS or (source or "").startswith("//")))
    return meta


def _disk_usage(path: Path) -> dict | None:
    try:
        u = shutil.disk_usage(path)
        return {
            "total": u.total,
            "used": u.used,
            "free": u.free,
            "percent": round(100 * u.used / u.total, 1) if u.total else 0,
        }
    except OSError:
        return None


def _place_from_root(r: dict) -> dict:
    p = Path(r["path"])
    meta = _mount_meta(p) if p.exists() else {"fstype": None, "source": None, "network": False, "mounted": False}
    kind = r.get("kind") or ("network" if meta["network"] else "local")
    if r.get("kind") == "network":
        kind = "network"
    icon = r.get("icon")
    if not icon:
        icon = "🖧" if kind == "network" else "🖴"
    usage = _disk_usage(p) if p.exists() else None
    return {
        "id": r["id"],
        "label": r["label"],
        "path": r["path"],
        "kind": kind,
        "icon": icon,
        "exists": p.exists(),
        "mounted": bool(meta.get("mounted")),
        "writable": write_allowed(r["id"]) and p.exists() and os.access(p, os.W_OK),
        "fstype": meta.get("fstype"),
        "source": meta.get("source"),
        "usage": usage,
        "desc": r.get("desc") or (
            meta.get("source") if kind == "network" else r["path"]
        ),
    }


def discover_network_mounts() -> list[dict]:
    """Extra CIFS/NFS mounts under /mnt not already in config."""
    known = {str(Path(r["path"]).resolve()) for r in CFG.get("roots", []) if Path(r["path"]).exists()}
    known |= {str(Path(r["path"])) for r in CFG.get("roots", [])}
    found = []
    code, out, _ = _run(["findmnt", "-t", "cifs,nfs,nfs4", "-n", "-o", "TARGET,SOURCE,FSTYPE"], timeout=5)
    if code != 0:
        return found
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        target, source = parts[0], parts[1]
        fstype = parts[2] if len(parts) > 2 else "cifs"
        try:
            resolved = str(Path(target).resolve())
        except OSError:
            resolved = target
        if resolved in known or target in known:
            continue
        # only expose under /mnt or /media
        if not (target.startswith("/mnt/") or target.startswith("/media/")):
            continue
        slug = Path(target).name or "share"
        pid = f"net-{slug}"
        # avoid id clash
        i = 1
        while any(x["id"] == pid for x in found):
            i += 1
            pid = f"net-{slug}-{i}"
        usage = _disk_usage(Path(target))
        found.append({
            "id": pid,
            "label": Path(target).name.title() or "Network share",
            "path": target,
            "kind": "network",
            "icon": "🖧",
            "exists": True,
            "mounted": True,
            "writable": False,
            "fstype": fstype,
            "source": source,
            "usage": usage,
            "desc": source,
            "discovered": True,
        })
    return found


def _cpu_times() -> tuple[float, float] | None:
    try:
        with open("/proc/stat", encoding="utf-8") as f:
            parts = f.readline().split()
        vals = [float(x) for x in parts[1:]]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        total = sum(vals)
        return idle, total
    except (OSError, ValueError, IndexError):
        return None


def cpu_percent() -> float | None:
    """Estimate CPU % from /proc/stat deltas (thread-safe under waitress/threaded WSGI)."""
    global _cpu_prev
    cur = _cpu_times()
    if not cur:
        return None
    with _cpu_lock:
        if _cpu_prev is None:
            _cpu_prev = cur
            # Release lock during sleep so other threads aren't blocked
            pass
        else:
            prev = _cpu_prev
            _cpu_prev = cur
            idle_d = cur[0] - prev[0]
            total_d = cur[1] - prev[1]
            if total_d <= 0:
                return 0.0
            used = 100.0 * (1.0 - idle_d / total_d)
            return round(max(0.0, min(100.0, used)), 1)
    # First call: short second sample outside lock
    time.sleep(0.08)
    cur2 = _cpu_times()
    if not cur2:
        return None
    with _cpu_lock:
        prev = _cpu_prev if _cpu_prev is not None else cur
        _cpu_prev = cur2
        idle_d = cur2[0] - prev[0]
        total_d = cur2[1] - prev[1]
        if total_d <= 0:
            return 0.0
        used = 100.0 * (1.0 - idle_d / total_d)
        return round(max(0.0, min(100.0, used)), 1)


def _fmt_uptime(secs: float) -> str:
    s = int(secs)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    parts = []
    if d:
        parts.append(f"{d}d")
    if h or d:
        parts.append(f"{h}h")
    parts.append(f"{m}m")
    return " ".join(parts)


def _run(cmd: list[str], timeout: float = 8) -> tuple[int, str, str]:
    try:
        p = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return p.returncode, p.stdout or "", p.stderr or ""
    except (subprocess.SubprocessError, OSError, FileNotFoundError) as e:
        return 127, "", str(e)


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


def _os_release() -> dict:
    info: dict[str, str] = {}
    try:
        with open("/etc/os-release", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or "=" not in line or line.startswith("#"):
                    continue
                k, v = line.split("=", 1)
                info[k] = v.strip().strip('"')
    except OSError:
        pass
    return {
        "id": info.get("ID") or platform.system().lower(),
        "name": info.get("PRETTY_NAME") or f"{platform.system()} {platform.release()}",
        "version": info.get("VERSION_ID") or platform.release(),
        "like": info.get("ID_LIKE") or "",
    }


def _builtin_apps() -> list[dict]:
    """Core desktop apps always available (portable)."""
    return [
        {"id": "files", "label": "File Explorer", "action": "files", "icon": "📁", "desc": "Browse disks & shares"},
        {"id": "trash", "label": "Recycle Bin", "action": "trash", "icon": "🗑", "desc": "Restore or empty deleted files"},
        {"id": "system", "label": "System", "action": "system", "icon": "🖥", "desc": "CPU, RAM, disks — live"},
        {"id": "programs", "label": "Programs", "action": "programs", "icon": "📦", "desc": "Installed apps & tools"},
        {"id": "processes", "label": "Processes", "action": "processes", "icon": "⚙", "desc": "What's running"},
        {"id": "docker", "label": "Docker", "action": "docker", "icon": "🐳", "desc": "Containers"},
        {"id": "services", "label": "Services", "action": "services", "icon": "🛠", "desc": "systemd units"},
        {"id": "network", "label": "Network", "action": "network", "icon": "🌐", "desc": "Interfaces & ports"},
        {"id": "logs", "label": "Logs", "action": "logs", "icon": "📜", "desc": "Journal tail"},
        {"id": "launcher", "label": "Launcher", "action": "launcher", "icon": "🚀", "desc": "Bookmarked links"},
        {"id": "notes", "label": "Notes", "action": "notes", "icon": "📝", "desc": "Sticky notes"},
        {"id": "calc", "label": "Calculator", "action": "calc", "icon": "🔢", "desc": "Quick math"},
        {"id": "browser", "label": "Browser", "action": "browser", "icon": "🌐", "desc": "Browse the web in Fox OS"},
        {"id": "terminal", "label": "Terminal", "action": "terminal", "icon": "⌨", "desc": "PTY shell (xterm.js; allow_terminal)"},
        {"id": "settings", "label": "Settings", "action": "settings", "icon": "🔧", "desc": "Fox OS options"},
    ]


def _merged_apps() -> list[dict]:
    """Builtin apps + user config apps (user entries win on same id)."""
    by_id: dict[str, dict] = {a["id"]: dict(a) for a in _builtin_apps()}
    for a in CFG.get("apps") or []:
        if not a.get("id"):
            continue
        # Skip docker app if docker missing
        if a["id"] == "docker" and not shutil.which("docker"):
            continue
        cur = by_id.get(a["id"], {})
        cur.update(a)
        by_id[a["id"]] = cur
    # Drop docker builtin if no docker
    if not shutil.which("docker"):
        by_id.pop("docker", None)
    # Preserve builtin order then extras
    order = [a["id"] for a in _builtin_apps() if a["id"] in by_id]
    for aid in by_id:
        if aid not in order:
            order.append(aid)
    return [by_id[i] for i in order]


def _parse_desktop_file(path: Path) -> dict | None:
    """Parse a FreeDesktop .desktop file into a program entry."""
    try:
        cp = configparser.ConfigParser(interpolation=None)
        # Desktop files are key=value; ConfigParser needs a section
        text = path.read_text(encoding="utf-8", errors="replace")
        if "[Desktop Entry]" not in text:
            return None
        cp.read_string(text)
        if not cp.has_section("Desktop Entry"):
            return None
        e = cp["Desktop Entry"]
        if e.get("Type", "Application") != "Application":
            return None
        if e.getboolean("NoDisplay", fallback=False) or e.getboolean("Hidden", fallback=False):
            return None
        name = e.get("Name") or path.stem
        exec_cmd = (e.get("Exec") or "").strip()
        if not exec_cmd:
            return None
        # Strip field codes %f %u etc.
        parts = []
        for tok in exec_cmd.split():
            if tok.startswith("%"):
                continue
            parts.append(tok)
        binary = parts[0] if parts else ""
        icon = e.get("Icon") or "📦"
        # Prefer emoji-ish short label; keep icon name as text if not path
        if icon.startswith("/") or icon.endswith((".png", ".svg", ".xpm")):
            icon_display = "📦"
        else:
            icon_display = "📦"
        cats = [c for c in (e.get("Categories") or "").split(";") if c]
        return {
            "id": f"desktop:{path.stem}",
            "name": name,
            "comment": e.get("Comment") or e.get("GenericName") or "",
            "exec": " ".join(parts),
            "binary": Path(binary).name if binary else "",
            "terminal": e.getboolean("Terminal", fallback=False),
            "categories": cats[:8],
            "icon": icon_display,
            "icon_name": e.get("Icon") or "",
            "source": "desktop",
            "desktop_file": str(path),
            "available": bool(binary and (shutil.which(binary) or Path(binary).exists())),
        }
    except (OSError, configparser.Error, ValueError):
        return None


def discover_desktop_apps(limit: int = 120) -> list[dict]:
    if not CFG.get("discover_desktop_apps", True):
        return []
    dirs = [
        Path("/usr/share/applications"),
        Path("/usr/local/share/applications"),
        Path.home() / ".local/share/applications",
    ]
    seen: set[str] = set()
    out: list[dict] = []
    for d in dirs:
        if not d.is_dir():
            continue
        try:
            files = sorted(d.glob("*.desktop"))
        except OSError:
            continue
        for f in files:
            if f.name in seen:
                continue
            seen.add(f.name)
            ent = _parse_desktop_file(f)
            if ent:
                out.append(ent)
            if len(out) >= limit:
                return out
    out.sort(key=lambda x: (not x.get("available"), x.get("name", "").lower()))
    return out


def discover_running_services(limit: int = 40) -> list[str]:
    """Unit names for running system services (generic hosts)."""
    code, stdout, _ = _run(
        ["systemctl", "list-units", "--type=service", "--state=running",
         "--no-pager", "--no-legend", "--plain"],
        timeout=6,
    )
    if code != 0:
        return []
    skip_prefixes = ("session-", "user@", "getty@", "serial-getty@", "user-runtime-dir@")
    units = []
    for line in stdout.splitlines():
        parts = line.split()
        if not parts:
            continue
        unit = parts[0]
        if not unit.endswith(".service"):
            continue
        if unit.startswith(skip_prefixes):
            continue
        units.append(unit.replace(".service", ""))
        if len(units) >= limit:
            break
    return units



def trash_enabled() -> bool:
    return bool(CFG.get("trash_enabled", True))


def _trash_max_items() -> int:
    try:
        n = int(CFG.get("trash_max_items", 200) or 200)
    except (TypeError, ValueError):
        n = 200
    return max(1, n)


def _trash_max_bytes() -> int:
    try:
        mb = float(CFG.get("trash_max_mb", 1024) or 1024)
    except (TypeError, ValueError):
        mb = 1024.0
    if mb <= 0:
        return 0  # unlimited
    return int(mb * 1024 * 1024)


def _trash_max_age_seconds() -> int:
    try:
        days = float(CFG.get("trash_max_age_days", 30) or 30)
    except (TypeError, ValueError):
        days = 30.0
    if days <= 0:
        return 0  # unlimited
    return int(days * 86400)


def _path_size(path: Path) -> int:
    """Total size of a file or directory tree (best-effort)."""
    try:
        if path.is_file():
            return int(path.stat().st_size)
    except OSError:
        return 0
    total = 0
    try:
        for p in path.rglob("*"):
            try:
                if p.is_file():
                    total += int(p.stat().st_size)
            except OSError:
                continue
    except OSError:
        pass
    return total


def _load_trash_manifest() -> list[dict]:
    if not TRASH_MANIFEST.is_file():
        return []
    try:
        data = json.loads(TRASH_MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return [x for x in data["items"] if isinstance(x, dict) and x.get("id")]
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict) and x.get("id")]
    return []


def _save_trash_manifest(items: list[dict]) -> None:
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "items": items}
    tmp = TRASH_MANIFEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(TRASH_MANIFEST)


def _trash_store_path(store_name: str) -> Path:
    name = Path(store_name or "").name
    if not name or name in (".", ".."):
        raise ValueError("bad trash id")
    target = (TRASH_FILES / name).resolve()
    try:
        target.relative_to(TRASH_FILES.resolve())
    except ValueError as e:
        raise ValueError("outside trash") from e
    return target


def _purge_trash_store(store_name: str) -> None:
    try:
        path = _trash_store_path(store_name)
    except ValueError:
        return
    if not path.exists():
        return
    try:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    except OSError:
        pass


def _public_trash_item(it: dict) -> dict:
    """Normalize manifest row for API clients."""
    return {
        "id": it.get("id"),
        "original_root": it.get("original_root"),
        "path": it.get("original_path") or it.get("path") or "",
        "name": it.get("name") or "",
        "deleted_at": int(it.get("deleted_at") or 0),
        "deleted_iso": it.get("deleted_iso") or "",
        "size": int(it.get("size") or 0),
        "is_dir": bool(it.get("is_dir")),
    }


def _enforce_trash_caps(items: list[dict]) -> list[dict]:
    """Drop expired/oldest trash entries until under age/item/size caps."""
    max_items = _trash_max_items()
    max_bytes = _trash_max_bytes()
    max_age = _trash_max_age_seconds()
    now = time.time()
    items = sorted(items, key=lambda x: int(x.get("deleted_at") or 0))
    if max_age > 0:
        kept = []
        for it in items:
            age = now - int(it.get("deleted_at") or 0)
            if age > max_age:
                _purge_trash_store(str(it.get("store_name") or ""))
            else:
                kept.append(it)
        items = kept
    while len(items) > max_items:
        old = items.pop(0)
        _purge_trash_store(str(old.get("store_name") or ""))
    if max_bytes > 0:
        def total() -> int:
            return sum(int(x.get("size") or 0) for x in items)
        while items and total() > max_bytes:
            old = items.pop(0)
            _purge_trash_store(str(old.get("store_name") or ""))
    return items


def soft_delete_to_trash(root_id: str, rel: str) -> dict:
    """Move a jailed path into data/trash and record manifest entry."""
    if not rel:
        raise ValueError("cannot delete root")
    if not write_allowed(root_id):
        raise PermissionError("read-only root")
    path = resolve_safe(root_id, rel)
    base = roots_map()[root_id]
    if path == base:
        raise ValueError("cannot delete root")
    if not path.exists():
        raise FileNotFoundError("not found")

    try:
        path.resolve().relative_to(base.resolve())
    except ValueError as e:
        raise ValueError("outside root") from e

    with _TRASH_LOCK:
        TRASH_FILES.mkdir(parents=True, exist_ok=True)
        item_id = uuid.uuid4().hex
        store_name = item_id
        dest = TRASH_FILES / store_name
        size = _path_size(path)
        is_dir = path.is_dir()
        name = path.name
        now = time.time()
        try:
            shutil.move(str(path), str(dest))
        except OSError as e:
            raise OSError(str(e)) from e

        entry = {
            "id": item_id,
            "store_name": store_name,
            "original_root": root_id,
            "original_path": rel.replace("\\", "/"),
            "name": name,
            "is_dir": is_dir,
            "size": size,
            "deleted_at": int(now),
            "deleted_iso": datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M"),
        }
        items = _load_trash_manifest()
        items.append(entry)
        items = _enforce_trash_caps(items)
        _save_trash_manifest(items)
        return _public_trash_item(entry)


def hard_delete_path(root_id: str, rel: str) -> None:
    if not rel:
        raise ValueError("cannot delete root")
    if not write_allowed(root_id):
        raise PermissionError("read-only root")
    path = resolve_safe(root_id, rel)
    if path == roots_map()[root_id]:
        raise ValueError("cannot delete root")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def _unique_restore_dest(parent: Path, base: Path, preferred: Path) -> Path:
    """Pick preferred path, or name (1).ext / name (2).ext on collision."""
    if not preferred.exists():
        return preferred
    stem = preferred.stem
    suffix = preferred.suffix
    n = 1
    while n < 1000:
        cand = preferred.with_name(f"{stem} ({n}){suffix}")
        try:
            cand.resolve().relative_to(base.resolve())
        except ValueError as e:
            raise ValueError("outside root") from e
        if not cand.exists():
            return cand
        n += 1
    raise ValueError("could not find free restore name")



@app.get("/api/health")
def health():
    return jsonify({"ok": True, "name": "Fox OS", "ts": time.time(), "version": VERSION})


@app.get("/api/config")
def api_config():
    roots = [_place_from_root(r) for r in CFG.get("roots", [])]
    desk = load_desktop()
    wp = resolve_wallpaper()
    return jsonify({
        "title": CFG.get("title", "Fox OS"),
        "version": VERSION,
        "roots": roots,
        "default_root": CFG.get("default_root", "home"),
        "apps": _merged_apps(),
        "links": CFG.get("links", []),
        "quick_access": CFG.get("quick_access", []),
        "embed_map": CFG.get("embed_map") or {},
        "wallpaper": wp.get("name"),
        "wallpaper_url": wp.get("url"),
        "wallpaper_source": wp.get("source"),
        "desktop": {
            "show_widgets": bool(desk.get("show_widgets", True)),
            "icon_size": desk.get("icon_size") or "md",
            "accent": desk.get("accent") or "",
        },
        "allow_write": CFG.get("allow_write", False),
        "allow_system_browser": bool(CFG.get("allow_system_browser", False)),
        "system_browser_available": _find_system_browser() is not None,
        "allow_terminal": bool(CFG.get("allow_terminal", False)),
        "terminal_ws_port": int(CFG.get("terminal_ws_port") or 8766),
        "terminal_ws_path": "/ws/terminal",
        # Deprecated Wetty keys (Terminal app ignores; still echoed for older UIs)
        "terminal_embed": CFG.get("terminal_embed") or "",
        "terminal_url": CFG.get("terminal_url") or "",
        "user": pwd.getpwuid(os.getuid()).pw_name,
        "hostname": socket.gethostname(),
        "features": {
            "docker": shutil.which("docker") is not None,
            "journal": shutil.which("journalctl") is not None,
            "systemctl": shutil.which("systemctl") is not None,
            "desktop_apps": CFG.get("discover_desktop_apps", True),
            "service_control": bool(CFG.get("allow_service_control", False)),
            "docker_control": bool(CFG.get("allow_docker_control", False)),
            "trash": trash_enabled(),
            "system_browser": bool(CFG.get("allow_system_browser", False)),
            "terminal": bool(CFG.get("allow_terminal", False)),
        },
        "trash_caps": {
            "max_items": _trash_max_items(),
            "max_mb": CFG.get("trash_max_mb", 1024),
            "max_age_days": CFG.get("trash_max_age_days", 30),
            "enabled": trash_enabled(),
        },
    })


@app.get("/api/places")
def api_places():
    """This PC / Network navigation for File Explorer."""
    configured = [_place_from_root(r) for r in CFG.get("roots", [])]
    # merge discovered network mounts (read-only virtual ids)
    extra = discover_network_mounts()
    _prune_ephemeral()
    _register_ephemeral_roots(extra)

    local = [p for p in configured if p["kind"] != "network"]
    network = [p for p in configured if p["kind"] == "network"] + extra

    quick = []
    for q in CFG.get("quick_access") or []:
        rid = q.get("root") or CFG.get("default_root", "home")
        place = next((p for p in configured if p["id"] == rid), None)
        quick.append({
            "id": q.get("id") or f"qa-{rid}-{q.get('path') or 'root'}",
            "label": q.get("label") or (place["label"] if place else rid),
            "root": rid,
            "path": q.get("path") or "",
            "icon": q.get("icon") or ("🖧" if place and place["kind"] == "network" else "📁"),
            "kind": place["kind"] if place else "local",
        })
    if not quick:
        for p in configured:
            quick.append({
                "id": f"qa-{p['id']}",
                "label": p["label"],
                "root": p["id"],
                "path": "",
                "icon": p.get("icon") or "📁",
                "kind": p["kind"],
            })

    return jsonify({
        "quick_access": quick,
        "this_pc": local,
        "network": network,
        "all": configured + extra,
    })


def _register_ephemeral_roots(places: list[dict]) -> None:
    with _EPHEMERAL_LOCK:
        for p in places:
            if p.get("discovered") and p.get("id") and p.get("path"):
                try:
                    _EPHEMERAL[p["id"]] = Path(p["path"]).resolve()
                except OSError:
                    _EPHEMERAL[p["id"]] = Path(p["path"])


@app.get("/api/system")
def api_system():
    uname = os.uname()
    mem = {"total": 0, "available": 0, "used": 0, "percent": 0}
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            info = {}
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.strip().split()[0]) * 1024
            total = info.get("MemTotal", 0)
            avail = info.get("MemAvailable", info.get("MemFree", 0))
            used = max(0, total - avail)
            mem = {
                "total": total,
                "available": avail,
                "used": used,
                "percent": round(100 * used / total, 1) if total else 0,
                "swap_total": info.get("SwapTotal", 0),
                "swap_free": info.get("SwapFree", 0),
            }
    except OSError:
        pass

    load = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)
    uptime_s = 0
    try:
        with open("/proc/uptime", encoding="utf-8") as f:
            uptime_s = float(f.read().split()[0])
    except OSError:
        pass

    disks = []
    try:
        out = subprocess.check_output(
            ["df", "-B1", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs"],
            text=True,
            timeout=5,
        )
        lines = out.strip().splitlines()[1:]
        for line in lines:
            parts = line.split()
            if len(parts) < 6:
                continue
            fs, size, used, avail, pct, mount = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
            if mount.startswith("/snap"):
                continue
            disks.append({
                "filesystem": fs,
                "size": int(size),
                "used": int(used),
                "available": int(avail),
                "percent": pct,
                "mount": mount,
            })
    except (subprocess.SubprocessError, ValueError, OSError):
        pass

    temp_c = None
    try:
        t = Path("/sys/class/thermal/thermal_zone0/temp")
        if t.exists():
            temp_c = round(int(t.read_text().strip()) / 1000, 1)
    except (OSError, ValueError):
        pass

    nproc = os.cpu_count() or 1
    rel = _os_release()
    return jsonify({
        "hostname": socket.gethostname(),
        "user": pwd.getpwuid(os.getuid()).pw_name,
        "os": f"{uname.sysname} {uname.release}",
        "os_pretty": rel.get("name"),
        "distro_id": rel.get("id"),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "machine": uname.machine,
        "uptime_sec": uptime_s,
        "uptime_human": _fmt_uptime(uptime_s),
        "load": {"1": load[0], "5": load[1], "15": load[2]},
        "cpu_percent": cpu_percent(),
        "cpu_count": nproc,
        "memory": mem,
        "disks": disks,
        "cpu_temp_c": temp_c,
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "foxos_version": VERSION,
    })


@app.get("/api/processes")
def api_processes():
    """Top processes by CPU / memory (read-only)."""
    limit = min(int(request.args.get("limit") or 40), 100)
    procs: list[dict] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            pid = int(entry.name)
            stat = (entry / "stat").read_text(encoding="utf-8", errors="replace")
            # comm is in parens and may contain spaces
            lpar = stat.index("(")
            rpar = stat.rindex(")")
            comm = stat[lpar + 1:rpar]
            fields = stat[rpar + 2:].split()
            state = fields[0] if fields else "?"
            utime = int(fields[11]) if len(fields) > 11 else 0
            stime = int(fields[12]) if len(fields) > 12 else 0
            rss_pages = int(fields[21]) if len(fields) > 21 else 0
            page = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
            rss = rss_pages * page
            cmdline = ""
            try:
                raw = (entry / "cmdline").read_bytes()
                cmdline = raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()
            except OSError:
                pass
            uid = None
            try:
                status = (entry / "status").read_text(encoding="utf-8", errors="replace")
                for line in status.splitlines():
                    if line.startswith("Uid:"):
                        uid = int(line.split()[1])
                        break
            except (OSError, ValueError, IndexError):
                pass
            user = "?"
            if uid is not None:
                try:
                    user = pwd.getpwuid(uid).pw_name
                except KeyError:
                    user = str(uid)
            procs.append({
                "pid": pid,
                "name": comm,
                "state": state,
                "cpu_ticks": utime + stime,
                "rss": rss,
                "user": user,
                "cmd": (cmdline or comm)[:200],
            })
        except (OSError, ValueError, IndexError):
            continue

    # Sort by RSS as a stand-in; ticks need two samples for real CPU%
    procs.sort(key=lambda p: p["rss"], reverse=True)
    procs = procs[:limit]
    return jsonify({"processes": procs, "count": len(procs), "ts": time.time()})


@app.get("/api/network")
def api_network():
    ifaces = []
    code, out, _ = _run(["ip", "-j", "addr"], timeout=5)
    if code == 0 and out.strip():
        try:
            data = json.loads(out)
            for iface in data:
                addrs = []
                for a in iface.get("addr_info") or []:
                    addrs.append({
                        "family": a.get("family"),
                        "address": a.get("local"),
                        "prefix": a.get("prefixlen"),
                    })
                ifaces.append({
                    "name": iface.get("ifname"),
                    "state": iface.get("operstate") or iface.get("flags", [""])[0],
                    "mac": iface.get("address"),
                    "mtu": iface.get("mtu"),
                    "addrs": addrs,
                })
        except json.JSONDecodeError:
            pass
    if not ifaces:
        code, out, _ = _run(["ip", "-br", "addr"], timeout=5)
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                ifaces.append({
                    "name": parts[0],
                    "state": parts[1],
                    "mac": None,
                    "mtu": None,
                    "addrs": [{"address": a, "family": "inet" if ":" not in a else "inet6"} for a in parts[2:]],
                })

    hostname = socket.gethostname()
    fqdn = socket.getfqdn()
    # listening ports (ss), limited
    listeners = []
    code, out, _ = _run(["ss", "-tlnp"], timeout=5)
    if code == 0:
        for line in out.splitlines()[1:]:
            parts = line.split()
            if len(parts) < 4:
                continue
            local = parts[3]
            listeners.append({"local": local, "process": parts[-1] if len(parts) > 5 else ""})
            if len(listeners) >= 40:
                break

    return jsonify({
        "hostname": hostname,
        "fqdn": fqdn,
        "interfaces": ifaces,
        "listeners": listeners,
    })


@app.get("/api/programs")
def api_programs():
    """Installed programs: FreeDesktop apps, config links, optional Docker."""
    desktop = discover_desktop_apps()
    links = []
    for l in CFG.get("links") or []:
        links.append({
            "id": f"link:{l.get('id') or l.get('label')}",
            "name": l.get("label") or l.get("id") or "Link",
            "comment": l.get("desc") or l.get("group") or "",
            "url": l.get("url"),
            "icon": l.get("icon") or "🔗",
            "source": "link",
            "group": l.get("group") or "Links",
            "available": True,
        })
    containers = []
    if CFG.get("discover_docker", True) and shutil.which("docker"):
        code, out, _ = _run(
            ["docker", "ps", "-a", "--format",
             "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}"],
            timeout=10,
        )
        if code == 0:
            for line in out.splitlines():
                parts = line.split("\t")
                if len(parts) < 4:
                    continue
                containers.append({
                    "id": f"docker:{parts[0]}",
                    "name": parts[0],
                    "comment": parts[1],
                    "icon": "🐳",
                    "source": "docker",
                    "state": parts[3],
                    "status": parts[2],
                    "available": parts[3] == "running",
                })

    # PATH-notable CLIs (small curated set if present)
    cli_candidates = [
        ("python3", "Python 3", "🐍"),
        ("node", "Node.js", "📗"),
        ("npm", "npm", "📗"),
        ("docker", "Docker CLI", "🐳"),
        ("git", "Git", "🌿"),
        ("nginx", "Nginx", "🌐"),
        ("curl", "curl", "📡"),
        ("htop", "htop", "📊"),
        ("vim", "Vim", "📝"),
        ("nano", "Nano", "📝"),
        ("systemctl", "systemctl", "🛠"),
    ]
    clis = []
    for bin_name, label, icon in cli_candidates:
        p = shutil.which(bin_name)
        if p:
            clis.append({
                "id": f"cli:{bin_name}",
                "name": label,
                "comment": p,
                "binary": bin_name,
                "icon": icon,
                "source": "cli",
                "available": True,
            })

    return jsonify({
        "desktop": desktop,
        "links": links,
        "docker": containers,
        "cli": clis,
        "counts": {
            "desktop": len(desktop),
            "links": len(links),
            "docker": len(containers),
            "cli": len(clis),
        },
    })


@app.get("/api/services")
def api_services():
    """systemd unit status — config list and/or auto-discovered running units."""
    units = list(CFG.get("services") or [])
    if CFG.get("services_auto", True) or not units:
        for u in discover_running_services():
            if u not in units:
                units.append(u)
    # sensible portable defaults if still empty
    if not units:
        units = ["ssh", "cron", "docker", "nginx", "foxos"]
    # de-dupe preserve order
    seen = set()
    clean = []
    for u in units:
        name = u if u.endswith(".service") else f"{u}.service"
        if name not in seen:
            seen.add(name)
            clean.append(name)

    rows = []
    for unit in clean:
        code, out, _ = _run(
            ["systemctl", "show", unit, "--no-page",
             "-p", "Id", "-p", "ActiveState", "-p", "SubState",
             "-p", "Description", "-p", "MainPID", "-p", "FragmentPath",
             "-p", "UnitFileState"],
            timeout=4,
        )
        info = {"unit": unit, "active": "unknown", "sub": "unknown", "description": "", "pid": 0, "enabled": ""}
        if code == 0:
            for line in out.splitlines():
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k == "ActiveState":
                    info["active"] = v
                elif k == "SubState":
                    info["sub"] = v
                elif k == "Description":
                    info["description"] = v
                elif k == "MainPID":
                    try:
                        info["pid"] = int(v)
                    except ValueError:
                        pass
                elif k == "UnitFileState":
                    info["enabled"] = v
                elif k == "Id":
                    info["unit"] = v
        else:
            info["active"] = "not-found"
        rows.append(info)

    return jsonify({
        "services": rows,
        "can_control": bool(CFG.get("allow_service_control", False)),
    })


@app.get("/api/docker")
def api_docker():
    if not shutil.which("docker"):
        return jsonify({"available": False, "containers": [], "error": "docker not installed"})
    code, out, err = _run(
        ["docker", "ps", "-a", "--format",
         "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.State}}"],
        timeout=12,
    )
    if code != 0:
        return jsonify({"available": True, "containers": [], "error": err.strip() or "docker ps failed"})
    containers = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        containers.append({
            "id": parts[0][:12],
            "name": parts[1],
            "image": parts[2],
            "status": parts[3],
            "ports": parts[4],
            "state": parts[5],
        })
    # sort running first
    containers.sort(key=lambda c: (0 if c["state"] == "running" else 1, c["name"].lower()))
    return jsonify({
        "available": True,
        "containers": containers,
        "count": len(containers),
        "can_control": bool(CFG.get("allow_docker_control", False)),
    })


def _normalize_unit(name: str) -> str:
    """Normalize a systemd unit name; empty if unsafe."""
    unit = (name or "").strip()
    if not unit:
        return ""
    if not all(c.isalnum() or c in ".-_@" for c in unit):
        return ""
    if not unit.endswith(".service") and not unit.endswith(".timer") and not unit.endswith(".socket"):
        unit = f"{unit}.service"
    return unit


def _allowed_service_units() -> set[str]:
    """Allowlist: config.services + currently discoverable running units (same as GET list)."""
    units: list[str] = list(CFG.get("services") or [])
    if CFG.get("services_auto", True) or not units:
        for u in discover_running_services(limit=80):
            if u not in units:
                units.append(u)
    if not units:
        units = ["ssh", "cron", "docker", "nginx", "foxos"]
    out: set[str] = set()
    for u in units:
        n = _normalize_unit(u)
        if n:
            out.add(n)
            # also accept bare name without .service
            if n.endswith(".service"):
                out.add(n[:-8])
    return out


def _allowed_docker_names() -> set[str]:
    """Allowlist: names from docker ps -a only."""
    if not shutil.which("docker"):
        return set()
    code, out, _ = _run(
        ["docker", "ps", "-a", "--format", "{{.Names}}"],
        timeout=10,
    )
    if code != 0:
        return set()
    names: set[str] = set()
    for line in out.splitlines():
        name = line.strip()
        if name and all(c.isalnum() or c in "._-" for c in name):
            names.add(name)
    return names


@app.post("/api/services/control")
def api_services_control():
    """Start/stop/restart a systemd unit — allowlisted, fixed argv only."""
    if not CFG.get("allow_service_control", False):
        return jsonify({"error": "service control disabled (set allow_service_control in config)"}), 403
    if not shutil.which("systemctl"):
        return jsonify({"error": "systemctl not available"}), 501
    body = request.get_json(force=True, silent=True) or {}
    action = str(body.get("action") or "").strip().lower()
    if action not in ("start", "stop", "restart"):
        return jsonify({"error": "action must be start, stop, or restart"}), 400
    unit = _normalize_unit(str(body.get("unit") or body.get("name") or ""))
    if not unit:
        return jsonify({"error": "invalid unit name"}), 400
    allowed = _allowed_service_units()
    bare = unit[:-8] if unit.endswith(".service") else unit
    if unit not in allowed and bare not in allowed:
        return jsonify({"error": "unit not in allowlist"}), 403
    # Fixed argv — never shell=True, never client-supplied command strings
    code, out, err = _run(["systemctl", action, unit], timeout=30)
    ok = code == 0
    return jsonify({
        "ok": ok,
        "action": action,
        "unit": unit,
        "code": code,
        "stdout": (out or "").strip()[-2000:],
        "stderr": (err or "").strip()[-2000:],
        "error": None if ok else ((err or out or "systemctl failed").strip()[:500]),
    }), (200 if ok else 500)


@app.post("/api/docker/control")
def api_docker_control():
    """Start/stop/restart a Docker container — allowlisted names, fixed argv only."""
    if not CFG.get("allow_docker_control", False):
        return jsonify({"error": "docker control disabled (set allow_docker_control in config)"}), 403
    if not shutil.which("docker"):
        return jsonify({"error": "docker not installed"}), 501
    body = request.get_json(force=True, silent=True) or {}
    action = str(body.get("action") or "").strip().lower()
    if action not in ("start", "stop", "restart"):
        return jsonify({"error": "action must be start, stop, or restart"}), 400
    name = str(body.get("name") or body.get("container") or "").strip()
    if not name or not all(c.isalnum() or c in "._-" for c in name):
        return jsonify({"error": "invalid container name"}), 400
    if name not in _allowed_docker_names():
        return jsonify({"error": "container not in allowlist"}), 403
    code, out, err = _run(["docker", action, name], timeout=60)
    ok = code == 0
    return jsonify({
        "ok": ok,
        "action": action,
        "name": name,
        "code": code,
        "stdout": (out or "").strip()[-2000:],
        "stderr": (err or "").strip()[-2000:],
        "error": None if ok else ((err or out or "docker failed").strip()[:500]),
    }), (200 if ok else 500)


@app.get("/api/logs")
def api_logs():
    """Recent journal lines (read-only, capped)."""
    unit = (request.args.get("unit") or "").strip()
    n = min(int(request.args.get("n") or 80), 200)
    if not shutil.which("journalctl"):
        return jsonify({"lines": [], "error": "journalctl not available"})
    cmd = ["journalctl", "-n", str(n), "--no-pager", "-o", "short-iso"]
    # only allow safe unit names
    if unit:
        if not all(c.isalnum() or c in ".-_@" for c in unit):
            return jsonify({"error": "bad unit"}), 400
        if not unit.endswith(".service") and not unit.endswith(".timer"):
            unit = f"{unit}.service"
        cmd.extend(["-u", unit])
    code, out, err = _run(cmd, timeout=10)
    if code != 0:
        return jsonify({"lines": [], "error": err.strip() or "journalctl failed", "unit": unit or None})
    lines = out.splitlines()
    return jsonify({"lines": lines, "unit": unit or None, "count": len(lines)})


@app.get("/api/notes")
def api_notes_get():
    if not NOTES_PATH.exists():
        return jsonify({"notes": []})
    try:
        data = json.loads(NOTES_PATH.read_text(encoding="utf-8"))
        return jsonify({"notes": data if isinstance(data, list) else []})
    except (OSError, json.JSONDecodeError):
        return jsonify({"notes": []})


@app.post("/api/notes")
def api_notes_save():
    body = request.get_json(force=True, silent=True) or {}
    notes = body.get("notes")
    if not isinstance(notes, list):
        return jsonify({"error": "notes must be a list"}), 400
    # cap size
    clean = []
    for n in notes[:50]:
        if not isinstance(n, dict):
            continue
        clean.append({
            "id": str(n.get("id") or "")[:40],
            "title": str(n.get("title") or "Note")[:120],
            "body": str(n.get("body") or "")[:20000],
            "updated": int(n.get("updated") or time.time()),
        })
    try:
        NOTES_PATH.write_text(json.dumps(clean, indent=2), encoding="utf-8")
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "count": len(clean)})


@app.get("/api/files")
def api_files_list():
    root_id = request.args.get("root") or CFG.get("default_root", "home")
    rel = request.args.get("path") or ""
    try:
        path = resolve_safe(root_id, rel)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    if not path.is_dir():
        return jsonify({"error": "not a directory"}), 400

    base = roots_map()[root_id]
    entries = []
    try:
        for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            try:
                entries.append(file_entry(child, base))
            except OSError:
                continue
    except PermissionError:
        return jsonify({"error": "permission denied"}), 403

    crumbs = []
    if rel:
        acc = []
        for part in rel.replace("\\", "/").split("/"):
            if not part:
                continue
            acc.append(part)
            crumbs.append({"name": part, "path": "/".join(acc)})

    place = next((p for p in (_place_from_root(r) for r in CFG.get("roots", [])) if p["id"] == root_id), None)
    if place is None and root_id in _EPHEMERAL:
        place = {
            "id": root_id,
            "label": Path(_EPHEMERAL[root_id]).name,
            "kind": "network",
            "icon": "🖧",
        }
    usage = _disk_usage(path)
    return jsonify({
        "root": root_id,
        "root_label": (place or {}).get("label") or root_id,
        "root_kind": (place or {}).get("kind") or "local",
        "root_icon": (place or {}).get("icon") or "📁",
        "path": rel.replace("\\", "/"),
        "absolute": str(path),
        "writable": write_allowed(root_id) and os.access(path, os.W_OK),
        "crumbs": crumbs,
        "entries": entries,
        "usage": usage,
    })


@app.get("/api/files/read")
def api_files_read():
    root_id = request.args.get("root") or CFG.get("default_root", "home")
    rel = request.args.get("path") or ""
    try:
        path = resolve_safe(root_id, rel)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not path.is_file():
        return jsonify({"error": "not a file"}), 400
    if path.stat().st_size > 2_000_000:
        return jsonify({"error": "file too large to preview (>2MB)"}), 413
    mime, _ = mimetypes.guess_type(str(path))
    try:
        data = path.read_bytes()
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    # image preview as data url for small images
    if mime and mime.startswith("image/") and len(data) <= 1_500_000:
        import base64
        b64 = base64.b64encode(data).decode("ascii")
        return jsonify({
            "binary": False,
            "image": True,
            "size": len(data),
            "mime": mime,
            "name": path.name,
            "data_url": f"data:{mime};base64,{b64}",
        })
    if b"\x00" in data[:8000]:
        return jsonify({
            "binary": True,
            "size": len(data),
            "mime": mime or "application/octet-stream",
            "name": path.name,
        })
    text = data.decode("utf-8", errors="replace")
    return jsonify({
        "binary": False,
        "image": False,
        "size": len(data),
        "mime": mime or "text/plain",
        "name": path.name,
        "content": text,
    })


@app.get("/api/files/download")
def api_files_download():
    root_id = request.args.get("root") or CFG.get("default_root", "home")
    rel = request.args.get("path") or ""
    try:
        path = resolve_safe(root_id, rel)
    except ValueError:
        abort(400)
    if not path.is_file():
        abort(404)
    return send_file(path, as_attachment=True, download_name=path.name)


@app.post("/api/files/mkdir")
def api_mkdir():
    body = request.get_json(force=True, silent=True) or {}
    root_id = body.get("root") or CFG.get("default_root", "home")
    parent = body.get("path") or ""
    name = (body.get("name") or "").strip()
    if not name or "/" in name or name in (".", ".."):
        return jsonify({"error": "bad name"}), 400
    if not write_allowed(root_id):
        return jsonify({"error": "read-only root"}), 403
    try:
        base = resolve_safe(root_id, parent)
        target = resolve_safe(root_id, str(Path(parent) / name) if parent else name)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not base.is_dir():
        return jsonify({"error": "parent not a directory"}), 400
    try:
        target.mkdir(exist_ok=False)
    except FileExistsError:
        return jsonify({"error": "already exists"}), 409
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "path": str(target.relative_to(roots_map()[root_id]))})


@app.post("/api/files/rename")
def api_rename():
    body = request.get_json(force=True, silent=True) or {}
    root_id = body.get("root") or CFG.get("default_root", "home")
    rel = body.get("path") or ""
    new_name = (body.get("name") or "").strip()
    if not rel:
        return jsonify({"error": "path required"}), 400
    if not new_name or "/" in new_name or new_name in (".", ".."):
        return jsonify({"error": "bad name"}), 400
    if not write_allowed(root_id):
        return jsonify({"error": "read-only root"}), 403
    try:
        path = resolve_safe(root_id, rel)
        parent = path.parent
        dest = resolve_safe(root_id, str(Path(rel).parent / new_name) if "/" in rel else new_name)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if path == roots_map()[root_id]:
        return jsonify({"error": "cannot rename root"}), 400
    if dest.exists():
        return jsonify({"error": "target exists"}), 409
    try:
        path.rename(dest)
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "path": str(dest.relative_to(roots_map()[root_id]))})


@app.post("/api/files/delete")
def api_delete():
    """Delete a file/folder. Soft-deletes to trash by default when enabled.
    Pass permanent=true (or trash_enabled=false) for hard delete.
    """
    body = request.get_json(force=True, silent=True) or {}
    root_id = body.get("root") or CFG.get("default_root", "home")
    rel = body.get("path") or ""
    permanent = bool(body.get("permanent"))
    if not rel:
        return jsonify({"error": "cannot delete root"}), 400
    if not write_allowed(root_id):
        return jsonify({"error": "read-only root"}), 403
    try:
        if permanent or not trash_enabled():
            hard_delete_path(root_id, rel)
            return jsonify({"ok": True, "trashed": False})
        entry = soft_delete_to_trash(root_id, rel)
        return jsonify({"ok": True, "trashed": True, "item": entry})
    except PermissionError as e:
        return jsonify({"error": str(e)}), 403
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        return jsonify({"error": str(e)}), 500


@app.get("/api/trash")
def api_trash_list():
    if not trash_enabled():
        return jsonify({"enabled": False, "items": [], "count": 0, "total_size": 0})
    with _TRASH_LOCK:
        items = _load_trash_manifest()
        clean = []
        for it in items:
            try:
                store = _trash_store_path(str(it.get("store_name") or it.get("id") or ""))
            except ValueError:
                continue
            if store.exists():
                clean.append(it)
        clean = _enforce_trash_caps(clean)
        if clean != items:
            _save_trash_manifest(clean)
        total = sum(int(x.get("size") or 0) for x in clean)
        clean_sorted = sorted(clean, key=lambda x: int(x.get("deleted_at") or 0), reverse=True)
        return jsonify({
            "enabled": True,
            "items": [_public_trash_item(x) for x in clean_sorted],
            "count": len(clean_sorted),
            "total_size": total,
            "max_items": _trash_max_items(),
            "max_mb": CFG.get("trash_max_mb", 1024),
            "max_age_days": CFG.get("trash_max_age_days", 30),
        })


@app.post("/api/trash/restore")
def api_trash_restore():
    if not trash_enabled():
        return jsonify({"error": "trash disabled"}), 400
    body = request.get_json(force=True, silent=True) or {}
    item_id = (body.get("id") or "").strip()
    if not item_id:
        return jsonify({"error": "id required"}), 400
    with _TRASH_LOCK:
        items = _load_trash_manifest()
        entry = next((x for x in items if x.get("id") == item_id), None)
        if not entry:
            return jsonify({"error": "not found"}), 404
        root_id = entry.get("original_root") or ""
        rel = entry.get("original_path") or ""
        if not write_allowed(root_id):
            return jsonify({"error": "read-only root"}), 403
        try:
            store = _trash_store_path(str(entry.get("store_name") or item_id))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if not store.exists():
            items = [x for x in items if x.get("id") != item_id]
            _save_trash_manifest(items)
            return jsonify({"error": "trash payload missing"}), 404
        try:
            preferred = resolve_safe(root_id, rel)
            parent_rel = str(Path(rel).parent).replace("\\", "/")
            if parent_rel in (".", ""):
                parent = roots_map()[root_id]
            else:
                parent = resolve_safe(root_id, parent_rel)
            base = roots_map()[root_id]
            dest = _unique_restore_dest(parent, base, preferred)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if not parent.is_dir():
            return jsonify({"error": "original folder missing — recreate it or delete permanently"}), 409
        try:
            shutil.move(str(store), str(dest))
        except OSError as e:
            return jsonify({"error": str(e)}), 500
        items = [x for x in items if x.get("id") != item_id]
        _save_trash_manifest(items)
        out_rel = str(dest.relative_to(base)).replace("\\", "/")
        renamed = out_rel != rel.replace("\\", "/")
        return jsonify({
            "ok": True,
            "root": root_id,
            "path": out_rel,
            "renamed": renamed,
            "name": dest.name,
        })


@app.post("/api/trash/delete")
def api_trash_delete():
    """Permanently delete one trash item."""
    if not trash_enabled():
        return jsonify({"error": "trash disabled"}), 400
    body = request.get_json(force=True, silent=True) or {}
    item_id = (body.get("id") or "").strip()
    if not item_id:
        return jsonify({"error": "id required"}), 400
    with _TRASH_LOCK:
        items = _load_trash_manifest()
        entry = next((x for x in items if x.get("id") == item_id), None)
        if not entry:
            return jsonify({"error": "not found"}), 404
        _purge_trash_store(str(entry.get("store_name") or item_id))
        items = [x for x in items if x.get("id") != item_id]
        _save_trash_manifest(items)
        return jsonify({"ok": True})


@app.post("/api/trash/empty")
def api_trash_empty():
    """Permanently delete all trash items."""
    if not trash_enabled():
        return jsonify({"error": "trash disabled"}), 400
    with _TRASH_LOCK:
        items = _load_trash_manifest()
        for entry in items:
            _purge_trash_store(str(entry.get("store_name") or entry.get("id") or ""))
        _save_trash_manifest([])
        try:
            for child in TRASH_FILES.iterdir():
                try:
                    if child.is_dir():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
                except OSError:
                    continue
        except OSError:
            pass
        return jsonify({"ok": True, "removed": len(items)})



@app.post("/api/files/upload")
def api_upload():
    root_id = request.form.get("root") or CFG.get("default_root", "home")
    rel = request.form.get("path") or ""
    if not write_allowed(root_id):
        return jsonify({"error": "read-only root"}), 403
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "no file"}), 400
    name = Path(f.filename).name
    if not name or name in (".", ".."):
        return jsonify({"error": "bad filename"}), 400
    try:
        dest_dir = resolve_safe(root_id, rel)
        dest = resolve_safe(root_id, str(Path(rel) / name) if rel else name)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not dest_dir.is_dir():
        return jsonify({"error": "not a directory"}), 400
    try:
        f.save(dest)
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "name": name})




@app.get("/api/desktop")
def api_desktop_get():
    desk = load_desktop()
    wp = resolve_wallpaper()
    return jsonify({"ok": True, "desktop": desk, "wallpaper": wp})


@app.post("/api/desktop")
def api_desktop_set():
    """Update appearance overlay in data/desktop.json (never whole config.json)."""
    body = request.get_json(force=True, silent=True) or {}
    patch = {}
    if "show_widgets" in body:
        patch["show_widgets"] = bool(body.get("show_widgets"))
    if "icon_size" in body:
        size = str(body.get("icon_size") or "md").lower()
        if size not in ("sm", "md", "lg"):
            return jsonify({"error": "icon_size must be sm|md|lg"}), 400
        patch["icon_size"] = size
    if "accent" in body:
        accent = str(body.get("accent") or "").strip()
        if accent and not re.fullmatch(r"#[0-9A-Fa-f]{3,8}", accent):
            return jsonify({"error": "accent must be #hex"}), 400
        patch["accent"] = accent
    if not patch:
        return jsonify({"error": "no fields"}), 400
    desk = save_desktop(patch)
    return jsonify({"ok": True, "desktop": desk, "wallpaper": resolve_wallpaper()})


@app.get("/api/wallpaper/list")
def api_wallpaper_list():
    items = []
    for cand in ("wallpaper.default.svg", "wallpaper.png", "wallpaper.jpg", "wallpaper.webp"):
        path = STATIC / cand
        if path.is_file():
            items.append({
                "name": cand,
                "source": "static",
                "label": cand,
                "url": f"/api/wallpaper/file?source=static&name={cand}",
                "current": False,
            })
    try:
        for path in sorted(WALLPAPERS_DIR.iterdir(), key=lambda p: p.name.lower()):
            if not path.is_file():
                continue
            if path.suffix.lower() not in WALLPAPER_EXT:
                continue
            try:
                name = _safe_wallpaper_name(path.name)
            except ValueError:
                continue
            items.append({
                "name": name,
                "source": "data",
                "label": name,
                "url": f"/api/wallpaper/file?source=data&name={name}",
                "current": False,
            })
    except OSError:
        pass
    cur = resolve_wallpaper()
    for it in items:
        if it["name"] == cur.get("name") and it["source"] == cur.get("source"):
            it["current"] = True
    return jsonify({"items": items, "current": cur})


@app.get("/api/wallpaper/file")
def api_wallpaper_file():
    source = (request.args.get("source") or "static").strip()
    try:
        name = _safe_wallpaper_name(request.args.get("name") or "")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if source == "data":
        path = (WALLPAPERS_DIR / name).resolve()
        try:
            path.relative_to(WALLPAPERS_DIR.resolve())
        except ValueError:
            abort(400)
    else:
        path = (STATIC / name).resolve()
        try:
            path.relative_to(STATIC.resolve())
        except ValueError:
            abort(400)
    if not path.is_file():
        abort(404)
    return send_file(path)


@app.post("/api/wallpaper/upload")
def api_wallpaper_upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    try:
        name = _safe_wallpaper_name(Path(f.filename).name)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    WALLPAPERS_DIR.mkdir(parents=True, exist_ok=True)
    dest = WALLPAPERS_DIR / name
    # avoid overwrite collisions
    if dest.exists():
        stem, suf = dest.stem, dest.suffix
        for i in range(1, 1000):
            alt = WALLPAPERS_DIR / f"{stem}-{i}{suf}"
            if not alt.exists():
                dest = alt
                name = dest.name
                break
    try:
        f.save(str(dest))
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    desk = save_desktop({"wallpaper": name, "wallpaper_source": "data"})
    wp = resolve_wallpaper()
    return jsonify({"ok": True, "desktop": desk, "wallpaper": wp})


@app.post("/api/wallpaper/select")
def api_wallpaper_select():
    body = request.get_json(force=True, silent=True) or {}
    source = (body.get("source") or "static").strip()
    try:
        name = _safe_wallpaper_name(body.get("name") or "")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if source == "data":
        path = WALLPAPERS_DIR / name
    else:
        source = "static"
        path = STATIC / name
    if not path.is_file():
        return jsonify({"error": "not found"}), 404
    desk = save_desktop({"wallpaper": name, "wallpaper_source": source})
    return jsonify({"ok": True, "desktop": desk, "wallpaper": resolve_wallpaper()})


@app.post("/api/wallpaper/reset")
def api_wallpaper_reset():
    """Clear desktop wallpaper override → fall back to config/static default."""
    desk = save_desktop({"wallpaper": None, "wallpaper_source": "static"})
    return jsonify({"ok": True, "desktop": desk, "wallpaper": resolve_wallpaper()})


@app.post("/api/files/copy")
def api_files_copy():
    body = request.get_json(force=True, silent=True) or {}
    items = body.get("items")
    if not items:
        items = [{
            "root": body.get("src_root") or body.get("root"),
            "path": body.get("src_path") or body.get("path"),
        }]
    dest_root = body.get("dest_root") or body.get("root")
    dest_path = body.get("dest_path") if "dest_path" in body else body.get("dest") or ""
    if not dest_root:
        return jsonify({"error": "dest_root required"}), 400
    results = []
    errors = []
    for it in items:
        try:
            src_root = it.get("root") or body.get("src_root")
            src_path = it.get("path") or ""
            if not src_root or not src_path:
                raise ValueError("src root/path required")
            results.append(copy_path_safe(src_root, src_path, dest_root, dest_path or ""))
        except PermissionError as e:
            errors.append(str(e))
        except (ValueError, FileNotFoundError, OSError) as e:
            errors.append(str(e))
    if not results and errors:
        return jsonify({"error": errors[0], "errors": errors}), 400
    return jsonify({"ok": True, "results": results, "errors": errors})


@app.post("/api/files/move")
def api_files_move():
    body = request.get_json(force=True, silent=True) or {}
    items = body.get("items")
    if not items:
        items = [{
            "root": body.get("src_root") or body.get("root"),
            "path": body.get("src_path") or body.get("path"),
        }]
    dest_root = body.get("dest_root") or body.get("root")
    dest_path = body.get("dest_path") if "dest_path" in body else body.get("dest") or ""
    if not dest_root:
        return jsonify({"error": "dest_root required"}), 400
    results = []
    errors = []
    for it in items:
        try:
            src_root = it.get("root") or body.get("src_root")
            src_path = it.get("path") or ""
            if not src_root or not src_path:
                raise ValueError("src root/path required")
            results.append(move_path_safe(src_root, src_path, dest_root, dest_path or ""))
        except PermissionError as e:
            errors.append(str(e))
        except (ValueError, FileNotFoundError, OSError) as e:
            errors.append(str(e))
    if not results and errors:
        return jsonify({"error": errors[0], "errors": errors}), 400
    return jsonify({"ok": True, "results": results, "errors": errors})


@app.post("/api/files/delete-bulk")
def api_files_delete_bulk():
    body = request.get_json(force=True, silent=True) or {}
    root_id = body.get("root") or CFG.get("default_root", "home")
    paths = body.get("paths") or []
    permanent = bool(body.get("permanent"))
    if not isinstance(paths, list) or not paths:
        return jsonify({"error": "paths required"}), 400
    if not write_allowed(root_id):
        return jsonify({"error": "read-only root"}), 403
    results = []
    errors = []
    for rel in paths:
        rel = (rel or "").strip()
        if not rel:
            errors.append("empty path")
            continue
        try:
            if permanent or not trash_enabled():
                hard_delete_path(root_id, rel)
                results.append({"path": rel, "trashed": False})
            else:
                entry = soft_delete_to_trash(root_id, rel)
                results.append({"path": rel, "trashed": True, "item": entry})
        except Exception as e:
            errors.append(f"{rel}: {e}")
    if not results and errors:
        return jsonify({"error": errors[0], "errors": errors}), 400
    return jsonify({"ok": True, "results": results, "errors": errors})


@app.post("/api/files/zip")
def api_files_zip():
    """Zip selected files (same root) and download. Paths validated via resolve_safe."""
    body = request.get_json(force=True, silent=True) or {}
    root_id = body.get("root") or CFG.get("default_root", "home")
    paths = body.get("paths") or []
    if not isinstance(paths, list) or not paths:
        return jsonify({"error": "paths required"}), 400
    if len(paths) > 100:
        return jsonify({"error": "too many files (max 100)"}), 400
    base = roots_map().get(root_id)
    if not base:
        return jsonify({"error": "unknown root"}), 400
    resolved = []
    for rel in paths:
        try:
            path = resolve_safe(root_id, rel or "")
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if not path.exists():
            return jsonify({"error": f"not found: {rel}"}), 404
        if path.is_dir():
            return jsonify({"error": "zip of folders not supported — pick files"}), 400
        if path.stat().st_size > 200 * 1024 * 1024:
            return jsonify({"error": f"file too large to zip: {path.name}"}), 413
        resolved.append(path)
    tmp = tempfile.NamedTemporaryFile(prefix="foxos-zip-", suffix=".zip", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in resolved:
                arc = path.name
                # disambiguate duplicate basenames
                if arc in zf.namelist():
                    arc = f"{path.stem}-{uuid.uuid4().hex[:6]}{path.suffix}"
                zf.write(path, arcname=arc)
        @after_this_request
        def _cleanup(resp):
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            return resp
        return send_file(
            tmp_path,
            as_attachment=True,
            download_name="foxos-files.zip",
            mimetype="application/zip",
        )
    except OSError as e:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        return jsonify({"error": str(e)}), 500




@app.get("/api/terminal")
def api_terminal_status():
    """Terminal enablement + WS proxy hints. 403 when allow_terminal is false."""
    if not CFG.get("allow_terminal", False):
        return jsonify({
            "error": "terminal disabled (allow_terminal=false)",
            "hint": "Set allow_terminal=true in config.json and restart Fox OS. "
                    "Proxy /ws/terminal to 127.0.0.1:<terminal_ws_port> (WebSocket upgrade).",
            "allow_terminal": False,
        }), 403
    port = int(CFG.get("terminal_ws_port") or 8766)
    return jsonify({
        "ok": True,
        "allow_terminal": True,
        "ws_path": "/ws/terminal",
        "listen": f"127.0.0.1:{port}",
        "shell": os.environ.get("SHELL") or "/bin/bash",
        "user": pwd.getpwuid(os.getuid()).pw_name,
    })


@app.post("/api/browser/open")
def api_browser_open():
    """Opt-in: open http(s) URL in system Chromium on the server display.
    Fixed argv only; never shell; never client-supplied argv beyond URL.
    """
    if not CFG.get("allow_system_browser", False):
        return jsonify({"error": "system browser disabled (allow_system_browser=false)"}), 403
    body = request.get_json(force=True, silent=True) or {}
    try:
        url = _sanitize_http_url(body.get("url") or "")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    binary = _find_system_browser()
    if not binary:
        return jsonify({"error": "no chromium/chrome binary found on PATH"}), 404
    argv = [binary, "--new-window", url]
    try:
        # Detach from request worker; do not wait.
        subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "binary": Path(binary).name, "url": url})



@app.errorhandler(413)
def _too_large(_err):
    mb = CFG.get("max_upload_mb", 512)
    return jsonify({"error": f"file too large (max {mb} MB)"}), 413


def main():
    host = CFG.get("host", "127.0.0.1")
    port = int(CFG.get("port", 8765))
    threads = int(CFG.get("threads") or 8)
    print(f"Fox OS v{VERSION} on http://{host}:{port} (waitress, threads={threads})")

    # Waitress cannot terminate WebSockets — optional side listener for PTY terminal.
    if CFG.get("allow_terminal", False):
        try:
            from terminal_ws import start_terminal_ws
            ws_port = int(CFG.get("terminal_ws_port") or 8766)
            ok = start_terminal_ws(
                host="127.0.0.1",
                port=ws_port,
                allow_check=lambda: bool(CFG.get("allow_terminal", False)),
            )
            if ok:
                print(f"Terminal PTY WebSocket on ws://127.0.0.1:{ws_port} — proxy /ws/terminal → there")
            else:
                print("WARNING: allow_terminal=true but terminal WebSocket failed to start (is websockets installed?)")
        except Exception as e:
            print(f"WARNING: terminal WebSocket not started: {e}")
    else:
        print("Terminal PTY disabled (allow_terminal=false)")

    try:
        from waitress import serve
    except ImportError:
        # Dev fallback only — production installs should include waitress (requirements.txt)
        print("WARNING: waitress not installed; falling back to Flask dev server (not for production)")
        app.run(host=host, port=port, threaded=True)
        return
    serve(app, host=host, port=port, threads=threads, ident="FoxOS")


if __name__ == "__main__":
    main()
