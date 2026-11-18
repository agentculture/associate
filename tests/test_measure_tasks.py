"""The measurement task format and its checker (groundwork plan task t6)."""

from __future__ import annotations

import copy
import json
import os
import subprocess
from pathlib import Path

import pytest
from evidence.answer import grade

from associate.contract.validate import validate
from associate.measure import tasks as measure_tasks
from associate.measure.tasks import (
    TaskFileError,
    check_expected_in_repository,
    grade_task,
    load_task_file,
    validate_task,
    validate_task_file,
)

ROOT = Path(__file__).resolve().parent.parent
SIX = [
    "gate-thresholds",
    "worktree-merge-refusals",
    "read-budget",
    "senses-rights",
    "forbidden-decisions",
    "decider-retry-count",
]

# One hand-written wrong answer per converted task: it names the right area and is
# wrong (or silent) about every value the task asks for.
WRONG = {
    "gate-thresholds": (
        "associate/contract/clef.json, version 8. The rules are safe_unattended >= 0.8 "
        "and destructive <= 0.5. Only write and edit are gated."
    ),
    "worktree-merge-refusals": (
        "The harness merges the branch into main whenever the model says it is finished, "
        "and refuses only when the run timed out."
    ),
    "read-budget": (
        "budgets.read sets max_lines 500, max_output_chars 10000, max_bytes 2048 "
        "and spill_to_disk false."
    ),
    "senses-rights": (
        'The senses entry has may_mutate true and may_delegate ["cortex"], so it can '
        "change the checkout."
    ),
    "forbidden-decisions": (
        "associate/contract/role.json forbids code_authoring and repo_action for every model."
    ),
    "decider-retry-count": (
        "The gate retries a failed decider call three times with exponential backoff."
    ),
}


@pytest.fixture(scope="module")
def doc() -> dict:
    return load_task_file()


def _task(doc: dict, task_id: str) -> dict:
    return next(t for t in doc["tasks"] if t["id"] == task_id)


def _basic() -> dict:
    return {
        "id": "t-basic",
        "kind": "find",
        "repository": {"host": "github.com", "owner": "example", "name": "demo"},
        "commit": "a" * 40,
        "prompt": "Which file holds the limit?",
        "answer": "limits.py, version 9.",
        "expected": {
            "schema_version": 1,
            "must_appear": [{"text": "limits.py", "kind": "identifier"}],
        },
    }


# --- criterion 1: every task validates; bad tasks are refused with the reason ---------


def test_every_task_in_the_file_validates(doc):
    assert validate_task_file(doc) == []
    assert [t["id"] for t in doc["tasks"][:6]] == SIX


def test_the_file_schema_accepts_the_file_and_refuses_an_unknown_file_key(doc):
    schema = json.loads(
        (ROOT / "associate/contract/schemas/measure-tasks.schema.json").read_text(encoding="utf-8")
    )
    assert validate(doc, schema) == []
    bad = copy.deepcopy(doc)
    bad["surprise"] = 1
    assert any("surprise" in e for e in validate(bad, schema))


def test_a_task_with_an_unknown_key_is_refused_with_the_key_named():
    task = _basic()
    task["difficulty"] = "hard"
    problems = validate_task(task)
    assert any("unknown key" in p and "difficulty" in p for p in problems)


def test_an_unknown_key_inside_the_expected_values_is_refused():
    task = _basic()
    task["expected"]["must_apear"] = []
    assert any("must_apear" in p for p in validate_task(task))


def test_a_task_without_a_pinned_commit_is_refused():
    task = _basic()
    del task["commit"]
    problems = validate_task(task)
    assert any("commit" in p and "pinned" in p for p in problems)


@pytest.mark.parametrize("commit", ["main", "abc123", "A" * 40, "g" * 40])
def test_a_commit_that_is_not_a_full_hash_is_refused(commit):
    task = _basic()
    task["commit"] = commit
    assert any("commit" in p for p in validate_task(task))


def test_a_bare_number_below_100_is_refused_with_the_reason():
    task = _basic()
    task["expected"]["must_appear"] = [{"text": "9", "kind": "number"}]
    problems = validate_task(task)
    assert len(problems) == 1
    assert "bare number" in problems[0]
    assert "below 100" in problems[0]
    assert "'9'" in problems[0]


@pytest.mark.parametrize("text", ["0.5", "99", "-3", "12.75", "1,5"])
def test_other_small_bare_numbers_are_refused_too(text):
    task = _basic()
    task["expected"]["must_appear"] = [{"text": text, "kind": "number"}]
    assert any("bare number" in p for p in validate_task(task))


def test_a_small_bare_number_is_refused_in_a_one_of_group_and_in_must_not_appear():
    task = _basic()
    task["expected"]["one_of"] = [[{"text": "5", "kind": "number"}]]
    task["expected"]["must_not_appear"] = [{"text": "7", "kind": "number"}]
    refused = [p for p in validate_task(task) if "bare number" in p]
    assert len(refused) == 2


