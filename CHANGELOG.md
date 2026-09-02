# Changelog

All notable changes to Fox OS are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/).

## [3.4.0] — 2026-09-01

Themes: four selectable looks for the whole shell, switchable live from Settings.

### Added

- **Theme system** — CSS-variable-driven, applied via `<html data-theme="…">`; loaded from `static/themes.css` (kept separate from `static/style.css`, which still defines the **Classic** baseline directly in `:root`). Covers windows, titlebars, taskbar, Start menu, context menus, buttons, boot screen, and the mobile status bar/dock.
- **Classic** — the original Win 3.1/98 chrome, unchanged, still the default for existing users.
- **Modern** — a new flat, light shell: soft shadows, rounded corners, indigo accent, system-ui typography.
- **Liquid Glass** — frosted translucency (`backdrop-filter: blur()`) on windows, taskbar, Start menu, and context menus, with a specular highlight streak on titlebars; degrades to a solid near-opaque panel via `@supports` when `backdrop-filter` isn't available.
- **Frutiger Aero** — glossy blue/aqua gradients, skeuomorphic gloss highlight on titlebars, 2000s-web nostalgia — CSS-only, no image assets.
- **Settings → Theme** — swatch picker with name + blurb per theme; switching applies instantly, no reload.
- Theme choice persists in `localStorage` (`foxos.theme.v1`) for instant apply on load (set before first paint to avoid a flash of the wrong theme), and best-effort syncs to the `data/desktop.json` appearance overlay (new `theme` field, validated server-side) via `POST /api/desktop` so a fresh browser on the same server picks up the last-chosen theme.

### Changed

- Version bumped to **3.4.0**; static asset cache busters (`?v=340`).
- A handful of previously-hardcoded chrome colors (context-menu hover, task tab counter, active titlebar gradient, tray meters, Start search, Settings theme cards) now reference CSS variables (`--sel`, `--title`/`--title2`, `--text`, `--panel-*`) instead of literal hex — Classic values stay in `:root` so the default look is unchanged.
- Titlebars gain `--title-fg` / `--title-fg-inactive` so Modern / Liquid Glass / Frutiger Aero inactive windows keep readable contrast (white-on-light was a miss); gloss `::after` overlays stack *behind* title text and window controls.
- Classic is applied by *omitting* `<html data-theme>` (the `:root` default). The other three set `data-theme`; invalid `localStorage` values fall back to Classic.
- No backend/API changes beyond the new optional `theme` field on `/api/desktop` (GET/POST) and `/api/config`; wallpaper, mobile detection, trash, and the PTY terminal are untouched.

## [3.3.0] — 2026-09-01

Mobile shell: Android/iOS-style launcher chrome for phones and tablets, alongside the unchanged desktop.

### Added

- **Mobile layout detection** — `body.mobile` (+ `<html data-layout>`) toggles automatically via `matchMedia('(max-width: 768px), (pointer: coarse)')`, live-updated on resize/orientation change. **Settings → Layout** adds an override select (Auto-detect / Force mobile / Force desktop) stored in `localStorage` — no server round-trip, no config.json changes.
- **Home screen** — desktop icon grid restyles into a full-screen app grid (44px+ touch targets) between a top status bar and bottom dock; single tap opens apps in mobile mode (desktop keeps double-click / drag).
- **Status bar** — fixed top bar with clock, hostname, compact CPU/RAM, safe-area aware (`env(safe-area-inset-*)`).
- **Bottom dock** — iOS-style tab bar: Home, Files, System, Terminal, More (app drawer). Long-press / right-click Home for a **Recents** menu (jump to or close open windows).
- **Full-screen app sheets** — windows become edge-to-edge sheets on mobile (rounded top, docked between status bar and bottom nav) instead of floating Win 3.1 windows; minimize/maximize controls hidden, resize handles disabled. **Swipe down on the title bar** (or the close button) dismisses a sheet.
- **App drawer** — Start menu is reused and restyled as a full-screen search sheet on mobile (same data/search logic as desktop); opened from the dock's "More" button.
- File Explorer, context menus, toolbars, Settings, and Calculator get mobile-specific sizing (44px+ rows/buttons, horizontally-scrolling toolbars, hidden sidebar/details pane, single-tap-to-open rows and "This PC" tiles) — purely cosmetic; same `/api/files*` calls as desktop.
- `viewport` meta gains `maximum-scale=1`; added `mobile-web-app-capable` / `apple-mobile-web-app-*` meta tags (home-screen install polish, no new permissions).

### Changed

- Version bumped to **3.3.0**; static asset cache busters (`?v=330`).
- No backend/API changes — mobile shell is a client-side rebuild of chrome only. Desktop layout, PTY terminal, trash, auth model, and `config.json` handling are untouched.

## [3.2.0] — 2026-09-01

Desktop plus: Explorer power features, wallpaper & Settings, Browser + Terminal apps.

### Added

