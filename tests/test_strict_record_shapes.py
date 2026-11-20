"""What evidence-cli 0.9.0 changed for callers of the strict re-check, as associate reports it.

Three surfaces are held against the same exports: the library call
(``recheck_strict_export``), ``associate check`` and the ``accuracy`` block of a
run result.

* ``agrees`` has three values. ``null`` is neither agreement nor disagreement:
  a part of ``check.json`` was not compared, and the reason is given.
* A record with a part not compared, or a fact with no record, is incomplete.
* A strict export where facts do not apply (no ``facts.json``, a walk format
  that is not supported) is reported as not re-checked, with the reason.
* ``returned_before_source`` says whether the facts returned in earlier rounds
  were read from ``check.json`` or inferred.

Agreement means two implementations gave the same record from the same saved
files; it never says a value is true.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

from associate.accuracy import accuracy_result, recheck_strict_export
from associate.cli import main
from associate.contract import load_accuracy

STRICT_EXPORT = Path(__file__).parent / "fixtures" / "strict_export"

Change = Callable[[dict[str, Any]], Optional[dict[str, Any]]]

NEW_KEYS = (
    "python_recheck_agrees_reason",
    "python_recheck_incomplete",
    "python_recheck_not_compared_reasons",
    "python_recheck_facts_without_record",
    "python_recheck_returned_before_source",
)


def _full(record: dict[str, Any]) -> None:
    """The record as the extension wrote it."""


def _mode_only(record: dict[str, Any]) -> dict[str, Any]:
    return {"mode": "strict"}


def _mode_and_accepted(record: dict[str, Any]) -> dict[str, Any]:
    return {"mode": "strict", "accepted": True}


def _last_fact_record_removed(record: dict[str, Any]) -> None:
    assert record["facts"].pop()["id"] == "f2"


def _with_returned_before(record: dict[str, Any]) -> None:
    record["strict"]["returned_before"] = []


def _export(tmp_path: Path, change: Change) -> Path:
    """A copy of the strict export whose check.json was changed (or replaced) by *change*."""
    export = tmp_path / "export"
    shutil.copytree(STRICT_EXPORT, export)
    record = json.loads((export / "check.json").read_text(encoding="utf-8"))
    replaced = change(record)
    written = record if replaced is None else replaced
    (export / "check.json").write_text(json.dumps(written), encoding="utf-8")
    return export


def _without_facts(tmp_path: Path) -> Path:
    export = _export(tmp_path, _full)
    (export / "facts.json").unlink()
    return export


def _unsupported_format(tmp_path: Path) -> Path:
    export = _export(tmp_path, _full)
    walk = export / "walk.jsonl"
    lines = walk.read_text(encoding="utf-8").splitlines()
    marker = json.loads(lines[0])
    assert marker["format"]["version"] == 2
    marker["format"]["version"] = 99
    walk.write_text("\n".join([json.dumps(marker), *lines[1:]]) + "\n", encoding="utf-8")
    return export


#: change, agrees, incomplete
SHAPES = [
    pytest.param(_full, True, False, id="full_record"),
    pytest.param(_mode_only, None, True, id="mode_only"),
    pytest.param(_mode_and_accepted, None, True, id="mode_and_accepted"),
    pytest.param(_last_fact_record_removed, False, True, id="last_fact_record_removed"),
]
NOT_APPLICABLE = [
    pytest.param(_without_facts, "facts.json", id="no_facts_json"),
    pytest.param(_unsupported_format, "99", id="unsupported_walk_format"),
]


def _check_json(export: Path, capsys) -> dict[str, Any]:
    assert main(["check", str(export), "--json"]) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    return json.loads(captured.out)


def _check_text(export: Path, capsys) -> str:
    assert main(["check", str(export)]) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    return captured.out


# ------------------------------------------------------------- the four record shapes


@pytest.mark.parametrize("change, agrees, incomplete", SHAPES)
def test_the_library_call_gives_the_verdict_of_the_record_shape(
    tmp_path, change, agrees, incomplete
):
    got = recheck_strict_export(_export(tmp_path, change), load_accuracy())
    assert got["applicable"] is True
    assert got["comparison"]["agrees"] is agrees
    assert got["comparison"]["incomplete"] is incomplete
    assert (got["comparison"]["agrees_reason"] is None) is (agrees is not None)


@pytest.mark.parametrize("change, agrees, incomplete", SHAPES)
def test_check_json_gives_the_verdict_of_the_record_shape(
    tmp_path, capsys, change, agrees, incomplete
):
    out = _check_json(_export(tmp_path, change), capsys)
    assert out["python_recheck_ran"] is True
    assert out["python_recheck_agrees"] is agrees
    assert out["python_recheck_incomplete"] is incomplete
    assert (out["python_recheck_agrees_reason"] is None) is (agrees is not None)
    assert out["strict"]["recheck"]["agrees"] is agrees


@pytest.mark.parametrize("change, agrees, incomplete", SHAPES)
def test_the_run_result_gives_the_verdict_of_the_record_shape(tmp_path, change, agrees, incomplete):
    result = accuracy_result(_export(tmp_path, change), load_accuracy())
    accuracy = result["accuracy"]
    assert accuracy["python_recheck_ran"] is True
    assert accuracy["python_recheck_agrees"] is agrees
    assert accuracy["python_recheck_incomplete"] is incomplete
    assert (accuracy["python_recheck_agrees_reason"] is None) is (agrees is not None)
    assert result["strict"]["recheck"]["agrees"] is agrees


def test_a_record_holding_only_the_mode_names_why_nothing_agrees(tmp_path, capsys):
    out = _check_json(_export(tmp_path, _mode_only), capsys)
    assert out["python_recheck_agrees_reason"] == "nothing in check.json could be compared"
    assert out["python_recheck_compared"] == []
    assert out["python_recheck_disagreements"] == []
    assert out["python_recheck_not_compared_reasons"]["facts"] == "absent from check.json"


def test_a_record_holding_the_mode_and_accepted_names_the_parts_not_compared(tmp_path):
    accuracy = accuracy_result(_export(tmp_path, _mode_and_accepted), load_accuracy())["accuracy"]
    assert accuracy["python_recheck_compared"] == ["accepted"]
    assert accuracy["python_recheck_agrees_reason"] == (
        "not compared: facts, verdicts, open_items, counts, drop_reasons, judge_counts"
    )
    assert accuracy["python_recheck_disagreements"] == []


def test_the_row_names_the_fact_without_a_record_in_check_json(tmp_path, capsys):
    out = _check_json(_export(tmp_path, _last_fact_record_removed), capsys)
    assert out["python_recheck_facts_without_record"] == ["f2"]
    assert out["python_recheck_disagreements"] == [
        {
            "id": None,
            "field": "facts",
            "recorded": 1,
            "recheck": 2,
            "without_record": ["f2"],
            "not_in_payload": [],
        }
    ]


def test_the_row_names_the_fact_without_a_record_in_the_run_result(tmp_path):
    export = _export(tmp_path, _last_fact_record_removed)
    accuracy = accuracy_result(export, load_accuracy())["accuracy"]
    assert accuracy["python_recheck_facts_without_record"] == ["f2"]
    assert [row["without_record"] for row in accuracy["python_recheck_disagreements"]] == [["f2"]]
    assert accuracy["python_recheck_not_compared"] == [
        "verdicts",
        "open_items",
        "counts",
        "drop_reasons",
        "judge_counts",
    ]


def test_every_new_key_is_in_both_results_of_a_strict_export(capsys):
    out = _check_json(STRICT_EXPORT, capsys)
    accuracy = accuracy_result(STRICT_EXPORT, load_accuracy())["accuracy"]
    assert [key for key in NEW_KEYS if key not in out] == []
    assert [key for key in NEW_KEYS if key not in accuracy] == []


# ------------------------------------------------------------- the three text verdicts

AGREES_LINE = "  agrees: yes"
DISAGREES_LINE = "  agrees: no, the rows below differ"
NEITHER_START = "  agrees: neither yes nor no ("


def _verdict_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith("  agrees: ")]


def test_check_text_says_agrees_for_the_full_record(tmp_path, capsys):
    text = _check_text(_export(tmp_path, _full), capsys)
    assert _verdict_lines(text) == [AGREES_LINE]
    assert "record incomplete" not in text


def test_check_text_says_disagrees_and_names_the_fact_without_a_record(tmp_path, capsys):
    text = _check_text(_export(tmp_path, _last_fact_record_removed), capsys)
    assert _verdict_lines(text) == [DISAGREES_LINE]
    assert "    facts: check.json has 1, the re-check has 2; no record for f2" in text
    assert (
        "  record incomplete: not compared verdicts, open_items, counts, drop_reasons, "
        "judge_counts; facts without a record: f2" in text
    )


@pytest.mark.parametrize(
    "change, reason",
    [
        (_mode_only, "nothing in check.json could be compared"),
        (
            _mode_and_accepted,
            "not compared: facts, verdicts, open_items, counts, drop_reasons, judge_counts",
        ),
    ],
    ids=["mode_only", "mode_and_accepted"],
)
def test_check_text_says_neither_with_the_reason(tmp_path, capsys, change, reason):
    text = _check_text(_export(tmp_path, change), capsys)
    assert _verdict_lines(text) == [f"{NEITHER_START}{reason})"]
    assert "  record incomplete: not compared facts, verdicts, open_items, " in text
    assert "facts without a record: none" in text


def test_the_run_text_never_calls_a_null_verdict_yes_or_no(tmp_path):
    from associate.cli._commands.run import _render_accuracy

    accuracy = accuracy_result(_export(tmp_path, _mode_only), load_accuracy())["accuracy"]
    text = _render_accuracy(accuracy)
    assert (
        "agrees with check.json: neither yes nor no (nothing in check.json could be compared)"
        in text
    )
    assert text.endswith("disagreements 0; record incomplete")


def test_the_run_text_marks_an_incomplete_record_that_disagrees(tmp_path):
    from associate.cli._commands.run import _render_accuracy

    export = _export(tmp_path, _last_fact_record_removed)
    text = _render_accuracy(accuracy_result(export, load_accuracy())["accuracy"])
    assert "agrees with check.json: no;" in text
    assert text.endswith("disagreements 1 (facts); record incomplete, no record for f2")


# ------------------------------------------------------------- facts do not apply


@pytest.mark.parametrize("build, named", NOT_APPLICABLE)
def test_the_library_call_says_not_applicable_with_nothing_to_index(tmp_path, build, named):
    got = recheck_strict_export(build(tmp_path), load_accuracy())
    assert got["applicable"] is False
    assert named in got["not_applicable_reason"]
    assert [got["recheck"], got["accepted"], got["rounds_left"]] == [None, None, None]
    assert got["comparison"]["agrees"] is None


@pytest.mark.parametrize("build, named", NOT_APPLICABLE)
def test_check_json_reports_the_export_as_not_rechecked(tmp_path, capsys, build, named):
    out = _check_json(build(tmp_path), capsys)
    assert out["applicable"] is False
    assert out["python_recheck_ran"] is False
    assert named in out["not_applicable_reason"]
    assert out["python_recheck_agrees"] is None
    assert [out[key] for key in NEW_KEYS] == [None, None, None, None, None]
    assert "strict_recheck" not in out
    assert out["strict"]["recheck"] == {
        "ran": False,
        "reason": out["not_applicable_reason"],
        "agrees": None,
    }


@pytest.mark.parametrize("build, named", NOT_APPLICABLE)
def test_check_text_reports_the_export_as_not_rechecked(tmp_path, capsys, build, named):
    text = _check_text(build(tmp_path), capsys)
    line = next(
        one for one in text.splitlines() if one.startswith("  strict facts: not re-checked")
    )
    assert named in line
    assert "The Python re-check did not run on these facts." in text
    assert _verdict_lines(text) == []


@pytest.mark.parametrize("build, named", NOT_APPLICABLE)
def test_the_run_result_reports_the_export_as_not_rechecked(tmp_path, build, named):
    result = accuracy_result(build(tmp_path), load_accuracy())
    accuracy = result["accuracy"]
    assert accuracy["python_recheck_ran"] is False
    assert accuracy["python_recheck_verdict"] is None
    assert named in accuracy["not_applicable_reason"]
    assert accuracy["python_recheck_agrees"] is None
    assert [accuracy[key] for key in NEW_KEYS] == [None, None, None, None, None]
    assert result["strict"]["recheck"]["ran"] is False
    assert result["strict"]["counts"]["dropped"] == 1


def test_an_unsupported_walk_format_is_called_unsupported(tmp_path, capsys):
    export = _unsupported_format(tmp_path)
    out = _check_json(export, capsys)
    assert out["unsupported"] is True
    assert accuracy_result(export, load_accuracy())["accuracy"]["unsupported"] is True
    text = _check_text(export, capsys)
    assert "  strict facts: not re-checked (unsupported): " in text


def test_a_missing_facts_file_is_not_called_unsupported(tmp_path, capsys):
    export = _without_facts(tmp_path)
    assert "unsupported" not in _check_json(export, capsys)
    text = _check_text(export, capsys)
    assert "  strict facts: not re-checked: no facts.json in the export" in text
    assert "unsupported" not in text


# ------------------------------------------------------------- returned_before_source


def test_returned_before_in_the_record_is_shown_as_taken_from_the_record(tmp_path, capsys):
    export = _export(tmp_path, _with_returned_before)
    out = _check_json(export, capsys)
    assert out["python_recheck_returned_before_source"] == "check.json"
    assert out["python_recheck_agrees"] is True
    assert out["python_recheck_incomplete"] is False
    accuracy = accuracy_result(export, load_accuracy())["accuracy"]
    assert accuracy["python_recheck_returned_before_source"] == "check.json"
    text = _check_text(export, capsys)
    assert (
        "  returned before: read from check.json (strict.returned_before); kept with the mark "
        "against returned was decided again by the re-check" in text
    )
    assert "nor on keep_marked against returned" not in text


def test_a_record_without_returned_before_is_shown_as_inferred(tmp_path, capsys):
    export = _export(tmp_path, _full)
    out = _check_json(export, capsys)
    assert out["python_recheck_returned_before_source"] == "inferred from keep_marked"
    text = _check_text(export, capsys)
    assert (
        "  returned before: inferred from the facts recorded as keep_marked; the re-check "
        "cannot disagree on kept with the mark against returned" in text
    )


# ------------------------------------------------------------- one re-check per run


def test_the_run_result_rechecks_a_strict_export_once(monkeypatch):
    import evidence.accuracy.strict_export as strict_export

    calls: list[str] = []
    held = strict_export.recheck_loaded

    def counted(export_dir, *args, **kwargs):
        calls.append(str(export_dir))
        return held(export_dir, *args, **kwargs)

    monkeypatch.setattr(strict_export, "recheck_loaded", counted)
    result = accuracy_result(STRICT_EXPORT, load_accuracy())
    assert result["accuracy"]["python_recheck_agrees"] is True
    assert calls == [str(STRICT_EXPORT)]
