"""``associate run`` carries the accuracy result (issue #20, t17; spec h32).

The adapter's result now holds the harness-rendered answer, the report counts
from the Python re-check, whether that re-check ran and its verdict, and a
named outcome for a hand-back refused after the allowed rounds, which exits 3.
The stub writes the new walk, facts and report shapes; a scripted fake ``pi``
stands in for the extension's files on the Pi path. No model runs here.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path
from typing import Any

import pytest

from associate import contract
from associate import harness as harness_pkg
from associate.cli import main
from associate.cli._errors import EXIT_ENV_ERROR, EXIT_HANDBACK_REFUSED, EXIT_USER_ERROR
from associate.contract import validate
from associate.harness.pi import PiHarness
from associate.harness.stub import StubHarness

# ---------------------------------------------------------------- helpers


def _task(tmp_path: Path, session: str = "s1") -> dict[str, str]:
    return {
        "id": "t-1",
        "prompt": "find it",
        "checkout": str(tmp_path / "checkout"),
        "session_id": session,
        "export_dir": str(tmp_path / "exports"),
    }


def _run_stub(tmp_path: Path, **kwargs: Any) -> tuple[dict[str, Any], Path]:
    export = tmp_path / "exports" / "s1"
    harness = StubHarness(**kwargs)
    harness.start(
        checkout=tmp_path / "checkout",
        contract_dir=contract.contract_dir(),
        session_id="s1",
        export_dir=export,
    )
    harness.submit(_task(tmp_path))
    return harness.collect(), export


def _json(capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    return json.loads(capsys.readouterr().out)


class RefusingStub(StubHarness):
    """A stub whose hand-back has an unsupported fact."""

    name = "stubrefuse"

    def __init__(self, check_mode: str | None = None) -> None:
        super().__init__(check_mode=check_mode, unsupported_fact=True)


class RefusingWriter(RefusingStub):
    """The same, and it also changes a file in the checkout it is handed."""

    def submit(self, task: dict[str, Any]) -> None:
        (Path(task["checkout"]) / "NEW.md").write_text("written by the run\n", encoding="utf-8")
        super().submit(task)


@pytest.fixture
def refusing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(harness_pkg._REGISTRY, "stubrefuse", lambda: RefusingStub)
    monkeypatch.setitem(harness_pkg._REGISTRY, "stubwriter", lambda: RefusingWriter)


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    root.mkdir()
    (root / "README.md").write_text("# fixture\n", encoding="utf-8")
    return root


def _cli(
    checkout: Path, tmp_path: Path, harness: str, *extra: str, model: str | None = "senses"
) -> int:
    argv = [
        "run",
        "--harness",
        harness,
        "--checkout",
        str(checkout),
        "--export-root",
        str(tmp_path / "runs"),
        "--session-id",
        "s1",
        "--json",
    ]
    if model:
        argv += ["--model", model]
    return main([*argv, *extra])


# ------------------------------------------------- the stub's artifact shapes


def _format_schema() -> dict[str, Any]:
    walk = contract.load_schema("walk")
    return {**walk["$defs"]["format"], "$defs": walk["$defs"]}


def test_the_stub_writes_a_format_2_walk_with_purposes_and_saved_results(tmp_path: Path):
    result, export = _run_stub(tmp_path)
    lines = [json.loads(x) for x in Path(result["walk_path"]).read_text().splitlines()]
    assert lines[0] == {"format": {"name": "associate-walk", "version": 2}}
    assert validate.validate(lines[0]["format"], _format_schema()) == []
    entries = [x for x in lines if "id" in x]
    assert [e["id"] for e in entries] == [f"w{i}" for i in range(1, len(entries) + 1)]
    for entry in entries:
        assert validate.validate(entry, contract.walk_entry_schema()) == [], entry
        assert isinstance(entry["purpose"], str)
        assert entry["purpose"]
    saved = [e for e in entries if "saved_result" in e]
    assert saved, "the stub saves at least one result text"
    for entry in saved:
        assert (export / entry["saved_result"]).is_file()
    assert any(e.get("source_kind") == "file" for e in entries)
    assert validate.validate(lines[-1]["run"], contract.walk_run_schema()) == []


def test_the_stub_facts_and_report_validate_against_their_schemas(tmp_path: Path):
    _, export = _run_stub(tmp_path)
    facts = json.loads((export / "facts.json").read_text())
    assert validate.validate(facts, contract.load_schema("facts")) == []
    report = json.loads((export / "report.json").read_text())
    assert validate.validate(report, contract.load_schema("report")) == []
    assert report["unchecked_text"]["final_message_sentences"] == 0
    check = json.loads((export / "check.json").read_text())
    assert check["outcome"] == "accepted"
    assert (export / "answer.md").read_text().strip()


def test_the_stub_result_carries_the_accuracy_fields(tmp_path: Path):
    result, export = _run_stub(tmp_path, check_mode="enforce")
    assert result["plumbing_only"] is True
    assert result["check_mode"] == "enforce"
    assert result["answer"] == (export / "answer.md").read_text()
    assert result["handback_outcome"] == "accepted"
    acc = result["accuracy"]
    assert acc["python_recheck_ran"] is True
    assert acc["python_recheck_verdict"] == "accepted"
    assert acc["check_mode_used"] == "enforce"
    assert acc["report"]["python_recheck_ran"] is True
    assert validate.validate(acc["report"], contract.load_schema("report")) == []
    assert acc["report"]["facts"]["made"] >= 1
    assert acc["unchecked_text_source"] == "extension"
    assert acc["report"]["unchecked_text"] == {
        "summary_sentences": acc["report"]["unchecked_text"]["summary_sentences"],
        "final_message_sentences": 0,
    }


def test_a_refused_stub_handback_in_enforce_mode_ends_the_run_with_no_answer(tmp_path: Path):
    result, export = _run_stub(tmp_path, check_mode="enforce", unsupported_fact=True)
    assert result["outcome"] == "refused"
    assert result["handback_outcome"] == "refused_after_rounds"
    assert result["answer"] is None
    assert not (export / "answer.md").exists()
    check = json.loads((export / "check.json").read_text())
    assert check["outcome"] == "refused"
    assert check["run_ended"] is True
    assert result["accuracy"]["python_recheck_verdict"] == "refused"
    assert result["accuracy"]["report"]["facts"]["refused"] >= 1


def test_the_same_stub_handback_in_report_mode_is_accepted_with_would_refuse(tmp_path: Path):
    result, export = _run_stub(tmp_path, check_mode="report", unsupported_fact=True)
    assert result["outcome"] == "ok"
    assert result["handback_outcome"] == "accepted"
    assert result["answer"]
    check = json.loads((export / "check.json").read_text())
    assert check["would_refuse"]


# ------------------------------------------------------------- the CLI verb


def test_run_json_carries_answer_counts_recheck_and_outcome(
    checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    assert _cli(checkout, tmp_path, "stub") == 0
    out = _json(capsys)
    assert out["answer"]
    assert out["answer_path"].endswith("answer.md")
    assert out["handback_outcome"] == "accepted"
    assert out["accuracy"]["python_recheck_ran"] is True
    assert out["accuracy"]["python_recheck_verdict"] == "accepted"
    assert out["accuracy"]["report"]["facts"]["made"] >= 1
    assert out["check_mode"] is None


def test_check_mode_flag_is_recorded_in_the_result(
    checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    assert _cli(checkout, tmp_path, "stub", "--check-mode", "enforce") == 0
    out = _json(capsys)
    assert out["check_mode"] == "enforce"
    assert out["accuracy"]["check_mode_used"] == "enforce"


def test_support_score_is_null_in_the_result_without_the_flag(
    checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    assert _cli(checkout, tmp_path, "stub") == 0
    assert _json(capsys)["support_score"] is None


@pytest.mark.parametrize("setting", ["on", "off"])
def test_support_score_flag_is_recorded_in_the_result(
    checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str], setting: str
):
    assert _cli(checkout, tmp_path, "stub", "--support-score", setting) == 0
    assert _json(capsys)["support_score"] == setting


@pytest.mark.parametrize("value", ["yes", "ON", "true", ""])
def test_a_bad_support_score_exits_1(checkout: Path, tmp_path: Path, value: str):
    with pytest.raises(SystemExit) as raised:
        _cli(checkout, tmp_path, "stub", "--support-score", value)
    assert raised.value.code == EXIT_USER_ERROR


def test_a_bad_check_mode_exits_1(checkout: Path, tmp_path: Path):
    with pytest.raises(SystemExit) as raised:
        _cli(checkout, tmp_path, "stub", "--check-mode", "strict")
    assert raised.value.code == EXIT_USER_ERROR


def test_a_refused_handback_exits_3_and_still_prints_the_result(
    checkout: Path, tmp_path: Path, refusing, capsys: pytest.CaptureFixture[str]
):
    assert EXIT_HANDBACK_REFUSED == 3
    assert _cli(checkout, tmp_path, "stubrefuse", "--check-mode", "enforce") == 3
    captured = capsys.readouterr()
    out = json.loads(captured.out)
    assert out["outcome"] == "refused"
    assert out["handback_outcome"] == "refused_after_rounds"
    assert out["answer"] is None
    assert "refused" in captured.err
    assert "check.json" in captured.err


def test_a_refused_handback_in_text_mode_exits_3_and_prints_the_result(
    checkout: Path, tmp_path: Path, refusing, capsys: pytest.CaptureFixture[str]
):
    argv = [
        "run",
        "--harness",
        "stubrefuse",
        "--checkout",
        str(checkout),
        "--export-root",
        str(tmp_path / "runs"),
        "--model",
        "senses",
        "--check-mode",
        "enforce",
    ]
    assert main(argv) == 3
    out = capsys.readouterr().out
    assert "handback_outcome=refused_after_rounds" in out


def test_exit_codes_0_1_and_2_keep_their_meaning(
    checkout: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    assert _cli(checkout, tmp_path, "stub") == 0
    capsys.readouterr()
    assert _cli(checkout, tmp_path, "bogus") == EXIT_USER_ERROR
    assert _cli(checkout, tmp_path, "stub", model="nope") == EXIT_USER_ERROR
    inside = checkout / "runs"
    argv = ["run", "--harness", "stub", "--checkout", str(checkout), "--export-root", str(inside)]
    assert main([*argv, "--json"]) == EXIT_ENV_ERROR


def _git(cwd: Path, *args: str) -> str:
    done = subprocess.run(  # nosec B603 B607 - test helper, fixed argv
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True
    )
    return done.stdout.strip()


def test_a_writing_run_with_a_refused_handback_is_kept_and_not_merged(
    tmp_path: Path, refusing, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    empty = tmp_path / "empty.gitconfig"
    empty.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    repo = tmp_path / "ws" / "proj"
    repo.mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("# fixture\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(
        repo,
        "-c",
        "user.name=Op",
        "-c",
        "user.email=op@example.invalid",
        "commit",
        "-q",
        "-m",
        "initial",
    )
    before = _git(repo, "rev-parse", "main")
    rc = _cli(repo, tmp_path, "stubwriter", "--check-mode", "enforce", model="worker")
    assert rc == 3
    out = _json(capsys)
    assert out["merge"] == "kept"
    assert out["handback_outcome"] == "refused_after_rounds"
    assert _git(repo, "rev-parse", "main") == before
    assert not (repo / "NEW.md").exists()
    assert Path(out["worktree"]).is_dir()


# --------------------------------------------------------- the Pi adapter

_FAKE_PI = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

SCENARIO = {scenario!r}
argv = sys.argv[1:]
if "--version" in argv:
    print("1.5.2")
    raise SystemExit(0)
root = Path(os.environ["ASSOCIATE_EXPORT_ROOT"])
export = root / os.environ["ASSOCIATE_SESSION_ID"] / "export"
export.mkdir(parents=True, exist_ok=True)
(root / "env-seen.json").write_text(
    json.dumps({{"mode": os.environ.get("ASSOCIATE_CHECK_MODE"),
                "support": os.environ.get("ASSOCIATE_SUPPORT_SCORE")}}), encoding="utf-8"
)
ready = {{
    "ok": True, "extension_version": "0.1.0", "contract_version": 1,
    "tools": ["associate_ready", "finish"], "active_tools": ["associate_ready", "finish"],
    "writer_tools_active": [], "session": {{"id": "x", "export_dir": str(export)}},
}}
(export / "ready.json").write_text(json.dumps(ready), encoding="utf-8")
print(json.dumps({{"type": "session", "version": 3, "id": "fake", "cwd": os.getcwd()}}))
if any(a.endswith("preflight.ts") for a in argv):
    raise SystemExit(0)
for name, content in SCENARIO["files"].items():
    target = export / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
print(json.dumps({{"type": "agent_end", "messages": []}}))
"""

