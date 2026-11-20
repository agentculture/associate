"""The strict arm pair, attribution by item id, and the strict report (strict-facts t10).

Everything here is plumbing: exports and records written by hand in the shape the
harness and the runner store, no model, no key, no network.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from associate.cli import main
from associate.cli._commands import measure as measure_cmd
from associate.cli._commands import measure_broad
from associate.cli._errors import CliError
from associate.measure import answer as answer_mod
from associate.measure import runner as runner_mod
from associate.measure import sheet as sheet_mod
from tests.test_measure_broad import CONFIRMED, runner_task
from tests.test_measure_broad_command import TASKS, note_repo, read, store
from tests.test_measure_command import run_json
from tests.test_measure_sheet import record

FIXTURE = Path(__file__).parent / "fixtures" / "strict_export"
OFF, ON = "strict-off", "strict-on"
COMMIT = "abcdef1"
FLAG = "--strict"

STRICT_ANSWER = """# Answer (rendered by the harness from checked items)

## Conclusions

- v1 [supported] The package is built with hatchling. (rests on f1)

## Open items

- o1: Whether the CLI has a plugin system. (deciding check: read cli.py)

## Facts

Each item below was checked by the harness.

**f1:** The build backend is hatchling

- kind: direct
- how to check: `read pyproject.toml`
- result: `results/w1.txt`, line 3

```text
3\tbuild-backend = "hatchling.build"
```

**f2:** Tests run with pytest

- kind: llm (judged by the decider: part)
- how to check: `read pyproject.toml`
- result: `results/w1.txt`, line 9
- marked: weakly supported (the decider answered part)

```text
9\ttestpaths = ["tests"]
```

2 items were dropped (2 decider_drop); dropped.json in the export lists each with its reason.

## Unchecked: the model's own words, not checked by the harness

Finish summary (1 sentence):

> It is a small CLI.

Final message (2 sentences):

