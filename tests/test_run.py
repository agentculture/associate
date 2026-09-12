"""``associate run`` — the fail-closed launcher over ``pi`` (spec c34 / h26).

The launcher's whole job is to refuse to serve unless the ``associate`` Pi
extension actually loaded, and h26 pins *how* it may know: **from the tool list
Pi reports**, never from the presence of a config file on disk. Pi 0.84.2 has no
``--list-tools``, and its ``--mode json`` stream carries no startup tool
inventory (``docs/json.md``), so the only list Pi reports is the one the
``associate_ready`` sentinel returns as a tool result. The launcher therefore
drives one turn whose prompt is "call associate_ready, then finish" and reads
the report off the ``tool_execution_end`` event.

That makes the check model-dependent, which is why most tests here drive a
**fake ``pi`` on PATH**: a script that emits a real ``--mode json`` event stream
and records the argv and environment it was invoked with. It settles the
launcher's behaviour deterministically with no lane. The real-pi test at the
bottom is the honest complement — it runs the actual binary against the stdlib
fake lane and asserts only what that combination can actually produce.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import time
from pathlib import Path

import pytest

from associate.cli import main
from associate.harness import available_harnesses, get_harness
from associate.harness.base import ExtensionNotLoadedError, HarnessError
from associate.harness.pi import PiHarness, resolve_export_root, sanitize_session_id
from tests.conftest import require_pi
from tests.fake_lane import FakeLaneServer

REPO_ROOT = Path(__file__).resolve().parent.parent

_FAKE_PI = '''#!/usr/bin/env python3
"""A scripted stand-in for the pi binary: real event stream, no model."""
import json
import os
import sys
from pathlib import Path

READY = {ready!r}
WRITERS = {writers!r}
VERSION = {version!r}
#: Exit code of the TASK turn (the preflight always exits 0, as preflight.ts does).
TASK_EXIT = {task_exit!r}
#: Which export artifacts this fake writes — a run that produced none is a
#: failed run even when pi exits 0.
ARTIFACTS = {artifacts!r}

argv = sys.argv[1:]
if "--version" in argv or "-v" in argv:
    print(VERSION)
    raise SystemExit(0)

root = Path(os.environ["ASSOCIATE_EXPORT_ROOT"])
root.mkdir(parents=True, exist_ok=True)
# The launcher invokes pi TWICE per run (deviation d8): a preflight that loads
# the extensions and exits, then the task turn. Both are recorded, in order.
invocations_path = root / "invocation.json"
invocations = (
    json.loads(invocations_path.read_text(encoding="utf-8"))
    if invocations_path.exists()
    else []
)
invocations.append(
    {{
        "argv": argv,
        "cwd": os.getcwd(),
        "env": {{k: v for k, v in os.environ.items() if k.startswith("ASSOCIATE_")}},
        "stdin_closed": sys.stdin.read() == "",
    }}
)
invocations_path.write_text(json.dumps(invocations), encoding="utf-8")

export = root / os.environ["ASSOCIATE_SESSION_ID"] / "export"
export.mkdir(parents=True, exist_ok=True)
run_record = {{
    "run": {{"duration_ms": 1, "tool_calls": 1, "outcome": "ok", "truncated": False}}
}}
if "walk.jsonl" in ARTIFACTS:
    (export / "walk.jsonl").write_text(json.dumps(run_record) + "\\n", encoding="utf-8")
if "statements.md" in ARTIFACTS:
    (export / "statements.md").write_text("# Statements\\n", encoding="utf-8")
if "statements.json" in ARTIFACTS:
    (export / "statements.json").write_text(
        json.dumps({{"statements": [], "citations": [], "not_fully_read": False}}) + "\\n",
        encoding="utf-8",
    )

report = {{
    "ok": True,
    "extension_version": "0.1.0",
    "contract_version": 1,
    "contract_dir": os.environ.get("ASSOCIATE_CONTRACT_DIR", ""),
    "contract_source": "env",
    "tools": ["read", "bash", "edit", "write", "associate_ready", "finish"],
    "active_tools": ["associate_ready", "finish", "bash"] + WRITERS,
    "writer_tools_active": WRITERS,
    "session": {{"id": os.environ["ASSOCIATE_SESSION_ID"], "export_dir": str(export)}},
}}
if READY:
    # What the real extension writes on session_start, before any model request.
    (export / "ready.json").write_text(json.dumps(report), encoding="utf-8")

print(json.dumps({{"type": "session", "version": 3, "id": "fake", "cwd": os.getcwd()}}))

if any(arg.endswith("preflight.ts") for arg in argv):
    # The preflight extension ends the process on before_agent_start: no turn
    # runs, so no sentinel event is ever emitted.
    raise SystemExit(0)

print(json.dumps({{"type": "agent_start"}}))
if READY:
    print(
        json.dumps(
            {{
                "type": "tool_execution_end",
                "toolCallId": "call_0",
                "toolName": "associate_ready",
                "result": {{
                    "content": [{{"type": "text", "text": json.dumps(report)}}],
                    "details": report,
                }},
                "isError": False,
            }}
        )
    )
print(json.dumps({{"type": "agent_end", "messages": []}}))

if TASK_EXIT:
    for number in range(1, 5):
        print("boom-%d: the task turn failed" % number, file=sys.stderr)
    # A real failure can print a credential; the launcher must not quote it back.
    print("Authorization: Bearer sk-abcdefghijklmnop1234", file=sys.stderr)
    raise SystemExit(TASK_EXIT)
'''


_ALL_ARTIFACTS = ["walk.jsonl", "statements.md", "statements.json"]


def _install_fake_pi(
    directory: Path,
    *,
    ready: bool = True,
    writers: list[str] | None = None,
    version: str = "0.84.2",
    task_exit: int = 0,
    artifacts: list[str] | None = None,
) -> Path:
    """Write an executable fake ``pi`` into *directory* and return its path."""
    directory.mkdir(parents=True, exist_ok=True)
    script = directory / "pi"
    script.write_text(
        _FAKE_PI.format(
            ready=ready,
            writers=writers or [],
            version=version,
            task_exit=task_exit,
            artifacts=list(_ALL_ARTIFACTS if artifacts is None else artifacts),
        ),
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return script


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    (root / "sub").mkdir(parents=True)
    (root / "README.md").write_text("# fixture\n", encoding="utf-8")
    return root


@pytest.fixture
def fake_pi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Install a fake ``pi`` first on PATH; returns the installer for re-scripting."""

    bin_dir = tmp_path / "bin"

    def install(**kwargs) -> Path:
        path = _install_fake_pi(bin_dir, **kwargs)
        monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
        return path

    install()
    return install


