"""The ``associate`` provider, observed through the real ``pi`` binary.

Three things the TypeScript unit tests cannot show on their own:

* **c14 / h22** — with ``ASSOCIATE_BASE_URL`` / ``ASSOCIATE_API_KEY`` /
  ``ASSOCIATE_MODEL`` set, ``pi --list-models`` lists a provider named
  ``associate``; with them unset, it does not, and the extension prints a hint
  naming the three variables. The endpoint is therefore configuration, not code.
* **per-model reasoning** — verified *on the wire*: a real request pi sends is
  captured by the stdlib fake lane. A model whose registry entry declares no
  reasoning override sends no ``chat_template_kwargs``; only an entry that says
  ``off`` gets ``enable_thinking=false``.

``ASSOCIATE_MODEL`` is a registry key; the wire ``model`` is that entry's
``lobes_role``.

The fake lane answers plain JSON while pi's ``openai-completions`` path expects
an SSE stream, so pi never finishes the turn. That is fine and deliberate: the
request body is captured the moment pi sends it, so these tests poll for the
capture and then kill pi rather than waiting for a completion the fake server
was never built to produce.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from tests.conftest import require_pi
from tests.fake_lane import FakeLaneServer

REPO_ROOT = Path(__file__).resolve().parent.parent

PROVIDER_ID = "associate"
DUMMY_KEY = "dummy-test-key"  # nosec B105 - not a credential; the fake lane ignores it

#: Environment keys this module always controls explicitly, so an operator's
#: own lane configuration can never decide whether a test passes.
_CONTROLLED = (
    "ASSOCIATE_BASE_URL",
    "ASSOCIATE_API_KEY",
    "ASSOCIATE_MODEL",
    "ASSOCIATE_CONTRACT_DIR",
)


def _pi_env(**overrides: str) -> dict[str, str]:
    env = dict(os.environ)
    for key in _CONTROLLED:
        env.pop(key, None)
    env["PI_OFFLINE"] = "1"
    env.update(overrides)
    return env


def _provider_rows(list_models_stdout: str) -> list[str]:
    """Rows of ``pi --list-models`` output whose provider column is ours.

    A fuzzy ``--list-models associate`` search also matches any *model* named
    ``associate`` under some other provider, so match the first column.
    """

    rows = []
    for line in list_models_stdout.splitlines():
        parts = line.split()
        if parts and parts[0] == PROVIDER_ID:
            rows.append(line)
    return rows


def _run_pi(args: list[str], env: dict[str, str], timeout: int = 120):
    return subprocess.run(  # nosec B603 - fixed argv, no shell
        ["pi", *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )


def test_list_models_shows_the_provider_when_the_env_is_set(fake_lane: FakeLaneServer):
    require_pi()

    result = _run_pi(
        ["--approve", "--list-models", PROVIDER_ID],
        _pi_env(
            ASSOCIATE_BASE_URL=f"{fake_lane.base_url}/v1",
            ASSOCIATE_API_KEY=DUMMY_KEY,
            ASSOCIATE_MODEL="worker",
        ),
    )

    assert result.returncode == 0, result.stderr
    rows = _provider_rows(result.stdout)
    assert rows, f"no row for provider {PROVIDER_ID!r} in:\n{result.stdout}"
    # One row per ACTIVE registry model, id = lobes_role; pending is absent.
    assert sorted(row.split()[1] for row in rows) == ["cortex", "senses", "worker"]


def test_no_provider_and_a_hint_when_the_env_is_unset():
    require_pi()

    result = _run_pi(["--approve", "--list-models", PROVIDER_ID], _pi_env())

    assert result.returncode == 0, result.stderr
    assert not _provider_rows(result.stdout), (
        "the provider must not register without ASSOCIATE_API_KEY:\n" + result.stdout
    )

    combined = result.stdout + result.stderr
    for name in ("ASSOCIATE_BASE_URL", "ASSOCIATE_API_KEY", "ASSOCIATE_MODEL"):
        assert name in combined, f"the hint must name {name}:\n{combined}"


def _contract_with_reasoning(tmp_path: Path, key: str, reasoning: str) -> Path:
    """A copy of the contract directory whose ``key`` entry has ``reasoning`` set."""
    dest = tmp_path / "contract"
    shutil.copytree(REPO_ROOT / "associate" / "contract", dest)
    path = dest / "models.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["models"][key]["reasoning"] = reasoning
    path.write_text(json.dumps(doc), encoding="utf-8")
    return dest


def _first_chat_body(fake_lane: FakeLaneServer, role: str, **overrides: str) -> dict[str, object]:
    env = {
        "ASSOCIATE_BASE_URL": f"{fake_lane.base_url}/v1",
        "ASSOCIATE_API_KEY": DUMMY_KEY,
        **overrides,
    }
    process = subprocess.Popen(  # nosec B603 - fixed argv, no shell
        [
            "pi",
            "-p",
            "--no-session",
            "--approve",
            "--no-tools",
            "--no-context-files",
            "--provider",
            PROVIDER_ID,
            "--model",
            role,
            "pong",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        env=_pi_env(**env),
        cwd=REPO_ROOT,
    )
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and not fake_lane.requests.chat_completions:
            time.sleep(0.2)
    finally:
        process.kill()
        process.communicate(timeout=60)

    captured = fake_lane.requests.chat_completions
    assert captured, "pi sent no /v1/chat/completions request to the fake lane"
    return captured[0]


@pytest.mark.parametrize("key", ["worker", "senses", "cortex"])
def test_no_enable_thinking_override_when_the_entry_declares_none(
    fake_lane: FakeLaneServer, key: str
):
    """The shipped entries are ``on`` or ``model-default``: nothing is injected."""
    require_pi()

    body = _first_chat_body(fake_lane, key, ASSOCIATE_MODEL=key)

    assert body["model"] == key
    assert "chat_template_kwargs" not in body, body
    assert "reasoning_effort" not in body, body


def test_reasoning_off_reaches_the_wire_for_that_model_only(
    fake_lane: FakeLaneServer, tmp_path: Path
):
    require_pi()
    contract = _contract_with_reasoning(tmp_path, "senses", "off")

    body = _first_chat_body(
        fake_lane, "senses", ASSOCIATE_MODEL="senses", ASSOCIATE_CONTRACT_DIR=str(contract)
    )
    assert body["model"] == "senses"
    assert body.get("chat_template_kwargs") == {"enable_thinking": False}, body
    assert "reasoning_effort" not in body

    fake_lane.requests.chat_completions.clear()
    sibling = _first_chat_body(
        fake_lane, "worker", ASSOCIATE_MODEL="worker", ASSOCIATE_CONTRACT_DIR=str(contract)
    )
    assert sibling["model"] == "worker"
    assert "chat_template_kwargs" not in sibling, sibling


# ------------------------------------------------- pi 1.1.0 transcript semantics

#: A second extension, loaded with ``-e`` ahead of the project's own, that
#: re-enables the built-in writers from *its* ``before_agent_start`` handler and
#: records the active set it left behind and the one ``agent_start`` sees.
#: Handlers run in extension load order, so the associate extension's own
#: ``before_agent_start`` ``dropWriters`` runs after this one — the exact path
#: ``index.ts`` keeps "in case a later hook re-enabled a writer".
_REENABLE_WRITERS_EXTENSION = """\
import { writeFileSync } from "node:fs";

