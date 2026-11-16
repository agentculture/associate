"""``associate mcp``: one MCP tool per runs verb, the same logic as the CLI and HTTP."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

pytest.importorskip("mcp")

from associate.bridge import mcpserver  # noqa: E402
from associate.cli import main  # noqa: E402
from associate.runs import mcp_tools, service  # noqa: E402
from associate.runs.service import RunsConfig  # noqa: E402
from tests.test_runs import HOSTILE, fake, make_repo  # noqa: E402


def session_call(tools, fn):
    from mcp.shared.memory import create_connected_server_and_client_session

    async def go():
        server = mcpserver.build_server(mcp_tools.SERVER_NAME, tools)
        async with create_connected_server_and_client_session(server) as session:
            return await fn(session)

    return asyncio.run(go())


@pytest.fixture
def setup(tmp_path: Path):
    roots = tmp_path / "roots"
    roots.mkdir()
    cfg = RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))
    repo = make_repo(roots / "repo")
    return cfg, repo, tmp_path


def start_args(repo, **kw):
    return {
        "checkout": str(repo),
        "model": "worker",
        "instruction": HOSTILE,
        "test_commands": ["true"],
        **kw,
    }


def test_one_tool_per_verb_with_the_verbs_schema():
    tools = mcp_tools.tools()
    assert [t.name for t in tools] == [f"runs_{v.name}" for v in service.VERBS]
    assert [t.name for t in tools] == ["runs_start", "runs_show", "runs_list"]
    for tool, verb in zip(tools, service.VERBS, strict=True):
        assert tool.input_schema == verb.params
        assert verb.summary in tool.description


def test_list_tools_over_a_real_session():
    async def fn(session):
        return (await session.list_tools()).tools

    listed = session_call(mcp_tools.tools(), fn)
    assert {t.name: t.inputSchema for t in listed} == {
        f"runs_{v.name}": v.params for v in service.VERBS
    }


def test_runs_show_of_an_unknown_run_is_a_tool_error(setup):
    cfg, _repo, _tmp = setup

    async def fn(session):
        return await session.call_tool("runs_show", {"run_id": "run-" + "0" * 32})

    res = session_call(mcp_tools.tools(config=cfg), fn)
    assert res.isError
    text = res.content[0].text
    assert "not_found" in text
    assert "no run run-" in text
    assert "Traceback" not in text


def test_runs_show_with_a_malformed_id_is_an_invalid_tool_error(setup):
    cfg, _repo, _tmp = setup

    async def fn(session):
        return await session.call_tool("runs_show", {"run_id": "../../etc"})

    res = session_call(mcp_tools.tools(config=cfg), fn)
    assert res.isError
    assert "invalid" in res.content[0].text


def test_runs_list_with_no_runs_and_a_bad_limit(setup):
    cfg, _repo, _tmp = setup

    async def fn(session):
        return (
            await session.call_tool("runs_list", {}),
            await session.call_tool("runs_list", {"limit": 0}),
            await session.call_tool("runs_list", {"limit": "5"}),
        )

    ok, bad, mistyped = session_call(mcp_tools.tools(config=cfg), fn)
    assert not ok.isError
    assert json.loads(ok.content[0].text)["runs"] == []
    assert bad.isError
    assert "invalid" in bad.content[0].text
    assert mistyped.isError


def test_runs_start_runs_the_fake_child_and_show_reads_the_result(setup):
    cfg, repo, _tmp = setup
    tools = mcp_tools.tools(config=cfg, child_command=fake("merge"))

    async def fn(session):
        started = await session.call_tool("runs_start", start_args(repo))
        run_id = json.loads(started.content[0].text)["run_id"]
        deadline = time.monotonic() + 60
        while True:
            shown = await session.call_tool("runs_show", {"run_id": run_id})
            reply = json.loads(shown.content[0].text)
            if reply["status"] != "running" or time.monotonic() > deadline:
                break
            await asyncio.sleep(0.05)
        listed = await session.call_tool("runs_list", {})
        return started, run_id, reply, listed

    started, run_id, reply, listed = session_call(tools, fn)
    assert not started.isError
    assert reply["status"] == "finished"
    assert reply["ok"] is True
    assert reply["merge"] == "merged"
    argv = json.loads((cfg.state_dir / "runs" / run_id / "export" / "argv.json").read_text())
    assert argv[-1] == HOSTILE  # one argument, never a shell
    assert [r["run_id"] for r in json.loads(listed.content[0].text)["runs"]] == [run_id]


def test_runs_start_applies_the_checkout_allowlist_like_http(setup, tmp_path):
    cfg, _repo, _tmp = setup
    outside = make_repo(tmp_path / "outside")
    none = RunsConfig(state_dir=tmp_path / "state2", allowed_roots=())

    async def fn(session):
        return await session.call_tool("runs_start", start_args(outside))

    outside_res = session_call(mcp_tools.tools(config=cfg, child_command=fake("plain")), fn)
    empty_res = session_call(mcp_tools.tools(config=none, child_command=fake("plain")), fn)
    for res in (outside_res, empty_res):
        assert res.isError
        assert "forbidden" in res.content[0].text
    assert not (cfg.state_dir / "runs").exists() or not list((cfg.state_dir / "runs").iterdir())


def test_runs_start_refuses_bad_arguments_and_a_busy_checkout(setup):
    cfg, repo, _tmp = setup
    tools = mcp_tools.tools(config=cfg, child_command=fake("gate"))

    async def fn(session):
        missing = await session.call_tool("runs_start", {"checkout": str(repo)})
        extra = await session.call_tool("runs_start", start_args(repo, bogus=1))
        badmodel = await session.call_tool("runs_start", start_args(repo, model="../x"))
        first = await session.call_tool("runs_start", start_args(repo))
        second = await session.call_tool("runs_start", start_args(repo))
        return missing, extra, badmodel, first, second

    missing, extra, badmodel, first, second = session_call(tools, fn)
    assert missing.isError and "missing required" in missing.content[0].text
    assert extra.isError and "unexpected argument" in extra.content[0].text
    assert badmodel.isError and "invalid" in badmodel.content[0].text
    assert not first.isError
    assert second.isError and "busy" in second.content[0].text
    run_id = json.loads(first.content[0].text)["run_id"]
    (cfg.state_dir / "runs" / run_id / "release").write_text("")
    deadline = time.monotonic() + 60
    while service.show(run_id, config=cfg)["status"] == "running":
        assert time.monotonic() < deadline
        time.sleep(0.05)


def test_an_environment_error_carries_its_kind_message_and_remediation():
    err = service.RunsError("env", "the state directory cannot be used", "fix it")
    assert (
        str(mcp_tools.tool_error(err)) == "env: the state directory cannot be used (hint: fix it)"
    )
    bare = service.RunsError("invalid", "bad input")
    assert str(mcp_tools.tool_error(bare)) == "invalid: bad input"


def test_the_mcp_verb_is_wired_into_the_cli():
    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    with redirect_stdout(buf):
        assert main(["explain", "mcp"]) == 0
    assert "associate mcp" in buf.getvalue()
    buf = io.StringIO()
    with redirect_stdout(buf):
        main(["learn"])
    assert "associate mcp" in buf.getvalue()


def test_the_mcp_verb_without_the_extra_is_a_clear_environment_error():
    code = (
        "import sys\nfor m in ('mcp', 'anyio'):\n    sys.modules[m] = None\n"
        "from associate.cli import main\nsys.exit(main(['mcp', '--json']))\n"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.returncode == 2
    assert "Traceback" not in done.stderr
    err = json.loads(done.stderr.strip().splitlines()[-1])
    assert "mcp" in err["message"]
    assert "associate[mcp]" in err["remediation"]
    assert done.stdout == ""  # stdout is the protocol channel: nothing else is ever written


def test_the_mcp_verb_serves_over_real_stdio(setup):
    cfg, _repo, _tmp = setup
    code = """
import asyncio, json, sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def go():
    params = StdioServerParameters(command=sys.executable, args=['-m', 'associate', 'mcp'],
                                  env={'ASSOCIATE_RUNS_DIR': sys.argv[1]})
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tools = [t.name for t in (await s.list_tools()).tools]
            res = await s.call_tool('runs_list', {})
            print(json.dumps([tools, res.isError, json.loads(res.content[0].text)]))
asyncio.run(go())
"""
    done = subprocess.run(
        [sys.executable, "-c", code, str(cfg.state_dir)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    tools, is_error, listed = json.loads(done.stdout.strip().splitlines()[-1])
    assert tools == ["runs_start", "runs_show", "runs_list"]
    assert is_error is False
    assert listed["runs"] == []
