"""Drive an ASGI app with a raw request path no HTTP client normalises.

httpx (and so the test client) percent-normalises a URL and removes ``..`` segments before it
sends it, so a path such as ``/health%3F/../assets/a.js`` never reaches the app as written. A
server such as uvicorn does pass it: ``raw_path`` as sent and ``path`` percent-decoded
(``/health?/../assets/a.js``). This helper builds that scope by hand.
"""

from __future__ import annotations

import asyncio
from urllib.parse import unquote

__all__ = ["Reply", "raw_get", "raw_request"]


class Reply:
    """The status, headers (lower-case names) and body of one ASGI response."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status_code, self.headers, self.content = status, headers, body

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")


def raw_get(app, raw_path: str, headers: dict[str, str] | None = None) -> Reply:
    """``GET raw_path`` as uvicorn would hand it to ``app`` (``path`` is the decoded form)."""
    return raw_request(app, "GET", raw_path, headers)


def raw_request(
    app, method: str, raw_path: str, headers: dict[str, str] | None = None, body: bytes = b""
) -> Reply:
    """One request as a server would hand it to ``app``; header values go as latin-1 bytes."""
    sent = [(b"host", b"testserver")]
    sent += [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": unquote(raw_path),
        "raw_path": raw_path.encode("ascii"),
        "root_path": "",
        "query_string": b"",
        "headers": sent,
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }
    out: dict = {"status": 0, "headers": {}, "body": b""}

    async def run() -> None:
        sent_body = False
        done = asyncio.Event()

        async def receive():
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {"type": "http.request", "body": body, "more_body": False}
            await done.wait()  # like a server: the client goes away once the reply is complete
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start":
                out["status"] = message["status"]
                out["headers"] = {k.decode().lower(): v.decode() for k, v in message["headers"]}
            elif message["type"] == "http.response.body":
                out["body"] += message.get("body", b"")
                if not message.get("more_body", False):
                    done.set()

        await app(scope, receive, send)

    asyncio.run(run())
    return Reply(out["status"], out["headers"], out["body"])
