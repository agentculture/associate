"""The measurement task format and its checker (groundwork plan task t6).

A task file (``docs/accuracy/tasks.json``) holds tasks. Each task names the
repository it asks about, the full commit the repository is pinned to, a prompt,
the hand-checked answer, and expected values in evidence-cli's expected-values
schema version 1. Grading is ``evidence.answer.grade``; nothing here reads a
model's output or calls one.

Two rules go beyond evidence-cli's own schema:

* A ``number`` item below 100 is refused. A bare ``9`` matches any ``9`` in an
  answer, so the weakness found in the evidence-cli live test was a small count
  or version passing by accident. Write it in text form with its label
  (``"version 9"``, ``"max_lines 1000"``).
* Every expected text must be found in the repository at the pinned commit, or
  be marked derived with the command that derives it. The check reads the commit
  with ``git grep`` (never the working tree) and skips the answer key itself.
  A derived command is only named here; ``check_expected_in_repository`` does not
  run it.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from evidence.answer import ExpectedValuesError, grade, load_expected

FORMAT_VERSION = 1
TASKS_PATH = Path(__file__).resolve().parents[2] / "docs" / "accuracy" / "tasks.json"
#: Paths the repository check never searches: the answer key would find every value.
DEFAULT_EXCLUDE = ("docs/accuracy",)
SMALL_NUMBER_LIMIT = 100

FILE_KEYS = frozenset({"$comment", "format_version", "checked_on", "tasks"})
KINDS = ("read", "find", "count", "review", "not_found")
REQUIRED_KEYS = ("id", "kind", "repository", "commit", "prompt", "answer", "expected")
OPTIONAL_KEYS = (
    "derived",
    "search_paths",
    "evidence",
    "absent",
    "reused_from_2026_11_17",
    "stable_replacement_for",
)
TASK_KEYS = frozenset(REQUIRED_KEYS + OPTIONAL_KEYS)
REPOSITORY_KEYS = frozenset({"host", "owner", "name"})
DERIVED_KEYS = frozenset({"texts", "command"})
_COMMIT = re.compile(r"[0-9a-f]{40}")
_GROUPED = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", re.ASCII)
_GIT_TIMEOUT_S = 60


class TaskFileError(ValueError):
    """The task file is not valid; ``problems`` lists every reason."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("; ".join(problems))


class RepositoryCheckError(RuntimeError):
    """The repository could not be searched (unknown commit, no git, ...)."""


@dataclass(frozen=True)
class RepositoryCheck:
    """What the repository check found for one task's expected texts."""

    found: list[str] = field(default_factory=list)
    derived: list[tuple[str, str]] = field(default_factory=list)  # (text, command)
    missing: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.missing


# --- loading and validation ---------------------------------------------------------


def load_task_file(path: Path | str | None = None) -> dict[str, Any]:
    """Read and validate a task file; raise ``TaskFileError`` with every reason."""
    target = Path(path) if path is not None else TASKS_PATH
    try:
        doc = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise TaskFileError([f"{target}: cannot read the task file: {exc}"]) from exc
    problems = validate_task_file(doc)
    if problems:
        raise TaskFileError(problems)
    return doc


def validate_task_file(doc: Any) -> list[str]:
    """Every problem with a task file, empty when it is valid."""
    if not isinstance(doc, dict):
        return ["the task file must be a JSON object"]
    problems = _unknown_keys(doc, FILE_KEYS, "the task file")
    if doc.get("format_version") != FORMAT_VERSION or isinstance(doc.get("format_version"), bool):
        problems.append(f"format_version must be {FORMAT_VERSION}")
    tasks = doc.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return problems + ["tasks must be a non-empty list"]
    seen: set[str] = set()
    for index, task in enumerate(tasks):
        problems.extend(validate_task(task, f"tasks[{index}]"))
        task_id = task.get("id") if isinstance(task, dict) else None
        if isinstance(task_id, str):
            if task_id in seen:
                problems.append(f"duplicate task id {task_id!r}")
            seen.add(task_id)
    return problems


