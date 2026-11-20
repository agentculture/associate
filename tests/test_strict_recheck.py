"""The strict re-check from evidence-cli (0.8.0 on), held against associate's own files.

Four things are measured here:

* the shared cases file is the same bytes in associate and in the installed
  evidence-cli;
* evidence-cli's ``strict_recheck`` gives every case's expected result;
* ``recheck_strict_export`` agrees with the ``check.json`` of each committed
  strict export, and reports a disagreement for a copy with one changed outcome;
* ``associate check`` and the run result report what the re-check found: whether
  it ran, whether it agrees, what was and was not compared, each disagreement.

A fact with outcome ``pass`` had its evidence copied from a saved result, or its
quote found in one. Agreement means two implementations gave the same record
from the same saved files and the same stored decider answers; neither says a
value is true.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from importlib import metadata, resources
from pathlib import Path
from typing import Any, Callable

import pytest

from associate.accuracy import (
    EVIDENCE_FLOOR,
    accuracy_result,
    is_strict_export,
    load_strict_vectors,
    recheck_strict_export,
    strict_recheck,
)
from associate.cli import main
from associate.contract import contract_dir, load_accuracy

FIXTURES = Path(__file__).parent / "fixtures"
STRICT_EXPORT = FIXTURES / "strict_export"
#: Every committed export whose check.json says strict.
STRICT_EXPORTS = [STRICT_EXPORT, FIXTURES / "accuracy" / "strict_colleague_no_fact_passed_export"]
QUOTE_EXPORT = FIXTURES / "measure" / "answer" / "older" / "export"

#: sha256 of associate/contract/strict_vectors.json, the bytes evidence-cli 0.8.0 bundles.
STRICT_VECTORS_SHA256 = "fb02095abc7470d9671393485ba667436cb16178d1c3d0b356f1f4f79f625103"
PARTS = ["facts", "verdicts", "open_items", "accepted", "counts", "drop_reasons", "judge_counts"]
ADDED_KEYS = (
    "python_recheck_agrees",
    "python_recheck_compared",
    "python_recheck_not_compared",
    "python_recheck_disagreements",
)

OURS = contract_dir() / "strict_vectors.json"
DOC = json.loads(OURS.read_text(encoding="utf-8"))
CASES = DOC["cases"]


def _same(got: Any, want: Any) -> bool:
    """Equal with types kept apart (``1`` is not ``True``, ``1`` is not ``1.0``)."""
    return json.dumps(got, sort_keys=True) == json.dumps(want, sort_keys=True)


# ------------------------------------------------------------- the floor


def test_the_installed_evidence_cli_is_at_the_floor_that_ships_the_strict_recheck():
    assert EVIDENCE_FLOOR == "0.8.0"
    installed = tuple(int(part) for part in metadata.version("evidence-cli").split(".")[:3])
    assert installed >= (0, 8, 0)


# ------------------------------------------------------------- the shared cases


def test_the_strict_cases_file_equals_the_copy_in_the_installed_evidence_package():
    ours = OURS.read_bytes()
    theirs = resources.files("evidence").joinpath("data/strict_vectors.json").read_bytes()
    assert ours == theirs, (
        "associate/contract/strict_vectors.json differs from the copy evidence-cli ships; "
        "the extension's strict check and the Python re-check are no longer tested on the "
        "same cases"
    )
    assert hashlib.sha256(ours).hexdigest() == STRICT_VECTORS_SHA256
    assert hashlib.sha256(theirs).hexdigest() == STRICT_VECTORS_SHA256


def test_evidence_cli_loads_the_same_cases():
    assert _same(load_strict_vectors(), DOC)


def test_there_are_45_named_cases():
    assert len(CASES) == 45
    assert len({case["name"] for case in CASES}) == 45


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_strict_recheck_gives_the_expected_result_of_the_case(case):
    got = strict_recheck(case["input"], DOC["redaction"])
    assert _same(got, case["expect"]), f"case {case['name']}: {got!r}"


# ------------------------------------------------------------- the committed exports


def test_the_listed_exports_are_every_committed_strict_export():
    found = sorted(
        path.parent
        for path in FIXTURES.rglob("check.json")
        if json.loads(path.read_text(encoding="utf-8")).get("mode") == "strict"
    )
    assert found == sorted(STRICT_EXPORTS)
    assert all(is_strict_export(export) for export in STRICT_EXPORTS)
    assert not is_strict_export(QUOTE_EXPORT)


@pytest.mark.parametrize("export", STRICT_EXPORTS, ids=lambda path: path.name)
def test_the_recheck_agrees_with_the_check_json_of_the_export(export):
    got = recheck_strict_export(export, load_accuracy())
    comparison = got["comparison"]
    assert comparison["disagreements"] == []
    assert comparison["agrees"] is True
    assert comparison["compared"] == PARTS
    assert comparison["not_compared"] == []
    recorded = json.loads((export / "check.json").read_text(encoding="utf-8"))
    assert got["recheck"]["counts"] == recorded["strict"]["counts"]
    assert len(comparison["facts"]) == len(recorded["facts"])


def _changed(tmp_path: Path, change: Callable[[dict[str, Any]], None]) -> Path:
    """A copy of the strict export whose check.json was changed by *change*."""
    export = tmp_path / "export"
    shutil.copytree(STRICT_EXPORT, export)
    record = json.loads((export / "check.json").read_text(encoding="utf-8"))
    change(record)
    (export / "check.json").write_text(json.dumps(record), encoding="utf-8")
    return export


def _f2_passes(record: dict[str, Any]) -> None:
    assert record["facts"][1]["strict_outcome"] == "dropped"
    record["facts"][1]["strict_outcome"] = "pass"


F2_DISAGREEMENT = {"id": "f2", "field": "strict_outcome", "recorded": "pass", "recheck": "dropped"}


def test_one_changed_strict_outcome_is_a_reported_disagreement(tmp_path):
    got = recheck_strict_export(_changed(tmp_path, _f2_passes), load_accuracy())
    comparison = got["comparison"]
    assert comparison["agrees"] is False
    assert comparison["disagreements"] == [F2_DISAGREEMENT]
    assert [row["agrees"] for row in comparison["facts"]] == [True, False]


# ------------------------------------------------------------- the run result


def test_the_run_result_says_the_recheck_ran_and_agrees():
    result = accuracy_result(STRICT_EXPORT, load_accuracy())
    accuracy = result["accuracy"]
    assert accuracy["python_recheck_ran"] is True
    assert accuracy["python_recheck_verdict"] == "accepted"
    assert accuracy["not_applicable_reason"] is None
    assert accuracy["check"] == "strict"
    assert accuracy["python_recheck_agrees"] is True
    assert accuracy["python_recheck_compared"] == PARTS
    assert accuracy["python_recheck_not_compared"] == []
    assert accuracy["python_recheck_disagreements"] == []
    assert accuracy["report"]["dropped"] == {"total": 1, "by_reason": {"decider_drop": 1}}
    assert result["strict"]["source"] == "extension"
    assert result["strict"]["recheck"] == {"ran": True, "reason": None, "agrees": True}


def test_the_run_result_names_a_disagreement(tmp_path):
    result = accuracy_result(_changed(tmp_path, _f2_passes), load_accuracy())
    accuracy = result["accuracy"]
    assert accuracy["python_recheck_ran"] is True
    assert accuracy["python_recheck_agrees"] is False
    assert accuracy["python_recheck_disagreements"] == [F2_DISAGREEMENT]
    assert result["strict"]["recheck"] == {"ran": True, "reason": None, "agrees": False}


def test_the_run_result_lists_a_part_the_record_does_not_hold_as_not_compared(tmp_path):
    def drop_counts(record: dict[str, Any]) -> None:
        del record["strict"]["judge_counts"]
        del record["accepted"]

    accuracy = accuracy_result(_changed(tmp_path, drop_counts), load_accuracy())["accuracy"]
    assert accuracy["python_recheck_agrees"] is True
    assert accuracy["python_recheck_not_compared"] == ["accepted", "judge_counts"]
    assert "judge_counts" not in accuracy["python_recheck_compared"]


def _bad_fact_record(record: dict[str, Any]) -> None:
    record["facts"] = [1, 2]


def test_a_strict_export_the_recheck_cannot_read_gives_a_reason_in_the_run_result(tmp_path):
    result = accuracy_result(_changed(tmp_path, _bad_fact_record), load_accuracy())
    accuracy = result["accuracy"]
    assert accuracy["python_recheck_ran"] is False
    assert accuracy["python_recheck_verdict"] is None
    assert "fact record 1" in accuracy["not_applicable_reason"]
    assert accuracy["report"] is None
    assert [accuracy[key] for key in ADDED_KEYS] == [None, None, None, None]
    assert result["strict"]["recheck"]["ran"] is False
    assert "fact record 1" in result["strict"]["recheck"]["reason"]


def test_a_strict_export_with_no_facts_payload_is_not_applicable_in_the_run_result(tmp_path):
    export = _changed(tmp_path, lambda record: None)
    (export / "facts.json").unlink()
    result = accuracy_result(export, load_accuracy())
    assert result["accuracy"]["python_recheck_ran"] is False
    assert "facts.json" in result["accuracy"]["not_applicable_reason"]
    assert result["accuracy"]["python_recheck_agrees"] is None
    assert result["strict"]["recheck"]["ran"] is False
    assert result["strict"]["counts"]["dropped"] == 1


def test_an_export_that_is_not_strict_gains_none_of_the_keys():
    result = accuracy_result(QUOTE_EXPORT, load_accuracy())
    assert "strict" not in result
    assert not set(ADDED_KEYS) & set(result["accuracy"])
    assert "check" not in result["accuracy"]


def test_the_run_text_names_the_comparison(tmp_path):
    from associate.cli._commands.run import _render_accuracy

    agreed = _render_accuracy(accuracy_result(STRICT_EXPORT, load_accuracy())["accuracy"])
    assert agreed == (
        "python re-check accepted (strict facts); agrees with check.json: yes; compared "
        "facts, verdicts, open_items, accepted, counts, drop_reasons, judge_counts; "
        "not compared none; disagreements 0"
    )
    changed = accuracy_result(_changed(tmp_path, _f2_passes), load_accuracy())["accuracy"]
    text = _render_accuracy(changed)
    assert "agrees with check.json: no" in text
    assert text.endswith("disagreements 1 (f2 strict_outcome)")


# ------------------------------------------------------------- associate check


def test_check_json_reports_the_recheck_and_keeps_the_extensions_copy(capsys):
    assert main(["check", str(STRICT_EXPORT), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["check"] == "strict"
    assert out["applicable"] is True
    assert out["python_recheck_ran"] is True
    assert out["python_recheck_agrees"] is True
    assert out["python_recheck_compared"] == PARTS
    assert out["python_recheck_not_compared"] == []
    assert out["python_recheck_disagreements"] == []
    assert [fact["strict_outcome"] for fact in out["facts"]] == ["pass", "dropped"]
    assert out["strict"]["source"] == "extension"
    assert out["strict"]["recheck"] == {"ran": True, "reason": None, "agrees": True}
    assert out["strict_recheck"]["comparison"]["agrees"] is True
    assert out["strict_recheck"]["strict_source"] == "settings"


def test_check_reports_a_changed_outcome_as_a_disagreement(tmp_path, capsys):
    export = _changed(tmp_path, _f2_passes)
    assert main(["check", str(export), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["python_recheck_ran"] is True
    assert out["python_recheck_agrees"] is False
    assert out["python_recheck_disagreements"] == [F2_DISAGREEMENT]
    assert main(["check", str(export)]) == 0
    text = capsys.readouterr().out
    assert "  agrees: no" in text
    assert "  disagreements: 1" in text
    assert "f2 strict_outcome: check.json has 'pass', the re-check has 'dropped'" in text


def test_check_text_on_the_strict_export(capsys):
    assert main(["check", str(STRICT_EXPORT)]) == 0
    text = capsys.readouterr().out
    assert "not applicable" not in text
    assert "  facts: pass 1  keep_marked 0  returned 0  dropped 1  not_judged 0" in text
    assert "  f1  w1  kind checked: direct  passed  pass" in text
    assert (
        "  f2  w1  kind checked: llm  judged (decider's stored answer: none)  "
        "dropped (decider_drop)" in text
    )
    assert "  agrees: yes" in text
    assert "  compared: " + ", ".join(PARTS) in text
    assert "  not compared: none" in text
    assert "  disagreements: none" in text
    assert "it is not a statement that the fact is true" in text
    assert "accuracy" not in text.lower()


def test_check_on_a_strict_export_it_cannot_read_exits_1_with_the_reason(tmp_path, capsys):
    export = _changed(tmp_path, _bad_fact_record)
    for argv in (["check", str(export)], ["check", str(export), "--json"]):
        assert main(argv) == 1
        captured = capsys.readouterr()
        assert captured.out == ""
        assert "fact record 1" in captured.err
        assert "Traceback" not in captured.err
        assert "strict" in captured.err


def test_check_on_a_strict_export_with_damaged_facts_exits_1_with_the_reason(tmp_path, capsys):
    export = _changed(tmp_path, lambda record: None)
    (export / "facts.json").write_text("{not json", encoding="utf-8")
    assert main(["check", str(export), "--json"]) == 1
    captured = capsys.readouterr()
    error = json.loads(captured.err)
    assert "facts.json" in error["message"]
    assert "Traceback" not in captured.err


def test_check_on_a_strict_export_with_no_facts_payload_is_not_applicable(tmp_path, capsys):
    export = _changed(tmp_path, lambda record: None)
    (export / "facts.json").unlink()
    assert main(["check", str(export), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["applicable"] is False
    assert out["python_recheck_ran"] is False
    assert "facts.json" in out["not_applicable_reason"]
    assert [out[key] for key in ADDED_KEYS] == [None, None, None, None]
    assert "strict_recheck" not in out
    assert out["strict"]["recheck"]["ran"] is False
    assert main(["check", str(export)]) == 0
    text = capsys.readouterr().out
    assert "not applicable: " in text
    assert "The Python re-check did not run on these facts." in text
