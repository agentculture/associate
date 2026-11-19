"""The broad explanation tasks: the task file, the first marking and the rule (decider-score t11).

A broad task asks one open question about a repository ("explain this
repository") and is read against a checklist of facts. The task file
(``docs/accuracy/broad-tasks.json``) holds one prompt for every task and, per
task, a repository, a pinned commit and the facts. Each fact has an ``id``, a
``question``, the ``answer``, ``evidence`` and ``match``.

The first marking
-----------------
``match`` is a list of groups. A fact is marked as stated when every group is
found in the answer text by any one of its alternatives, case-insensitively
(``evidence.answer.grade`` with one ``one_of`` group per match group, each
alternative a ``text`` item with ``fold_case``). This is a **first marking**:
it says the words were found, not that the answer states the fact correctly,
and every marking is read by hand afterwards. The number of facts marked is a
count per run. It is never pooled over runs and never turned into a share.

What the runner is given
------------------------
:func:`load_broad_tasks` returns tasks in the comparison runner's shape (``id``,
``repository``, ``commit``, ``prompt``) with ``facts`` holding only each fact's
``id`` and ``match``. The questions, answers and evidence are the answer key
and stay in the file.

The rule file
-------------
``docs/accuracy/broad-difference-threshold.md`` states the difference that will
be called a change. Its parameters are the first fenced ``json`` block of the
file: ``status`` (``draft`` or ``confirmed``), ``repositories``,
``repositories_required`` and ``runs_per_arm``. The file is a draft while
``status`` is not ``confirmed`` or the word ``DRAFT`` is anywhere in it; a real
broad run is refused on a draft. :func:`rule_verdict` applies the rule to one
count: per repository, an arm is better when every one of its runs is at least
as good as every run of the other arm and one is strictly better.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from evidence.answer import grade

from associate.measure import answer as answer_mod

_DOCS = Path(__file__).resolve().parents[2] / "docs" / "accuracy"
BROAD_TASKS_PATH = _DOCS / "broad-tasks.json"
BROAD_NOTE = _DOCS / "broad-difference-threshold.md"
#: The broad answer key inside a repository, and the name a read of it carries.
BROAD_KEY_PATH = "docs/accuracy/broad-tasks.json"
BROAD_KEY_NAME = "broad-tasks.json"
FORMAT_VERSION = 1
FIRST_MARKING = "first marking"
#: ``associate.harness.pi.FINAL_REPLY_CHARS``: how much of a final reply a run result keeps.
FINAL_REPLY_CAP = answer_mod.FINAL_REPLY_CAP
#: The result's ``handback_outcome`` when ``finish`` was accepted.
HANDBACK_ACCEPTED = "accepted"
DRAFT_WORD = "DRAFT"
STATUS_CONFIRMED = "confirmed"
STATUS_DRAFT = "draft"
VERDICT_CHANGE = "a change"
VERDICT_NONE_SHOWN = "no difference shown"
VERDICT_NOT_APPLICABLE = "not applicable"

_FILE_KEYS = frozenset({"$comment", "version", "prompt", "tasks"})
_TASK_KEYS = frozenset({"id", "repo", "commit", "facts", "dropped"})
_REPO_KEYS = ("host", "owner", "name")
_COMMIT = re.compile(r"[0-9a-f]{40}", re.ASCII)
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", re.ASCII)
_PARAMETERS = re.compile(r"^```json\n(.*?)\n```$", re.DOTALL | re.MULTILINE)
_RULE_NUMBERS = ("repositories", "repositories_required", "runs_per_arm")
_RULE_KEYS = frozenset(("status", *_RULE_NUMBERS))
_UTF8 = "utf-8"
_K_FACTS = "facts"
_K_MATCH = "match"
_K_VERSION = "version"
_K_PROMPT = "prompt"
_K_TASKS = "tasks"
_K_COMMIT = "commit"
_K_VERDICT = "verdict"


class BroadFileError(ValueError):
    """The broad task file is not valid; ``problems`` lists every reason."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("; ".join(problems))


