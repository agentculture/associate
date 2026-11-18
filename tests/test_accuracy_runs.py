"""The re-check after a run reads the prior run and each child run (issue #20, t17).

``associate check`` and ``load_export`` used to read only the current run. A
fact may cite ``prior:wN`` (the ``--continue-from`` export) or ``cN:wM`` (a
child run named by a ``child`` line of the walk); these tests build small
exports by hand and check that the Python re-check resolves those labels the
way the extension's checker does.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from associate.accuracy.check import inspect_export, load_handback_input
from associate.contract import load_accuracy

QUOTE = "the quoted line is here"


def _export(
    root: Path,
    text: str = QUOTE + "\n",
    *,
    facts: list[dict[str, Any]] | None = None,
    child: dict[str, str] | None = None,
) -> Path:
    """One export directory: a format-2 walk with w1 saved, optionally facts and a child link."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "results").mkdir(exist_ok=True)
    (root / "results" / "w1.txt").write_text(text, encoding="utf-8")
    lines: list[dict[str, Any]] = [
        {"format": {"name": "associate-walk", "version": 2}},
        {
            "id": "w1",
            "ts": "2026-11-18T00:00:00+00:00",
            "tool": "read",
            "args": {},
            "result": {},
            "truncated": False,
            "saved_result": "results/w1.txt",
        },
    ]
    if child is not None:
        lines.append({"child": child})
    lines.append({"run": {"duration_ms": 1, "tool_calls": 1, "outcome": "ok", "truncated": False}})
    (root / "walk.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines), encoding="utf-8")
    if facts is not None:
        payload = {"facts": facts}
        (root / "facts.json").write_text(json.dumps(payload), encoding="utf-8")
    return root


def _fact(source: str, quote: str = QUOTE) -> dict[str, Any]:
    return {"id": "f1", "value": "", "source": source, "quote": quote}


def _verdicts(facts: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "facts": facts,
        "verdicts": [
            {"id": "v1", "text": "t", "verdict": "supported", "basis": ["f1"], "closing": True}
        ],
    }


def _write_facts(root: Path, facts: list[dict[str, Any]]) -> None:
    (root / "facts.json").write_text(json.dumps(_verdicts(facts)), encoding="utf-8")


def test_a_prior_fact_is_unknown_without_continue_from_and_passes_with_it(tmp_path: Path):
    prior = _export(tmp_path / "prior" / "export", "prior text, quotable line\n")
    current = _export(tmp_path / "cur" / "export")
    _write_facts(current, [_fact("prior:w1", "prior text, quotable line")])

    without = inspect_export(current, load_accuracy())
    assert without["facts"][0]["verdict"] == "refused"
    assert without["facts"][0]["reason"] == "source_unknown"

    with_prior = inspect_export(current, load_accuracy(), continue_from=prior)
    assert with_prior["facts"][0]["verdict"] == "passed"
    assert with_prior["facts"][0]["run"] == "prior"
    assert with_prior["report"]["facts"]["passed"] == 1


def test_continue_from_may_name_the_session_directory_holding_export(tmp_path: Path):
    _export(tmp_path / "prior" / "export", "prior text, quotable line\n")
    current = _export(tmp_path / "cur" / "export")
    _write_facts(current, [_fact("prior:w1", "prior text, quotable line")])
    result = inspect_export(current, load_accuracy(), continue_from=tmp_path / "prior")
    assert result["facts"][0]["verdict"] == "passed"


def test_a_prior_run_also_holding_the_bare_id_is_flagged_ambiguous(tmp_path: Path):
    prior = _export(tmp_path / "prior" / "export")
    current = _export(tmp_path / "cur" / "export")
    _write_facts(current, [_fact("w1")])
    result = inspect_export(current, load_accuracy(), continue_from=prior)
    assert any("ambiguous" in flag["check"] for flag in result["report"]["flags"])


def test_a_continue_from_without_a_walk_is_skipped_not_an_error(tmp_path: Path):
    current = _export(tmp_path / "cur" / "export")
    _write_facts(current, [_fact("w1")])
    result = inspect_export(current, load_accuracy(), continue_from=tmp_path / "nowhere")
    assert result["facts"][0]["verdict"] == "passed"


def test_a_child_fact_resolves_under_its_cn_label_and_is_listed_with_its_own_counts(
    tmp_path: Path,
):
    child = _export(tmp_path / "child" / "export", "child text, quotable line\n")
    _write_facts(child, [_fact("w1", "child text, quotable line")])
    link = {
        "id": "c1",
        "ts": "2026-11-18T00:00:00+00:00",
        "child_model": "senses",
        "child_walk": str(child / "walk.jsonl"),
        "child_session_id": "child",
    }
    current = _export(tmp_path / "cur" / "export", child=link)
    _write_facts(current, [_fact("c1:w1", "child text, quotable line")])

    result = inspect_export(current, load_accuracy())
    assert result["facts"][0]["verdict"] == "passed"
    assert result["facts"][0]["run"] == "c1"
    children = result["report"]["children"]
    assert [c["label"] for c in children] == ["c1"]
    assert children[0]["report"]["facts"]["passed"] == 1
    # listed, never summed into this run's counts
    assert result["report"]["facts"]["made"] == 1


def test_a_child_label_the_walk_does_not_name_is_unknown(tmp_path: Path):
    current = _export(tmp_path / "cur" / "export")
    _write_facts(current, [_fact("c9:w1")])
    result = inspect_export(current, load_accuracy())
    assert result["facts"][0]["reason"] == "source_unknown"


def test_a_child_with_no_walk_on_disk_reads_as_empty(tmp_path: Path):
    link = {
        "id": "c1",
        "ts": "t",
        "child_model": "worker",
        "child_walk": str(tmp_path / "gone" / "walk.jsonl"),
        "child_session_id": "gone",
    }
    current = _export(tmp_path / "cur" / "export", child=link)
    _write_facts(current, [_fact("c1:w1")])
    result = inspect_export(current, load_accuracy())
    assert result["facts"][0]["reason"] == "source_unknown"


def test_load_handback_input_has_the_shapes_check_handback_accepts(tmp_path: Path):
    prior = _export(tmp_path / "prior" / "export")
    current = _export(tmp_path / "cur" / "export")
    _write_facts(current, [_fact("w1")])
    loaded = load_handback_input(current, continue_from=prior)
    assert set(loaded["prior_runs"]) == {"prior"}
    assert set(loaded["prior_runs"]["prior"]) >= {"entries", "results"}
    assert loaded["children"] == []
    assert loaded["payload"]["facts"][0]["id"] == "f1"


def test_the_check_verb_takes_continue_from(tmp_path: Path, capsys):
    from associate.cli import main

    prior = _export(tmp_path / "prior" / "export", "prior text, quotable line\n")
    current = _export(tmp_path / "cur" / "export")
    _write_facts(current, [_fact("prior:w1", "prior text, quotable line")])

    assert main(["check", str(current), "--json"]) == 0
    without = json.loads(capsys.readouterr().out)
    assert without["facts"][0]["reason"] == "source_unknown"

    assert main(["check", str(current), "--continue-from", str(prior), "--json"]) == 0
    with_prior = json.loads(capsys.readouterr().out)
    assert with_prior["facts"][0]["verdict"] == "passed"
    assert with_prior["facts"][0]["run"] == "prior"
