# Changelog

All notable changes to Fox OS are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/).

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

[3.1.0]: https://github.com/Kruton1122/Fox-OS/compare/v3.0.1...v3.1.0
[3.0.1]: https://github.com/Kruton1122/Fox-OS/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/Kruton1122/Fox-OS/releases/tag/v3.0.0
