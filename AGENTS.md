# Repository Notes

## Scope

- This is a dependency-free local OpenCode session panel: `server.py` uses only the Python standard library, and `public/` is plain HTML/CSS/JS.
- Do not add package manager files or frontend build tooling unless the task explicitly requires a new dependency.
- The panel talks to OpenCode only through the official HTTP API; do not read or mutate OpenCode internal data files.

## Run Commands

- Start OpenCode first when testing end to end:
  `opencode serve --hostname 127.0.0.1 --port 4096 --cors http://127.0.0.1:7878`
- Start the panel from this directory with `python3 server.py`, then open `http://127.0.0.1:7878`.
- For Basic Auth testing, run OpenCode with `OPENCODE_SERVER_PASSWORD=your-password opencode serve --port 4096` and set the same password in the panel UI or env.
- Panel env vars: `PANEL_PORT`, `OPENCODE_BASE_URL`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`.

## Architecture

- `server.py` serves static files from `public/` and proxies `/api/*` to OpenCode endpoints.
- OpenCode connection settings come from request headers first, then query params, then env vars, then `DEFAULT_OPENCODE_BASE_URL`; the browser stores UI config in `localStorage` key `opencode-session-panel:v1` and initializes its own URL fallback separately.
- `/api/events` proxies OpenCode server-sent events from `/event`; the frontend also polls tracked sessions every 3 seconds.
- Session detail fetches combine `/session/:id`, `/session/status`, `/session/:id/message?limit=20`, `/session/:id/todo`, and `/session/:id/children`.

## Local Networking

- `server.py` binds the panel to `127.0.0.1`; change deliberately if LAN access is required.
- In WSL/Windows networking issues, use `hostname -I` to find the WSL IP and run OpenCode with `--hostname 0.0.0.0 --port 4096 --cors http://127.0.0.1:7878` before pointing the panel at `http://<WSL-IP>:4096`.
