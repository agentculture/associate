"""A minimal OpenAI-compatible chat/completions server for tests.

Standard-library only (``http.server`` + ``json``). Used by pytest to
exercise HTTP call sites without touching the real lane (the lobes gateway /
associate role described in CLAUDE.md). It always answers with a scripted
``tool_calls`` structure so callers can assert on tool-calling behavior
deterministically, with no network access and no real model involved.

No test in this repo may read ``ASSOCIATE_BASE_URL`` or a bearer token from
the environment to decide whether it passes — the base URL this server binds
to is handed to callers directly (via the fixture's return value), never
resolved through an environment variable.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL_ID = "associate"

#: Default scripted tool call returned by /v1/chat/completions. Callers can
#: override this per-instance via FakeLaneServer.tool_calls.
DEFAULT_TOOL_CALLS = [
    {
        "id": "call_0",
        "type": "function",
        "function": {
            "name": "read",
            "arguments": json.dumps({"path": "README.md"}),
        },
    }
]


def _chat_completion_response(tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": "chatcmpl-fake-lane-0",
        "object": "chat.completion",
        "model": MODEL_ID,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": tool_calls,
                },
                "finish_reason": "tool_calls",
            }
        ],
    }


def _models_response() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_ID,
                "object": "model",
                "owned_by": "fake-lane",
            }
        ],
    }


@dataclass
class _RequestLog:
    """Captures request bodies the fake server has handled, for assertions."""

    chat_completions: list[dict[str, Any]] = field(default_factory=list)


def _make_handler(server_state: "FakeLaneServer") -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # Silence default stderr request logging; keep test output clean.
            pass

        def _write_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/v1/models":
                self._write_json(200, _models_response())
                return
            self._write_json(404, {"error": {"message": "not found"}})

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/v1/chat/completions":
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    request_body = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    request_body = {}
                server_state.requests.chat_completions.append(request_body)
                self._write_json(200, _chat_completion_response(server_state.tool_calls))
                return
            self._write_json(404, {"error": {"message": "not found"}})

    return Handler


class FakeLaneServer:
    """A scripted, in-process OpenAI-compatible server.

    Binds to 127.0.0.1 on an ephemeral port. Start/stop are explicit so this
    can be used directly or wrapped in a pytest fixture.
    """

    def __init__(self, tool_calls: list[dict[str, Any]] | None = None) -> None:
        self.tool_calls = tool_calls if tool_calls is not None else DEFAULT_TOOL_CALLS
        self.requests = _RequestLog()
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(self))
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)
