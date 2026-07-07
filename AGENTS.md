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

## OpenCode API scoping gotchas

OpenCode 1.17.x has **two independent scoping mechanisms** that both affect what the panel can see. Failing to account for either causes silent data loss.

### 1. `/session/status` — per-directory scoped

- Each directory has its own `Map<sessionID, status>` (InstanceState ScopedCache). A request without `x-opencode-directory` only returns status for the serve process cwd, typically empty `{}`.
- `server.py` `collect_statuses` queries `/session/status` once per unique session directory and merges the maps, so the frontend poll is authoritative for busy/retry state. Do not collapse this into a single status call.
- Status classification (`app.js` `classifyStatus`): `type === "busy"` → working, `type === "retry"` → retrying, absent → idle.

### 2. `/session` (list) — per-project scoped

- The `/session` list endpoint filters by `projectID`, **not** by directory directly. The server resolves the request's directory → `projectID` via `Project.resolve()`, then runs `WHERE project_id = ?`.
- A request without `x-opencode-directory` falls back to `process.cwd()` (serve cwd, here `/home/lee`), resolves its `projectID`, and returns only sessions matching that `projectID`.
- `projectID` resolution priority (from `packages/core/src/project.ts`): git remote URL SHA1 → `.git/opencode` cache file → root commit hash (`git rev-list --max-parents=0 HEAD | sort | head -1`) → `"global"`. Non-git directories and empty git repos (no remote, no commit) fall through to the literal string `"global"`.
- One `projectID` can span many directories. All non-git directories map to `"global"`, so their sessions share `project_id = "global"` while keeping distinct `directory` values. A git repo's subdirectories share the repo's `projectID`.
- **Impact on the panel**: `server.py` `handle_sessions` calls `/session` **without** `x-opencode-directory`, so it only receives sessions whose `projectID` equals the serve cwd's `projectID` (here `"global"`). Any session created in a directory that resolves to a different `projectID` (e.g. a standalone git repo like `/mnt/d/Note/notes_vault`, whose `projectID` is its root commit hash) is **invisible** to the "拉取列表" button and to `collect_statuses` (which derives directories from the already-filtered session list).
- **Verified on 1.17.14**: `GET /session` (no header) → 77 sessions, all `projectID = "global"`. `GET /session` + `x-opencode-directory: /mnt/d/Note/notes_vault` → 87 sessions, all `projectID = b3acc554...` (that repo's root commit). Zero overlap. The target session `ses_0c455bb...` is reachable via `GET /session/:id` but absent from the unscoped list.
- **Known limitation**: the panel currently has no mechanism to discover all `projectID`s. A fix requires either a user-configured directory watchlist, or an OpenCode API that enumerates projects. The `collect_statuses` directory-derivation logic is built on the false premise that the unscoped `/session` list is complete.

## Local Networking

- `server.py` binds the panel to `127.0.0.1`; change deliberately if LAN access is required.
- In WSL/Windows networking issues, use `hostname -I` to find the WSL IP and run OpenCode with `--hostname 0.0.0.0 --port 4097 --cors http://127.0.0.1:7878` before pointing the panel at `http://<WSL-IP>:4097`.

## Workflow

- 每有一个独立改动就提交并推送，保持工作区整洁。
