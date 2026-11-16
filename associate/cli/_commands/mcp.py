"""``associate mcp`` — serve the runs verbs as MCP tools over stdio (the ``mcp`` extra).

One tool per runs verb (``runs_start``, ``runs_show``, ``runs_list``), calling the same
:mod:`associate.runs.service` functions as the CLI and the HTTP API. Stdout is the protocol
channel, so nothing else is ever written there; a missing ``mcp`` package is an environment
error (exit 2) naming the extra, never a traceback.
"""

from __future__ import annotations

import argparse

from associate.cli._errors import EXIT_ENV_ERROR, CliError
from associate.cli._output import emit_diagnostic


def cmd_mcp(args: argparse.Namespace) -> int:
    from associate.bridge import mcpserver
    from associate.runs import mcp_tools

    try:
        if not getattr(args, "json", False):
            emit_diagnostic("serving associate MCP tools over stdio")
        mcpserver.run_stdio(
            mcp_tools.SERVER_NAME, mcp_tools.tools(), extra_hint=mcp_tools.EXTRA_HINT
        )
    except mcpserver.ServerExtraMissing as exc:
        raise CliError(EXIT_ENV_ERROR, str(exc), mcp_tools.EXTRA_HINT) from exc
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "mcp",
        help="Serve the runs verbs as MCP tools over stdio (needs the 'mcp' extra).",
    )
    p.add_argument("--json", action="store_true", help="Emit structured JSON errors.")
    p.set_defaults(func=cmd_mcp)
