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
from typing import Any

from associate.bridge.policy import RoutePolicy
from associate.bridge.principal import AuthError
from associate.bridge.resolve import AuthSettings, Resolver, TokenAuthenticator

__all__ = ["MAX_BODY_BYTES", "STATUS_BY_KIND", "TOKEN_PREFIX", "build_policy", "create_app"]

#: The service-token prefix for this app's tokens.
TOKEN_PREFIX = "asc_"  # nosec B105 - a public token prefix, not a secret
#: A start's body is at most this many bytes (the instruction is capped at 100,000 chars).
MAX_BODY_BYTES = 512 * 1024
#: ``RunsError.kind`` -> HTTP status.
STATUS_BY_KIND = {"invalid": 400, "forbidden": 403, "not_found": 404, "busy": 409, "env": 500}


def build_policy() -> RoutePolicy:
    """``/health`` public, each runs verb at its role, everything else admin."""
    from associate.runs.service import VERBS

    policy = RoutePolicy(default="admin")
    policy.public("/health", "GET")
    for verb in VERBS:
        policy.add(verb.http[0], verb.http[1], verb.role)
    return policy


def create_app(
    *,
    tokens: TokenAuthenticator,
    settings: AuthSettings | None = None,
    runs_config: Any = None,
    child_command: list[str] | None = None,
) -> Any:
    """The FastAPI app. ``child_command`` replaces ``python -m associate`` (tests only)."""
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from starlette.concurrency import run_in_threadpool

    from associate import __version__
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
        method, path = request.method, request.url.path
        try:
            if policy.required_role(method, path) is not None:
                principal = resolver.resolve(dict(request.headers.items()))
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
        declared = request.headers.get("content-length", "0")
        if not declared.isdigit() or int(declared) > MAX_BODY_BYTES:
            return bad_request(f"the body must be at most {MAX_BODY_BYTES} bytes")
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            return bad_request(f"the body must be at most {MAX_BODY_BYTES} bytes")
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

    return app
