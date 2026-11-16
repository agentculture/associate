# Cited into this repo from qodo-cli qodo/server/serve.py @
#  9ac0a9c4f1d7a93507ccc15295f565123025e1e1
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: ENV_PREFIX is ASSOCIATE_ and the default ports are 8794 (loopback) and 8795 (LAN);
#          the app is the runs API, so create_app takes runs_config/child_command and there is
#          no registry; web_dist is passed through as in qodo-cli (default: the packaged UI);
#          the extra's name is 'associate[server]'; uvicorn's access log is sent to stderr so
#          stdout stays the result channel.
"""``serve``: the listeners and uvicorn. FastAPI and uvicorn are imported lazily, here only.

Two listeners, on purpose (see :mod:`associate.bridge.resolve`):

- ``loopback`` on ``--host``/``--port`` (``ASSOCIATE_HOST``/``ASSOCIATE_PORT``, default
  ``127.0.0.1:8794``), always on, and **always a loopback address**: it is the one that trusts a
  Cloudflare Access assertion (``Cf-Access-Jwt-Assertion``), so it must be reachable only by
  ``cloudflared`` on the same host. Access is on when ``ASSOCIATE_ACCESS_LISTEN`` (``host:port``,
  also loopback, and the address of this listener unless a flag says otherwise),
  ``ASSOCIATE_ACCESS_TEAM_DOMAIN`` and ``ASSOCIATE_ACCESS_AUD`` are all set (a partial set is
  refused); service tokens work here too.
- ``lan`` on ``--lan-host``/``--lan-port`` (``ASSOCIATE_LAN_HOST``/``ASSOCIATE_LAN_PORT``, port
  default ``8795``): **off unless a LAN host is given**. Service tokens only: an Access header is
  ignored.

People Access lets through are viewers; ``ASSOCIATE_EDITORS`` and ``ASSOCIATE_ADMINS``
(comma-separated identities) raise them. Tokens live in the file
:func:`associate.server.tokenstore.default_token_path` names (``--tokens``,
``ASSOCIATE_SERVER_TOKENS``). The plan (:func:`plan_listeners`) is pure data and opens no
socket; :func:`build_listeners` builds the apps; :func:`serve` runs them under uvicorn until
SIGINT or SIGTERM.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from associate.bridge.access import AccessListenerConfig, AccessVerifier
from associate.bridge.resolve import LAN, LOOPBACK, AuthSettings

__all__ = [
    "DEFAULT_HOST",
    "DEFAULT_LAN_PORT",
    "DEFAULT_PORT",
    "ENV_PREFIX",
    "Listener",
    "ListenerConfigError",
    "ListenerSpec",
    "ServerExtraMissing",
    "build_listeners",
    "is_loopback",
    "names",
    "plan_listeners",
    "require_extra",
    "serve",
]

ENV_PREFIX = "ASSOCIATE_"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8794
DEFAULT_LAN_PORT = 8795


class ListenerConfigError(ValueError):
    """The listener configuration is refused (a user error: fix the flag or variable)."""


class ServerExtraMissing(RuntimeError):
    """The optional ``server`` extra (FastAPI and uvicorn) is not installed."""


@dataclass(frozen=True)
class ListenerSpec:
    """One listener as data: its name, bind address and, for loopback, the Access pin."""

    name: str
    host: str
    port: int
    access: AccessListenerConfig | None = None


@dataclass(frozen=True)
class Listener:
    """One built app, ready to bind."""

    name: str
    host: str
    port: int
    app: Any


def is_loopback(host: str) -> bool:
    """True for ``localhost`` and any loopback IP; ``0.0.0.0``, ``::`` and names are not."""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def names(env: Mapping[str, str], key: str) -> frozenset[str]:
    """A comma-separated identity list from ``env[key]``."""
    return frozenset(v.strip() for v in (env.get(key) or "").split(",") if v.strip())


def _port(value: Any, what: str) -> int:
    text = str(value).strip()
    if not text.isdigit() or not 0 < int(text) < 65536:
        raise ListenerConfigError(f"{what} must be a port from 1 to 65535, not {text!r}")
    return int(text)


def plan_listeners(
    env: Mapping[str, str],
    *,
    host: str | None = None,
    port: int | None = None,
    lan_host: str | None = None,
    lan_port: int | None = None,
) -> list[ListenerSpec]:
    """The listeners to run, as data; flags win over ``env``. Opens nothing.

    Raises :class:`ListenerConfigError` (a non-loopback loopback listener, a bad port, two
    listeners on one address) or :class:`associate.bridge.access.AccessConfigError` (a partial
    Access configuration).
    """
    access = AccessListenerConfig.from_env(env, ENV_PREFIX)  # raises on a partial tuple
    if host is None and port is None and access is not None:
        loop_host, loop_port = access.host, access.port
    else:
        loop_host = host or env.get(f"{ENV_PREFIX}HOST") or DEFAULT_HOST
        loop_port = _port(
            port if port is not None else env.get(f"{ENV_PREFIX}PORT") or DEFAULT_PORT,
            "the port",
        )
    if not is_loopback(loop_host):
        raise ListenerConfigError(
            f"the loopback listener must bind a loopback address, not {loop_host!r}: it trusts "
            "Cloudflare Access headers (use --lan-host for a listener other machines reach)"
        )
    specs = [ListenerSpec(LOOPBACK, loop_host, loop_port, access)]
    chosen_lan = lan_host or env.get(f"{ENV_PREFIX}LAN_HOST")
    if chosen_lan:
        lan_p = _port(
            (
                lan_port
                if lan_port is not None
                else env.get(f"{ENV_PREFIX}LAN_PORT") or DEFAULT_LAN_PORT
            ),
            "the LAN port",
        )
        if (chosen_lan, lan_p) == (loop_host, loop_port):
            raise ListenerConfigError(
                "the LAN and loopback listeners cannot share the same address"
            )
        specs.append(ListenerSpec(LAN, chosen_lan, lan_p))
    return specs


def require_extra() -> None:
    """Raise :class:`ServerExtraMissing` unless FastAPI and uvicorn import."""
    try:
        import fastapi  # noqa: F401, PLC0415 - optional extra, imported lazily
        import uvicorn  # noqa: F401, PLC0415
    except ImportError as exc:
        raise ServerExtraMissing(
            "the HTTP API needs the optional extra: pip install 'associate[server]'"
        ) from exc


#: ``build_listeners(web_dist=...)`` left out: the built UI inside the installed package.
_PACKAGED_UI = object()


def build_listeners(
    specs: list[ListenerSpec],
    tokens: Any,
    *,
    env: Mapping[str, str],
    fetch_jwks: Callable[[], Any] | None = None,
    runs_config: Any = None,
    child_command: list[str] | None = None,
    web_dist: Any = _PACKAGED_UI,
) -> list[Listener]:
    """One app per spec: Access JWTs only on the loopback listener that has Access pinned.

    ``web_dist`` is the built UI each app serves (default: the one inside the installed
    package, if any; ``None``: API only), as :func:`~associate.server.app.create_app` takes it.
    """
    require_extra()
    from associate.server.app import DEFAULT_UI, create_app  # noqa: PLC0415

    ui = DEFAULT_UI if web_dist is _PACKAGED_UI else web_dist

    common = {
        "admins": names(env, f"{ENV_PREFIX}ADMINS"),
        "editors": names(env, f"{ENV_PREFIX}EDITORS"),
    }
    built: list[Listener] = []
    for spec in specs:
        if spec.name == LOOPBACK and spec.access is not None:
            verifier = AccessVerifier(
                spec.access.team_domain, spec.access.audience, fetch_jwks=fetch_jwks
            )
            settings = AuthSettings(LOOPBACK, access=verifier, **common)
        else:
            settings = AuthSettings(spec.name, **common)
        app = create_app(
            tokens=tokens,
            settings=settings,
            runs_config=runs_config,
            child_command=child_command,
            web_dist=ui,
        )
        built.append(Listener(spec.name, spec.host, spec.port, app))
    return built


class ListenerFailed(RuntimeError):
    """A listener did not start (for example its port is taken)."""


def serve(
    listeners: list[Listener],
    *,
    log_level: str = "info",
    ready: Callable[[], None] | None = None,
) -> None:
    """Serve every listener under uvicorn until SIGINT or SIGTERM, then stop them all."""
    require_extra()
    import asyncio  # noqa: PLC0415
    import contextlib  # noqa: PLC0415
    import copy  # noqa: PLC0415
    import signal  # noqa: PLC0415

    import uvicorn  # noqa: PLC0415

    # uvicorn writes its access log to stdout; stdout is this CLI's result channel (one JSON
    # document under --json), so the access log goes to stderr with the rest of the logs.
    log_config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    log_config["handlers"]["access"]["stream"] = "ext://sys.stderr"

    class Server(uvicorn.Server):
        """uvicorn would let the last server to start own the signals; this process owns them."""

        @contextlib.contextmanager
        def capture_signals(self):  # newer uvicorn
            yield

        def install_signal_handlers(self) -> None:  # older uvicorn
            return None

    servers = [
        Server(
            uvicorn.Config(
                lst.app,
                host=lst.host,
                port=lst.port,
                log_level=log_level,
                log_config=log_config,
            )
        )
        for lst in listeners
    ]

    async def main() -> None:
        loop = asyncio.get_running_loop()

        def stop() -> None:
            for server in servers:
                server.should_exit = True

        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop)

        async def run(server: Any) -> None:
            try:
                await server.serve()
            except SystemExit as stop_now:  # uvicorn exits when its listener cannot start
                failed.append(stop_now.code)
                stop()

        tasks = [asyncio.ensure_future(run(server)) for server in servers]
        # "ready" means every listener has bound its socket, not that startup began
        while not all(server.started for server in servers):
            if any(task.done() for task in tasks):  # one failed to start: stop the others
                stop()
                break
            await asyncio.sleep(0.02)
        else:
            if ready is not None:
                ready()
        await asyncio.gather(*tasks)

    failed: list[Any] = []
    asyncio.run(main())
    if any(code not in (0, None) for code in failed):
        raise ListenerFailed(
            "a listener could not start; the address may be in use (see the log above)"
        )
