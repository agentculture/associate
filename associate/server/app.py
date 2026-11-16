"""The runs HTTP API: a FastAPI app factory over :mod:`associate.runs.service`.

Routes (the role each needs comes from :data:`associate.runs.service.VERBS`, through the
cited bridge's :class:`~associate.bridge.policy.RoutePolicy`; anything unlisted needs admin):

- ``GET /health`` — public; ``{status, service, version}``, no secret, no state.
- ``POST /runs`` — ``admin`` (a start runs an agent and the caller's test commands in a
  checkout); body ``{checkout, model, instruction, test_commands[, timeout]}``; 202 with the
  run id. The checkout must be under ``ASSOCIATE_RUNS_ROOTS``; while that is empty every
  start is refused (403).
- ``GET /runs/{run_id}`` — ``viewer``; the ``runs show`` reply (under 64 KiB).
- ``GET /runs`` — ``viewer``; the ``runs list`` reply.
- ``GET /`` — ``viewer``; a JSON 404 saying there is no web UI, unless the package holds a
  built UI (``associate/web_dist``, shipped in the wheel by ``hatch_build.py``).

The web UI (when built): :func:`associate.bridge.static.install` serves ``web_dist`` with an
SPA fallback, lets a browser navigation to ``/runs`` or ``/runs/<id>`` reach the UI and maps the
same-origin ``/api`` prefix onto the routes above (``/api/runs`` -> ``/runs``) before the role
check, so the prefix reaches the same routes at the same roles. Only then does the policy make
``GET /**`` viewer-readable (the UI's own files and client-side routes); without a build an
unlisted route still needs admin. The UI adds no runs verb and no API route of its own.

Forged writes: every method other than GET, HEAD and OPTIONS goes through
:func:`associate.bridge.origin.check_write` **before** authentication, so a forged request gets
the same answer whether or not it carries a credential (and learns nothing about one): 403
``cross_site_request`` when ``Sec-Fetch-Site`` is ``cross-site``, 403 ``cross_origin_request``
when an ``Origin`` header is not this server's own (the scheme the server saw, which uvicorn
takes from ``X-Forwarded-Proto`` only from its trusted proxy address, and the ``Host`` header; no
forwarded host is read), then 415 ``unsupported_media_type`` unless the body is declared
``application/json``, before any body is read. A request with neither header (curl, a rules
engine, the CLI) is unaffected. The app sends no ``Access-Control-*`` header, so a CORS
preflight is never granted (it is answered 401, or 405 with a credential).

The start body is read as a stream and refused 413 ``body_too_large`` as soon as it passes
:data:`MAX_BODY_BYTES`, whatever ``Content-Length`` says or omits (a declared length over the cap
is refused before reading; a malformed one is 400).

Authentication is the bridge's: ``Authorization: Bearer <service token>`` resolved by
:class:`~associate.bridge.resolve.Resolver` over :class:`~associate.bridge.tokens.ServiceTokens`
(prefix :data:`TOKEN_PREFIX`). No credential or a bad one is 401, too low a role 403, both
before any handler runs. Errors are ``{code, message[, remediation]}``.

FastAPI is the ``server`` extra and is imported inside :func:`create_app` only, so importing
this module costs nothing on a base install. Serving (a listener, uvicorn, issuing tokens) is
not wired here.
"""

# No `from __future__ import annotations`: FastAPI reads the handlers' annotations at
# runtime, and `Request` is imported inside create_app (the lazy `server` extra).
import json
from pathlib import Path
from typing import Any

from associate.bridge import origin
from associate.bridge.policy import RoutePolicy
from associate.bridge.principal import AuthError
from associate.bridge.resolve import AuthSettings, Resolver, TokenAuthenticator

__all__ = [
    "BodyRefused",
    "DEFAULT_UI",
    "MAX_BODY_BYTES",
    "STATUS_BY_KIND",
    "TOKEN_PREFIX",
    "build_policy",
    "create_app",
    "default_web_dist",
    "read_capped",
]

#: The service-token prefix for this app's tokens.
TOKEN_PREFIX = "asc_"  # nosec B105 - a public token prefix, not a secret
#: A start's body is at most this many bytes (the instruction is capped at 100,000 chars).
MAX_BODY_BYTES = 512 * 1024
#: ``RunsError.kind`` -> HTTP status.
STATUS_BY_KIND = {"invalid": 400, "forbidden": 403, "not_found": 404, "busy": 409, "env": 500}
#: ``create_app(web_dist=DEFAULT_UI)``: the built UI inside the installed package, if any.
DEFAULT_UI = object()