> The tool is a CLI. It has many verbs.
"""


def _check(outcomes: dict[str, str]) -> dict:
    def entry(item_id: str) -> dict:
        found = {"id": item_id, "strict_outcome": outcomes[item_id]}
        if item_id == "f2":
            found.update(kind_checked="llm", judge={"option": "part", "judged": True})
        if item_id == "f1":
            found.update(kind_checked="direct", judge=None)
        return found

    return {
        "mode": "strict",
        "facts": [entry("f1"), entry("f2")],
        "verdicts": [entry("v1")],
        "open_items": [entry("o1")],
        "strict": {"rounds_used": 2, "retry_rounds": 2, "counts": {"pass": 3, "dropped": 2}},
    }


@pytest.fixture
def strict_export(tmp_path: Path) -> Path:
    export = tmp_path / "export"
    export.mkdir()
    (export / "answer.md").write_text(STRICT_ANSWER, encoding="utf-8")
    outcomes = {"f1": "pass", "f2": "keep_marked", "v1": "pass", "o1": "pass"}
    (export / "check.json").write_text(json.dumps(_check(outcomes)), encoding="utf-8")
    return export


# --- attribution by item id ------------------------------------------------------------------


def test_a_strict_export_gives_one_tagged_part_per_item(strict_export):
    found = answer_mod.broad_answer({"strict_switch": "on"}, strict_export)
    assert found.source == "answer.md"
    items = [part for part in found.parts if part.get("item")]
    assert [part["item"] for part in items] == ["v1", "o1", "f1", "f2"]
    by_id = {part["item"]: part for part in items}
    assert by_id["f1"] == {
        "text": "The build backend is hatchling",
        "origin": "answer",
        "item": "f1",
        "strict_outcome": "pass",
        "kind_checked": "direct",
        "option": None,
    }
    assert by_id["f2"]["strict_outcome"] == "keep_marked"
    assert by_id["f2"]["option"] == "part"
    assert by_id["v1"]["text"] == "The package is built with hatchling."
    assert by_id["o1"]["text"] == "Whether the CLI has a plugin system."


def test_the_summary_and_the_final_message_are_parts_with_no_item(strict_export):
    found = answer_mod.broad_answer(None, strict_export)
    rest = [part for part in found.parts if not part.get("item")]
    assert rest == [
        {"text": "It is a small CLI.", "origin": "summary"},
        {"text": "The tool is a CLI. It has many verbs.", "origin": "final_reply"},
    ]


def test_the_strict_text_holds_no_line_the_harness_wrote(strict_export):
    text = answer_mod.broad_answer(None, strict_export).text
    for harness_words in ("kind:", "how to check", "result:", "marked:", "dropped.json", "```"):
        assert harness_words not in text
    assert "The build backend is hatchling" in text
    assert "It has many verbs." in text


def test_the_committed_strict_fixture_has_one_fact_and_its_summary():
    found = answer_mod.broad_answer(None, FIXTURE)
    assert [(p["origin"], p.get("item"), p["text"]) for p in found.parts] == [
        ("answer", "f1", "ROLE_RESPONSIBILITIES"),
        ("summary", None, "The role table."),
    ]
    assert found.parts[0]["strict_outcome"] == "pass"


def test_a_non_strict_export_is_tagged_with_origin_only(tmp_path):
    export = tmp_path / "plain"
    export.mkdir()
    (export / "answer.md").write_text(
        "# Answer (rendered by the harness from checked items)\n\n## Facts\n\n"
        'A fact marked "quote found" means its quote is in the saved result it cites; '
        "it does not mean the value is true.\n\n"
        '- f1: The backend is hatchling — "build-backend" (quote found; w1)\n\n'
        "## Unchecked: the model's own words, not checked by the harness\n\n"
        "Final message (1 sentence):\n\n> It is a CLI.\n",
        encoding="utf-8",
    )
    (export / "check.json").write_text(json.dumps({"mode": "report", "facts": []}))
    found = answer_mod.broad_answer(None, export)
    assert found.parts == (
        {"text": "The backend is hatchling", "origin": "answer"},
        {"text": "It is a CLI.", "origin": "final_reply"},
    )
    assert found.text == "The backend is hatchling\n\nIt is a CLI."


def test_a_run_with_no_answer_file_is_one_final_reply_part():
    found = answer_mod.broad_answer({"unchecked_final_reply": "Hello there. It is a CLI."}, None)
    assert found.parts == ({"text": "Hello there. It is a CLI.", "origin": "final_reply"},)


def test_the_stored_record_keeps_the_parts_and_the_strict_counts(strict_export):
    fields = runner_mod._broad_fields({"strict_switch": "on"}, strict_export, runner_task())
    assert fields["answer"]["parts"][0]["item"] == "v1"
    assert fields["broad"]["strict"]["rounds_used"] == 2
    assert fields["broad"]["strict"]["dropped"] == 2
    assert fields["broad"]["strict_switch"] == "on"


def test_a_record_of_a_run_without_strict_keeps_its_old_shape(tmp_path):
    fields = runner_mod._broad_fields({"final_reply": "hatchling"}, None, runner_task())
    assert "strict" not in fields["broad"]
    assert "strict_switch" not in fields["broad"]


# --- the sheet: tags in the key, never on the sheet --------------------------------------------


def strict_record(task: str, arm: str, repeat: int, export: Path | None = None) -> dict:
    """A stored broad run of the strict pair; strict-on has item parts, strict-off has none."""
    if arm == ON:
        parts = [
            {
                "text": "Uses hatchling.",
                "origin": "answer",
                "item": "f1",
                "strict_outcome": "pass",
                "kind_checked": "direct",
                "option": None,
            },
            {
                "text": "Tests run with pytest.",
                "origin": "answer",
                "item": "f2",
                "strict_outcome": "keep_marked",
                "kind_checked": "llm",
                "option": "part",
            },
            {"text": "It is a CLI. It has verbs.", "origin": "final_reply"},
        ]
    else:
        parts = [
            {"text": "Uses hatchling. Tests run with pytest.", "origin": "answer"},
            {"text": "It is a CLI. It has verbs.", "origin": "final_reply"},
        ]
    made = record(task, arm, repeat, "\n\n".join(p["text"] for p in parts))
    made["arm"]["strict"] = "on" if arm == ON else "off"
    made["answer"]["parts"] = parts
    made["launch"] = {"duration_s": 100.5 + repeat}
    if arm == ON:
        made["broad"]["strict"] = {"rounds_used": repeat, "dropped": 1, "counts": {}}
    return made


def strict_pair(stated_on: int = 2) -> list[dict]:
    records = []
    for index, task in enumerate(TASKS):
        for arm in (OFF, ON):
            for repeat in (1, 2, 3):
                made = strict_record(task, arm, repeat)
                made["broad"]["facts_stated"] = stated_on if arm == ON and index < 5 else 1
                records.append(made)
    return records


@pytest.fixture
def pair_results(tmp_path: Path) -> Path:
    return store(tmp_path / "results", strict_pair())


def fill_strict(results: Path) -> None:
    """True everywhere; in strict-off runs the first answer statement is false."""
    sheet_path = results / measure_broad.DEFAULT_SHEET
    sheet, key = read(sheet_path), read(results / measure_broad.DEFAULT_KEY)
    for run in sheet["runs"]:
        tags = key["runs"][run["id"]]["tags"]
        for statement, tag in zip(run["statements"], tags):
            statement["verdict"] = "true"
        if key["runs"][run["id"]]["arm"] == OFF:
            run["statements"][0].update(verdict="false", file="pyproject.toml", line=3)
        else:
            run["statements"][1]["verdict"] = "false"  # f2, kept with its mark
            run["statements"][1].update(file="pyproject.toml", line=9)
            run["statements"][3]["verdict"] = "not_checkable"
    sheet_path.write_text(json.dumps(sheet), encoding="utf-8")


def test_the_key_names_where_each_statement_came_from_and_the_sheet_does_not(pair_results):
    records = runner_mod.load_records(pair_results)
    sheet, key = sheet_mod.build(records, 7)
    assert "origin" not in json.dumps(sheet)
    assert "strict_outcome" not in json.dumps(sheet)
    for run in sheet["runs"]:
        assert set(run) == {"id", "task", "repository", "commit", "statements"}
        for statement in run["statements"]:
            assert set(statement) == {"n", "text", "verdict", "file", "line", "note"}
    for run_id, entry in key["runs"].items():
        on_sheet = next(run for run in sheet["runs"] if run["id"] == run_id)
        assert len(entry["tags"]) == len(on_sheet["statements"]) == entry["statements"]
    on = next(e for e in key["runs"].values() if e["arm"] == ON)
    assert [(t["origin"], t.get("item")) for t in on["tags"]] == [
        ("answer", "f1"),
        ("answer", "f2"),
        ("final_reply", None),
        ("final_reply", None),
    ]
    assert on["tags"][1]["strict_outcome"] == "keep_marked"
    assert on["tags"][1]["option"] == "part"


def test_records_without_parts_make_a_key_without_tags():
    records = [record("broad-one", "a", 1, "One sentence. Another one.")]
    _sheet, key = sheet_mod.build(records, 1)
    assert "tags" not in next(iter(key["runs"].values()))


def test_the_join_counts_answer_and_reply_statements_apart(pair_results):
    records = runner_mod.load_records(pair_results)
    sheet, key = sheet_mod.build(records, 7)
    filled = json.loads(json.dumps(sheet))
    on_id = next(i for i, e in key["runs"].items() if e["arm"] == ON)
    for run in filled["runs"]:
        for statement in run["statements"]:
            statement["verdict"] = "true"
        if run["id"] == on_id:
            run["statements"][1].update(verdict="false", file="a", line=1)
            run["statements"][3].update(verdict="not_checkable")
    joined = sheet_mod.join(filled, key, records)
    counts = joined[(key["runs"][on_id]["task"], ON, key["runs"][on_id]["repeat"])]
    assert counts["answer"] == {"statements": 2, "true": 1, "false": 1, "not_checkable": 0}
    assert counts["final_reply"] == {"statements": 2, "true": 1, "false": 0, "not_checkable": 1}
    assert counts["answer_pass"] == {"statements": 1, "true": 1, "false": 0, "not_checkable": 0}
    assert counts["answer_keep_marked"]["false"] == 1
    off = next(c for k, c in joined.items() if k[1] == OFF)
    assert off["answer_pass"]["statements"] == 0


# --- the report ---------------------------------------------------------------------------


def test_the_strict_report_prints_the_per_run_counts(pair_results, capsys):
    assert main(["measure", "sheet", str(pair_results)]) == 0
    fill_strict(pair_results)
    capsys.readouterr()
    assert main(["measure", "report", str(pair_results)]) == 0
    text = capsys.readouterr().out
    assert "Strict pair, per run" in text
    assert "arm strict-on (strict on)" in text
    on_line = (
        "answer statements: true 1, false 1, not checkable 0; "
        "final reply statements: true 1, false 0, not checkable 1; "
        "of the answer statements 1 rest on a passed item, 0 of those graded false; "
        "kept-with-mark items graded false 1 of 1"
    )
    assert on_line in text
    assert "run time 101.5 s; retry rounds 1; items dropped 1" in text
    assert "checklist facts stated 2 of 3 (first marking)" in text
    assert "retry rounds not recorded; items dropped not recorded" in text  # strict-off arm
    assert "answer statements graded false" in text


def test_the_strict_report_json_holds_the_row_fields_and_the_rule(pair_results, tmp_path, capsys):
    note = str(note_repo(tmp_path, CONFIRMED))
    assert main(["measure", "sheet", str(pair_results)]) == 0
    fill_strict(pair_results)
    argv = ["measure", "report", str(pair_results), "--difference-note", note, "--json"]
    payload = run_json(capsys, argv)
    assert payload["strict_pair"] is True
    row = next(r for r in payload["runs"] if r["arm"] == ON and r["repeat"] == 1)
    assert row["answer_false"] == 1
    assert row["answer_pass"] == 1
    assert row["answer_pass_false"] == 0
    assert row["answer_keep_marked_false"] == 1
    assert row["duration_s"] == 101.5
    assert row["rounds_used"] == 1
    assert set(payload["rule"]["counts"]) == {"facts_stated", "answer_false"}
    # strict-off has one false answer statement per run, strict-on one too: no difference.
    assert payload["rule"]["counts"]["answer_false"]["verdict"] == "no difference shown"
    assert payload["rule"]["counts"]["facts_stated"]["verdict"] == "a change"
    assert "answer_false" in payload["middle_values"]


def test_the_strict_report_applies_the_committed_rule_to_answer_false(tmp_path, capsys):
    records = strict_pair()
    results = store(tmp_path / "results", records)
    note = str(note_repo(tmp_path, CONFIRMED))
    assert main(["measure", "sheet", str(results)]) == 0
    sheet_path = results / measure_broad.DEFAULT_SHEET
    sheet, key = read(sheet_path), read(results / measure_broad.DEFAULT_KEY)
    for run in sheet["runs"]:
        for statement in run["statements"]:
            statement["verdict"] = "true"
        entry = key["runs"][run["id"]]
        if entry["arm"] == OFF:
            run["statements"][0].update(verdict="false", file="a", line=1)
        elif entry["task"] == TASKS[5]:
            run["statements"][0].update(verdict="false", file="a", line=1)
    sheet_path.write_text(json.dumps(sheet), encoding="utf-8")
    capsys.readouterr()
    assert main(["measure", "report", str(results), "--difference-note", note]) == 0
    text = capsys.readouterr().out
    assert f"answer statements graded false: a change (arm {ON} is better in 5 repositories" in text
    assert "Middle value" in text
    assert "answer statements graded false: strict-off 1, strict-on 0" in text


def test_a_report_of_the_older_pair_has_no_strict_section(tmp_path, capsys):
    from tests.test_measure_sheet import some_records

    results = store(tmp_path / "results", some_records(tasks=("broad-one",)))
    assert main(["measure", "report", str(results)]) == 0
    assert "Strict pair" not in capsys.readouterr().out
    payload = run_json(capsys, ["measure", "report", str(results), "--json"])
    assert "strict_pair" not in payload
    assert all("strict" not in row for row in payload["runs"])


def test_status_works_on_a_results_directory_of_the_strict_pair(pair_results, capsys):
    manifest = {
        "format": 1,
        "tasks": list(TASKS),
        "arms": [OFF, ON],
        "repeats": 3,
        "expected_runs": 36,
        "harness": "stub",
        "broad": True,
        "plumbing_only": False,
        "log": None,
        "pid": None,
    }
    (pair_results / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    payload = run_json(capsys, ["measure", "status", str(pair_results), "--json"])
    assert (payload["expected_runs"], payload["finished"], payload["not_stored"]) == (36, 36, 0)


# --- the arm setting -------------------------------------------------------------------------


def _arms_file(tmp_path, **extra) -> Path:
    arm = {"name": "a", "harness_commit": COMMIT, "model": "worker", **extra}
    path = tmp_path / "arms.json"
    path.write_text(json.dumps([arm]), encoding="utf-8")
    return path


@pytest.mark.parametrize("setting", ["on", "off"])
def test_an_arm_may_carry_strict(tmp_path, setting):
    (arm,) = measure_cmd.load_arms(_arms_file(tmp_path, strict=setting))
    assert arm.strict == setting
    assert arm.support_score is None


def test_an_arm_with_another_strict_value_is_refused(tmp_path):
    with pytest.raises(CliError, match="strict must be one of on, off"):
        measure_cmd.load_arms(_arms_file(tmp_path, strict="maybe"))


def _ctx(tmp_path):
    return runner_mod._Context(
        results=tmp_path,
        harness_root=tmp_path,
        checkouts={},
        python="python3",
        timeout_s=1.0,
        grace_s=1.0,
        excluded=[],
        retry_failed=False,
        untrusted_checkout=False,
        harness="pi",
        launcher=lambda launch: None,
        pi_on_path=None,
        progress=lambda message: None,
    )


@pytest.mark.parametrize("setting", ["on", "off"])
def test_the_flag_reaches_the_runs_of_the_arm_and_the_support_switch_is_left_alone(
    tmp_path, setting
):
    arm = runner_mod.Arm(name="a", harness_commit=COMMIT, model="worker", strict=setting)
    harness = runner_mod._Harness(commit="a" * 40, flags=frozenset({FLAG, "--support-score"}))
    args, settings, _ = runner_mod._settings(_ctx(tmp_path), arm, harness)
    assert args[-2:] == [FLAG, setting]
    assert "--support-score" not in args
    assert settings["requested"]["strict"] == setting
    assert settings["applied"]["strict"] == FLAG


def test_the_identity_and_the_record_name_strict_only_when_the_arm_sets_it():
    harness = runner_mod._Harness(commit="a" * 40, flags=frozenset())
    on = runner_mod.Arm(name="a", harness_commit=COMMIT, model="worker", strict="on")
    plain = runner_mod.Arm(name="b", harness_commit=COMMIT, model="worker")
    identity = runner_mod._arm_identity(on, harness)
    assert identity["strict"] == "on"
    base = runner_mod._base_record(("t", "a", 1), identity, {"id": "t"}, 1, [])
    assert base["strict"] == "on"
    assert "strict" not in runner_mod._arm_identity(plain, harness)
    other = runner_mod._base_record(
        ("t", "b", 1), runner_mod._arm_identity(plain, harness), {"id": "t"}, 1, []
    )
    assert "strict" not in other


def test_a_commit_without_the_strict_flag_is_refused_for_an_arm_that_sets_it():
    arm = runner_mod.Arm(name="a", harness_commit=COMMIT, model="worker", strict="on")
    prepared = {"full": runner_mod._Harness(commit="f" * 40, flags=frozenset({"--support-score"}))}
    problems = runner_mod._flag_problems([arm], {COMMIT: "full"}, prepared)
    assert len(problems) == 1
    assert FLAG in problems[0]
