# Cited into this repo through qodo-cli qodo/bridge/static.py @
#  ef231828f72da019f1f6904a31ea168582cdf3e8
# Cited from culture-rules culture_rules/server/static.py @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: no `from __future__ import annotations` (FastAPI resolves the handler's annotations
# at runtime, and the framework is now a local import); the web framework is imported inside
#  install() (lazy, behind the server extra) instead of at module level;
# Adapted: default_web_dist() is gone: the app passes its own build directory;
# Adapted: the scope flag and docstring examples no longer name the source app; the caching
#          import is relative.
# Adapted: a path with a `..` segment, a `?`, a `#`, a backslash or a control character is
#          refused before it is resolved (_unsafe), with the API's JSON 404 (taken from qodo-cli).
"""Serve a packaged web build from the API. No Node at runtime.

When the build exists, ``install`` (called by ``create_app``) adds:

- an ASGI shim that lets the same-origin ``/api`` prefix the web app uses reach the API
  (``/api/things`` -> ``/things``), applied before authentication so the role check sees the
  real route path; the route paths in ``api/openapi.json`` do not change;
- browser navigations (``Accept: text/html``) to an unprefixed path are routed to the UI even
  where the path is also an API route (``/things``, ``/things/x``, ...); API
  clients (curl, the CLI, ``fetch`` under ``/api``) never send that Accept and keep the API;
- a catch-all ``GET`` that serves files from the build and falls back to ``index.html`` for
  client-side routes (``/things/x``, ...), kept out of the OpenAPI document. A path that holds a
  ``..`` segment, a ``?`` or ``#`` (which only arrive percent-encoded), a backslash or a control
  character is refused with a JSON 404 before anything is resolved, browser or not.

Everything, static files included, sits behind the same authentication as the API (the
Cloudflare edge attaches the credential to every same-origin request). Imported lazily, with
the ``server`` extra: the web framework is imported inside :func:`install`, so importing this
module needs no third-party package.
"""

from pathlib import Path
from typing import TYPE_CHECKING

from .caching import ASSET, SHELL

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import FastAPI

__all__ = ["API_PREFIX", "install"]

API_PREFIX = "/api"
_FLAG = "bridge_api_prefixed"
_UI = "/_ui"
#: Characters a UI file path never holds: a query or fragment marker that arrived
#: percent-encoded, and a backslash (a separator on some systems).
_REFUSED_CHARS = frozenset("?#\\")


def _unsafe(path: str) -> bool:
    """True when ``path`` must not be resolved: a ``..`` segment, a refused or control character."""
    if ".." in path.split("/"):
        return True
    return any(c in _REFUSED_CHARS or ord(c) < 32 or 127 <= ord(c) < 160 for c in path)


def _not_found(message: str):
    from fastapi.responses import JSONResponse  # lazy: the ``server`` extra

    return JSONResponse(
        {"error": {"code": "not_found", "message": message, "errors": []}}, status_code=404
    )


class _ApiPrefix:
    """Strip ``/api`` from the request path and mark the scope so unknown paths 404."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            scope = _route(scope)
        await self.app(scope, receive, send)


def _route(scope):
    """``scope`` with ``/api`` stripped (and flagged), or a browser GET sent to the SPA."""
    path = scope.get("path", "")
    if path == API_PREFIX or path.startswith(API_PREFIX + "/"):
        return _strip_api(scope, path)
    if scope["type"] == "http" and scope.get("method") in ("GET", "HEAD"):
        if b"text/html" in dict(scope.get("headers", ())).get(b"accept", b""):
            scope = dict(scope)
            scope["path"] = _UI + path
            scope["raw_path"] = _UI.encode() + (scope.get("raw_path") or path.encode())
    return scope


def _strip_api(scope, path: str):
    scope = dict(scope)
    scope["path"] = path[len(API_PREFIX) :] or "/"
    raw = scope.get("raw_path")
    if raw and raw.startswith(API_PREFIX.encode()):
        scope["raw_path"] = raw[len(API_PREFIX) :] or b"/"
    scope[_FLAG] = True
    return scope


def install(app: "FastAPI", web_dist: Path | None) -> bool:
    """Mount ``web_dist`` on ``app`` if it holds an ``index.html``; True when mounted.

    ``web_dist`` is the app's own build directory (None: nothing to serve, False).
    """
    from fastapi import Request  # lazy: the ``server`` extra
    from fastapi.responses import FileResponse, Response

    if web_dist is None:
        return False
    root = Path(web_dist).resolve()
    index = root / "index.html"
    if not index.is_file():
        return False

    @app.get(_UI + "/{path:path}", include_in_schema=False)
    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str, request: Request) -> Response:
        if request.scope.get(_FLAG):
            return _not_found("no such API route")
        if _unsafe(path):
            return _not_found("no such route")
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            hashed = candidate.is_relative_to(root / "assets")
            return FileResponse(candidate, headers={"Cache-Control": ASSET if hashed else SHELL})
        if path and "text/html" not in request.headers.get("accept", ""):
            # not a browser navigation and not a built file: an API client asked for a path
            # that is no route, so answer like the API does instead of with the SPA page
            return _not_found("no such route")
        return FileResponse(index, headers={"Cache-Control": SHELL})

    app.add_middleware(_ApiPrefix)
    return True
