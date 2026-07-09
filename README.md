# Fox OS

**Clickable web desktop for headless Linux servers.**

Browse files, watch live system stats, list installed programs, check Docker/systemd, tail logs, and open bookmarked services — from any browser. Win 3.1 energy, no full desktop environment required.

Inspired by Cockpit, CasaOS, and classic File Explorer.

![License: MIT](https://img.shields.io/badge/license-MIT-blue)

## Features

| App | Description |
|-----|-------------|
| **File Explorer** | Windows-style browser with This PC / Network, multi-root jails |
| **System** | Live CPU %, RAM, swap, load, temp (if available), disks |
| **Programs** | FreeDesktop `.desktop` apps, PATH tools, Docker containers, config links |
| **Processes** | Top processes by memory |
| **Docker** | Container list (read-only) when Docker is installed |
| **Services** | systemd unit status (config list and/or auto-discovered) |
| **Network** | Interfaces, addresses, listening ports |
| **Logs** | `journalctl` tail by unit |
| **Launcher** | Bookmark tiles from config |
| **Notes / Calculator** | Desktop utilities |

Safety first: path jail under configured roots, optional writes, **no arbitrary command execution** from the web UI.

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
| `apps` | Extra desktop icons (or override builtins by `id`) |
| `services` | systemd unit names to always show |
| `services_auto` | Also list running units (default `true`) |
| `discover_desktop_apps` | Scan `/usr/share/applications` etc. (default `true`) |
| `discover_docker` | Include `docker ps` in Programs (default `true`) |
| `embed_map` | Optional: map hostnames → `/embed/<key>/` for same-origin iframes |
| `wallpaper` | Filename under `static/` (optional) |

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

## Programs discovery

`GET /api/programs` returns:

1. **desktop** — FreeDesktop `.desktop` files (Name, Exec, categories; no remote exec)
2. **cli** — Common tools if found on `PATH` (python3, docker, git, …)
3. **docker** — containers when Docker CLI is available
4. **links** — your `config.json` bookmarks

This is intentionally inventory-oriented: listing is safe from a browser; running arbitrary binaries over HTTP is not.

## API sketch

| Endpoint | Notes |
|----------|--------|
| `/api/health` | Liveness |
| `/api/config` | UI bootstrap |
| `/api/system` | Live host metrics + distro |
| `/api/programs` | Installed / discovered software |
| `/api/processes` | Process table |
| `/api/services` | systemd |
| `/api/docker` | containers |
| `/api/network` | interfaces / listeners |
| `/api/logs` | journalctl |
| `/api/files*` | jails file browser |
| `/api/places` | This PC / Network places |
| `/api/notes` | sticky notes store |

## Wallpaper

- Drop `static/wallpaper.png` (or set `wallpaper` in config)
- Display uses **`object-fit: cover`** + **center** — no stretch/squash
- Repo ships `static/wallpaper.default.svg` as a generic fallback you can copy

```bash
cp static/wallpaper.default.svg static/wallpaper.png   # or use your own PNG/JPG
```

## Security notes

- Prefer `host: 127.0.0.1` + reverse proxy + auth (Authelia, Basic Auth, VPN, …)
- Limit `write_roots`
- Do not expose write-enabled Fox OS to the public internet without auth
- File APIs reject path traversal outside configured roots

## Reverse proxy (nginx sketch)

```nginx
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Optional same-origin embeds for other apps live under your proxy as `/embed/<name>/` — configure `embed_map` if you use that pattern.

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
