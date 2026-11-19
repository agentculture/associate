"""Five findings of the review of the broad measurement, each pinned here.

Every export and record in this file is CONSTRUCTED.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from associate.cli._commands import measure_broad
from associate.harness import pi
from associate.measure import answer as answer_mod
from associate.measure import broad
from associate.measure import sheet as sheet_mod
from tests.test_measure_sheet import fill, record, some_records

UNCHECKED = "## Unchecked: the model's own words, not checked by the harness"
FOUND = "quote found in the saved result"
RENDERED = "\n".join(
    [
        "# Answer (rendered by the harness from checked items)",
        "",
        "## Conclusions",
        "",
        "- v1 [supported] It is a Python package with a CLI. (rests on f1)",
        "",
        "## Open items",
        "",
        "- o1: Whether the suite passes here. (deciding check: run the tests)",
        "",
        "## Facts",
        "",
        f'- f1: The build backend is hatchling — "build-backend" (w5, file; {FOUND}; '
        "quote supports the value, support 0.97)",
        f'- f2: The script is named ledger — "ledger = x" (w5, file; {FOUND})',
        "",
        UNCHECKED,
        "",
        "Finish summary (1 sentence):",
        "",
        "> Tests run with pytest.",
        "",
    ]
)
HANDED_BACK = {
    "facts": [
        {"id": "f1", "value": "The build backend is hatchling", "source": "w5"},
        {"id": "f2", "value": "The script is named ledger", "source": "w5"},
        {"id": "f3", "value": "A refused fact", "source": "w9"},
    ],
    "verdicts": [{"id": "v1", "text": "It is a Python package with a CLI."}],
    "open_items": [{"id": "o1", "text": "Whether the suite passes here."}],
}
OWN_WORDS = [
    "It is a Python package with a CLI.",
    "Whether the suite passes here.",
    "The build backend is hatchling",
    "The script is named ledger",
    "Tests run with pytest.",
]


def export(tmp_path: Path, facts: dict | None) -> Path:
    (tmp_path / "answer.md").write_text(RENDERED, encoding="utf-8")
    if facts is not None:
        (tmp_path / "facts.json").write_text(json.dumps(facts), encoding="utf-8")
    return tmp_path


# --- the broad answer holds what was handed back as checked items ----------------------------


@pytest.mark.parametrize("facts", [HANDED_BACK, None, {"facts": "not a list"}])
def test_the_broad_answer_holds_the_accepted_items_and_the_unchecked_text(tmp_path, facts):
    found = answer_mod.broad_answer({}, export(tmp_path, facts))
    assert found.text.split("\n\n") == OWN_WORDS
    assert found.source == "answer.md"


def test_the_broad_answer_has_no_word_the_harness_added(tmp_path):
    text = answer_mod.broad_answer({}, export(tmp_path, HANDED_BACK)).text
    for added in ("support", "quote found", "w5", "rests on", "deciding check", "A refused fact"):
        assert added not in text


def test_the_short_task_answer_is_still_the_unchecked_text_alone(tmp_path):
    assert answer_mod.model_answer({}, export(tmp_path, HANDED_BACK)).text == OWN_WORDS[-1]


def test_a_checklist_fact_handed_back_only_as_a_checked_fact_is_marked(tmp_path):
    text = answer_mod.broad_answer({}, export(tmp_path, HANDED_BACK)).text
    fact = {"id": "b1", "text": "hatchling", "match": [["hatchling"]]}
    assert broad.first_marking([fact], text)["facts_stated"] == 1


# --- an answer that cannot be graded is not the best on false statements ---------------------


def joined_rows(records):
    sheet, key = sheet_mod.build(records, seed=3)
    return sheet_mod.run_rows(records, sheet_mod.join(fill(sheet), key, records))


def test_a_run_with_no_statement_is_left_out_of_the_false_count_only():
    records = some_records(tasks=("broad-one",))
    records[0]["answer"]["text"] = ""
    rows = joined_rows(records)
    assert sheet_mod.rule_counts(rows, "statements_false")["broad-one"]["score-off"] == [0, 0]
    assert len(sheet_mod.rule_counts(rows, "facts_stated")["broad-one"]["score-off"]) == 3
    assert "no statement to grade (left out of the rule on false statements)" in (
        sheet_mod.render_rows(rows)
    )


@pytest.mark.parametrize("count", ["statements_false", "facts_stated"])
def test_a_run_cut_at_the_cap_is_left_out_of_both_counts(count):
    records = some_records(tasks=("broad-one",))
    records[0]["broad"].update(answer_source="final_reply_capped", at_cap=True)
    rows = joined_rows(records)
    assert len(sheet_mod.rule_counts(rows, count)["broad-one"]["score-off"]) == 2
    assert "the answer was cut at the cap (left out of the rule)" in sheet_mod.render_rows(rows)


def test_leaving_a_run_out_makes_the_rule_not_applicable_rather_than_a_win():
    records = some_records(tasks=("broad-one",))
    records[0]["answer"]["text"] = ""
    rule = broad.Rule(status="confirmed", repositories=1, repositories_required=1, runs_per_arm=3)
    counts = sheet_mod.rule_counts(joined_rows(records), "statements_false")
    verdict = broad.rule_verdict(rule, counts, higher_is_better=False)
    assert verdict["verdict"] == broad.VERDICT_NOT_APPLICABLE


# --- the rule cannot be met by both arms -----------------------------------------------------


def rule_text(repositories: int, required: int) -> str:
    values = {
        "status": "confirmed",
        "repositories": repositories,
        "repositories_required": required,
        "runs_per_arm": 3,
    }
    return f"```json\n{json.dumps(values)}\n```\n"


@pytest.mark.parametrize(("repositories", "required"), [(6, 3), (2, 1), (6, 1)])
def test_a_rule_both_arms_could_meet_is_refused(repositories, required):
    text = rule_text(repositories, required)
    with pytest.raises(broad.RuleError, match="more than half"):
        broad.read_rule(text)


@pytest.mark.parametrize(("repositories", "required"), [(6, 4), (6, 5), (1, 1), (3, 2)])
def test_a_rule_only_one_arm_can_meet_is_read(repositories, required):
    assert broad.read_rule(rule_text(repositories, required)).repositories_required == required


# --- a run without an id on the sheet is a problem, not a crash ------------------------------


@pytest.mark.parametrize("bad", [{"statements": []}, {"id": 7, "statements": []}])
def test_the_join_names_a_sheet_run_without_an_id(bad):
    records = some_records(tasks=("broad-one",), repeats=1)
    sheet, key = sheet_mod.build(records, seed=3)
    filled = fill(sheet)
    filled["runs"].append(bad)
    with pytest.raises(sheet_mod.SheetError, match="is not a run with an id"):
        sheet_mod.join(filled, key, records)


# --- one definition of each shared value -----------------------------------------------------


def test_the_cap_the_note_and_the_commit_pattern_are_each_defined_once():
    assert answer_mod.FINAL_REPLY_CAP is pi.FINAL_REPLY_CHARS
    assert broad.FINAL_REPLY_CAP is pi.FINAL_REPLY_CHARS
    assert measure_broad.BROAD_NOTE is broad.BROAD_NOTE
    assert sheet_mod.COMMIT_ID is broad.COMMIT_ID
    assert not hasattr(sheet_mod, "_COMMIT")


def test_a_record_helper_run_is_a_finished_broad_run():
    assert sheet_mod.broad_runs([record("broad-one", "score-off", 1, "It builds.")])


# --- the middle value of each arm's runs, printed beside the rule without a verdict ----------


def stated(records, values):
    for found, value in zip(records, values):
        found["broad"]["facts_stated"] = value
    return records


def test_the_middle_value_is_per_repository_and_arm_over_the_runs_the_rule_counts():
    records = stated(some_records(tasks=("broad-one",)), [3, 1, 2, 2, 2, 3])
    records[1]["broad"].update(answer_source="final_reply_capped", at_cap=True)
    rows = sheet_mod.run_rows(records, None)
    middles = sheet_mod.middle_values(rows, "facts_stated")
    assert middles == {"broad-one": {"score-off": 2.5, "score-on": 2}}


def test_the_middle_values_are_printed_with_no_verdict_and_no_sum():
    records = stated(some_records(), [3, 1, 2, 2, 2, 3] * 2)
    text = sheet_mod.render_middles(sheet_mod.run_rows(records, None))
    assert "Middle value of each arm's runs" in text
    assert "broad-one: facts marked as stated: score-off 2, score-on 2" in text
    assert "no verdict" in text
    assert "statements counted false" not in text


def test_the_middle_of_false_statements_is_printed_once_the_sheet_is_joined():
    text = sheet_mod.render_middles(joined_rows(some_records(tasks=("broad-one",))))
    assert "broad-one: statements counted false: score-off 0, score-on 0" in text
