"""scripts/broad_attribution_comparison.py: statements attributed by the structure of the export.

Small exports are written by hand in the shape of the 2026-11-19 runs (the old rendering with
``- fN:`` lines). The real graded statements live on another branch; nothing here needs them.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "broad_attribution_comparison.py"
_spec = importlib.util.spec_from_file_location("broad_attribution_comparison", SCRIPT)
script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(script)

ANSWER = """# Answer (rendered by the harness from checked items)

## Open items

- o1: Whether it ships. (deciding check: read the docs)

## Facts

A fact marked "quote found" means its quote is in the saved result it cites; it does not
mean the value is true.

- f1: It uses hatchling. It has a CLI. — "build-backend" (w1, file; quote found in the saved result)

1 item was refused by the check and is not part of this answer (check.json lists each with its fix).

## Unchecked: the model's own words, not checked by the harness

Finish summary (1 sentence):

> It is a CLI

Final message (2 sentences):

> and it has verbs. It is tested.
"""


def make_results(tmp_path: Path, answer: str = ANSWER, *, with_export: bool = True) -> Path:
    results = tmp_path / "results"
    record = results / "records" / "broad-a" / "arm-x" / "r1.json"
    record.parent.mkdir(parents=True)
    record.write_text(json.dumps({"attempt": 1, "repeat": 1}), encoding="utf-8")
    if with_export:
        export = (
            results / "work" / "broad-a" / "arm-x" / "r1" / "a1" / "export-root" / "s" / "export"
        )
        export.mkdir(parents=True)
        (export / "answer.md").write_text(answer, encoding="utf-8")
    return results


def graded_file(tmp_path: Path, texts: list[str], verdicts: list[str] | None = None) -> Path:
    verdicts = verdicts or ["true"] * len(texts)
    run = {
        "id": "s01",
        "task": "broad-a",
        "arm": "arm-x",
        "repeat": 1,
        "statements": [
            {"n": n, "text": t, "claude": v, "gemini": "false" if v == "true" else v}
            for n, (t, v) in enumerate(zip(texts, verdicts), start=1)
        ],
    }
    path = tmp_path / "graded.json"
    path.write_text(json.dumps({"format": 1, "runs": [run]}), encoding="utf-8")
    return path


STATEMENTS = [
    "Whether it ships.",
    "It uses hatchling.",
    "It has a CLI.",
    # The summary's last line and the final message's first were run together by the old builder.
    "It is a CLI and it has verbs.",
    "It is tested.",
]


def test_statements_are_attributed_to_their_items_by_structure(tmp_path):
    results = make_results(tmp_path)
    graded = graded_file(tmp_path, STATEMENTS, ["not_checkable", "true", "false", "true", "true"])
    out = script.build(results, graded)
    claude = out["structural"]["by_source"]["claude"]
    assert out["structural"]["runs_attributed"] == 1
    assert claude["open_item"]["not_checkable"] == 1
    assert claude["fact"] == {"true": 1, "false": 1, "not_checkable": 0, "no verdict": 0}
    assert claude["summary_and_final"]["true"] == 1
    assert claude["final_reply"]["true"] == 1
    assert claude["structure cannot decide"]["true"] == 0


def test_the_comparison_puts_the_written_totals_beside_the_structure(tmp_path):
    out = script.build(make_results(tmp_path), graded_file(tmp_path, STATEMENTS))
    row = out["comparison"]["claude"]
    assert sum(row["structural_answer_items"]) == 3
    assert row["written_unchecked_text"] == [1022, 65, 296]
    assert out["per_statement_comparison"]["possible"] is False


def test_a_run_whose_statements_do_not_rebuild_is_counted_as_undecided(tmp_path):
    out = script.build(make_results(tmp_path), graded_file(tmp_path, ["Something else entirely."]))
    structural = out["structural"]
    assert structural["runs_attributed"] == 0
    assert "not the graded statements" in structural["runs_not_attributed"][0]["reason"]
    assert structural["by_source"]["claude"]["structure cannot decide"]["true"] == 1


def test_a_run_with_no_export_is_counted_as_undecided(tmp_path):
    results = make_results(tmp_path, with_export=False)
    out = script.build(results, graded_file(tmp_path, STATEMENTS))
    assert out["structural"]["runs_not_attributed"][0]["reason"].startswith("the export")


def test_a_graded_file_with_no_runs_is_an_error(tmp_path):
    path = tmp_path / "graded.json"
    path.write_text(json.dumps({"runs": []}), encoding="utf-8")
    with pytest.raises(script.ComparisonError):
        script.build(make_results(tmp_path), path)


def test_main_writes_both_files_and_a_missing_graded_file_is_an_error_not_a_crash(tmp_path, capsys):
    out_json, out_note = tmp_path / "c.json", tmp_path / "c.md"
    graded = graded_file(tmp_path, STATEMENTS)
    argv = [str(make_results(tmp_path)), str(graded), "--json-out", str(out_json)]
    assert script.main([*argv, "--note-out", str(out_note)]) == 0
    assert json.loads(out_json.read_text())["kind"] == "broad_attribution_comparison"
    note = out_note.read_text()
    assert "None is a score and none is accuracy" in note
    assert "not stored per statement" in note
    missing = [str(tmp_path / "results"), str(tmp_path / "absent.json")]
    assert script.main(missing) == 1
    assert "error:" in capsys.readouterr().err


def test_the_committed_comparison_names_no_machine_path():
    for name in (
        "docs/accuracy/broad-attribution-comparison.json",
        "docs/notes/broad-attribution-comparison.md",
    ):
        text = (REPO_ROOT / name).read_text(encoding="utf-8")
        assert "/home/" not in text
        assert "/tmp/" not in text
