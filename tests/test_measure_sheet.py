"""The broad grading sheet: statements, hidden arms, the check and the join (decider-score t11).

Records here are written by hand in the shape the runner stores for a broad
run. No model is run and nothing reads a key.
"""

from __future__ import annotations

import copy
import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from associate.measure import sheet as sheet_mod

GIT_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}
ARMS = ("score-off", "score-on")


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **GIT_ENV},
    ).stdout.strip()


def record(task: str, arm: str, repeat: int, text: str, **kw) -> dict:
    name = kw.get("name", task.removeprefix("broad-"))
    return {
        "record_format": 1,
        "task": {
            "id": task,
            "repository": {"host": "github.com", "owner": "example", "name": name},
            "commit": kw.get("commit", "a" * 40),
        },
        "arm": {"name": arm, "model": "worker", "harness_commit": "b" * 40},
        "support_score": "on" if arm.endswith("on") else "off",
        "repeat": repeat,
        "status": kw.get("status", "finished"),
        "answer": {"text": text, "source": kw.get("source", "answer.md"), "empty_reason": None},
        "contamination": {"checked": True, "contaminated": kw.get("contaminated", False)},
        "broad": {
            "marking": "first marking",
            "facts_total": kw.get("total", 3),
            "facts_stated": kw.get("stated", 1),
            "facts": [],
            "answer_source": kw.get("source", "answer.md"),
            "at_cap": kw.get("at_cap", False),
            "final_reply_cap": 2000,
        },
    }


def answer_for(arm: str, repeat: int) -> str:
    return (
        f"The project is built with hatchling. Marker {arm} {repeat} is here.\n\n"
        "- It has a CLI.\n- Tests run with pytest.\n"
    )


def some_records(tasks=("broad-one", "broad-two"), repeats=3) -> list[dict]:
    return [
        record(task, arm, repeat, answer_for(arm, repeat))
        for task in tasks
        for arm in ARMS
        for repeat in range(1, repeats + 1)
    ]


def fill(sheet: dict, verdict: str = "true") -> dict:
    filled = copy.deepcopy(sheet)
    for run in filled["runs"]:
        for statement in run["statements"]:
            statement["verdict"] = verdict
    return filled


# --- splitting an answer into statements ----------------------------------------------------


def test_sentences_and_list_items_become_statements_in_their_order():
    text = (
        "# Overview\n\n"
        "It is a CLI. It is built with hatchling,\nand tested with pytest!\n\n"
        "- first item\n- second item, e.g. Python code. Still the second item? Yes.\n"
        "  continued here\n"
        "1. numbered item\n"
    )
    assert sheet_mod.split_statements(text) == [
        "Overview",
        "It is a CLI.",
        "It is built with hatchling, and tested with pytest!",
        "first item",
        "second item, e.g. Python code.",
        "Still the second item?",
        "Yes. continued here",
        "numbered item",
    ]


def test_a_file_name_or_a_version_does_not_end_a_sentence():
    text = "The version is 1.5.2 in pyproject.toml and the entry is cli.main. Next sentence."
    assert sheet_mod.split_statements(text) == [
        "The version is 1.5.2 in pyproject.toml and the entry is cli.main.",
        "Next sentence.",
    ]


