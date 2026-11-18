"""The 24-task measurement set (groundwork plan task t8).

``docs/accuracy/tasks.json`` holds 8 tasks in each of associate, workledger-cli
and coherence-cli, each pinned to a commit. These tests check the set as a
whole: its shape, that every expected text is at the pinned commit (or derived
by a command that prints it there), that no expected value is a bare small
number or is given away by the prompt, and that the answer check marks every
recorded case (saved model answers and hand-written right and wrong answers,
``docs/accuracy/answer-cases.json``) the way it was judged by hand.

A sibling repository is looked for beside the repository root (``../<name>``),
and beside the main checkout when this is a git worktree. When it is absent, or
does not hold the pinned commit, the tests that need it are skipped with that
reason; they never pass without looking. The outcome of the repository check for
all 24 tasks is recorded in ``docs/accuracy/checks/repository-check.md`` so it
is in the repository even where CI skips.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections import Counter
from functools import lru_cache
from pathlib import Path

import pytest
from evidence.answer import grade

from associate.measure.tasks import (
    check_expected_in_repository,
    grade_task,
    load_task_file,
)

ROOT = Path(__file__).resolve().parent.parent
CASES_FILE = ROOT / "docs" / "accuracy" / "answer-cases.json"
CHECKS_DIR = ROOT / "docs" / "accuracy" / "checks"
REPOSITORIES = {
    "associate": ("github.com", "agentculture"),
    "workledger-cli": ("github.com", "agentculture"),
    "coherence-cli": ("github.com", "agentculture"),
}
TASKS_PER_REPOSITORY = 8
CONVERTED = {
    "gate-thresholds",
    "worktree-merge-refusals",
    "read-budget",
    "senses-rights",
    "forbidden-decisions",
    "decider-retry-count",
}
_NUMBER = re.compile(r"-?\d+(?:[.,]\d+)*", re.ASCII)
_GROUPED = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", re.ASCII)


def _doc() -> dict:
    return load_task_file()


def _tasks() -> list[dict]:
    return _doc()["tasks"]


def _ids() -> list[str]:
    return [t["id"] for t in _tasks()]


def _task(task_id: str) -> dict:
    return next(t for t in _tasks() if t["id"] == task_id)


def _cases() -> list[dict]:
    return json.loads(CASES_FILE.read_text(encoding="utf-8"))["cases"]


def _case_ids(source_prefix: str) -> list[str]:
    if not CASES_FILE.is_file():
        return ["answer-cases.json is missing"]
    return [
        f"{c['task']}:{i}" for i, c in enumerate(_cases()) if c["source"].startswith(source_prefix)
    ]


def _items(expected: dict) -> list[dict]:
    out = list(expected.get("must_appear", []))
    out += expected.get("must_not_appear", [])
    out += [i for group in expected.get("one_of", []) for i in group]
    return out


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False
    )


@lru_cache(maxsize=None)
def _main_checkout() -> Path:
    done = _git(ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir")
    common = Path(done.stdout.strip()) if done.returncode == 0 and done.stdout.strip() else None
    return common.parent if common is not None else ROOT


def _this_checkout(commit: str) -> Path:
    """This checkout, or pytest.skip when it is shallow and lacks the pinned commit.

    A shallow checkout (a default CI checkout) holds only the newest commit.
    With the object present, or in a checkout that has its whole history, the
    test runs and asserts.
    """
    if _git(ROOT, "cat-file", "-e", commit).returncode != 0:
        shallow = _git(ROOT, "rev-parse", "--is-shallow-repository")
        if shallow.returncode == 0 and shallow.stdout.strip() == "true":
            pytest.skip(
                f"the pinned commit {commit} is not in this checkout, which is shallow; "
                "fetch the full history to run this test"
            )
    return ROOT


def _locate(task: dict, needs_commit: bool = True) -> Path:
    """The checkout holding the task's pinned commit, or pytest.skip with the reason.

    ``needs_commit`` False is for a test that reads only the working tree of this
    repository: it runs in a shallow checkout too.
    """
    name = task["repository"]["name"]
    if name == "associate":
        return _this_checkout(task["commit"]) if needs_commit else ROOT
    candidates = []
    for base in (ROOT.parent, _main_checkout().parent):
        if base / name not in candidates:
            candidates.append(base / name)
    present = [c for c in candidates if (c / ".git").exists()]
    if not present:
        where = ", ".join(str(c) for c in candidates)
        pytest.skip(f"sibling repository {name} is not checked out (looked in {where})")
    for checkout in present:
        if _git(checkout, "cat-file", "-e", f"{task['commit']}^{{commit}}").returncode == 0:
            return checkout
    pytest.skip(f"no checkout of {name} holds the pinned commit {task['commit']}")


# --- criterion 1: 24 tasks, 8 per repository, each passing the repository check ------


def test_the_file_holds_24_tasks_8_per_repository():
    tasks = _tasks()
    names = Counter(t["repository"]["name"] for t in tasks)
    assert dict(names) == {name: TASKS_PER_REPOSITORY for name in REPOSITORIES}
    assert len(tasks) == TASKS_PER_REPOSITORY * len(REPOSITORIES)
    for task in tasks:
        host, owner = REPOSITORIES[task["repository"]["name"]]
        assert (task["repository"]["host"], task["repository"]["owner"]) == (host, owner)


def test_the_six_converted_tasks_are_still_there_and_first():
    assert set(_ids()[:6]) == CONVERTED


def test_each_repository_has_two_not_found_tasks_and_the_kinds_are_mixed():
    tasks = _tasks()
    for name in REPOSITORIES:
        kinds = Counter(t["kind"] for t in tasks if t["repository"]["name"] == name)
        assert kinds["not_found"] >= 2, (name, kinds)
        assert len(kinds) >= 3, (name, kinds)
    every = Counter(t["kind"] for t in tasks)
    for kind in ("read", "find", "count", "review", "not_found"):
        assert every[kind] >= 2, every


def test_tasks_in_one_repository_share_one_pinned_commit():
    commits: dict[str, set[str]] = {}
    for task in _tasks():
        commits.setdefault(task["repository"]["name"], set()).add(task["commit"])
    assert {name: len(c) for name, c in commits.items()} == {name: 1 for name in REPOSITORIES}


@pytest.mark.parametrize("task_id", _ids())
def test_each_task_passes_the_repository_check_at_its_pinned_commit(task_id):
    task = _task(task_id)
    repo = _locate(task)
    result = check_expected_in_repository(task, repo)
    assert result.missing == [], (task_id, result.missing)
    assert result.found or result.derived


@pytest.mark.parametrize("task_id", _ids())
def test_every_derived_command_prints_each_text_it_derives(task_id):
    task = _task(task_id)
    if not task.get("derived"):
        return
    # Only a command that reads the pinned commit needs it in the checkout.
    repo = _locate(task, any("COMMIT" in entry["command"] for entry in task["derived"]))
    for entry in task["derived"]:
        done = subprocess.run(
            ["bash", "-c", entry["command"]],
            cwd=repo,
            env={**os.environ, "COMMIT": task["commit"]},
            capture_output=True,
            text=True,
            check=False,
        )
        assert done.returncode == 0, (task_id, done.stderr)
        out = " ".join(done.stdout.split())
        for text in entry["texts"]:
            assert " ".join(text.split()) in out, (task_id, text, out)


@pytest.mark.parametrize("task_id", _ids())
def test_the_recorded_answer_matches(task_id):
    task = _task(task_id)
    assert grade_task(task, task["answer"])["verdict"] == "matches"


# --- criterion 4: no expected value is a bare small number ----------------------------


def bare_small_numbers(task: dict) -> list[str]:
    """Item texts, of any kind, that are nothing but a number below 100."""
    out = []
    for item in _items(task["expected"]):
        text = item["text"].strip()
        if not _NUMBER.fullmatch(text):
            continue
        cleaned = text.lstrip("-")
        value = float(
            cleaned.replace(",", "") if _GROUPED.fullmatch(cleaned) else cleaned.replace(",", ".")
        )
        if value < 100:
            out.append(text)
    return out


def test_no_expected_value_is_a_bare_small_number():
    found = {t["id"]: bare_small_numbers(t) for t in _tasks()}
    assert {k: v for k, v in found.items() if v} == {}


@pytest.mark.parametrize(
    "item",
    [
        {"text": "9", "kind": "text"},
        {"text": "0.5", "kind": "text"},
        {"text": "7", "kind": "number"},
        {"text": " 30 ", "kind": "identifier"},
    ],
)
def test_the_bare_number_check_finds_a_planted_small_number(item):
    task = {"expected": {"schema_version": 1, "must_appear": [item]}}
    assert bare_small_numbers(task) == [item["text"].strip()]


def test_the_bare_number_check_accepts_labelled_and_large_values():
    task = {
        "expected": {
            "schema_version": 1,
            "must_appear": [
                {"text": "version 9", "kind": "text"},
                {"text": "365", "kind": "number"},
                {"text": "1,048,576", "kind": "number"},
                {"text": ">= 0.5", "kind": "text"},
            ],
        }
    }
    assert bare_small_numbers(task) == []


# --- no task is answered by its own prompt --------------------------------------------


def _prompt_gives_away(task: dict) -> list[str]:
    prompt = task["prompt"]
    expected = task["expected"]
    given = []
    for item in expected.get("must_appear", []):
        one = {"schema_version": 1, "must_appear": [item]}
        if grade(prompt, one)["verdict"] == "matches":
            given.append(item["text"])
    for group in expected.get("one_of", []):
        for item in group:
            one = {"schema_version": 1, "must_appear": [item]}
            if grade(prompt, one)["verdict"] == "matches":
                given.append(item["text"])
    return given


def test_no_prompt_contains_an_expected_value():
    given = {t["id"]: _prompt_gives_away(t) for t in _tasks()}
    assert {k: v for k, v in given.items() if v} == {}


def test_no_prompt_alone_is_marked_as_a_matching_answer():
    for task in _tasks():
        assert grade_task(task, task["prompt"])["verdict"] == "does_not_match", task["id"]


# --- the answer check agrees with the hand judgement ----------------------------------


def _case(case_id: str) -> dict:
    if not CASES_FILE.is_file():
        pytest.fail(f"{CASES_FILE} is missing")
    return _cases()[int(case_id.rsplit(":", 1)[1])]


@pytest.mark.parametrize("case_id", _case_ids("saved:"))
def test_each_saved_model_answer_grades_as_judged_by_hand(case_id):
    case = _case(case_id)
    result = grade_task(_task(case["task"]), case["text"])
    assert result["verdict"] == case["hand_verdict"], (case_id, case["source"], result)


@pytest.mark.parametrize("case_id", _case_ids("hand"))
def test_each_hand_written_answer_grades_as_judged_by_hand(case_id):
    case = _case(case_id)
    result = grade_task(_task(case["task"]), case["text"])
    assert result["verdict"] == case["hand_verdict"], (case_id, case["text"], result)


def test_every_new_task_has_three_right_and_two_wrong_hand_written_answers():
    cases = _cases()
    for task_id in _ids():
        if task_id in CONVERTED:
            continue
        mine = [c for c in cases if c["task"] == task_id and c["source"] == "hand"]
        right = {c["text"] for c in mine if c["hand_verdict"] == "matches"}
        wrong = {c["text"] for c in mine if c["hand_verdict"] == "does_not_match"}
        assert len(right) >= 3, task_id
        assert len(wrong) >= 2, task_id


def test_every_saved_answer_to_the_six_is_a_case():
    saved = [c for c in _cases() if c["source"].startswith("saved:")]
    assert len(saved) == 14
    assert {c["task"] for c in saved} == CONVERTED
    for case in saved:
        assert case["text"].strip(), case["source"]
        assert case["grade_before"] in ("matches", "does_not_match")


def test_every_case_names_a_known_task_and_a_hand_verdict():
    known = set(_ids())
    for case in _cases():
        assert case["task"] in known
        assert case["hand_verdict"] in ("matches", "does_not_match")


# --- criteria 2 and 3: the first check is recorded; the second checker's brief --------


@pytest.mark.parametrize("task_id", _ids())
def test_each_task_has_a_first_check_record(task_id):
    path = CHECKS_DIR / f"{task_id}.first.md"
    assert path.is_file(), path
    text = path.read_text(encoding="utf-8")
    assert _task(task_id)["commit"] in text
    assert "git " in text


def test_the_checks_readme_tells_a_second_checker_what_they_get_and_states_no_answer():
    text = (CHECKS_DIR / "README.md").read_text(encoding="utf-8")
    assert ".second.md" in text
    assert "pinned commit" in text
    assert "prompt" in text
    for task in _tasks():
        assert task["answer"] not in text
        for item in task["expected"].get("must_appear", []):
            if len(item["text"]) >= 8:
                assert item["text"] not in text, (task["id"], item["text"])


def test_the_repository_check_output_is_recorded_for_all_24_tasks():
    text = (CHECKS_DIR / "repository-check.md").read_text(encoding="utf-8")
    for task_id in _ids():
        line = next((ln for ln in text.splitlines() if f"`{task_id}`" in ln), None)
        assert line is not None, task_id
        assert "missing: none" in line, line


@pytest.mark.parametrize("task_id", _ids())
def test_each_task_has_a_second_check_that_did_not_see_the_first(task_id):
    path = CHECKS_DIR / f"{task_id}.second.md"
    assert path.is_file(), path
    text = path.read_text(encoding="utf-8")
    assert "## What I was given" in text
    assert "did not see the first check" in text


def test_no_disagreement_between_the_two_checks_is_left_unsettled():
    text = (CHECKS_DIR / "disagreements.md").read_text(encoding="utf-8")
    assert "## Disagreements" in text
    assert "unsettled" in text
    assert "not settled" not in text
