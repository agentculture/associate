"""Acceptance tests for the harness adapter boundary (t16).

Covers c47: ``associate/harness/base.py`` defines the interface and the stub
adapter satisfies it end to end **without pi installed** — plumbing only, and
labelled as such.
"""

import json
from pathlib import Path

import pytest

from associate import contract
from associate.contract import validate
from associate.harness import available_harnesses, base, get_harness
from associate.harness.stub import StubHarness


def _task(tmp_path: Path) -> dict:
    return {
        "id": "t-1",
        "prompt": "find the tool registry",
        "checkout": str(tmp_path / "checkout"),
        "session_id": "s-abc",
        "export_dir": str(tmp_path / "exports" / "s-abc"),
    }


def test_base_module_imports_no_pi():
    source = Path(base.__file__).read_text(encoding="utf-8")
    assert "import pi" not in source
    assert "pi_coding_agent" not in source


def test_harness_is_abstract_and_stub_satisfies_it():
    assert issubclass(StubHarness, base.Harness)
    with pytest.raises(TypeError):
        base.Harness()  # abstract: start/submit/collect unimplemented

    for method in ("start", "submit", "collect"):
        assert callable(getattr(StubHarness, method))


def test_registry_knows_the_stub_and_lists_names_on_a_miss():
    assert "stub" in available_harnesses()
    assert get_harness("stub") is StubHarness

    with pytest.raises(KeyError) as excinfo:
        get_harness("bogus")
    message = str(excinfo.value)
    assert "bogus" in message
    assert "stub" in message


def test_stub_runs_end_to_end_and_writes_valid_artifacts(tmp_path):
    task = _task(tmp_path)
    harness = get_harness("stub")()
    harness.start(
        checkout=Path(task["checkout"]),
        contract_dir=contract.contract_dir(),
        session_id=task["session_id"],
        export_dir=Path(task["export_dir"]),
    )
    harness.submit(task)
    result = harness.collect()

    assert set(result) >= {"walk_path", "statements_path", "outcome", "plumbing_only"}
    assert result["plumbing_only"] is True
    assert result["outcome"] == "ok"

    walk_path = Path(result["walk_path"])
    statements_path = Path(result["statements_path"])
    assert walk_path.name == "walk.jsonl"
    assert statements_path.name == "statements.json"
    assert walk_path.is_file() and statements_path.is_file()

    lines = walk_path.read_text(encoding="utf-8").splitlines()
    entries = [json.loads(line) for line in lines]
    run_record = entries.pop()["run"]

    entry_schema = contract.walk_entry_schema()
    for entry in entries:
        assert validate.validate(entry, entry_schema) == [], entry
    assert [e["id"] for e in entries] == [f"w{i}" for i in range(1, len(entries) + 1)]
    assert validate.validate(run_record, contract.walk_run_schema()) == []
    assert run_record["tool_calls"] == len(entries)

    statements = json.loads(statements_path.read_text(encoding="utf-8"))
    assert validate.validate(statements, contract.load_schema("statements")) == []
    assert statements["plumbing_only"] is True
    # Every evidence reference points at a walk id the stub actually wrote.
    written = {e["id"] for e in entries}
    for statement in statements["statements"]:
        assert set(statement["evidence"]) <= written
        expected = "referenced" if statement["evidence"] else "unreferenced"
        assert statement["status"] == expected


def test_stub_rejects_a_task_that_fails_the_task_schema(tmp_path):
    task = _task(tmp_path)
    del task["prompt"]
    harness = StubHarness()
    harness.start(
        checkout=Path(tmp_path / "checkout"),
        contract_dir=contract.contract_dir(),
        session_id="s-abc",
        export_dir=tmp_path / "exports" / "s-abc",
    )
    with pytest.raises(validate.ValidationError):
        harness.submit(task)


def test_stub_requires_start_before_submit_and_submit_before_collect(tmp_path):
    harness = StubHarness()
    with pytest.raises(RuntimeError):
        harness.submit(_task(tmp_path))
    harness.start(
        checkout=tmp_path / "checkout",
        contract_dir=contract.contract_dir(),
        session_id="s-abc",
        export_dir=tmp_path / "exports" / "s-abc",
    )
    with pytest.raises(RuntimeError):
        harness.collect()


def test_stub_replays_a_caller_supplied_script(tmp_path):
    script = [
        {"tool": "shell", "args": {"argv": ["rg", "registry"]}, "result": {"content": "hit"}},
        {"tool": "read", "args": {"path": "a.py"}, "result": {"content": "x"}, "truncated": True},
    ]
    harness = StubHarness(script=script, statements=[{"text": "one", "evidence": ["w2"]}])
    export_dir = tmp_path / "exports" / "s-1"
    harness.start(
        checkout=tmp_path / "checkout",
        contract_dir=contract.contract_dir(),
        session_id="s-1",
        export_dir=export_dir,
    )
    harness.submit(_task(tmp_path))
    result = harness.collect()

    entries = [json.loads(line) for line in Path(result["walk_path"]).read_text().splitlines()]
    run_record = entries.pop()["run"]
    assert [e["tool"] for e in entries] == ["shell", "read"]
    assert entries[1]["truncated"] is True
    assert run_record["truncated"] is True
    assert run_record["duration_ms"] >= 0

    statements = json.loads(Path(result["statements_path"]).read_text())
    assert statements["statements"][0]["status"] == "referenced"


def test_stub_export_dir_is_created_and_session_scoped(tmp_path):
    export_dir = tmp_path / "deep" / "exports" / "s-9"
    harness = StubHarness()
    harness.start(
        checkout=tmp_path / "checkout",
        contract_dir=contract.contract_dir(),
        session_id="s-9",
        export_dir=export_dir,
    )
    assert export_dir.is_dir()
    harness.submit(_task(tmp_path))
    result = harness.collect()
    assert Path(result["walk_path"]).parent == export_dir