def _run(args: list[str], checkout: Path, tmp_path: Path) -> int:
    return main(
        [
            "run",
            "--checkout",
            str(checkout),
            "--export-root",
            str(tmp_path / "runs"),
            *args,
        ]
    )


# --------------------------------------------------------------- the registry


def test_pi_is_a_registered_adapter():
    assert "pi" in available_harnesses()
    assert get_harness("pi") is PiHarness


def test_the_pi_adapter_imports_no_pi_package():
    """Criterion 4 / claim c13: subprocess only, and no runtime dependency."""
    source = (REPO_ROOT / "associate" / "harness" / "pi.py").read_text(encoding="utf-8")
    for forbidden in ("import pi\n", "import pi ", "from pi ", "from pi.", "pi_coding_agent"):
        assert forbidden not in source, f"pi.py must not import a pi package ({forbidden!r})"


def test_the_package_declares_no_runtime_dependency():
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "dependencies = []" in text


# ------------------------------------------------------------ unknown harness


def test_unknown_harness_exits_1_listing_the_adapters(capsys: pytest.CaptureFixture[str]):
    code = main(["run", "--harness", "bogus"])
    assert code == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "bogus" in captured.err
    for name in available_harnesses():
        assert name in captured.err


def test_unknown_harness_in_json_mode_emits_the_error_object(
    capsys: pytest.CaptureFixture[str],
):
    code = main(["run", "--harness", "bogus", "--json"])
    assert code == 1

    payload = json.loads(capsys.readouterr().err)
    assert payload["code"] == 1
    assert "pi" in payload["remediation"]


# ---------------------------------------------------------------- fail closed