class RuleError(ValueError):
    """The rule file's parameters cannot be read."""


@dataclass(frozen=True)
class Rule:
    """The parameters of the committed rule."""

    status: str
    repositories: int
    repositories_required: int
    runs_per_arm: int


# ------------------------------------------------------------------ the task file


def _text_problem(value: Any, where: str) -> list[str]:
    ok = isinstance(value, str) and bool(value.strip())
    return [] if ok else [f"{where} must be a non-empty string"]


def _match_problems(match: Any, where: str) -> list[str]:
    if not isinstance(match, list) or not match:
        return [f"{where}: match must be a non-empty list of groups"]
    problems = []
    for index, group in enumerate(match):
        ok = isinstance(group, list) and group
        ok = ok and all(isinstance(text, str) and text.strip() for text in group)
        if not ok:
            problems.append(
                f"{where}: match[{index}] must be a non-empty list of non-empty strings"
            )
    return problems


def _fact_problems(facts: Any, name: str) -> list[str]:
    if not isinstance(facts, list) or not facts:
        return [f"{name}: facts must be a non-empty list"]
    problems: list[str] = []
    seen: set[str] = set()
    for index, fact in enumerate(facts):
        if not isinstance(fact, dict):
            problems.append(f"{name}: facts[{index}] is not an object")
            continue
        fact_id = fact.get("id")
        if not isinstance(fact_id, str) or _SAFE_ID.fullmatch(fact_id) is None:
            problems.append(f"{name}: facts[{index}] has no plain id")
            continue
        if fact_id in seen:
            problems.append(f"{name}: duplicate fact id {fact_id!r}")
        seen.add(fact_id)
        problems.extend(_match_problems(fact.get(_K_MATCH), f"{name} fact {fact_id}"))
    return problems


def _task_problems(task: Any, label: str) -> list[str]:
    if not isinstance(task, dict):
        return [f"{label} is not an object"]
    task_id = task.get("id")
    if not isinstance(task_id, str) or _SAFE_ID.fullmatch(task_id) is None:
        return [f"{label} has no plain id (letters, digits, dot, dash and underscore)"]
    name = f"task {task_id!r}"
    unknown = sorted(str(key) for key in set(task) - _TASK_KEYS)
    problems = [f"unknown key in {name}: {', '.join(unknown)}"] if unknown else []
    repo = task.get("repo")
    if not isinstance(repo, dict) or set(repo) != set(_REPO_KEYS):
        problems.append(f"{name}: repo must be an object with host, owner and name")
    else:
        for key in _REPO_KEYS:
            problems.extend(_text_problem(repo[key], f"{name}: repo.{key}"))
    commit = task.get(_K_COMMIT)
    if not isinstance(commit, str) or _COMMIT.fullmatch(commit) is None:
        problems.append(f"{name}: commit must be a full lowercase 40-character hash")
    return problems + _fact_problems(task.get(_K_FACTS), name)


def validate_broad_file(doc: Any) -> list[str]:
    """Every problem with a broad task file, empty when it is valid."""
    if not isinstance(doc, dict):
        return ["the broad task file must be a JSON object"]
    unknown = sorted(str(key) for key in set(doc) - _FILE_KEYS)
    problems = [f"unknown key in the broad task file: {', '.join(unknown)}"] if unknown else []
    if doc.get(_K_VERSION) != FORMAT_VERSION or isinstance(doc.get(_K_VERSION), bool):
        problems.append(f"version must be {FORMAT_VERSION}")
    problems.extend(_text_problem(doc.get(_K_PROMPT), "prompt (one for every task)"))
    tasks = doc.get(_K_TASKS)
    if not isinstance(tasks, list) or not tasks:
        return problems + ["tasks must be a non-empty list"]
    seen: set[str] = set()
    for index, task in enumerate(tasks):
        problems.extend(_task_problems(task, f"tasks[{index}]"))
        task_id = task.get("id") if isinstance(task, dict) else None
        if isinstance(task_id, str):
            if task_id in seen:
                problems.append(f"duplicate task id {task_id!r}")
            seen.add(task_id)
    return problems