export default async function (pi: any) {
  const seen: Record<string, string[]> = {};
  const dump = () => writeFileSync(process.env.ASSOCIATE_TEST_PROBE_OUT!, JSON.stringify(seen));
  pi.on("before_agent_start", async () => {
    pi.setActiveTools([...pi.getActiveTools(), "write", "edit"]);
    seen.after_reenable = pi.getActiveTools();
    dump();
  });
  pi.on("agent_start", async () => {
    seen.at_agent_start = pi.getActiveTools();
    dump();
  });
}
"""


def _message_text(message: dict[str, object]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def _first_request_with_extension(
    fake_lane: FakeLaneServer, tmp_path: Path, extra_args: list[str], **env_overrides: str
) -> dict[str, object]:
    """Run real ``pi`` with the project extension and return its first request body.

    The fake lane answers plain JSON, so pi never finishes the turn; the body
    is captured the moment it is sent and pi is then killed (see the module
    docstring).
    """
    env = _pi_env(
        ASSOCIATE_BASE_URL=f"{fake_lane.base_url}/v1",
        ASSOCIATE_API_KEY=DUMMY_KEY,
        ASSOCIATE_MODEL="worker",
        ASSOCIATE_CONTRACT_DIR=str(REPO_ROOT / "associate" / "contract"),
        ASSOCIATE_EXPORT_ROOT=str(tmp_path / "runs"),
        **env_overrides,
    )
    env.pop("ASSOCIATE_CONTINUE_FROM", None)

    process = subprocess.Popen(  # nosec B603 - fixed argv, no shell
        [
            "pi",
            "-p",
            "--no-session",
            "--approve",
            "--no-context-files",
            *extra_args,
            "--provider",
            PROVIDER_ID,
            "--model",
            "worker",
            "pong",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        env=env,
        cwd=REPO_ROOT,
    )
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and not fake_lane.requests.chat_completions:
            time.sleep(0.2)
    finally:
        process.kill()
        _, stderr = process.communicate(timeout=60)

    captured = fake_lane.requests.chat_completions
    assert captured, f"pi sent no /v1/chat/completions request to the fake lane:\n{stderr}"
    return captured[0]


def _declared_tools(body: dict[str, object]) -> list[str]:
    return [tool["function"]["name"] for tool in body.get("tools", [])]  # type: ignore[union-attr]


def test_transcript_backed_prompt_and_tool_changes_reach_the_first_request(
    fake_lane: FakeLaneServer, tmp_path: Path
):
    """pi 0.86.0 made ``before_agent_start`` prompt and tool changes transcript-backed.

    Measured on the wire rather than inferred from the changelog — the first
    ``/v1/chat/completions`` body pi sends must show:

    * the system prompt delivered as a leading ``system`` message (the 0.86.0
      ``TranscriptContext`` conversion, with ``supportsDeveloperRole: false``),
      carrying no ancestor context file under ``--no-context-files``;
    * ``lib/prompt.ts``'s ``before_agent_start`` message — the checkout's own
      ``AGENTS.md`` — in the conversation;
    * no ``edit``/``write`` declared, although an earlier ``before_agent_start``
      handler re-enabled both: ``index.ts``'s ``setActiveTools`` from the same
      event must apply to this very request, not only to a later one.
    """
    require_pi()

    helper = tmp_path / "reenable-writers.ts"
    helper.write_text(_REENABLE_WRITERS_EXTENSION, encoding="utf-8")
    probe_out = tmp_path / "active-tools.json"

    body = _first_request_with_extension(
        fake_lane,
        tmp_path,
        ["-e", str(helper)],
        ASSOCIATE_INJECT_PROMPT="1",
        ASSOCIATE_TEST_PROBE_OUT=str(probe_out),
    )

    # The helper really did re-enable the writers, and they were gone again by
    # agent_start — so the removal came from a later before_agent_start handler.
    seen = json.loads(probe_out.read_text(encoding="utf-8"))
    assert {"write", "edit"} <= set(seen["after_reenable"]), seen
    assert not {"write", "edit"} & set(seen["at_agent_start"]), seen

    declared = _declared_tools(body)
    assert "associate_ready" in declared and "finish" in declared, declared
    assert not {"write", "edit"} & set(declared), f"a writer reached the wire: {declared}"

    messages = body["messages"]
    assert messages[0]["role"] == "system", [m["role"] for m in messages]
    system_text = _message_text(messages[0])
    assert system_text.strip(), "the system prompt is empty on the wire"
    assert (
        "<project_instructions" not in system_text
    ), "--no-context-files must keep every context file out of the system prompt"

    injected = [m for m in messages[1:] if "this lane's runtime prompt" in _message_text(m)]
    assert len(injected) == 1, "the AGENTS.md injection must reach the request exactly once"
    agents_first_line = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8").splitlines()[0]
    assert agents_first_line in _message_text(injected[0])


def test_an_operator_added_powershell_never_reaches_the_wire(
    fake_lane: FakeLaneServer, tmp_path: Path
):
    """pi 0.84.3 added a built-in ``powershell``; 1.1.0's ``--tools +name`` adds it.

    Measured on pi 1.1.0 (Linux): ``getAllTools()`` lists ``powershell`` as a
    configured built-in, and before ``lib/guard.ts`` named it a writer,
    ``--tools +powershell`` put an unrestricted shell on the wire beside the
    associate tools. It must be dropped like the built-in ``bash`` is.
    """
    require_pi()

    body = _first_request_with_extension(fake_lane, tmp_path, ["--tools", "+powershell"])

    declared = _declared_tools(body)
    assert "associate_ready" in declared, declared
    assert "powershell" not in declared, f"powershell reached the wire: {declared}"