_QUOTE = "the quoted line is here"


def _scenario(*, refused: bool) -> dict[str, Any]:
    entry = {
        "id": "w1",
        "ts": "2026-11-18T00:00:00+00:00",
        "tool": "read",
        "purpose": "read the file",
        "args": {},
        "result": {},
        "truncated": False,
        "source_kind": "file",
        "saved_result": "results/w1.txt",
    }
    outcome = "refused" if refused else "ok"
    walk = [
        {"format": {"name": "associate-walk", "version": 2}},
        entry,
        {"run": {"duration_ms": 1, "tool_calls": 1, "outcome": outcome, "truncated": False}},
    ]
    facts = {
        "summary": "one. two.",
        "facts": [{"id": "f1", "value": "", "source": "w1", "quote": _QUOTE}],
        "verdicts": [
            {"id": "v1", "text": "t", "verdict": "supported", "basis": ["f1"], "closing": True}
        ],
    }
    # The extension's own counts are deliberately wrong: the result must report
    # the Python re-check's, and only copy unchecked_text through.
    wrong = {"made": 99, "checked": 99, "passed": 99, "refused": 0, "unchecked": 0}
    report = {
        "facts": wrong,
        "conclusions": {"made": 1, "supported": 1, "refuted": 0, "open": 0},
        "statements": {"made": 1, "without_fact": 0},
        "unchecked_text": {"summary_sentences": 7, "final_message_sentences": 3},
        "by_source_kind": {k: wrong for k in ("file", "tool", "web", "memory", "agent", "harness")},
        "flags": [],
        "python_recheck_ran": False,
    }
    check: dict[str, Any] = {"mode": "enforce", "mode_source": "env", "accepted": not refused}
    if refused:
        check.update(outcome="refused", round=3, rounds_left=0, run_ended=True)
    else:
        check.update(outcome="accepted", would_refuse=[])
    files = {
        "walk.jsonl": "".join(json.dumps(x) + "\n" for x in walk),
        "results/w1.txt": _QUOTE + "\n",
        "statements.md": "# s\n",
        "statements.json": json.dumps({"statements": [], "citations": [], "not_fully_read": False}),
        "facts.json": json.dumps(
            facts
            if not refused
            else {
                **facts,
                "facts": [
                    {"id": "f1", "value": "", "source": "w1", "quote": "a line that is nowhere"}
                ],
            }
        ),
        "check.json": json.dumps(check),
        "report.json": json.dumps(report),
    }
    if not refused:
        files["answer.md"] = "ANSWER TEXT\n"
    return {"files": files}