@pytest.mark.parametrize("text", ["100", "25000", "1,048,576", "1048576", "100.5"])
def test_numbers_of_100_or_more_are_accepted(text):
    task = _basic()
    task["expected"]["must_appear"] = [{"text": text, "kind": "number"}]
    assert validate_task(task) == []


def test_a_small_number_in_text_form_with_its_label_is_accepted():
    task = _basic()
    task["expected"]["must_appear"] = [{"text": "version 9", "kind": "text"}]
    assert validate_task(task) == []


def test_expected_values_that_name_nothing_to_appear_are_refused():
    task = _basic()
    task["expected"] = {"schema_version": 1}
    assert any("no item" in p for p in validate_task(task))


def test_expected_values_that_evidence_refuses_are_refused_with_its_reason():
    task = _basic()
    task["expected"]["schema_version"] = 2
    assert any("schema_version" in p for p in validate_task(task))


def test_a_derived_entry_must_name_a_text_that_is_expected():
    task = _basic()
    task["derived"] = [{"texts": ["not expected anywhere"], "command": "true"}]
    assert any("not expected anywhere" in p for p in validate_task(task))


def test_load_task_file_refuses_a_bad_file_with_every_reason(tmp_path):
    bad = {"format_version": 1, "tasks": [{"id": "x"}]}
    path = tmp_path / "tasks.json"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(TaskFileError) as raised:
        load_task_file(path)
    assert len(raised.value.problems) >= 3


def test_duplicate_task_ids_are_refused(doc):
    bad = copy.deepcopy(doc)
    bad["tasks"].append(copy.deepcopy(bad["tasks"][0]))
    assert any("duplicate" in p for p in validate_task_file(bad))


# --- criterion 2: recorded answer matches, a wrong answer does not -------------------


@pytest.mark.parametrize("task_id", SIX)
def test_the_recorded_answer_is_graded_as_matching(doc, task_id):
    task = _task(doc, task_id)
    result = grade_task(task, task["answer"])
    assert result["verdict"] == "matches", result
    assert result == grade(task["answer"], task["expected"])


@pytest.mark.parametrize("task_id", SIX)
def test_a_hand_written_wrong_answer_is_graded_as_not_matching(doc, task_id):
    task = _task(doc, task_id)
    result = grade_task(task, WRONG[task_id])
    assert result["verdict"] == "does_not_match", result
    assert result["missing"] or result["forbidden_present"]


@pytest.mark.parametrize("task_id", SIX)
def test_an_empty_answer_cannot_be_told(doc, task_id):
    assert grade_task(_task(doc, task_id), "  ")["verdict"] == "cannot_tell"


def test_the_converted_tasks_hold_no_bare_small_number(doc):
    for task in doc["tasks"]:
        items = list(task["expected"].get("must_appear", []))
        items += task["expected"].get("must_not_appear", [])
        items += [i for group in task["expected"].get("one_of", []) for i in group]
        for item in items:
            if item["kind"] == "number":
                assert float(item["text"].replace(",", "")) >= 100, (task["id"], item)


# --- criterion 3: the repository check ------------------------------------------------


def _git(repo: Path, *args: str) -> str:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
    done = subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        capture_output=True,
        text=True,
        check=True,
        env=env,
    )
    return done.stdout.strip()


@pytest.fixture
def demo_repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "demo"
    (repo / "src").mkdir(parents=True)
    (repo / "docs" / "accuracy").mkdir(parents=True)
    (repo / "src" / "limits.py").write_text("MAX_ROWS = 250\nName = 'Alpha_Value'\n")
    (repo / "docs" / "accuracy" / "key.json").write_text('{"answer": "only_in_the_key"}\n')
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "one")
    pin = _git(repo, "rev-parse", "HEAD")
    (repo / "src" / "limits.py").write_text("MAX_ROWS = 999\n")
    _git(repo, "commit", "-q", "-am", "two")
    return repo, pin


def _demo_task(pin: str, must: list[dict], derived: list[dict] | None = None) -> dict:
    task = _basic()
    task["commit"] = pin
    task["expected"] = {"schema_version": 1, "must_appear": must}
    if derived:
        task["derived"] = derived
    return task


def test_a_value_present_at_the_pinned_commit_is_found(demo_repo):
    repo, pin = demo_repo
    task = _demo_task(pin, [{"text": "MAX_ROWS", "kind": "identifier"}])
    result = check_expected_in_repository(task, repo)
    assert (result.found, result.derived, result.missing) == (["MAX_ROWS"], [], [])
    assert result.ok is True


def test_the_pinned_commit_is_read_not_the_current_one(demo_repo):
    repo, pin = demo_repo
    old = _demo_task(pin, [{"text": "250", "kind": "number"}])
    assert check_expected_in_repository(old, repo).ok is True
    new = _demo_task(pin, [{"text": "999", "kind": "number"}])
    assert check_expected_in_repository(new, repo).missing == ["999"]


def test_a_planted_value_that_is_not_there_fails_and_is_named(demo_repo):
    repo, pin = demo_repo
    task = _demo_task(
        pin,
        [
            {"text": "MAX_ROWS", "kind": "identifier"},
            {"text": "planted_value_not_in_repo", "kind": "identifier"},
        ],
    )
    result = check_expected_in_repository(task, repo)
    assert result.ok is False
    assert result.missing == ["planted_value_not_in_repo"]
    assert result.found == ["MAX_ROWS"]