class BodyRefused(Exception):
    """A request body refused before it is parsed: ``status`` 400 or 413 and a stable code."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _declared_length(value: str | None, limit: int) -> None:
    """Refuse a malformed ``Content-Length`` (400) or one over ``limit`` (413) before reading."""
    if value is None:
        return
    # isascii: str.isdigit() also accepts a superscript digit, which int() rejects
    if not (value.isascii() and value.isdigit()):
        raise BodyRefused(400, "invalid", "the Content-Length header is not a whole number")
    # the digit count first: int() refuses a very long run of digits with a ValueError
    digits = value.lstrip("0") or "0"
    if len(digits) > len(str(limit)) or int(digits) > limit:
        raise BodyRefused(413, "body_too_large", f"the body must be at most {limit} bytes")


async def read_capped(request: Any, limit: int) -> bytes:
    """The request body, read as a stream that stops as soon as it passes ``limit`` bytes.

    A declared length over the cap is refused before anything is read; a body without a
    ``Content-Length`` (chunked) or with one that is too small is counted as it arrives, so at
    most ``limit`` bytes plus one chunk are ever held.
    """
    _declared_length(request.headers.get("content-length"), limit)
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise BodyRefused(413, "body_too_large", f"the body must be at most {limit} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def default_web_dist() -> Path:
    """Where the built web UI lives inside the installed package (it may not exist)."""
    return Path(__file__).resolve().parent.parent / "web_dist"


def build_policy() -> RoutePolicy:
    """``/health`` public, ``GET /`` viewer, each runs verb at its role, everything else admin.

    :func:`create_app` appends ``GET /** -> viewer`` only when it mounts a built UI.
    """
    from associate.runs.service import VERBS

    policy = RoutePolicy(default="admin")
    policy.public("/health", "GET")
    policy.add("GET", "/", "viewer")
    for verb in VERBS:
        policy.add(verb.http[0], verb.http[1], verb.role)
    return policy


def create_app(
    *,
    tokens: TokenAuthenticator,
    settings: AuthSettings | None = None,
    runs_config: Any = None,
    child_command: list[str] | None = None,
    web_dist: Any = DEFAULT_UI,
) -> Any:
    """The FastAPI app. ``child_command`` replaces ``python -m associate`` (tests only).

    ``web_dist`` is the built web UI directory (default: the one inside the installed package;
    ``None``, or a directory without ``index.html``: API only). ``app.state.web_ui`` says which.
    """
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from starlette.concurrency import run_in_threadpool

    from associate import __version__
    from associate.bridge import static
    from associate.bridge.caching import NoStoreByDefault
    from associate.runs import service

    policy = build_policy()
    resolver = Resolver(settings or AuthSettings(), tokens)
    start_props = set(service.VERBS[0].params["properties"])

    app = FastAPI(title="associate runs", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.runs_config = runs_config or service.RunsConfig.from_env()
    app.state.child_command = child_command

    def refused(err: service.RunsError) -> Any:
        return JSONResponse(err.to_dict(), status_code=STATUS_BY_KIND.get(err.kind, 500))

    def bad_request(message: str) -> Any:
        return JSONResponse({"code": "invalid", "message": message}, status_code=400)

    @app.middleware("http")
    async def authorize(request: Request, call_next: Any) -> Any:
        # scope["path"] is the decoded path the router matches; request.url.path may be cut at a
        # decoded "?" or "#" on older Starlette, which would judge another route's rule
        method, path = request.method, request.scope["path"]
        headers = dict(request.headers.items())
        # before authentication: a forged write gets one answer, credential or not
        forged = origin.check_write(method, headers, request.scope.get("scheme", "http"))
        if forged is not None:
            return JSONResponse(
                {"code": forged.code, "message": forged.message, "remediation": forged.remediation},
                status_code=forged.status,
            )
        try:
            if policy.required_role(method, path) is not None:
                principal = resolver.resolve(headers)
                policy.check(principal, method, path)
                request.state.principal = principal
        except AuthError as err:
            return JSONResponse({"code": err.code, "message": err.message}, status_code=err.status)
        return await call_next(request)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "associate-runs", "version": __version__}

    @app.post("/runs")
    async def post_runs(request: Request) -> Any:
        try:
            raw = await read_capped(request, MAX_BODY_BYTES)
        except BodyRefused as err:
            return JSONResponse({"code": err.code, "message": err.message}, status_code=err.status)
        try:
            body = json.loads(raw)
        except ValueError:
            return bad_request("the body must be a JSON object")
        if not isinstance(body, dict):
            return bad_request("the body must be a JSON object")
        unknown = sorted(set(body) - start_props)
        if unknown:
            return bad_request(f"unknown field(s): {', '.join(unknown)}")
        try:
            reply = await run_in_threadpool(
                lambda: service.start(
                    checkout=body.get("checkout"),
                    model=body.get("model"),
                    instruction=body.get("instruction"),
                    test_commands=body.get("test_commands"),
                    timeout=body.get("timeout"),
                    config=app.state.runs_config,
                    require_allowlist=True,
                    child_command=app.state.child_command,
                )
            )
        except service.RunsError as err:
            return refused(err)
        return JSONResponse(reply, status_code=202)

    @app.get("/runs/{run_id}")
    def get_run(run_id: str) -> Any:
        try:
            return service.show(run_id, config=app.state.runs_config)
        except service.RunsError as err:
            return refused(err)

    @app.get("/runs")
    def get_runs(limit: int = 20) -> Any:
        try:
            return service.list_runs(config=app.state.runs_config, limit=limit)
        except service.RunsError as err:
            return refused(err)

    ui_dir = default_web_dist() if web_dist is DEFAULT_UI else web_dist
    mounted = static.install(app, Path(ui_dir) if ui_dir is not None else None)
    app.state.web_ui = mounted
    if mounted:
        # the UI's own files and its client-side routes are read by any viewer
        policy.add("GET", "/**", "viewer")
    else:

        @app.get("/", include_in_schema=False)
        def no_ui() -> Any:
            return JSONResponse(
                {
                    "code": "not_found",
                    "message": "this server has no web UI; the API is at /runs and /health",
                    "remediation": "install a wheel built with the UI (web/dist), see "
                    "docs/operations/bridge.md",
                },
                status_code=404,
            )

    # outermost: every answer, the 401 and 403 included, says it may not be cached (the UI's
    # own files set their own policy)
    app.add_middleware(NoStoreByDefault)
    return app