def test_a_code_block_is_one_statement_and_a_table_row_is_one_each():
    text = (
        "Run it:\n\n```bash\nuv sync. Then\nuv run pytest\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    )
    assert sheet_mod.split_statements(text) == [
        "Run it:",
        "```bash\nuv sync. Then\nuv run pytest\n```",
        "| a | b |",
        "| 1 | 2 |",
    ]


def test_rules_are_dropped_and_a_closed_heading_loses_its_marks():
    text = "## Parts ##\n\n---\n* * *\n___\n\nOne part.\n--\n"
    assert sheet_mod.split_statements(text) == ["Parts", "One part. --"]


def test_splitting_is_deterministic_and_an_empty_answer_has_no_statement():
    text = answer_for("x", 1)
    assert sheet_mod.split_statements(text) == sheet_mod.split_statements(text)
    assert sheet_mod.split_statements("") == []
    assert sheet_mod.split_statements(" \n\n ") == []


# --- the sheet hides the arm; the key is separate ------------------------------------------


def test_the_sheet_has_every_run_under_an_opaque_id_and_no_arm():
    records = some_records()
    sheet, key = sheet_mod.build(records, seed=7)
    assert len(sheet["runs"]) == len(records) == len(key["runs"])
    ids = [run["id"] for run in sheet["runs"]]
    assert len(set(ids)) == len(ids)
    assert sorted(ids) == sorted(key["runs"])
    dumped = json.dumps(sheet)
    for word in (*ARMS, "support_score", "repeat", "worker", "harness_commit"):
        assert word not in dumped.replace("Marker score-off", "").replace("Marker score-on", "")
    for run in sheet["runs"]:
        assert set(run) == {"id", "task", "repository", "commit", "statements"}
        for statement in run["statements"]:
            assert set(statement) == {"n", "text", "verdict", "file", "line", "note"}
            assert statement["verdict"] is None and statement["file"] is None


def test_the_statements_of_a_run_keep_their_order():
    records = [record("broad-one", "score-off", 1, "First. Second.\n- third\n- fourth\n")]
    sheet, _key = sheet_mod.build(records, seed=1)
    statements = sheet["runs"][0]["statements"]
    assert [s["text"] for s in statements] == ["First.", "Second.", "third", "fourth"]
    assert [s["n"] for s in statements] == [1, 2, 3, 4]


def test_the_key_maps_each_id_to_its_run_and_arm_and_holds_the_seed():
    records = some_records()
    sheet, key = sheet_mod.build(records, seed=7)
    assert key["seed"] == 7
    assert "seed" not in sheet
    found = sorted((v["task"], v["arm"], v["repeat"]) for v in key["runs"].values())
    assert found == sorted((r["task"]["id"], r["arm"]["name"], r["repeat"]) for r in records)
    for run in sheet["runs"]:
        entry = key["runs"][run["id"]]
        assert entry["task"] == run["task"]
        marker = f"Marker {entry['arm']} {entry['repeat']} is here."
        assert marker in [s["text"] for s in run["statements"]]
        assert entry["support_score"] in ("on", "off")


def test_the_sheet_tells_the_grader_not_to_open_the_key():
    sheet, key = sheet_mod.build(some_records(), seed=7)
    assert "do not open" in " ".join(sheet["instructions"]).lower()
    assert sheet["verdicts"] == ["true", "false", "not_checkable"]
    assert "arm" in key["warning"]


def test_the_order_is_shuffled_and_reproducible_from_the_seed():
    records = some_records(tasks=("broad-one", "broad-two", "broad-three"))
    first, first_key = sheet_mod.build(records, seed=7)
    again, again_key = sheet_mod.build(list(reversed(records)), seed=7)
    assert first == again and first_key == again_key
    other, _ = sheet_mod.build(records, seed=8)
    order = [(first_key["runs"][run["id"]]["arm"], run["task"]) for run in first["runs"]]
    assert order != sorted(order), "the runs came out grouped by arm and task"
    assert [r["task"] for r in other["runs"]] != [r["task"] for r in first["runs"]] or [
        r["statements"] for r in other["runs"]
    ] != [r["statements"] for r in first["runs"]]


def test_a_run_that_did_not_finish_is_not_on_the_sheet():
    records = some_records(repeats=1)
    records[0]["status"] = "launch_failed"
    sheet, key = sheet_mod.build(records, seed=7)
    assert len(sheet["runs"]) == len(records) - 1 == len(key["runs"])


def test_records_that_are_not_broad_runs_cannot_make_a_sheet():
    short = record("t-one", "arm-a", 1, "text")
    del short["broad"]
    with pytest.raises(sheet_mod.SheetError):
        sheet_mod.build([short], seed=1)


# --- the check of a filled sheet ------------------------------------------------------------


def test_a_blank_sheet_is_not_acceptable_and_every_statement_is_named():
    sheet, _key = sheet_mod.build(some_records(tasks=("broad-one",), repeats=1), seed=7)
    problems = sheet_mod.check_sheet(sheet)
    statements = sum(len(run["statements"]) for run in sheet["runs"])
    assert len(problems) == statements
    assert all("verdict" in problem for problem in problems)
    assert sheet["runs"][0]["id"] in problems[0]


def test_a_sheet_with_every_verdict_filled_is_acceptable():
    sheet, _key = sheet_mod.build(some_records(), seed=7)
    assert sheet_mod.check_sheet(fill(sheet, "true")) == []
    assert sheet_mod.check_sheet(fill(sheet, "not_checkable")) == []


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"file": "README.md"},
        {"line": 3},
        {"file": "README.md", "line": 0},
        {"file": "README.md", "line": -2},
        {"file": "README.md", "line": "3"},
        {"file": "README.md", "line": True},
        {"file": "  ", "line": 3},
    ],
)
def test_a_false_statement_needs_a_file_and_a_positive_line(extra):
    sheet, _key = sheet_mod.build(some_records(tasks=("broad-one",), repeats=1), seed=7)
    filled = fill(sheet)
    target = filled["runs"][0]["statements"][1]
    target.update({"verdict": "false", **extra})
    problems = sheet_mod.check_sheet(filled)
    assert len(problems) == 1
    assert filled["runs"][0]["id"] in problems[0] and "statement 2" in problems[0]
    assert "file" in problems[0] and "line" in problems[0]