def test_the_answer_key_directory_is_not_searched(demo_repo):
    repo, pin = demo_repo
    task = _demo_task(pin, [{"text": "only_in_the_key", "kind": "identifier"}])
    assert check_expected_in_repository(task, repo).missing == ["only_in_the_key"]


def test_a_derived_value_is_reported_with_its_command_and_does_not_fail(demo_repo):
    repo, pin = demo_repo
    task = _demo_task(
        pin,
        [{"text": "rows 250", "kind": "text"}],
        [{"texts": ["rows 250"], "command": "git show $COMMIT:src/limits.py | wc -l"}],
    )
    result = check_expected_in_repository(task, repo)
    assert result.ok is True
    assert result.derived == [("rows 250", "git show $COMMIT:src/limits.py | wc -l")]
    assert result.found == []
    assert result.missing == []


def test_fold_case_text_is_found_case_insensitively(demo_repo):
    repo, pin = demo_repo
    task = _demo_task(pin, [{"text": "alpha_value", "kind": "text", "fold_case": True}])
    assert check_expected_in_repository(task, repo).found == ["alpha_value"]
    task = _demo_task(pin, [{"text": "alpha_value", "kind": "text"}])
    assert check_expected_in_repository(task, repo).missing == ["alpha_value"]


def test_search_paths_limit_where_a_value_may_be_found(demo_repo):
    repo, pin = demo_repo
    task = _demo_task(pin, [{"text": "MAX_ROWS", "kind": "identifier"}])
    task["search_paths"] = ["docs"]
    assert check_expected_in_repository(task, repo).missing == ["MAX_ROWS"]
    task["search_paths"] = ["src/limits.py"]
    assert check_expected_in_repository(task, repo).ok is True


def test_a_text_starting_with_a_dash_or_holding_regex_characters_is_literal(demo_repo):
    repo, pin = demo_repo
    task = _demo_task(pin, [{"text": "-x.*[", "kind": "text"}])
    assert check_expected_in_repository(task, repo).missing == ["-x.*["]


def test_an_unknown_commit_is_an_error_not_a_pass(demo_repo):
    repo, _ = demo_repo
    task = _demo_task("0" * 40, [{"text": "MAX_ROWS", "kind": "identifier"}])
    with pytest.raises(measure_tasks.RepositoryCheckError):
        check_expected_in_repository(task, repo)


@pytest.mark.parametrize("task_id", SIX)
def test_each_converted_task_is_found_or_derived_at_its_pinned_commit(doc, task_id):
    task = _task(doc, task_id)
    result = check_expected_in_repository(task, ROOT)
    assert result.missing == []
    assert result.found or result.derived


def test_a_planted_value_fails_on_a_real_task(doc):
    task = copy.deepcopy(_task(doc, "forbidden-decisions"))
    task["expected"]["must_appear"].append({"text": "planted_decision", "kind": "identifier"})
    assert check_expected_in_repository(task, ROOT).missing == ["planted_decision"]


def test_the_search_does_not_find_values_in_the_answer_key_of_the_real_repository(doc):
    task = copy.deepcopy(_task(doc, "forbidden-decisions"))
    task["search_paths"] = []
    task["expected"]["must_appear"] = [{"text": "never taken from a model run", "kind": "text"}]
    assert check_expected_in_repository(task, ROOT).missing == ["never taken from a model run"]


@pytest.mark.parametrize("task_id", SIX)
def test_every_derived_command_prints_each_text_it_derives(doc, task_id):
    task = _task(doc, task_id)
    for entry in task.get("derived", []):
        done = subprocess.run(
            ["bash", "-c", entry["command"]],
            cwd=ROOT,
            env={**os.environ, "COMMIT": task["commit"]},
            capture_output=True,
            text=True,
            check=False,
        )
        out = " ".join(done.stdout.split())
        assert done.returncode == 0, done.stderr
        for text in entry["texts"]:
            assert " ".join(text.split()) in out, (task_id, text, out)


@pytest.mark.parametrize("task_id", SIX)
def test_the_pinned_commit_is_on_origin_main(doc, task_id):
    task = _task(doc, task_id)
    done = subprocess.run(
        ["git", "-C", str(ROOT), "cat-file", "-t", task["commit"]],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.stdout.strip() == "commit", done.stderr


# --- criterion 4: grading twice gives equal results ------------------------------------


@pytest.mark.parametrize("task_id", SIX)
def test_grading_the_same_answer_twice_gives_equal_results(doc, task_id):
    task = _task(doc, task_id)
    for answer in (task["answer"], WRONG[task_id], ""):
        first = grade_task(task, answer)
        second = grade_task(task, answer)
        assert first == second
        assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


def test_grading_does_not_change_the_task(doc):
    task = _task(doc, "gate-thresholds")
    before = copy.deepcopy(task)
    grade_task(task, task["answer"])
    assert task == before