- **Explorer multi-select** — Ctrl/Cmd click and Shift click; bulk Move to Recycle Bin / permanent delete; multi-file download zip (`POST /api/files/zip`, `POST /api/files/delete-bulk`). Every path still passes `resolve_safe` / `write_allowed`.
- **Drag-and-drop** copy/move between Explorer folders (Ctrl/Alt = copy). Server endpoints `POST /api/files/copy` and `POST /api/files/move` with jail checks on both ends.
- **File clipboard** — Cut / Copy / Paste inside Explorer (internal clipboard; paste uses copy or move APIs).
- **Taskbar previews / grouping** — hover title preview; click cycles same-app windows when grouped.
- **Persistent window session** — open windows (id/app/pos/size/url) restored from `localStorage` after refresh.
- **Wallpaper Settings** — list / upload (png/jpg/webp/svg) / select / reset. Uploads in `data/wallpapers/` (gitignored). Preference overlay in `data/desktop.json` (not whole `config.json`). Served via `/api/wallpaper/*`; merged into `/api/config`.
- **Appearance** — show widgets, icon size, optional accent/titlebar color (CSS variables) persisted in `data/desktop.json`.
- **Browser app** — in-Fox-OS window with address bar + nav; friendly message when iframe blocked + Open externally. Opt-in **system Chromium** via `allow_system_browser` (default **false**) and `POST /api/browser/open` (fixed argv, http(s) URL only).
- **Terminal app** — proper **PTY passthrough** with vendored **xterm.js** (+ fit addon) and a localhost WebSocket side listener (`terminal_ws.py`). Opt-in via `allow_terminal` (default **false**). **Not Wetty** / not an iframe to wetty.home.

### Changed

- Version bumped to **3.2.0**; static asset cache busters (`?v=321` after Terminal PTY patch).
- Settings expanded beyond read-only feature list (wallpaper, appearance, status, session controls). Service/Docker control flags remain **status-only** in the UI.
- Terminal plan changed from Wetty embed to in-app PTY; `terminal_embed` / `terminal_url` deprecated.
- `config.example.json` documents `allow_system_browser`, `allow_terminal`, `terminal_ws_port`.

### Security

- System browser launch never accepts client argv beyond a sanitized http(s) URL; binary resolved via `shutil.which` allowlist; flag default false.
- Terminal PTY (`allow_terminal`) default **false**; WebSocket listener binds **127.0.0.1 only**; `GET /api/terminal` returns **403** when disabled.
- File copy/move/zip/bulk-delete validate every path with `resolve_safe`; writes require `write_allowed`.

## [3.1.1] — 2026-09-01

Desktop polish: Recycle Bin, Start menu search, window snap.

### Added

- **Recycle Bin / Trash** — Explorer soft-deletes into `data/trash/` with a JSON manifest (`id`, original root/path, name, deleted_at, size, is_dir). Soft delete still requires `write_allowed` for that root. Caps via `trash_max_mb` (default 1024), `trash_max_age_days` (default 30), and `trash_max_items` (default 200). Permanent delete via context menu / Shift+Delete with confirm. New Recycle Bin app: list, Restore (auto-renames on collision), Empty / permanently delete. APIs under `/api/trash*` (path-jail safe, no shell). `trash_enabled` default **true** in `config.example.json`.
- **Start menu search** — filter apps, bookmarks, and builtins client-side; focus when Start opens; Esc clears the query then closes the menu.
- **Window snap** — drag titlebar to left/right edges (or top to maximize); keyboard `Ctrl+Alt+←/→/↑/↓` (↓ restores). Client-only.

### Changed

- Version bumped to **3.1.1**; static asset cache busters (`?v=311`).

## [3.1.0] — 2026-09-01

Desktop-feel pass: window manager polish, richer Explorer, opt-in service/Docker controls.

### Added

- Resizable windows (edge and corner handles) with improved maximize/restore.
- Classic right-click context menus on desktop icons and File Explorer rows (Open, Preview, Download, Rename, Delete, New folder, Refresh).
- Ctrl+Tab / Ctrl+Shift+Tab window cycling; Esc closes Start menu and context menus.
- Desktop icon position persistence (`localStorage`).
- Safer Markdown preview for `.md` files; monospace preview for common code extensions; click-to-zoom images.
- Folder filter box in File Explorer.
- Opt-in systemd start/stop/restart via `allow_service_control` (default **false**); allowlisted units only, fixed `systemctl` argv.
- Opt-in Docker start/stop/restart via `allow_docker_control` (default **false**); names from `docker ps` only, fixed `docker` argv.
- Tray polish: temperature when available, clearer CPU/RAM meters, disk free snippet.
- Clearer config `apps` hook for `url` / `embed` / built-in actions (documented in README).

### Changed

- Version bumped to **3.1.0**; static asset cache busters (`?v=310`).
- README security notes expanded for service/Docker controls.

### Security

- Service and Docker control endpoints reject free-form commands; require config flags; enforce allowlists; never use `shell=True`.

## [3.0.1] — 2026-07-09

### Added

- Upload size cap (`max_upload_mb`).
- Waitress WSGI server (replacing Flask development server).
- Security headers (`X-Frame-Options`, `nosniff`).

### Fixed

- Thread-safety around CPU percent and ephemeral mount listing.

## [3.0.0] — 2026-07-09

Initial public release: portable Flask + static web desktop for headless Linux.

### Added

- Windowed desktop UI (Start menu, taskbar, tray, wallpaper).
- File Explorer with multi-root path jail and optional writes.
- System, Processes, Network, Services, Docker, Logs, Programs, Launcher, Notes, Calculator apps.
- `config.example.json` template; machine-local `config.json` gitignored.
- systemd unit example and reverse-proxy notes.

[3.4.0]: https://github.com/Kruton1122/Fox-OS/compare/v3.3.0...HEAD
[3.3.0]: https://github.com/Kruton1122/Fox-OS/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/Kruton1122/Fox-OS/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/Kruton1122/Fox-OS/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/Kruton1122/Fox-OS/compare/v3.0.1...v3.1.0
[3.0.1]: https://github.com/Kruton1122/Fox-OS/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/Kruton1122/Fox-OS/releases/tag/v3.0.0