def validate_task(task: Any, label: str = "task") -> list[str]:
    """Every problem with one task, empty when it is valid."""
    if not isinstance(task, dict):
        return [f"{label} is not an object"]
    name = f"task {task['id']!r}" if isinstance(task.get("id"), str) else label
    problems = _unknown_keys(task, TASK_KEYS, name)
    problems.extend(_required_problems(task, name))
    if "expected" in task:
        problems.extend(_expected_problems(task["expected"], name))
        problems.extend(_derived_problems(task, name))
    problems.extend(_search_path_problems(task, name))
    return problems


def _unknown_keys(obj: dict[str, Any], allowed: frozenset[str], where: str) -> list[str]:
    unknown = sorted(str(k) for k in set(obj) - allowed)
    return [f"unknown key in {where}: {', '.join(unknown)}"] if unknown else []


def _required_problems(task: dict[str, Any], name: str) -> list[str]:
    problems = [f"{name} has no {k}" for k in REQUIRED_KEYS if k not in task and k != "commit"]
    if "commit" not in task:
        problems.append(f"{name} has no pinned commit (commit: a full 40-character hash)")
    elif not isinstance(task["commit"], str) or not _COMMIT.fullmatch(task["commit"]):
        problems.append(f"{name}: commit must be a full lowercase 40-character hash")
    for key in ("id", "prompt", "answer"):
        if key in task and (not isinstance(task[key], str) or not task[key].strip()):
            problems.append(f"{name}: {key} must be a non-empty string")
    if "kind" in task and task["kind"] not in KINDS:
        problems.append(f"{name}: kind must be one of {', '.join(KINDS)}")
    if "repository" in task:
        problems.extend(_repository_problems(task["repository"], name))
    return problems


def _repository_problems(repo: Any, name: str) -> list[str]:
    if not isinstance(repo, dict):
        return [f"{name}: repository must be an object with host, owner and name"]
    problems = _unknown_keys(repo, REPOSITORY_KEYS, f"{name} repository")
    for key in sorted(REPOSITORY_KEYS):
        if not isinstance(repo.get(key), str) or not repo[key].strip():
            problems.append(f"{name}: repository.{key} must be a non-empty string")
    return problems


