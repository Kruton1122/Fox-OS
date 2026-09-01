# Fox OS

**Clickable web desktop for headless Linux servers.**

Browse files, watch live system stats, list installed programs, check Docker/systemd, tail logs, and open bookmarked services — from any browser. Win 3.1 energy, no full desktop environment required.

Inspired by Cockpit, CasaOS, and classic File Explorer.

![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Changelog](CHANGELOG.md) · [Releases](https://github.com/Kruton1122/Fox-OS/releases)

## Features

| App | Description |
|-----|-------------|
| **File Explorer** | This PC / Network, multi-select, DnD copy/move, cut/copy/paste, zip download, multi-root jails |
| **System** | Live CPU %, RAM, swap, load, temp (if available), disks |
| **Programs** | FreeDesktop `.desktop` apps, PATH tools, Docker containers, config links |
| **Processes** | Top processes by memory |
| **Docker** | Container list; optional start/stop/restart when enabled |
| **Services** | systemd unit status; optional start/stop/restart when enabled |
| **Network** | Interfaces, addresses, listening ports |
| **Logs** | `journalctl` tail by unit |
| **Launcher** | Bookmark tiles from config |
| **Notes / Calculator** | Desktop utilities |
| **Recycle Bin** | Soft-delete trash with restore / empty; size & age caps (`trash_max_mb`, `trash_max_age_days`) |
| **Browser** | In-desktop iframe browser (address bar + nav); optional server Chromium via `allow_system_browser` |
| **Terminal** | In-app PTY via xterm.js + WebSocket (`allow_terminal`, default off) |
| **Desktop chrome** | Resizable windows, snap, Start search, taskbar previews/grouping, session restore, wallpaper Settings |

Safety first: path jail under configured roots, optional writes, **no arbitrary command execution** from the web UI. Service/Docker controls (when enabled) use fixed argv + strict allowlists only.

## Requirements

- Linux (uses `/proc`, `systemctl`, optional Docker)
- Python 3.10+
- Flask 3.x

Works on Raspberry Pi, VPS, mini PCs, home servers — anything headless you can SSH into.

## Quick start

```bash
git clone https://github.com/Kruton1122/Fox-OS.git
cd foxos
python3 -m venv .venv && source .venv/bin/activate   # optional
pip install -r requirements.txt

cp config.example.json config.json
# edit config.json — roots, links, services

python3 server.py
# → http://127.0.0.1:8765/
```

Put it behind your reverse proxy (Caddy, nginx, Nginx Proxy Manager, Traefik) with TLS for LAN/WAN use.

### Systemd

```bash
# edit foxos.service.example → install path + user
sudo cp foxos.service.example /etc/systemd/system/foxos.service
sudo systemctl daemon-reload
sudo systemctl enable --now foxos
```

## Configuration (`config.json`)

Copy from `config.example.json`. Important keys:

| Key | Purpose |
|-----|---------|
| `host` / `port` | Bind address (`127.0.0.1` recommended behind a proxy) |
| `roots` | Places File Explorer can browse (`path` supports `~`) |
| `write_roots` | Which root ids allow upload/mkdir/delete |
| `links` | Launcher / Programs bookmarks (`url`, `icon`, `group`) |
| `apps` | Extra desktop icons (or override builtins by `id`) — see below |
| `services` | systemd unit names to always show |
| `services_auto` | Also list running units (default `true`) |
| `allow_service_control` | Allow web UI start/stop/restart of allowlisted units (default **`false`**) |
| `allow_docker_control` | Allow web UI start/stop/restart of containers from `docker ps` (default **`false`**) |
| `discover_desktop_apps` | Scan `/usr/share/applications` etc. (default `true`) |
| `discover_docker` | Include `docker ps` in Programs (default `true`) |
| `embed_map` | Optional: map hostnames → `/embed/<key>/` for same-origin iframes |
| `wallpaper` | Filename under `static/` (optional) |
| `trash_enabled` | Soft-delete to Recycle Bin (default **`true`**) |
| `trash_max_mb` | Cap trash storage in megabytes (default `1024`; `0` = unlimited) |
| `trash_max_age_days` | Auto-purge trash older than N days (default `30`; `0` = unlimited) |
| `trash_max_items` | Max trash entries before oldest are dropped (default `200`) |
| `allow_system_browser` | Allow `POST /api/browser/open` to launch Chromium on the **server** display (default **`false`**) |
| `allow_terminal` | Enable in-app PTY Terminal (xterm.js ↔ WebSocket). Default **`false`** — shell runs as the Fox OS process user |
| `terminal_ws_port` | Localhost-only side WebSocket port for the PTY (default `8766`; Waitress cannot do WS) |
| `terminal_embed` / `terminal_url` | **Deprecated** (Wetty-era). Ignored by the Terminal app; safe to leave empty |

Appearance overlays (wallpaper choice, widgets, icon size, accent) live in **`data/desktop.json`** (gitignored) and merge into `/api/config` — they do not rewrite `config.json`.

**Machine-specific** data (your paths, hostnames, personal wallpaper) stays in `config.json` and is **gitignored**.

### Example: file roots

```json
"roots": [
  { "id": "home", "label": "Home", "path": "~", "kind": "local" },
  { "id": "data", "label": "Data", "path": "/mnt/data", "kind": "local" },
  { "id": "nas", "label": "NAS", "path": "/mnt/nas", "kind": "network", "icon": "🖧" }
]
```

### Example: bookmarks

```json
"links": [
  { "id": "grafana", "label": "Grafana", "url": "https://grafana.example.com/", "icon": "📈", "group": "Monitor" }
]
```

### Apps extension (light hook)

`apps` merges with builtins by `id`. Each entry can:

| Field | Effect |
|-------|--------|
| `action` | Open a built-in app id (`files`, `trash`, `system`, `docker`, …) |
| `url` | Open inside a Fox OS window (iframe). Prefer same-origin `/embed/...` or a host listed in `embed_map` |
| `embed` | Alias for `url` when you want an explicit embed target |
| `label` / `icon` / `desc` | Desktop + Start menu chrome |

```json
"apps": [
  { "id": "files", "label": "My Files" },
  {
    "id": "grafana-desk",
    "label": "Grafana",
    "icon": "📈",
    "desc": "Metrics",
    "url": "https://grafana.example.com/"
  },
  {
    "id": "status-embed",
    "label": "Status",
    "icon": "📡",
    "embed": "/embed/status/"
  }
]
```

There is no plugin runtime — just config-driven icons that open builtins or embed URLs.

## Programs discovery

`GET /api/programs` returns:

1. **desktop** — FreeDesktop `.desktop` files (Name, Exec, categories; no remote exec)
2. **cli** — Common tools if found on `PATH` (python3, docker, git, …)
3. **docker** — containers when Docker CLI is available
4. **links** — your `config.json` bookmarks

This is intentionally inventory-oriented: listing is safe from a browser; running arbitrary binaries over HTTP is not.

## Service & Docker controls (opt-in)

Disabled by default. When enabled:

- **Services:** `POST /api/services/control` with `{ "action": "start"|"stop"|"restart", "unit": "nginx" }`
- **Docker:** `POST /api/docker/control` with `{ "action": "start"|"stop"|"restart", "name": "mycontainer" }`

Rules:

- Only units from `config.services` plus the discovered running list (same inventory as GET)
- Only container **names** currently returned by `docker ps -a`
- Fixed argv only (`systemctl start UNIT`, `docker restart NAME`) — never `shell=True`, never client-supplied command strings
- UI shows confirm dialogs; buttons stay disabled with a muted hint when flags are false

Enable in your private `config.json` (not committed):

```json
"allow_service_control": true,
"allow_docker_control": true
```

Restart Fox OS after changing these flags. Prefer reverse-proxy auth before turning controls on.

## API sketch

| Endpoint | Notes |
|----------|--------|
| `/api/health` | Liveness |
| `/api/config` | UI bootstrap |
| `/api/system` | Live host metrics + distro |
| `/api/programs` | Installed / discovered software |
| `/api/processes` | Process table |
| `/api/services` | systemd |
| `/api/services/control` | POST start/stop/restart (opt-in) |
| `/api/docker` | containers |
| `/api/docker/control` | POST start/stop/restart (opt-in) |
| `/api/network` | interfaces / listeners |
| `/api/logs` | journalctl |
| `/api/files*` | jails file browser (delete soft-trashes by default; copy/move/zip/bulk-delete) |
| `/api/trash*` | Recycle Bin list / restore / permanent delete / empty |
| `/api/places` | This PC / Network places |
| `/api/notes` | sticky notes store |
| `/api/desktop` | GET/POST appearance overlay (`data/desktop.json`) |
| `/api/wallpaper*` | list / upload / select / reset / file |
| `/api/browser/open` | POST opt-in system Chromium (fixed argv) |

## Wallpaper

- Default: drop `static/wallpaper.png` (or set `wallpaper` in config)
- **Settings → Wallpaper**: upload png/jpg/webp/svg into `data/wallpapers/`, select, or reset
- Preference stored in `data/desktop.json` (overlay); apply without editing `config.json`
- Display uses **`object-fit: cover`** + **center** — no stretch/squash
- Repo ships `static/wallpaper.default.svg` as a generic fallback

```bash
cp static/wallpaper.default.svg static/wallpaper.png   # or use your own PNG/JPG
```

## Mobile

Fox OS switches to an Android/iOS-style launcher shell on phones and tablets — same backend, same APIs, just different chrome.

- **Detection**: `matchMedia('(max-width: 768px), (pointer: coarse)')`, applied as `body.mobile` (and `<html data-layout="mobile">`), re-evaluated on resize/orientation change.
- **Override**: **Settings → Layout → Layout mode** — Auto-detect / Force mobile / Force desktop, stored client-side in `localStorage` (no `config.json` change, no restart needed).
- **Home screen**: desktop icons become a full-screen tap-to-open app grid, with a top status bar (clock, hostname, compact CPU/RAM) and a bottom dock (Home, Files, System, Terminal, More).
- **Apps open as full-screen sheets** (rounded top, docked between the status bar and bottom nav) instead of floating windows — swipe down the title bar, or tap close, to dismiss.
- **More** opens the same Start menu / search as desktop, restyled as a full-screen drawer.
- **Home** (long-press or right-click) shows **Recents** — jump back to, or close, open sheets.
- File Explorer, toolbars, context menus, and Settings get larger touch targets (≥44px), horizontally-scrolling toolbars, and a hidden sidebar/details pane; rows open on a single tap instead of double-click.
- Respects notches / safe areas via `env(safe-area-inset-*)`; Terminal (xterm.js PTY) and Browser remain fully usable full-screen.
- Purely a **frontend rebuild of chrome** — no new endpoints, no changes to the path jail, trash, auth model, or `config.json` secrets. Desktop mode (mouse + wide viewport) is unchanged.

## Browser & Terminal

- **Browser** app embeds pages in an iframe. Sites that send `X-Frame-Options` / CSP `frame-ancestors` show a friendly fallback with **Open externally**.
- **System Chromium** (optional): set `"allow_system_browser": true` in private `config.json`. Fox OS resolves `chromium` / `chromium-browser` / `google-chrome` via `PATH` and runs fixed argv `--new-window <url>`. Useful on a Pi kiosk **server display**; remote users should use the iframe Browser.
- **Terminal** app is a proper **PTY passthrough** (vendored **xterm.js** + fit addon), **not Wetty** and not an iframe to wetty.home.
  - Set `"allow_terminal": true` in private `config.json` (default **false**).
  - On start, Fox OS opens a **localhost-only** WebSocket listener on `terminal_ws_port` (default `8766`) because **Waitress does not support WebSockets**.
  - Reverse-proxy `/ws/terminal` (or `/foxos/ws/terminal` under a subpath) with Upgrade headers to `http://127.0.0.1:8766/` — see `nginx-foxos.conf`.
  - Each session runs `$SHELL` or `/bin/bash` as the Fox OS process user; resize uses `TIOCSWINSZ`.
  - `GET /api/terminal` returns status, or **403** when disabled.
  - Deprecated keys `terminal_embed` / `terminal_url` remain in the example config for compatibility but are ignored by the Terminal app.

## Security notes

- Prefer `host: 127.0.0.1` + reverse proxy + auth (Authelia, Basic Auth, VPN, …)
- Limit `write_roots`
- Keep `allow_service_control` / `allow_docker_control` **false** unless you trust every browser client that can reach Fox OS
- Keep **`allow_terminal` false** unless you trust every browser client that can reach Fox OS — it is a full interactive shell as the Fox OS user
- Do not expose write-enabled (or control-enabled / terminal-enabled) Fox OS to the public internet without auth
- File APIs reject path traversal outside configured roots
- Control APIs reject unknown units/containers and never run arbitrary shell
- `allow_system_browser` stays false unless you intend kiosk Chromium on the server display
- Terminal WebSocket binds **127.0.0.1 only**; never publish `terminal_ws_port` directly to the LAN/WAN

## Reverse proxy (nginx sketch)

```nginx
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# When allow_terminal=true — WebSocket upgrade to the side PTY listener
location /ws/terminal {
    proxy_pass http://127.0.0.1:8766/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

Optional same-origin embeds for other apps live under your proxy as `/embed/<name>/` — configure `embed_map` if you use that pattern. Nginx Proxy Manager: add a custom location for `/ws/terminal` (or `/foxos/ws/terminal`) with WebSockets enabled to `127.0.0.1:8766`.

## Project layout

```
foxos/
  server.py              # Flask backend
  config.example.json    # Template (committed)
  config.json            # Your machine (gitignored)
  requirements.txt
  foxos.service.example
  static/                # UI
  data/                  # runtime (notes, …)
  LICENSE
  README.md
```

## Development

```bash
python3 server.py
# edit static/* — bump ?v= query in index.html when testing caches
```

## License

MIT — see [LICENSE](LICENSE).

## Credits

Built for people who run headless boxes and still want a mouse-friendly panel. Not affiliated with Firefox or any commercial “Fox” product.