def load_broad_tasks(path: Path | str | None = None) -> list[dict[str, Any]]:
    """The broad tasks in the runner's shape; raise ``BroadFileError`` with every reason."""
    target = Path(path) if path is not None else BROAD_TASKS_PATH
    try:
        doc = json.loads(target.read_text(encoding=_UTF8))
    except (OSError, ValueError) as exc:
        raise BroadFileError([f"{target}: cannot read the broad task file: {exc}"]) from exc
    problems = validate_broad_file(doc)
    if problems:
        raise BroadFileError(problems)
    return [
        {
            "id": task["id"],
            "repository": {key: task["repo"][key] for key in _REPO_KEYS},
            _K_COMMIT: task[_K_COMMIT],
            _K_PROMPT: doc[_K_PROMPT],
            _K_FACTS: [{"id": f["id"], _K_MATCH: f[_K_MATCH]} for f in task[_K_FACTS]],
        }
        for task in doc[_K_TASKS]
    ]


# ------------------------------------------------------------------ the first marking


def _expected(fact: Mapping[str, Any]) -> dict[str, Any]:
    groups = [
        [{"text": text, "kind": "text", "fold_case": True} for text in group]
        for group in fact[_K_MATCH]
    ]
    return {"schema_version": 1, "must_appear": [], "must_not_appear": [], "one_of": groups}


def mark_fact(fact: Mapping[str, Any], text: str) -> bool:
    """Whether every match group of *fact* is found in *text* (the first marking)."""
    return grade(text, _expected(fact))[_K_VERDICT] == "matches"


def first_marking(facts: Sequence[Mapping[str, Any]], text: str) -> dict[str, Any]:
    """The first marking of every fact for one answer: a count and the fact ids, labelled."""
    marked = [{"id": fact["id"], "stated": mark_fact(fact, text)} for fact in facts]
    return {
        "marking": FIRST_MARKING,
        "facts_total": len(marked),
        "facts_stated": sum(1 for item in marked if item["stated"]),
        _K_FACTS: marked,
    }


def finish_accepted(result: Mapping[str, Any] | None) -> bool | None:
    """Whether ``finish`` was accepted, from the result's ``handback_outcome``.

    None when the result does not say (no result, or a harness from before the
    hand-back check).
    """
    outcome = (result or {}).get("handback_outcome")
    return outcome == HANDBACK_ACCEPTED if isinstance(outcome, str) else None


def answer_origin(result: Mapping[str, Any] | None, source: str) -> dict[str, Any]:
    """Where the stored answer came from, whether it is cut, and whether the run finished.

    ``answer_source`` is ``answer.md`` (an accepted ``finish``), or for a run
    that left none: ``final_message.md``, ``final_reply`` (shorter than the
    cap, so whole), ``statements.json`` (the statements of the export, joined)
    or ``final_reply_capped``. ``at_cap`` is true only for the last: the answer
    is then the last ``FINAL_REPLY_CAP`` characters of a longer message.
    ``finished`` is :func:`finish_accepted`.
    """
    return {
        "answer_source": source,
        "at_cap": source == answer_mod.SOURCE_FINAL_REPLY_CAPPED,
        "final_reply_cap": FINAL_REPLY_CAP,
        "finished": finish_accepted(result),
    }


# ------------------------------------------------------------------ the rule file