def _items(expected: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Every item of valid expected values with the list it sits in."""
    out = [("must_appear", i) for i in expected["must_appear"]]
    out += [("must_not_appear", i) for i in expected["must_not_appear"]]
    out += [("one_of", i) for group in expected["one_of"] for i in group]
    return out


def _number_value(text: str) -> float:
    cleaned = text.lstrip("-")
    if _GROUPED.fullmatch(cleaned):
        return float(cleaned.replace(",", ""))
    return float(cleaned.replace(",", "."))


def _expected_problems(expected: Any, name: str) -> list[str]:
    try:
        loaded = load_expected(expected)
    except ExpectedValuesError as exc:
        return [f"{name}: expected values: {exc}"]
    problems = []
    if not loaded["must_appear"] and not loaded["one_of"]:
        problems.append(f"{name}: expected values name no item that must appear")
    for where, item in _items(loaded):
        if item["kind"] == "number" and _number_value(item["text"]) < SMALL_NUMBER_LIMIT:
            problems.append(
                f"{name}: {where} holds the bare number {item['text']!r} below "
                f"{SMALL_NUMBER_LIMIT} with kind number; write it in text form with its "
                f'label (for example "version 9")'
            )
    return problems


def _expected_texts(task: dict[str, Any]) -> list[dict[str, Any]]:
    """Items whose text must be in the repository: must_appear and every one_of item."""
    loaded = load_expected(task["expected"])
    return loaded["must_appear"] + [i for group in loaded["one_of"] for i in group]


def _derived_problems(task: dict[str, Any], name: str) -> list[str]:
    if "derived" not in task:
        return []
    if not isinstance(task["derived"], list):
        return [f"{name}: derived must be a list"]
    try:
        known = {_collapse(i["text"]) for i in _expected_texts(task)}
    except ExpectedValuesError:
        return []  # reported by the expected-values check
    problems = []
    for index, entry in enumerate(task["derived"]):
        where = f"{name} derived[{index}]"
        problems.extend(_derived_entry_problems(entry, where, known))
    return problems


def _derived_entry_problems(entry: Any, where: str, known: set[str]) -> list[str]:
    if not isinstance(entry, dict):
        return [f"{where} is not an object"]
    problems = _unknown_keys(entry, DERIVED_KEYS, where)
    texts = entry.get("texts")
    if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
        problems.append(f"{where}: texts must be a non-empty list of strings")
        texts = []
    if not isinstance(entry.get("command"), str) or not entry["command"].strip():
        problems.append(f"{where}: command must name the command that derives the texts")
    problems.extend(
        f"{where}: {text!r} is not an expected text of the task"
        for text in texts
        if _collapse(text) not in known
    )
    return problems


def _search_path_problems(task: dict[str, Any], name: str) -> list[str]:
    paths = task.get("search_paths", [])
    if not isinstance(paths, list) or not all(isinstance(p, str) and p for p in paths):
        return [f"{name}: search_paths must be a list of non-empty strings"]
    return []


# --- grading ------------------------------------------------------------------------


def grade_task(task: dict[str, Any], answer_text: str) -> dict[str, Any]:
    """Grade an answer against the task's expected values (``evidence.answer.grade``)."""
    return grade(answer_text, task["expected"])


# --- the repository check -----------------------------------------------------------


def _collapse(text: str) -> str:
    return " ".join(text.split())


def check_expected_in_repository(
    task: dict[str, Any],
    repo: Path | str,
    exclude: tuple[str, ...] = DEFAULT_EXCLUDE,
) -> RepositoryCheck:
    """Look for every expected text at the task's pinned commit in ``repo``.

    A text is ``found`` when ``git grep`` finds it as a literal in one line of a
    tracked file at the commit (case-insensitively for ``fold_case`` items), looking
    only in ``search_paths`` when the task names some and never in ``exclude``. A
    text the task marks derived is reported with its command and is not searched.
    Anything else is ``missing``. ``must_not_appear`` items are not checked: they are
    values that must not be in an answer, not values the repository holds.
    """
    commands = {
        _collapse(text): entry["command"]
        for entry in task.get("derived", [])
        for text in entry["texts"]
    }
    found: list[str] = []
    derived: list[tuple[str, str]] = []
    missing: list[str] = []
    done: set[str] = set()
    for item in _expected_texts(task):
        text = _collapse(item["text"])
        if text in done:
            continue
        done.add(text)
        if text in commands:
            derived.append((text, commands[text]))
        elif _git_finds(repo, task, text, bool(item.get("fold_case")), exclude):
            found.append(text)
        else:
            missing.append(text)
    return RepositoryCheck(found=found, derived=derived, missing=missing)


def _git_finds(
    repo: Path | str,
    task: dict[str, Any],
    text: str,
    fold_case: bool,
    exclude: tuple[str, ...],
) -> bool:
    paths = task.get("search_paths") or ["."]
    pathspec = [*paths, *(f":(exclude){e}" for e in exclude)]
    args = ["git", "-C", str(repo), "grep", "-q", "-F"]
    if fold_case:
        args.append("-i")
    args += ["-e", text, task["commit"], "--", *pathspec]
    try:
        done = subprocess.run(  # nosec B603 B607 - fixed argv, no shell
            args, capture_output=True, text=True, check=False, timeout=_GIT_TIMEOUT_S
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RepositoryCheckError(f"git grep could not run: {exc}") from exc
    if done.returncode not in (0, 1):
        detail = (done.stderr or "").strip().splitlines()
        raise RepositoryCheckError(
            f"git grep failed at {task['commit']}: {detail[-1] if detail else done.returncode}"
        )
    return done.returncode == 0