def test_an_active_writer_tool_fails_closed(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """r14: the check is on ``writer_tools_active``, never on the full tool list."""
    fake_pi(ready=True, writers=["write"])

    code = _run([], checkout, tmp_path)
    assert code == 2

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "write" in captured.err


def test_the_full_tool_list_containing_writers_is_not_a_failure(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """r14 (measured under pi 0.84.2): ``getAllTools()`` lists edit/write regardless."""
    fake_pi(ready=True)

    assert _run([], checkout, tmp_path) == 0
    assert "walk.jsonl" in capsys.readouterr().out


# -------------------------------------------------------------------- serving


def test_a_ready_run_prints_both_artifact_paths(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """Criterion 1, second half."""
    code = _run([], checkout, tmp_path)
    assert code == 0

    captured = capsys.readouterr()
    assert captured.out.count("\n") >= 2
    assert "walk.jsonl" in captured.out
    assert "statements.md" in captured.out
    for line in captured.out.splitlines():
        assert "=" in line


def test_json_mode_prints_the_result_object(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    code = _run(["--json"], checkout, tmp_path)
    assert code == 0

    payload = json.loads(capsys.readouterr().out)
    for key in ("walk_path", "statements_path", "statements_md_path", "outcome", "session_id"):
        assert key in payload
    assert Path(payload["walk_path"]).is_file()
    assert Path(payload["statements_md_path"]).is_file()
    assert payload["outcome"] == "ok"


# ------------------------------------------------------ a failed task run

# The launcher used to build the result paths from the session id alone, so a
# task run that died — or ran and persisted nothing — still exited 0 with a
# result naming files that were absent or left over from an earlier run.


def test_a_failed_task_run_is_not_reported_as_success(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    fake_pi(task_exit=3)

    assert _run([], checkout, tmp_path) == 2

    captured = capsys.readouterr()
    assert captured.out == "", "a failed run must serve nothing on stdout"
    assert "3" in captured.err
    # The preflight still ran and passed: the refusal is about the task turn.
    assert len(_invocations(tmp_path)) == 2


def test_a_failed_task_run_quotes_a_bounded_redacted_stderr_tail(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """Three lines at most, and never a credential."""
    fake_pi(task_exit=1)

    assert _run([], checkout, tmp_path) == 2

    err = capsys.readouterr().err
    assert "boom-4" in err, "the operator gets the end of the failure"
    assert "boom-1" not in err, "the tail is bounded at three lines"
    assert "sk-abcdefghijklmnop1234" not in err, "a secret is redacted before it is quoted"


def test_a_task_run_that_wrote_no_statements_is_not_reported_as_success(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """pi exiting 0 is not proof it produced anything."""
    fake_pi(artifacts=["walk.jsonl", "statements.json"])

    assert _run([], checkout, tmp_path) == 2

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "statements.md" in captured.err


def test_a_task_run_that_wrote_no_walk_is_not_reported_as_success(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    fake_pi(artifacts=["statements.md", "statements.json"])

    assert _run([], checkout, tmp_path) == 2

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "walk.jsonl" in captured.err


def test_a_ready_run_that_produced_both_artifacts_still_serves(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """The other half of the same check: a healthy run is unaffected."""
    assert _run([], checkout, tmp_path) == 0

    out = capsys.readouterr().out
    assert "walk.jsonl" in out and "statements.md" in out


def test_a_preflight_that_exits_nonzero_fails_closed(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """`lib/preflight.ts` exits 0; anything else means pi never got that far."""
    from associate.harness.pi import PiHarness

    harness = PiHarness(executable=str(tmp_path / "bin" / "pi"))
    harness.start(
        checkout=checkout,
        contract_dir=Path("associate/contract").resolve(),
        session_id="preflight-nonzero",
        export_dir=tmp_path / "runs",
    )

    def boom(executable, argv_tail, env, *, timeout):
        return subprocess.CompletedProcess(argv_tail, 9, stdout="", stderr="pi: bad extension\n")

    harness._run_pi = boom  # type: ignore[assignment]
    harness._check_version = lambda executable: None  # type: ignore[assignment]

    with pytest.raises(ExtensionNotLoadedError) as err:
        harness.submit(
            {
                "id": "t",
                "prompt": "hi",
                "checkout": str(checkout),
                "session_id": "preflight-nonzero",
                "export_dir": str(tmp_path / "runs"),
            }
        )
    assert "9" in str(err.value)
    assert "bad extension" in str(err.value)


# ------------------------------------------------- what the launcher passes pi


def _invocations(tmp_path: Path) -> list[dict]:
    """Every pi invocation the run made, in order: the preflight, then the task."""
    return json.loads((tmp_path / "runs" / "invocation.json").read_text(encoding="utf-8"))


def _invocation(tmp_path: Path) -> dict:
    """The **task** invocation — the last one, after the d8 preflight."""
    return _invocations(tmp_path)[-1]


def _extension_flags(argv: list[str]) -> list[str]:
    return [argv[index + 1] for index, arg in enumerate(argv) if arg == "-e"]


def test_the_launcher_passes_the_flags_the_contract_requires(
    fake_pi, checkout: Path, tmp_path: Path
):
    assert _run(["--session-id", "t12-fixture"], checkout, tmp_path) == 0

    invocation = _invocation(tmp_path)
    argv = invocation["argv"]
    for flag in ("-p", "--mode", "json", "--no-session", "--approve", "--no-context-files"):
        assert flag in argv, f"{flag} missing from {argv}"
    assert invocation["cwd"] == str(checkout.resolve())
    # r16: with ancestor context files disabled, AGENTS.md is injected instead.
    assert invocation["env"]["ASSOCIATE_INJECT_PROMPT"] == "1"
    assert invocation["env"]["ASSOCIATE_SESSION_ID"] == "t12-fixture"
    assert invocation["env"]["ASSOCIATE_CONTRACT_DIR"].endswith("contract")
    assert invocation["env"]["ASSOCIATE_EXPORT_ROOT"] == str(tmp_path / "runs")
    assert "ASSOCIATE_CONTINUE_FROM" not in invocation["env"]
    # The recorded gotcha: pi blocks on an inherited stdin, so it gets DEVNULL.
    assert invocation["stdin_closed"] is True


def test_the_launcher_always_passes_the_extension_explicitly(
    fake_pi, checkout: Path, tmp_path: Path
):
    """d8, half two: `-e <index.ts>` so the extension loads in ANY checkout.

    Relying on the examined checkout carrying its own ``.pi/`` is what made
    ``associate bench --harness pi`` fail in a fixture repo with ``Unknown
    provider "associate"`` and no extension at all.
    """
    from associate.harness.pi import resolve_extension_path

    assert _run([], checkout, tmp_path) == 0

    index = str(resolve_extension_path())
    for invocation in _invocations(tmp_path):
        assert index in _extension_flags(invocation["argv"]), invocation["argv"]


def test_the_preflight_runs_first_and_loads_the_preflight_extension(
    fake_pi, checkout: Path, tmp_path: Path
):
    """d8, half one: readiness is proven by a run that never reaches the model."""
    assert _run([], checkout, tmp_path) == 0

    invocations = _invocations(tmp_path)
    assert len(invocations) == 2, "one preflight, then the task turn"

    preflight, task = invocations
    preflight_flags = _extension_flags(preflight["argv"])
    assert any(path.endswith("lib/preflight.ts") for path in preflight_flags), preflight_flags
    assert not any(
        path.endswith("lib/preflight.ts") for path in _extension_flags(task["argv"])
    ), "the task turn must not exit before the model runs"
    # Same session, same cwd: the preflight writes the ready.json the task
    # run's export directory is checked for.
    assert preflight["env"]["ASSOCIATE_SESSION_ID"] == task["env"]["ASSOCIATE_SESSION_ID"]
    assert preflight["cwd"] == task["cwd"] == str(checkout.resolve())
    assert preflight["stdin_closed"] is True


def test_a_missing_ready_json_fails_closed_before_the_task_runs(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    fake_pi(ready=False)

    assert _run([], checkout, tmp_path) == 2

    captured = capsys.readouterr()
    assert captured.out == "", "a refused run must serve nothing on stdout"
    assert "ready.json" in captured.err
    assert "index.ts" in captured.err
    assert "extension" in captured.err
    assert "approve" in captured.err
    # The task turn is never reached: only the preflight ran.
    assert len(_invocations(tmp_path)) == 1


def test_a_stale_ready_json_cannot_stand_in_for_this_run(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """The gate is evidence *this* preflight produced, not a leftover file."""
    fake_pi(ready=False)
    stale = tmp_path / "runs" / "pinned" / "export"
    stale.mkdir(parents=True)
    (stale / "ready.json").write_text(
        json.dumps({"ok": True, "active_tools": ["associate_ready"], "writer_tools_active": []}),
        encoding="utf-8",
    )

    assert _run(["--session-id", "pinned"], checkout, tmp_path) == 2
    assert "ready.json" in capsys.readouterr().err


def test_the_extension_path_resolves_from_the_repo(monkeypatch: pytest.MonkeyPatch):
    from associate.harness.pi import resolve_extension_path

    monkeypatch.delenv("ASSOCIATE_EXTENSION_PATH", raising=False)
    resolved = resolve_extension_path()
    assert resolved == REPO_ROOT / ".pi" / "extensions" / "associate" / "index.ts"
    assert resolved.is_file()


def test_the_extension_path_honours_the_environment(tmp_path: Path):
    from associate.harness.pi import resolve_extension_path

    override = tmp_path / "elsewhere" / "index.ts"
    override.parent.mkdir(parents=True)
    override.write_text("export default async function () {}\n", encoding="utf-8")

    assert resolve_extension_path({"ASSOCIATE_EXTENSION_PATH": str(override)}) == override


def test_an_extension_path_that_does_not_exist_is_a_harness_error(tmp_path: Path):
    from associate.harness.pi import resolve_extension_path

    with pytest.raises(HarnessError) as err:
        resolve_extension_path({"ASSOCIATE_EXTENSION_PATH": str(tmp_path / "nope.ts")})
    assert "ASSOCIATE_EXTENSION_PATH" in (err.value.remediation or "")


def test_continue_from_reaches_the_extension(fake_pi, checkout: Path, tmp_path: Path):
    prior = tmp_path / "prior-export"
    prior.mkdir()

    assert _run(["--continue-from", str(prior)], checkout, tmp_path) == 0
    assert _invocation(tmp_path)["env"]["ASSOCIATE_CONTINUE_FROM"] == str(prior)


def test_no_provider_flags_without_a_key(
    fake_pi, checkout: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("ASSOCIATE_API_KEY", raising=False)

    assert _run([], checkout, tmp_path) == 0
    assert "--provider" not in _invocation(tmp_path)["argv"]


def test_provider_flags_when_a_key_is_set(
    fake_pi, checkout: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("ASSOCIATE_API_KEY", "dummy-test-key")  # nosec B105
    monkeypatch.setenv("ASSOCIATE_MODEL", "associate")

    assert _run([], checkout, tmp_path) == 0

    argv = _invocation(tmp_path)["argv"]
    assert argv[argv.index("--provider") + 1] == "associate"
    assert argv[argv.index("--model") + 1] == "associate"
    assert "dummy-test-key" not in " ".join(argv)


def test_a_version_mismatch_warns_but_still_serves(
    fake_pi, checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """c39: the launcher warns naming the tested version; it never refuses on it."""
    fake_pi(version="0.99.0")

    assert _run([], checkout, tmp_path) == 0

    captured = capsys.readouterr()
    assert "0.84.2" in captured.err and "0.99.0" in captured.err
    assert "walk.jsonl" in captured.out


def test_a_missing_pi_binary_is_an_environment_error(
    checkout: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))

    assert _run([], checkout, tmp_path) == 2
    assert "pi" in capsys.readouterr().err


# ------------------------------------------------------------------- plumbing


def test_export_root_defaults_beside_the_checkout(checkout: Path):
    root = resolve_export_root(checkout)
    assert root == checkout.parent / ".associate-runs"


def test_an_export_root_inside_the_checkout_is_refused(checkout: Path):
    with pytest.raises(ValueError):
        resolve_export_root(checkout, str(checkout / "runs"))


def test_session_ids_are_safe_path_segments():
    """A traversing id is neutered — and now carries a digest of what it was."""
    assert sanitize_session_id("../../etc/passwd").startswith("etc-passwd-")
    assert sanitize_session_id("sess/01").startswith("sess-01-")
    assert "/" not in sanitize_session_id("../../etc/passwd")


def test_a_safe_session_id_is_returned_verbatim():
    """An id that needs no rewriting keeps its name, so a run stays findable."""
    assert sanitize_session_id("bench-local-read-find-9f2a") == "bench-local-read-find-9f2a"
    assert sanitize_session_id("  t12-fixture  ") == "t12-fixture"


def test_distinct_session_ids_never_collide_after_sanitizing():
    """Concurrent runs keyed ``task/a`` and ``task-a`` used to share one directory.

    Both cleaned to ``task-a``, so two live runs appended to one another's
    ``walk.jsonl`` and overwrote one another's ``statements.json``.
    """
    assert sanitize_session_id("task/a") != sanitize_session_id("task-a")
    assert sanitize_session_id("task-a") == "task-a", "an already-safe id is untouched"


def test_long_session_ids_with_a_shared_prefix_stay_distinct():
    """Truncation at 96 characters was the second collision; the digest closes it."""
    left = "x" * 190 + "-left"
    right = "x" * 190 + "-right"

    assert sanitize_session_id(left) != sanitize_session_id(right)
    assert len(sanitize_session_id(left)) == 96


def test_the_session_id_algorithm_has_a_golden_value():
    """The cross-check for ``lib/session.ts``, which implements the same algorithm.

    If the TypeScript side ever drifts, this literal is what catches it: both
    sides must key one run to one directory.
    """
    digest = hashlib.sha256(b"task/a").hexdigest()[:8]
    assert digest == "aa547b35"
    assert sanitize_session_id("task/a") == "task-a-aa547b35"


def test_a_session_id_that_cleans_away_to_nothing_is_generated():
    generated = sanitize_session_id("///")
    assert generated and "/" not in generated


def test_the_stub_adapter_still_runs_through_the_verb(
    checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    """The verb selects an adapter; it is not hard-wired to pi."""
    assert _run(["--harness", "stub"], checkout, tmp_path) == 0
    assert "walk.jsonl" in capsys.readouterr().out


def test_extension_not_loaded_is_a_harness_error():
    err = ExtensionNotLoadedError("nope", remediation="try --approve")
    assert isinstance(err, HarnessError)
    assert err.remediation == "try --approve"


def test_served_model_id_reads_the_endpoint(
    fake_lane: FakeLaneServer, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("ASSOCIATE_BASE_URL", f"{fake_lane.base_url}/v1")
    assert PiHarness().served_model_id() == "associate"


def test_served_model_id_returns_none_when_the_endpoint_is_unreachable(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("ASSOCIATE_BASE_URL", "http://127.0.0.1:1/v1")
    assert PiHarness().served_model_id() is None


# ------------------------------------------------------------- the real binary


def test_the_real_pi_writes_both_artifacts_against_the_fake_lane(
    fake_lane: FakeLaneServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Criterion 3, honestly.

    The checkout is this repo, because that is where ``.pi/extensions/associate``
    lives and a project extension is discovered relative to pi's working
    directory; the export root is still a temp directory outside it, so the run
    leaves the checkout untouched.

    The fake lane answers plain JSON where pi's ``openai-completions`` path
    wants SSE (see ``tests/test_provider_wire.py``), so the task turn never
    completes. Under deviation d8 that is no longer a refusal: readiness is
    proven by the **preflight**, which loads the extension, writes
    ``ready.json`` at ``session_start`` and exits before any provider request —
    so a dead lane cannot make a loaded extension look unloaded. The run
    therefore serves (exit 0) with the artifacts the extension persisted on its
    own — ``statements.md`` at construction, ``walk.jsonl`` from the exit hook —
    which is exactly claim c30's "persistence is the harness's job".

    This is the honest end-to-end proof of d8 with the real binary: no model
    ever answered, and the gate still passed on evidence the extension wrote.
    """
    require_pi()

    monkeypatch.setenv("ASSOCIATE_BASE_URL", f"{fake_lane.base_url}/v1")
    monkeypatch.setenv("ASSOCIATE_API_KEY", "dummy-test-key")  # nosec B105
    monkeypatch.setenv("ASSOCIATE_MODEL", "associate")
    monkeypatch.setenv("PI_OFFLINE", "1")

    export_root = tmp_path / "runs"
    code = main(
        [
            "run",
            "--checkout",
            str(REPO_ROOT),
            "--export-root",
            str(export_root),
            "--session-id",
            "t12-real-pi",
            "--timeout",
            "90",
        ]
    )

    export_dir = export_root / "t12-real-pi" / "export"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not (export_dir / "walk.jsonl").is_file():
        time.sleep(0.2)

    assert (export_dir / "statements.md").is_file(), "the extension must write statements.md"
    assert (export_dir / "walk.jsonl").is_file(), "the extension must write walk.jsonl"
    assert (export_dir / "ready.json").is_file(), "the preflight must write ready.json"
    assert code == 0, "the preflight proved readiness without any completed model turn"


def test_the_real_pi_help_offers_the_flags_the_launcher_passes():
    """The launcher's flags are pinned against pi 0.84.2; a rename must fail here."""
    require_pi()

    result = subprocess.run(  # nosec B603 B607 - fixed argv, no shell
        ["pi", "--help"],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=60,
        check=False,
    )
    for flag in ("--mode", "--no-session", "--approve", "--no-context-files", "--print"):
        assert flag in result.stdout, f"pi --help no longer documents {flag}"
