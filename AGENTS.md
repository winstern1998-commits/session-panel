# Repository Notes

## Scope

- Dependency-free local OpenCode session panel: `server.py` is Python stdlib only, `public/` is plain HTML/CSS/JS. No package manager, no build step, no test suite, no lint config.
- Do not add package manager files or frontend build tooling unless the task explicitly requires a new dependency.
- The panel talks to OpenCode only through the official HTTP API; do not read or mutate OpenCode internal data files.

## Running Environment

- Both OpenCode serve and the panel are managed by systemd user services and are **already running** in normal operation — no need to start them manually.
- **OpenCode serve** (`opencode-serve.service`): `127.0.0.1:4097`, started with Basic Auth (`OPENCODE_SERVER_PASSWORD` read from `~/.config/opencode/server-password`, username `opencode`).
- **Panel** (`opencode-session-panel.service`): `127.0.0.1:7878`, env vars (`OPENCODE_BASE_URL`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`) set in the service file.
- After code changes, restart the panel: `systemctl --user restart opencode-session-panel.service`.
- Check status / logs: `systemctl --user status opencode-session-panel.service`, `journalctl --user -u opencode-session-panel.service -f`.
- Detailed service config notes: `D:\Note\notes_vault\10-Notes\opencode 相关\opencode-session-panel 后台服务配置.md`.

## Run Commands

- Manual start (if services are down): `python3 server.py` from this directory, then open `http://127.0.0.1:7878`.
- For Basic Auth testing, run OpenCode with `OPENCODE_SERVER_PASSWORD=your-password opencode serve --port 4097` and set the same password in the panel UI or env.
- Panel env vars: `PANEL_PORT`, `OPENCODE_BASE_URL`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`.
- The default OpenCode port is **4097**, not 4096. `app.js` auto-migrates stale `4096` configs to `4097` on load.

## Architecture

- `server.py` serves static files from `public/` and proxies `/api/*` to OpenCode endpoints. Single file, no framework.
- OpenCode connection settings resolve in this order: request headers → query params → env vars → `DEFAULT_OPENCODE_BASE_URL` (`http://127.0.0.1:4097`). The browser stores UI config in `localStorage` key `opencode-session-panel:v1` and sends it as `x-opencode-*` headers on every request.
- `/api/events` proxies OpenCode SSE from `/event`. The frontend uses SSE as the primary real-time channel, with an 8s health check (`HEALTH_INTERVAL_MS`) and a 5-minute full-refresh poll (`POLL_INTERVAL_MS = 300000`) as fallbacks. SSE reconnect uses exponential backoff.
- Session detail fetches combine `/session/:id`, `/session/status`, `/session/:id/message?limit=20`, `/session/:id/todo`, and `/session/:id/children`.
- Other proxied mutations: `PATCH /api/session/:id` → rename; `POST /api/session/:id/abort` → abort session; `POST /api/session/:id/toast` → `/tui/show-toast`.

## SSE proxy and event handling

- `server.py` `handle_events` uses `response.read1(4096)` (not `read`) to stream chunked SSE data. `read(n)` blocks until n bytes are filled (~400s at 10s/heartbeat); `read1(n)` returns after one chunk. See `doc/sse-fix.md` for details.
- Frontend `handleEventStreamMessage` routes SSE events by type:
  - `server.heartbeat` → ignored (pure keep-alive, no refresh).
  - `server.connected` → `refreshAll()` to catch up after (re)connect.
  - `session.status` → fast path: updates snapshot directly from payload, calls `renderBoard()` (no network fetch).
  - `session.updated` / `message.*` → `refreshSessionDebounced(id)`: per-session 300ms debounce, fetches only the affected session (not all tracked sessions).
- `EventSource` cannot set custom headers, so SSE connection passes config via query params (`baseUrl`, `username`, `password`). When the browser-side password is empty, `server.py` falls back to env vars for auth.

## Rendering strategy

- `renderBoard()` computes a `renderSignature()` from all render-relevant fields (tracked IDs, lanes, notes, titles, status, todos, last message, errors, expanded lanes). If the signature is unchanged since the last render, it skips the full DOM rebuild and only updates the "刷新时间" text on existing cards in place.
- `.session-card` has a `card-in` entrance animation (opacity 0→1, 0.32s). After the first `renderBoard()`, a `board-ready` class is added to the board element; CSS `.board-ready .session-card { animation: none; }` disables the entrance animation on all subsequent renders to prevent flicker.
- Lane expand/collapse toggles cards in place via CSS classes (`collapsed`) without calling `renderBoard()`, so the CSS grid-transition runs smoothly.

## OpenCode status scoping gotcha

- OpenCode 1.17.x scopes `/session/status` **per directory** (InstanceState ScopedCache). A request without `x-opencode-directory` only returns status for the serve process cwd, typically empty.
- `server.py` `collect_statuses` queries `/session/status` once per unique session directory and merges the maps, so the frontend poll is authoritative for busy/retry state. Do not collapse this into a single status call.
- Status classification (`app.js` `classifyStatus`): `type === "busy"` → working, `type === "retry"` → retrying, absent → idle.

## Local Networking

- `server.py` binds the panel to `127.0.0.1`; change deliberately if LAN access is required.
- In WSL/Windows networking issues, use `hostname -I` to find the WSL IP and run OpenCode with `--hostname 0.0.0.0 --port 4097 --cors http://127.0.0.1:7878` before pointing the panel at `http://<WSL-IP>:4097`.
