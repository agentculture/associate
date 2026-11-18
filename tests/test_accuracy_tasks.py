"""The fixed measurement task set (issue #20, plan task t3).

``docs/accuracy/tasks.json`` records read/find tasks on this repository with
hand-checked answers. Every evidence item names a file, a line and the exact
text on that line. This test loads the file and checks each one against the
checkout.

Line numbers drift when a later task edits a file. A file marked
``"stable": true`` must match at its recorded line exactly. A file marked
``"stable": false`` may have moved: the text must still be in the file, and
the drift is reported by a warning naming the recorded and the current line.
A recorded text found nowhere in its file always fails.
"""

from __future__ import annotations

import json
import re
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TASKS_FILE = ROOT / "docs" / "accuracy" / "tasks.json"
KINDS = {"read", "find", "not_found"}


def _load() -> dict:
    return json.loads(TASKS_FILE.read_text(encoding="utf-8"))


def _lines(rel: str) -> list[str]:
    path = ROOT / rel
    assert path.is_file(), f"{rel}: file named by the task set does not exist"
    return path.read_text(encoding="utf-8").splitlines()


def _task_ids() -> list[str]:
    return [t["id"] for t in _load()["tasks"]]


def test_header_names_the_commit_the_answers_were_checked_against():
    data = _load()
    commit = data["checked_against_commit"]
    assert re.fullmatch(r"[0-9a-f]{40}", commit), commit
    assert data["checked_on"]
    # The hash is not required to exist in this clone: the answers were checked on a
    # local integration branch that reached main as one change, so that commit is
    # not in the published history. The header says so.
    assert data["checked_against_commit_note"].strip()


def test_task_set_has_enough_tasks_and_a_not_found():
    tasks = _load()["tasks"]
    assert len(tasks) >= 5
    assert len({t["id"] for t in tasks}) == len(tasks)
    assert any(t["kind"] == "not_found" for t in tasks)
    assert {t["kind"] for t in tasks} <= KINDS
    assert sum(1 for t in tasks if t.get("reused_from_2026_11_17")) >= 1


@pytest.mark.parametrize("task_id", _task_ids())
def test_task_is_complete(task_id):
    task = next(t for t in _load()["tasks"] if t["id"] == task_id)
    assert task["prompt"].strip()
    assert task["answer"].strip()
    if task["kind"] == "not_found":
        assert task["absent"], "a not_found task lists what was searched and not found"
        for item in task["absent"]:
            assert item["file"]
            assert item["patterns"]
    else:
        assert task["evidence"], "a read or find task lists file, line and exact text"
        for item in task["evidence"]:
            assert item["file"]
            assert item["text"]
            assert isinstance(item["line"], int)
            assert item["line"] >= 1
            assert isinstance(item["stable"], bool)


@pytest.mark.parametrize("task_id", _task_ids())
def test_evidence_matches_the_checkout(task_id):
    task = next(t for t in _load()["tasks"] if t["id"] == task_id)
    for item in task.get("evidence", []):
        lines = _lines(item["file"])
        at = item["line"]
        if at <= len(lines) and item["text"] in lines[at - 1]:
            continue
        found = [i + 1 for i, ln in enumerate(lines) if item["text"] in ln]
        where = f"{task_id}: {item['file']}:{at} text {item['text']!r}"
        assert found, f"{where} is not in the file any more"
        message = f"{where} has moved: recorded line {at}, now line(s) {found}"
        assert not item["stable"], f"line drift in a file marked stable: {message}"
        warnings.warn(message, stacklevel=1)


@pytest.mark.parametrize("task_id", _task_ids())
def test_not_found_patterns_are_absent(task_id):
    task = next(t for t in _load()["tasks"] if t["id"] == task_id)
    for item in task.get("absent", []):
        text = "\n".join(_lines(item["file"]))
        for pattern in item["patterns"]:
            hit = re.search(pattern, text, re.IGNORECASE)
            assert hit is None, f"{task_id}: {item['file']} now matches {pattern!r}"
