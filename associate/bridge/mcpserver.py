# Cited from culture-rules culture_rules/mcp/server.py and culture_rules/mcp/tools.py @
#  b7f861f690b57c4355f81371cc02ad1dd2ae9cac
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: the tool list is a parameter (a tuple of ``Tool``) instead of culture-rules' CLI
# registry, so any app can serve its own verbs; a tool's handler takes the argument dict and
# returns a JSON-able result (no API client, no ``apply`` flag); the server name and the
# install hint are parameters; arguments are checked against the tool's own JSON schema
# (unknown names when additionalProperties is false, required names, scalar types); an
# unexpected handler exception becomes a tool error naming only its class, never its text.
"""Serve a list of verbs as MCP tools over stdio.

Needs the ``mcp`` SDK (an app's optional extra). The SDK is imported lazily inside the
functions that need it, so importing this module never pulls it in. One :class:`Tool` per verb:
a name, a description, a JSON-schema ``input_schema`` and a ``handler`` that takes the
arguments dict and returns a JSON-serialisable result, or raises :class:`ToolError` (its
message is shown to the calling model). Any other exception from a handler is reported as
``tool failed unexpectedly (<ExceptionClass>)``: no traceback and no exception text leaves
the process.

Arguments are checked here, not by the SDK (``validate_input=False``), so every client gets
the same messages: an unknown name is refused when the schema says
``additionalProperties: false``, a required name must be present and not null, and a
``string``/``integer``/``number``/``boolean``/``array``/``object`` argument must have that
JSON type (``true`` is never an integer; a string such as ``"false"`` is never a boolean). A
null argument counts as absent.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

__all__ = [
    "ServerExtraMissing",
    "Tool",
    "ToolError",
    "build_server",
    "call_tool",
    "run_stdio",
    "tool_specs",
]


class ToolError(Exception):
    """A tool call that failed; the message is shown to the calling model."""


class ServerExtraMissing(ImportError):
    """The ``mcp`` SDK is not installed."""


@dataclass(frozen=True)
class Tool:
    """One verb as an MCP tool."""

    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Any]


def tool_specs(tools: Sequence[Tool]) -> list[dict[str, Any]]:
    """``{name, description, inputSchema}`` for every tool, in order."""
    return [
        {"name": t.name, "description": t.description, "inputSchema": t.input_schema} for t in tools
    ]


_JSON_TYPES: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "array": (list,),
    "object": (dict,),
}


def _typed_ok(kind: Any, value: Any) -> bool:
    if value is None or not isinstance(kind, str) or kind not in _JSON_TYPES:
        return True
    if kind in ("integer", "number") and isinstance(value, bool):
        return False
    return isinstance(value, _JSON_TYPES[kind])


def call_tool(tools: Sequence[Tool], name: str, arguments: dict[str, Any] | None) -> Any:
    """Run tool ``name`` with ``arguments`` and return its handler's result."""
    tool = next((t for t in tools if t.name == name), None)
    if tool is None:
        raise ToolError(f"unknown tool {name!r}")
    schema = tool.input_schema
    properties: dict[str, Any] = schema.get("properties", {})
    args = {k: v for k, v in dict(arguments or {}).items() if v is not None}
    if schema.get("additionalProperties") is False:
        extra = sorted(set(args) - set(properties))
        if extra:
            raise ToolError(f"{name}: unexpected argument(s) {', '.join(extra)}")
    missing = [p for p in schema.get("required", []) if p not in args]
    if missing:
        raise ToolError(f"{name}: missing required argument(s) {', '.join(missing)}")
    mistyped = [p for p, spec in properties.items() if not _typed_ok(spec.get("type"), args.get(p))]
    if mistyped:  # input validation is off: a truthy "false" would turn a guard off
        raise ToolError(f"{name}: {', '.join(mistyped)} must match the declared type")
    try:
        return tool.handler(args)
    except ToolError:
        raise
    except Exception as exc:  # noqa: BLE001 - no traceback or exception text leaves the process
        raise ToolError(f"{name}: tool failed unexpectedly ({type(exc).__name__})") from None


def _sdk(extra_hint: str) -> tuple[Any, Any]:
    try:
        import mcp.types as types  # noqa: PLC0415 - optional extra
        from mcp.server.lowlevel import Server  # noqa: PLC0415
    except ImportError as exc:
        raise ServerExtraMissing(f"the MCP server needs the 'mcp' SDK: {extra_hint}") from exc
    return Server, types


def build_server(
    server_name: str, tools: Sequence[Tool], *, extra_hint: str = "install the 'mcp' extra"
) -> Any:
    """An MCP ``Server`` exposing every tool."""
    server_cls, types = _sdk(extra_hint)
    tools = tuple(tools)
    server = server_cls(server_name)

    @server.list_tools()
    async def _list() -> list[Any]:
        return [types.Tool(**spec) for spec in tool_specs(tools)]

    @server.call_tool(validate_input=False)
    async def _call(name: str, arguments: dict[str, Any] | None) -> list[Any]:
        try:
            result = call_tool(tools, name, arguments)
        except ToolError as exc:
            raise ValueError(str(exc)) from exc  # the SDK turns this into isError
        return [types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]

    return server


def run_stdio(
    server_name: str, tools: Sequence[Tool], *, extra_hint: str = "install the 'mcp' extra"
) -> None:
    """Serve over stdio until the client disconnects.

    Raises :class:`ServerExtraMissing` when the SDK (and its ``anyio``) is not installed,
    before anything is served. Stdout is the protocol channel: nothing else is written there.
    """
    try:
        import anyio  # noqa: PLC0415 - optional extra (an mcp dependency)
        from mcp.server.stdio import stdio_server  # noqa: PLC0415
    except ImportError as exc:
        raise ServerExtraMissing(f"the MCP server needs the 'mcp' SDK: {extra_hint}") from exc

    server = build_server(server_name, tools, extra_hint=extra_hint)

    async def main() -> None:
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())

    anyio.run(main)