def _pi(tmp_path: Path, *, refused: bool, env: dict[str, str] | None = None, **kwargs: Any):
    script = tmp_path / "bin" / "pi"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(_FAKE_PI.format(scenario=_scenario(refused=refused)), encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    harness = PiHarness(executable=str(script), env={**os.environ, **(env or {})}, **kwargs)
    export_root = tmp_path / "exports"
    (tmp_path / "checkout").mkdir(exist_ok=True)
    harness.start(
        checkout=tmp_path / "checkout",
        contract_dir=contract.contract_dir(),
        session_id="s1",
        export_dir=export_root,
    )
    harness.submit(_task(tmp_path))
    return harness.collect(), export_root


def test_the_pi_result_reports_the_python_counts_and_copies_unchecked_text(tmp_path: Path):
    result, _ = _pi(tmp_path, refused=False, check_mode="report")
    assert result["answer"] == "ANSWER TEXT\n"
    assert result["handback_outcome"] == "accepted"
    acc = result["accuracy"]
    assert acc["python_recheck_ran"] is True
    assert acc["python_recheck_verdict"] == "accepted"
    assert acc["report"]["facts"] == {
        "made": 1,
        "checked": 1,
        "passed": 1,
        "refused": 0,
        "unchecked": 0,
    }
    assert acc["report"]["python_recheck_ran"] is True
    assert acc["report"]["unchecked_text"] == {"summary_sentences": 7, "final_message_sentences": 3}
    assert acc["unchecked_text_source"] == "extension"
    assert validate.validate(acc["report"], contract.load_schema("report")) == []


def test_the_pi_result_names_a_handback_refused_after_the_rounds(tmp_path: Path):
    result, _ = _pi(tmp_path, refused=True, check_mode="enforce")
    assert result["outcome"] == "refused"
    assert result["handback_outcome"] == "refused_after_rounds"
    assert result["answer"] is None
    assert result["accuracy"]["python_recheck_verdict"] == "refused"
    assert result["accuracy"]["report"]["facts"]["refused"] == 1


def test_check_mode_reaches_the_extension_as_an_environment_variable(tmp_path: Path):
    _, root = _pi(tmp_path, refused=False, check_mode="enforce")
    assert json.loads((root / "env-seen.json").read_text())["mode"] == "enforce"


def test_an_operators_ambient_check_mode_is_not_inherited(tmp_path: Path):
    _, root = _pi(tmp_path, refused=False, env={"ASSOCIATE_CHECK_MODE": "enforce"})
    assert json.loads((root / "env-seen.json").read_text())["mode"] is None


@pytest.mark.parametrize("setting", ["on", "off"])
def test_support_score_reaches_the_extension_as_an_environment_variable(
    tmp_path: Path, setting: str
):
    _, root = _pi(tmp_path, refused=False, support_score=setting)
    assert json.loads((root / "env-seen.json").read_text())["support"] == setting


@pytest.mark.parametrize("ambient", ["on", "off"])
def test_an_operators_ambient_support_score_is_not_inherited(tmp_path: Path, ambient: str):
    _, root = _pi(tmp_path, refused=False, env={"ASSOCIATE_SUPPORT_SCORE": ambient})
    assert json.loads((root / "env-seen.json").read_text())["support"] is None


def test_the_run_flag_wins_over_an_ambient_support_score(tmp_path: Path):
    _, root = _pi(
        tmp_path, refused=False, env={"ASSOCIATE_SUPPORT_SCORE": "on"}, support_score="off"
    )
    assert json.loads((root / "env-seen.json").read_text())["support"] == "off"


def test_the_pi_adapter_refuses_any_other_support_score_value():
    from associate.harness.base import HarnessError

    with pytest.raises(HarnessError, match="support-score"):
        PiHarness(support_score="maybe")


def test_an_export_with_no_facts_is_not_applicable_not_an_error(tmp_path: Path):
    from associate.accuracy import accuracy_result

    export = tmp_path / "e"
    export.mkdir()
    (export / "walk.jsonl").write_text(
        json.dumps(
            {"run": {"duration_ms": 1, "tool_calls": 0, "outcome": "ok", "truncated": False}}
        )
        + "\n",
        encoding="utf-8",
    )
    result = accuracy_result(export, contract.load_accuracy())
    assert result["handback_outcome"] == "none"
    assert result["answer"] is None
    assert result["accuracy"]["python_recheck_ran"] is False
    assert result["accuracy"]["python_recheck_verdict"] is None
    assert result["accuracy"]["not_applicable_reason"]
    assert result["accuracy"]["report"] is None


def test_a_refused_round_with_rounds_left_is_named_unresolved_and_does_not_exit_3(tmp_path: Path):
    from associate.accuracy import accuracy_result

    result, root = _pi(tmp_path, refused=True, check_mode="enforce")
    export = root / "s1" / "export"
    check = json.loads((export / "check.json").read_text())
    check["run_ended"] = False
    (export / "check.json").write_text(json.dumps(check))
    again = accuracy_result(export, contract.load_accuracy())
    assert again["handback_outcome"] == "refused_unresolved"
