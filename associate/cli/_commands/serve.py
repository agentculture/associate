# Cited into this repo from qodo-cli qodo/cli/_commands/serve.py @
#  9ac0a9c4f1d7a93507ccc15295f565123025e1e1
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: names and ASSOCIATE_ variables; the app is the runs API, so the command builds one
#          RunsConfig, passes it to the apps and reports whether the checkout allowlist is empty
#          (POST /runs refuses every start while it is); "listening" is spelled out in text mode;
#          --json is a plain flag (no add_json_flag helper here).
"""``associate serve`` — run the runs HTTP API (the ``server`` extra).

A loopback listener (always, and always on a loopback address: it is the one that trusts
Cloudflare Access) and, when configured, a LAN listener (service tokens only). The routes are
``POST /runs``, ``GET /runs/{run_id}``, ``GET /runs`` and the public ``GET /health``; see
``associate explain serve``. The server starts even with an empty ``ASSOCIATE_RUNS_ROOTS``: every
``POST /runs`` is then refused (403), and the startup line says so.
"""

from __future__ import annotations

import argparse
import os

from associate.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from associate.cli._output import emit_result


def cmd_serve(args: argparse.Namespace) -> int:
    from associate.bridge.access import AccessConfigError
    from associate.runs.service import RunsConfig
    from associate.server import serve as srv
    from associate.server.tokenstore import open_tokens

    try:
        srv.require_extra()
        env = os.environ
        specs = srv.plan_listeners(
            env,
            host=args.host,
            port=args.port,
            lan_host=args.lan_host,
            lan_port=args.lan_port,
        )
        runs_config = RunsConfig.from_env()
        listeners = srv.build_listeners(
            specs, open_tokens(args.tokens), env=env, runs_config=runs_config
        )
    except srv.ServerExtraMissing as err:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=str(err),
            remediation="install it: pip install 'associate[server]' (or uv sync --extra server)",
        ) from err
    except (srv.ListenerConfigError, AccessConfigError) as err:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=str(err),
            remediation="see `associate explain serve` for the flags and ASSOCIATE_* variables",
        ) from err
    json_mode = bool(getattr(args, "json", False))
    roots = [str(r) for r in runs_config.allowed_roots]

    def announce() -> None:
        if json_mode:
            emit_result(
                {
                    "listening": [{"name": s.name, "host": s.host, "port": s.port} for s in specs],
                    "allowlist_empty": not roots,
                    "runs_roots": roots,
                },
                json_mode=True,
            )
            return
        lines = [f"associate serve: {s.name} listening on {s.host}:{s.port}" for s in specs]
        lines.append(
            "associate serve: checkout allowlist is EMPTY, so POST /runs refuses every start "
            "(set ASSOCIATE_RUNS_ROOTS)"
            if not roots
            else f"associate serve: checkout allowlist: {', '.join(roots)}"
        )
        emit_result("\n".join(lines), json_mode=False)

    srv.serve(listeners, log_level=args.log_level, ready=announce)
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "serve",
        help="Run the runs HTTP API (needs the 'server' extra): loopback, and LAN if set.",
    )
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.add_argument("--host", help="loopback listener address (default 127.0.0.1; ASSOCIATE_HOST)")
    p.add_argument("--port", type=int, help="loopback listener port (default 8794; ASSOCIATE_PORT)")
    p.add_argument(
        "--lan-host", help="LAN listener address; unset = no LAN listener (ASSOCIATE_LAN_HOST)"
    )
    p.add_argument(
        "--lan-port", type=int, help="LAN listener port (default 8795; ASSOCIATE_LAN_PORT)"
    )
    p.add_argument(
        "--tokens", help="service-token file (default: ASSOCIATE_SERVER_TOKENS or XDG state)"
    )
    p.add_argument(
        "--log-level", default="info", choices=["critical", "error", "warning", "info", "debug"]
    )
    p.set_defaults(func=cmd_serve)
