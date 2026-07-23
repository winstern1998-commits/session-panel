#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
TRACKED_FILE = ROOT / "tracked.json"
PANEL_PORT = int(os.environ.get("PANEL_PORT", "7878"))
DEFAULT_OPENCODE_BASE_URL = "http://127.0.0.1:4097"


def read_tracked() -> list[str]:
    """Read tracked session IDs from tracked.json."""
    try:
        data = json.loads(TRACKED_FILE.read_text("utf-8"))
        if isinstance(data, list):
            return [s for s in data if isinstance(s, str)]
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return []


def write_tracked(ids: list[str]) -> None:
    """Write tracked session IDs to tracked.json."""
    TRACKED_FILE.write_text(json.dumps(ids, ensure_ascii=False, indent=2), "utf-8")


class OpenCodePanelHandler(BaseHTTPRequestHandler):
    server_version = "OpenCodeSessionPanel/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/health":
            self.handle_json_proxy("/global/health")
            return
        if parsed.path == "/api/sessions":
            self.handle_sessions()
            return
        if parsed.path == "/api/events":
            self.handle_events()
            return
        if parsed.path == "/api/statuses":
            self.handle_statuses()
            return
        if parsed.path == "/api/listdir":
            self.handle_listdir()
            return
        if parsed.path == "/api/tracked":
            self.send_json({"tracked": read_tracked()})
            return
        if parsed.path.startswith("/api/session/"):
            session_id = self.extract_session_id(parsed.path)
            if session_id:
                self.handle_session_detail(session_id)
                return

        self.handle_static(parsed.path)

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/session/"):
            session_id = self.extract_session_id(parsed.path)
            if session_id:
                body = self.read_json_body()
                self.handle_json_proxy(
                    f"/session/{quote(session_id, safe='')}",
                    method="PATCH",
                    body={"title": body.get("title")},
                )
                return
        self.send_json({"error": "Not found"}, 404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/track":
            body = self.read_json_body()
            session_id = body.get("sessionId", "").strip()
            if not session_id:
                self.send_json({"error": "sessionId required"}, 400)
                return
            ids = read_tracked()
            if session_id not in ids:
                ids.append(session_id)
                write_tracked(ids)
            self.send_json({"ok": True, "tracked": ids})
            return

        session_id = self.extract_session_id(parsed.path)
        if not session_id:
            self.send_json({"error": "Not found"}, 404)
            return

        encoded_id = quote(session_id, safe="")
        if parsed.path.endswith("/abort"):
            self.handle_json_proxy(f"/session/{encoded_id}/abort", method="POST")
            return
        if parsed.path.endswith("/toast"):
            body = self.read_json_body()
            self.handle_json_proxy(
                "/tui/show-toast",
                method="POST",
                body={
                    "title": body.get("title") or "OpenCode session update",
                    "message": body.get("message") or f"{session_id} looks OK now.",
                    "variant": body.get("variant") or "info",
                },
            )
            return

        self.send_json({"error": "Not found"}, 404)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        # DELETE /api/track/<session_id>
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "track":
            session_id = unquote(parts[2])
            ids = read_tracked()
            if session_id in ids:
                ids.remove(session_id)
                write_tracked(ids)
            self.send_json({"ok": True, "tracked": ids})
            return
        self.send_json({"error": "Not found"}, 404)

    def handle_sessions(self) -> None:
        try:
            params = parse_qs(urlparse(self.path).query)
            directory = params.get("directory", [None])[0]
            sessions = self.opencode_json("/session", directory=directory)
            status = self.collect_statuses(sessions)
            self.send_json({"sessions": sessions, "status": status})
        except Exception as exc:
            self.send_proxy_error(exc)

    def handle_statuses(self) -> None:
        """Lightweight status check — query /session/status for given directories."""
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        dirs_param = params.get("dirs", [""])[0]
        dirs = [d for d in dirs_param.split(",") if d]
        if not dirs:
            self.send_json({})
            return
        merged: dict[str, Any] = {}
        for d in dirs:
            partial = self.opencode_json("/session/status", fallback={}, directory=d)
            if isinstance(partial, dict):
                merged.update(partial)
        self.send_json(merged)

    def handle_listdir(self) -> None:
        """List subdirectories of a given path for autocomplete."""
        params = parse_qs(urlparse(self.path).query)
        raw_path = params.get("path", [""])[0]
        path = os.path.expanduser(raw_path) if raw_path else os.path.expanduser("~")
        try:
            entries = []
            for entry in os.scandir(path):
                if entry.is_dir() and not entry.name.startswith("."):
                    entries.append(entry.path)
            entries.sort()
            self.send_json({"dirs": entries})
        except (OSError, PermissionError):
            self.send_json({"dirs": [], "error": f"Cannot read directory: {path}"})

    def handle_session_detail(self, session_id: str) -> None:
        encoded_id = quote(session_id, safe="")
        try:
            session = self.opencode_json(f"/session/{encoded_id}")
            directory = session.get("directory") if isinstance(session, dict) else None
            status = self.opencode_json("/session/status", fallback={}, directory=directory)
            messages = self.opencode_json(f"/session/{encoded_id}/message?limit=20", fallback=[])
            todos = self.opencode_json(f"/session/{encoded_id}/todo", fallback=[])
            children = self.opencode_json(f"/session/{encoded_id}/children", fallback=[])

            raw_status = status.get(session_id) if isinstance(status, dict) else None

            # Fallback: /session/status can miss active sessions (per-directory
            # ScopedCache gaps). If the last message has completed=None the
            # session is actively generating — override to busy.
            if not raw_status and isinstance(messages, list) and messages:
                last_msg = messages[-1]
                last_time = last_msg.get("info", {}).get("time", {}) if isinstance(last_msg, dict) else {}
                if last_time.get("completed") is None:
                    raw_status = {"type": "busy"}

            self.send_json({
                "session": session,
                "status": raw_status,
                "messages": messages,
                "todos": todos,
                "children": children,
            })
        except Exception as exc:
            self.send_proxy_error(exc)

    def collect_statuses(self, sessions: Any) -> dict[str, Any]:
        """Aggregate /session/status across all session directories.

        OpenCode's status map is scoped per-directory (InstanceState ScopedCache).
        A request without x-opencode-directory falls back to the serve process cwd,
        which is typically empty. We must query once per unique directory to see
        the real busy/retry state of every tracked session.
        """
        if not isinstance(sessions, list):
            return {}
        directories: set[str] = set()
        for session in sessions:
            if isinstance(session, dict) and session.get("directory"):
                directories.add(session["directory"])
        merged: dict[str, Any] = {}
        for directory in directories:
            partial = self.opencode_json("/session/status", fallback={}, directory=directory)
            if isinstance(partial, dict):
                merged.update(partial)
        return merged

    def handle_json_proxy(self, endpoint: str, method: str = "GET", body: dict[str, Any] | None = None) -> None:
        try:
            self.send_json(self.opencode_json(endpoint, method=method, body=body))
        except Exception as exc:
            self.send_proxy_error(exc)

    def handle_events(self) -> None:
        try:
            request = self.opencode_request("/event")
            with urlopen(request, timeout=60) as response:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                while True:
                    chunk = response.read1(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except Exception as exc:
            try:
                self.send_error(502, explain=str(exc))
            except BrokenPipeError:
                pass

    def handle_static(self, request_path: str) -> None:
        relative = request_path.lstrip("/") or "index.html"
        path = (PUBLIC / relative).resolve()
        if not path.is_file() or PUBLIC not in path.parents:
            path = PUBLIC / "index.html"

        content_type = "text/html; charset=utf-8"
        if path.suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif path.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif path.suffix == ".svg":
            content_type = "image/svg+xml"
        elif path.suffix == ".png":
            content_type = "image/png"

        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def opencode_json(
        self,
        endpoint: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        fallback: Any | None = None,
        directory: str | None = None,
    ) -> Any:
        try:
            request = self.opencode_request(endpoint, method=method, body=body, directory=directory)
            with urlopen(request, timeout=30) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else True
        except Exception:
            if fallback is not None:
                return fallback
            raise

    def opencode_request(self, endpoint: str, method: str = "GET", body: dict[str, Any] | None = None, directory: str | None = None) -> Request:
        config = self.opencode_config()
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if config["password"]:
            token = base64.b64encode(f"{config['username']}:{config['password']}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        if directory:
            headers["x-opencode-directory"] = directory
        return Request(f"{config['base_url']}{endpoint}", data=data, headers=headers, method=method)

    def opencode_config(self) -> dict[str, str]:
        query = parse_qs(urlparse(self.path).query)
        base_url = self.headers.get("x-opencode-base-url") or first(query, "baseUrl") or os.environ.get("OPENCODE_BASE_URL") or DEFAULT_OPENCODE_BASE_URL
        username = self.headers.get("x-opencode-username") or first(query, "username") or os.environ.get("OPENCODE_SERVER_USERNAME") or "opencode"
        password = self.headers.get("x-opencode-password") or first(query, "password") or os.environ.get("OPENCODE_SERVER_PASSWORD") or ""
        return {"base_url": base_url.rstrip("/"), "username": username, "password": password}

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or "0")
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_json(self, body: Any, status: int = 200) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_proxy_error(self, exc: Exception) -> None:
        status = 502
        message = str(exc)
        if isinstance(exc, HTTPError):
            status = exc.code
            message = exc.read().decode("utf-8", errors="replace") or exc.reason
        elif isinstance(exc, URLError):
            message = str(exc.reason)
        self.send_json({"error": message}, status)

    @staticmethod
    def extract_session_id(path: str) -> str | None:
        parts = path.strip("/").split("/")
        if len(parts) < 3 or parts[0] != "api" or parts[1] != "session":
            return None
        return unquote(parts[2])


def first(query: dict[str, list[str]], key: str) -> str | None:
    values = query.get(key)
    return values[0] if values else None


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PANEL_PORT), OpenCodePanelHandler)
    print(f"OpenCode Session Panel listening on http://127.0.0.1:{PANEL_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
