"""The bridge's generic MCP server: tools from a list, stdio, errors without tracebacks."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from associate.bridge import mcpserver
from associate.bridge.mcpserver import Tool, ToolError, call_tool, tool_specs

BRIDGE = Path(__file__).resolve().parents[2] / "associate" / "bridge"

SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "count": {"type": "integer"},
        "flag": {"type": "boolean"},
        "ratio": {"type": "number"},
    },
    "required": ["text"],
    "additionalProperties": False,
}


def _echo(arguments):
    return {"got": arguments}


def _boom(arguments):
    raise ToolError("it failed: nothing to see")


def _crash(arguments):
    raise RuntimeError("secret /etc/passwd detail")


TOOLS = (
    Tool("things_echo", "Echo the arguments.", SCHEMA, _echo),
    Tool("things_boom", "Always a tool error.", {"type": "object", "properties": {}}, _boom),
    Tool("things_crash", "Raises an unexpected error.", {"type": "object"}, _crash),
)


def test_specs_are_name_description_and_input_schema_in_order():
    specs = tool_specs(TOOLS)
    assert [s["name"] for s in specs] == ["things_echo", "things_boom", "things_crash"]
    assert specs[0]["inputSchema"] == SCHEMA
    assert specs[0]["description"] == "Echo the arguments."


def test_call_passes_the_arguments_and_drops_nulls():
    assert call_tool(TOOLS, "things_echo", {"text": "a", "count": None}) == {"got": {"text": "a"}}


@pytest.mark.parametrize(
    "arguments, fragment",
    [
        ({}, "missing required argument(s) text"),
        ({"text": None}, "missing required argument(s) text"),
        ({"text": "a", "bogus": 1}, "unexpected argument(s) bogus"),
        ({"text": 5}, "text must match the declared type"),
        ({"text": "a", "count": True}, "count must match the declared type"),
        ({"text": "a", "flag": "false"}, "flag must match the declared type"),
        ({"text": "a", "ratio": "1"}, "ratio must match the declared type"),
    ],
)
def test_arguments_are_checked_against_the_schema(arguments, fragment):
    with pytest.raises(ToolError, match=fragment.replace("(", r"\(").replace(")", r"\)")):
        call_tool(TOOLS, "things_echo", arguments)


def test_a_number_may_be_an_integer_and_an_unknown_tool_is_refused():
    assert call_tool(TOOLS, "things_echo", {"text": "a", "ratio": 2})["got"]["ratio"] == 2
    with pytest.raises(ToolError, match="unknown tool"):
        call_tool(TOOLS, "nope", {})


def test_an_unexpected_exception_becomes_a_tool_error_without_its_detail():
    with pytest.raises(ToolError) as info:
        call_tool(TOOLS, "things_crash", {})
    assert "RuntimeError" in str(info.value)
    assert "passwd" not in str(info.value)


def _session(fn):
    from mcp.shared.memory import create_connected_server_and_client_session

    async def go():
        server = mcpserver.build_server("things", TOOLS)
        async with create_connected_server_and_client_session(server) as session:
            return await fn(session)

    return asyncio.run(go())


def test_the_server_lists_and_calls_tools_over_a_real_session():
    async def fn(session):
        listed = (await session.list_tools()).tools
        ok = await session.call_tool("things_echo", {"text": "hi"})
        bad = await session.call_tool("things_boom", {})
        crash = await session.call_tool("things_crash", {})
        return listed, ok, bad, crash

    listed, ok, bad, crash = _session(fn)
    assert [t.name for t in listed] == [s["name"] for s in tool_specs(TOOLS)]
    assert {t.name: t.inputSchema for t in listed}["things_echo"] == SCHEMA
    assert not ok.isError
    assert json.loads(ok.content[0].text) == {"got": {"text": "hi"}}
    assert bad.isError
    assert "it failed" in bad.content[0].text
    assert crash.isError
    assert "passwd" not in crash.content[0].text
    assert "Traceback" not in crash.content[0].text


def test_importing_the_module_does_not_import_the_sdk():
    code = "import sys, associate.bridge.mcpserver; assert 'mcp' not in sys.modules"
    subprocess.run([sys.executable, "-c", code], check=True)


def test_a_missing_sdk_raises_the_extra_missing_error_naming_the_extra():
    code = (
        "import sys\nsys.modules['mcp'] = None\nsys.modules['anyio'] = None\n"
        "from associate.bridge import mcpserver\n"
        "try:\n    mcpserver.run_stdio('x', (), extra_hint=\"pip install 'thing[mcp]'\")\n"
        "except mcpserver.ServerExtraMissing as exc:\n    print(exc)\n"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert "pip install 'thing[mcp]'" in done.stdout


def test_the_module_header_names_its_source():
    text = (BRIDGE / "mcpserver.py").read_text(encoding="utf-8")
    assert "culture_rules/mcp/server.py" in text
    assert "culture_rules/mcp/tools.py" in text