def _positive(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def read_rule(text: str) -> Rule:
    """The rule's parameters: the first fenced ``json`` block of the rule file."""
    found = _PARAMETERS.search(text)
    if found is None:
        raise RuleError("the rule file has no fenced json block holding its parameters")
    try:
        values = json.loads(found.group(1))
    except ValueError as exc:
        raise RuleError(f"the rule file's parameters are not JSON: {exc}") from exc
    if not isinstance(values, dict) or set(values) != _RULE_KEYS:
        raise RuleError(f"the rule file's parameters must be exactly {sorted(_RULE_KEYS)}")
    if values["status"] not in (STATUS_DRAFT, STATUS_CONFIRMED):
        raise RuleError(f"status must be {STATUS_DRAFT} or {STATUS_CONFIRMED}")
    if not all(_positive(values[name]) for name in _RULE_NUMBERS):
        raise RuleError(f"{', '.join(_RULE_NUMBERS)} must be positive whole numbers")
    if values["repositories_required"] > values["repositories"]:
        raise RuleError("repositories_required is more than repositories")
    return Rule(**values)


def draft_problem(text: str) -> str | None:
    """Why the rule file is not a confirmed rule, or None when it is one."""
    try:
        rule = read_rule(text)
    except RuleError as exc:
        return str(exc)
    if rule.status != STATUS_CONFIRMED:
        return f"its status is {rule.status!r}, not {STATUS_CONFIRMED!r}"
    if DRAFT_WORD in text:
        return f"it still holds the word {DRAFT_WORD}"
    return None


def _at_least_as_good(mine: Sequence[int], theirs: Sequence[int], higher: bool) -> bool:
    pairs = [(a, b) if higher else (b, a) for a in mine for b in theirs]
    return all(a >= b for a, b in pairs) and any(a > b for a, b in pairs)


def _not_applicable(why: str) -> dict[str, Any]:
    return {
        _K_VERDICT: VERDICT_NOT_APPLICABLE,
        "better_arm": None,
        "repositories_for": {},
        "why": why,
    }


def _shape_problem(rule: Rule, counts: Mapping[str, Mapping[str, Sequence[int]]]) -> str | None:
    arms = sorted({arm for by_arm in counts.values() for arm in by_arm})
    if len(arms) != 2 or any(sorted(by_arm) != arms for by_arm in counts.values()):
        return f"the rule compares two arms in every repository; these runs have {arms}"
    if len(counts) != rule.repositories:
        return f"the rule is written for {rule.repositories} repositories; {len(counts)} have runs"
    short = [
        f"{repo} arm {arm} ({len(values)})"
        for repo, by_arm in sorted(counts.items())
        for arm, values in sorted(by_arm.items())
        if len(values) < rule.runs_per_arm
    ]
    if short:
        return f"the rule needs {rule.runs_per_arm} runs per arm; fewer for {', '.join(short)}"
    return None


def rule_verdict(
    rule: Rule, counts: Mapping[str, Mapping[str, Sequence[int]]], *, higher_is_better: bool
) -> dict[str, Any]:
    """The rule applied to one count: ``counts`` is repository, then arm, then one value per run.

    An arm is better in a repository when every one of its runs is at least as
    good as every run of the other arm and one is strictly better. The verdict
    is ``a change`` when one arm is better in ``repositories_required``
    repositories, else ``no difference shown``; ``not applicable`` when the runs
    are not the ones the rule was written for (two arms, the stated number of
    repositories, enough runs per arm), with the reason in ``why``.
    """
    problem = _shape_problem(rule, counts)
    if problem is not None:
        return _not_applicable(problem)
    first, second = sorted({arm for by_arm in counts.values() for arm in by_arm})
    wins = {first: 0, second: 0}
    for by_arm in counts.values():
        for mine, other in ((first, second), (second, first)):
            if _at_least_as_good(by_arm[mine], by_arm[other], higher_is_better):
                wins[mine] += 1
    better = next((arm for arm, n in wins.items() if n >= rule.repositories_required), None)
    return {
        _K_VERDICT: VERDICT_CHANGE if better is not None else VERDICT_NONE_SHOWN,
        "better_arm": better,
        "repositories_for": wins,
        "why": (
            f"an arm must be better in {rule.repositories_required} of {rule.repositories} "
            "repositories"
        ),
    }
