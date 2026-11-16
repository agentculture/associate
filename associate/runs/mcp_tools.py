"""The runs verbs as MCP tools: one per entry of :data:`associate.runs.service.VERBS`.

A tool is named ``runs_<verb>`` and takes the verb's own JSON schema as its input schema; its
handler calls the same :mod:`associate.runs.service` function the CLI and the HTTP API call
(never the CLI, never a shell). An MCP client is a remote caller, not the local operator, so
``runs_start`` applies the checkout allowlist exactly as HTTP does (``require_allowlist=True``:
while ``ASSOCIATE_RUNS_ROOTS`` is empty every start is refused). A :class:`RunsError` becomes a
tool error ``<kind>: <message> (hint: <remediation>)``; nothing else about the failure leaks.

The generic server is :mod:`associate.bridge.mcpserver`; this module is the app wiring.
Stdlib only (the SDK is imported by the bridge, lazily).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from associate.bridge.mcpserver import Tool, ToolError
from associate.runs import service

__all__ = ["EXTRA_HINT", "NOUN", "SERVER_NAME", "tool_error", "tools"]

NOUN = "runs"
SERVER_NAME = "associate"
EXTRA_HINT = "pip install 'associate[mcp]'"


def tool_error(err: service.RunsError) -> ToolError:
    """The tool error for a refused request: its kind, message and remediation, no more."""
    text = f"{err.kind}: {err.message}"
    if err.remediation:
        text += f" (hint: {err.remediation})"
    return ToolError(text)


def _handler(
    call: Callable[[dict[str, Any]], Any],
) -> Callable[[dict[str, Any]], Any]:
    def run(arguments: dict[str, Any]) -> Any:
        try:
            return call(arguments)
        except service.RunsError as err:
            raise tool_error(err) from None

    return run


def tools(
    *, config: service.RunsConfig | None = None, child_command: list[str] | None = None
) -> list[Tool]:
    """One tool per registry verb. ``config`` and ``child_command`` are for tests; the served
    tools read the environment on every call, like the CLI and the HTTP app."""

    def start(arguments: dict[str, Any]) -> Any:
        return service.start(
            checkout=arguments.get("checkout"),
            model=arguments.get("model"),
            instruction=arguments.get("instruction"),
            test_commands=arguments.get("test_commands"),
            timeout=arguments.get("timeout"),
            config=config,
            require_allowlist=True,
            child_command=child_command,
        )

    def show(arguments: dict[str, Any]) -> Any:
        return service.show(arguments.get("run_id"), config=config)

    def list_runs(arguments: dict[str, Any]) -> Any:
        return service.list_runs(config=config, limit=arguments.get("limit", 20))

    handlers = {"start": start, "show": show, "list": list_runs}
    return [
        Tool(
            name=f"{NOUN}_{verb.name}",
            description=f"{verb.summary} (requires role {verb.role})",
            input_schema=verb.params,
            handler=_handler(handlers[verb.name]),
        )
        for verb in service.VERBS
    ]