def test_a_false_statement_with_a_file_and_a_line_is_acceptable():
    sheet, _key = sheet_mod.build(some_records(tasks=("broad-one",), repeats=1), seed=7)
    filled = fill(sheet)
    filled["runs"][0]["statements"][0].update(verdict="false", file="README.md", line=3, note="x")
    assert sheet_mod.check_sheet(filled) == []


@pytest.mark.parametrize("verdict", [True, False, "False", "wrong", "", 1])
def test_a_verdict_must_be_one_of_the_three_words(verdict):
    sheet, _key = sheet_mod.build(some_records(tasks=("broad-one",), repeats=1), seed=7)
    filled = fill(sheet)
    filled["runs"][0]["statements"][0]["verdict"] = verdict
    problems = sheet_mod.check_sheet(filled)
    assert len(problems) == 1 and "true, false or not_checkable" in problems[0]


def test_a_sheet_that_is_not_a_sheet_is_a_problem_not_a_crash():
    for bad in (None, [], {"runs": "x"}, {"format": 1, "runs": [{"id": "s01"}]}, {"runs": [3]}):
        assert sheet_mod.check_sheet(bad)


@pytest.fixture
def clone_root(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "checkouts" / "one"
    repo.mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("line one\nline two\nline three\n", encoding="utf-8")
    (repo / "src").mkdir()
    (repo / "src" / "no_newline.py").write_text("a = 1\nb = 2", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture")
    pinned = git(repo, "rev-parse", "HEAD")
    # The working tree moves on; the check reads the pinned commit, not these files.
    (repo / "README.md").write_text("one line now\n", encoding="utf-8")
    (repo / "later.md").write_text("added later\n", encoding="utf-8")
    return tmp_path / "checkouts", pinned


def one_false(clone_root, file: str, line: int, name: str = "one") -> tuple[dict, Path]:
    root, pinned = clone_root
    records = [record("broad-one", "score-off", 1, "First. Second.", commit=pinned, name=name)]
    sheet, _key = sheet_mod.build(records, seed=7)
    filled = fill(sheet)
    filled["runs"][0]["statements"][0].update(verdict="false", file=file, line=line)
    return filled, root


@pytest.mark.parametrize(
    "file, line", [("README.md", 1), ("README.md", 3), ("src/no_newline.py", 2)]
)
def test_with_a_clone_root_a_real_file_and_line_is_acceptable(clone_root, file, line):
    filled, root = one_false(clone_root, file, line)
    assert sheet_mod.check_sheet(filled, clone_root=root) == []


@pytest.mark.parametrize(
    "file, line, word",
    [
        ("README.md", 4, "3 lines"),
        ("src/no_newline.py", 3, "2 lines"),
        ("missing.md", 1, "not a file"),
        ("later.md", 1, "not a file"),
        ("src", 1, "not a file"),
        ("../one/README.md", 1, "not a file"),
    ],
)
def test_with_a_clone_root_a_missing_file_or_line_is_a_problem(clone_root, file, line, word):
    filled, root = one_false(clone_root, file, line)
    problems = sheet_mod.check_sheet(filled, clone_root=root)
    assert len(problems) == 1
    assert word in problems[0] and "statement 1" in problems[0]


def test_with_a_clone_root_a_repository_without_a_checkout_is_a_problem(clone_root):
    filled, root = one_false(clone_root, "README.md", 1, name="elsewhere")
    problems = sheet_mod.check_sheet(filled, clone_root=root)
    assert len(problems) == 1 and "elsewhere" in problems[0]


def test_without_a_clone_root_the_file_is_not_looked_up(clone_root):
    filled, _root = one_false(clone_root, "missing.md", 99)
    assert sheet_mod.check_sheet(filled) == []


# --- joining the sheet and the key ----------------------------------------------------------


def graded(records, seed=7):
    sheet, key = sheet_mod.build(records, seed=seed)
    filled = fill(sheet)
    for run in filled["runs"]:
        entry = key["runs"][run["id"]]
        if entry["arm"] == "score-off":
            run["statements"][0].update(verdict="false", file="README.md", line=1)
            run["statements"][2]["verdict"] = "not_checkable"
    return filled, key


def test_the_join_gives_each_run_its_counts():
    records = some_records()
    filled, key = graded(records)
    joined = sheet_mod.join(filled, key, records)
    assert sorted(joined) == sorted(
        (r["task"]["id"], r["arm"]["name"], r["repeat"]) for r in records
    )
    for (_task, arm, _repeat), counts in joined.items():
        assert counts["statements"] == 4
        assert counts["false"] == (1 if arm == "score-off" else 0)
        assert counts["not_checkable"] == (1 if arm == "score-off" else 0)
        assert counts["true"] == (2 if arm == "score-off" else 4)


def test_the_join_is_refused_while_one_run_is_not_fully_graded():
    records = some_records()
    filled, key = graded(records)
    filled["runs"][3]["statements"][1]["verdict"] = None
    with pytest.raises(sheet_mod.SheetError) as caught:
        sheet_mod.join(filled, key, records)
    assert filled["runs"][3]["id"] in "; ".join(caught.value.problems)


def test_the_join_is_refused_when_a_false_has_no_file_and_line():
    records = some_records()
    filled, key = graded(records)
    filled["runs"][0]["statements"][3].update(verdict="false", file=None, line=None)
    with pytest.raises(sheet_mod.SheetError):
        sheet_mod.join(filled, key, records)


def test_the_join_is_refused_when_a_run_of_the_key_is_missing_from_the_sheet():
    records = some_records()
    filled, key = graded(records)
    gone = filled["runs"].pop()
    with pytest.raises(sheet_mod.SheetError) as caught:
        sheet_mod.join(filled, key, records)
    assert gone["id"] in "; ".join(caught.value.problems)


def test_the_join_is_refused_when_statements_were_removed_or_reworded():
    records = some_records()
    filled, key = graded(records)
    removed = copy.deepcopy(filled)
    removed["runs"][0]["statements"].pop()
    with pytest.raises(sheet_mod.SheetError) as caught:
        sheet_mod.join(removed, key, records)
    assert "statements" in "; ".join(caught.value.problems)
    reworded = copy.deepcopy(filled)
    reworded["runs"][0]["statements"][0]["text"] = "Something easier to grade."
    with pytest.raises(sheet_mod.SheetError):
        sheet_mod.join(reworded, key, records)


def test_the_join_is_refused_when_a_stored_run_is_not_in_the_key():
    records = some_records()
    filled, key = graded(records[:-1])
    with pytest.raises(sheet_mod.SheetError) as caught:
        sheet_mod.join(filled, key, records)
    assert "not in the key" in "; ".join(caught.value.problems)


def test_the_join_is_refused_when_a_stored_answer_changed_since_the_sheet():
    records = some_records()
    filled, key = graded(records)
    records[0]["answer"]["text"] = "A different answer."
    with pytest.raises(sheet_mod.SheetError) as caught:
        sheet_mod.join(filled, key, records)
    assert "changed" in "; ".join(caught.value.problems)


def test_the_join_with_a_clone_root_checks_the_files(clone_root):
    root, pinned = clone_root
    records = [record("broad-one", "score-off", 1, "First. Second.", commit=pinned, name="one")]
    sheet, key = sheet_mod.build(records, seed=7)
    filled = fill(sheet)
    filled["runs"][0]["statements"][0].update(verdict="false", file="missing.md", line=1)
    assert sheet_mod.join(filled, key, records)
    with pytest.raises(sheet_mod.SheetError):
        sheet_mod.join(filled, key, records, clone_root=root)


# --- the rows and the text of the report ----------------------------------------------------


def test_rows_list_every_run_grouped_by_repository_and_arm_with_both_counts():
    records = some_records()
    records[0]["broad"].update(facts_stated=2, answer_source="final_reply", at_cap=True)
    filled, key = graded(records)
    rows = sheet_mod.run_rows(records, sheet_mod.join(filled, key, records))
    assert [(r["task"], r["arm"], r["repeat"]) for r in rows] == sorted(
        (r["task"]["id"], r["arm"]["name"], r["repeat"]) for r in records
    )
    first = rows[0]
    assert first["facts_stated"] == 2 and first["facts_total"] == 3
    assert first["statements_false"] == 1 and first["statements_not_checkable"] == 1
    assert first["statements"] == 4
    assert first["answer_source"] == "final_reply" and first["at_cap"] is True
    assert first["repository"] == "example/one"
    assert first["support_score"] == "off"


def test_rows_without_a_join_carry_no_statement_counts():
    rows = sheet_mod.run_rows(some_records(), None)
    assert all(row["statements_false"] is None and row["statements"] is None for row in rows)
    assert all(row["facts_stated"] == 1 for row in rows)


def test_the_text_prints_both_counts_per_run_and_no_pooled_number():
    records = some_records()
    filled, key = graded(records)
    text = sheet_mod.render_rows(sheet_mod.run_rows(records, sheet_mod.join(filled, key, records)))
    assert "first marking" in text
    assert text.count("1 of 3") == len(records)
    assert "broad-one" in text and "example/one" in text and "score-off" in text
    assert "statements counted false 1" in text and "not checkable 1" in text
    assert "answer from answer.md" in text
    lowered = text.lower()
    for word in ("%", "percent", "accuracy", "score ", "total", "average", "mean"):
        assert word not in lowered.replace("support_score ", "").replace("score-o", "")


def test_the_text_without_a_join_says_the_statements_are_not_joined():
    text = sheet_mod.render_rows(sheet_mod.run_rows(some_records(), None))
    assert "not joined" in text
    assert re.search(r"statements counted false \d", text) is None
    assert re.search(r"not checkable \d", text) is None


def test_a_final_reply_at_the_cap_is_flagged_in_the_text():
    records = some_records(tasks=("broad-one",), repeats=1)
    records[0]["broad"].update(answer_source="final_reply", at_cap=True)
    text = sheet_mod.render_rows(sheet_mod.run_rows(records, None))
    assert "answer from final_reply, at the 2000-character cap" in text
    assert "answer from answer.md, not at the cap" in text


def test_counts_for_the_rule_leave_out_runs_that_read_the_answer_key():
    records = some_records(tasks=("broad-one",))
    records[0]["contamination"]["contaminated"] = True
    rows = sheet_mod.run_rows(records, None)
    counts = sheet_mod.rule_counts(rows, "facts_stated")
    assert counts == {"broad-one": {"score-off": [1, 1], "score-on": [1, 1, 1]}}
