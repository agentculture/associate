"""The comparison table, the hand-grading sample and the success numbers (plan task t10).

Everything here reads the records the comparison runner stored
(:func:`associate.measure.runner.load_records`) and returns text or plain data.
It runs no model, reads no key and touches no network. The same stored records
always give the same text: arms, tasks and runs are sorted, and nothing reads a
clock or an environment value.

Every table and summary carries :data:`INTERNAL_LINE`: this is an internal
measurement, not a published benchmark result.

How a run is counted
--------------------
Each run falls in exactly one of five categories, checked in this order:

1. **not graded**: the launch failed, the record is not graded, the run's
   outcome is ``timeout``, or the chosen reading holds no grade;
2. **contaminated**: the stored contamination verdict says ``contaminated``.
   Such a run is excluded from the three grade counts and reported apart (a run
   whose walk was never checked is not contaminated here; its number is shown);
3. **matching**, **not matching** or **cannot tell**: the grade's verdict
   (``matches``, ``does_not_match``, ``cannot_tell``) in the chosen reading.

The two readings
----------------
A record's ``grades`` holds ``answer_text`` (always, when graded) and
``answer_text_plus_handback_values`` (only when the run's export had a
hand-back). A table is printed for one reading, ``answer_text`` unless asked
otherwise, and its header line names it. For the second reading a run without
it is counted under ``answer_text``, and the table says how many such runs each
arm has. :func:`readings_differences` lists, per arm, the runs whose grade
differs between the two readings.

The hand-grading sample
-----------------------
:func:`draw_sample` draws, with a fixed seed, ``size`` (48) runs from the runs
that count in the table (graded, not contaminated). With fewer, it returns all
of them and says the sample is short; it never pads or repeats.
:func:`write_blank_sheet` writes the sheet a person fills in::

    {"format": 1, "seed": ..., "reading": ..., "entries": [
        {"task": ..., "arm": ..., "repeat": ..., "answer_text": ...,
         "hand_grade": null, "note": ""}, ...]}

``hand_grade`` is ``matches``, ``does_not_match`` or ``cannot_tell``. The
sheet does not show the grader's grade. :func:`compare_hand_grades` reads the
filled sheet back: a sampled run with no hand grade is *missing*, a value that
is not one of the three is *invalid*, and neither counts as agreement.
"""

from __future__ import annotations

import json
import random
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from evidence.answer import grade as evidence_grade

from associate.measure.contamination import ANSWER_KEY

READING_ANSWER = "answer_text"
READING_WITH_HANDBACK = "answer_text_plus_handback_values"
INTERNAL_LINE = "This is an internal measurement and not a benchmark score."
SAMPLE_SIZE = 48
SHEET_FORMAT = 1
VERDICTS = ("matches", "does_not_match", "cannot_tell")

_NOT_GRADED = "not_graded"
_CONTAMINATED = "contaminated"
_COLUMNS = (
    ("runs", "runs"),
    ("matches", "matching"),
    ("does_not_match", "not matching"),
    ("cannot_tell", "cannot tell"),
    (_NOT_GRADED, "not graded"),
    (_CONTAMINATED, "contaminated"),
)
_UTF8 = "utf-8"
_FINISHED = "finished"
_TIMEOUT = "timeout"
_TOTAL = "Total"
_K_ANSWER = "answer"
_K_CONTAMINATION = "contamination"
_SUCCESS_KEYS = ("runs", "graded", "regrade_changes", "key_reads")

Key = tuple[str, str, int]


# ------------------------------------------------------------------ record reading


def _task_of(record: Mapping[str, Any]) -> str:
    return str((record.get("task") or {}).get("id", ""))


def _arm_of(record: Mapping[str, Any]) -> str:
    return str((record.get("arm") or {}).get("name", ""))


def _key_of(record: Mapping[str, Any]) -> Key:
    return (_task_of(record), _arm_of(record), int(record.get("repeat", 0)))


def _reading(record: Mapping[str, Any], name: str) -> dict[str, Any] | None:
    for item in record.get("grades") or []:
        if isinstance(item, dict) and item.get("reading") == name:
            return item
    if name == READING_ANSWER and isinstance(record.get("grade"), dict):
        return {"reading": name, "grade": record["grade"]}
    return None


def _verdict(reading: Mapping[str, Any] | None) -> str | None:
    grade = (reading or {}).get("grade")
    value = grade.get("verdict") if isinstance(grade, dict) else None
    return value if value in VERDICTS else None


def _used_reading(record: Mapping[str, Any], name: str) -> str:
    """The reading actually used: ``name``, or the first when the run lacks it."""
    return name if _reading(record, name) is not None else READING_ANSWER


def _was_run_to_grade(record: Mapping[str, Any]) -> bool:
    if record.get("status") != _FINISHED or not record.get("graded"):
        return False
    return record.get("outcome") != _TIMEOUT


def _is_contaminated(record: Mapping[str, Any]) -> bool:
    return (record.get(_K_CONTAMINATION) or {}).get("contaminated") is True


def _category(record: Mapping[str, Any], name: str) -> str:
    if not _was_run_to_grade(record):
        return _NOT_GRADED
    verdict = _verdict(_reading(record, _used_reading(record, name)))
    if verdict is None:
        return _NOT_GRADED
    return _CONTAMINATED if _is_contaminated(record) else verdict


def _check_reading(reading: str) -> None:
    if reading not in (READING_ANSWER, READING_WITH_HANDBACK):
        raise ValueError(f"unknown reading {reading!r}")


def _stored_text(record: Mapping[str, Any], reading: Mapping[str, Any] | None) -> str:
    text = (reading or {}).get("text")
    if isinstance(text, str):
        return text
    return str((record.get(_K_ANSWER) or {}).get("text", ""))


# ----------------------------------------------------------------------- the table


def count_runs(
    records: Sequence[Mapping[str, Any]], reading: str = READING_ANSWER
) -> dict[str, dict[str, Counter]]:
    """``{arm: {task: Counter}}``; each Counter has ``runs`` and one key per category."""
    _check_reading(reading)
    out: dict[str, dict[str, Counter]] = {}
    for record in records:
        cell = out.setdefault(_arm_of(record), {}).setdefault(_task_of(record), Counter())
        cell["runs"] += 1
        cell[_category(record, reading)] += 1
    return out


def _grid(rows: list[list[str]]) -> list[str]:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    lines = []
    for row in rows:
        cells = [row[0].ljust(widths[0])] + [c.rjust(w) for c, w in zip(row[1:], widths[1:])]
        lines.append("  ".join(cells).rstrip())
    return lines


def _section(title: str, cells: Mapping[str, Counter]) -> list[str]:
    rows = [["arm"] + [label for _key, label in _COLUMNS]]
    for arm in sorted(cells):
        rows.append([arm] + [str(cells[arm][key]) for key, _label in _COLUMNS])
    return [title, *_grid(rows)]


def _fallback_lines(records: Sequence[Mapping[str, Any]]) -> list[str]:
    seen: Counter = Counter()
    lacking: Counter = Counter()
    for record in records:
        if _category(record, READING_ANSWER) == _NOT_GRADED:
            continue
        seen[_arm_of(record)] += 1
        if _reading(record, READING_WITH_HANDBACK) is None:
            lacking[_arm_of(record)] += 1
    return [
        f"{arm}: {lacking[arm]} of {seen[arm]} runs have no second reading "
        f"and are counted under {READING_ANSWER}"
        for arm in sorted(seen)
    ]


def _unchecked_lines(records: Sequence[Mapping[str, Any]]) -> list[str]:
    unchecked: Counter = Counter()
    for record in records:
        checked = (record.get(_K_CONTAMINATION) or {}).get("checked") is True
        if _was_run_to_grade(record) and not checked:
            unchecked[_arm_of(record)] += 1
    return [
        f"{arm}: {n} graded runs with no contamination check"
        for arm, n in sorted(unchecked.items())
    ]


def render_table(records: Sequence[Mapping[str, Any]], reading: str = READING_ANSWER) -> str:
    """The comparison table: per task and in total, one row per arm."""
    counts = count_runs(records, reading)
    tasks = sorted({task for cells in counts.values() for task in cells})
    lines = ["Comparison of stored runs", f"Reading shown: {reading}", INTERNAL_LINE, ""]
    lines.append(
        "Contaminated runs are left out of the matching, not matching and cannot tell counts."
    )
    lines.append("Not graded: a failed launch or a timeout.")
    for task in tasks:
        per_arm = {arm: cells[task] for arm, cells in counts.items() if task in cells}
        lines += ["", *_section(f"Task: {task}", per_arm)]
    totals = {arm: sum(cells.values(), Counter()) for arm, cells in counts.items()}
    lines += ["", *_section(_TOTAL, totals)]
    notes = _unchecked_lines(records)
    if reading == READING_WITH_HANDBACK:
        notes = _fallback_lines(records) + notes
    if notes:
        lines += ["", *notes]
    return "\n".join(lines) + "\n"


def readings_differences(records: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Per arm, the graded runs with both readings whose verdict differs between them."""
    out: dict[str, int] = {}
    for record in records:
        arm = _arm_of(record)
        out.setdefault(arm, 0)
        if _category(record, READING_ANSWER) == _NOT_GRADED:
            continue
        first = _verdict(_reading(record, READING_ANSWER))
        second = _verdict(_reading(record, READING_WITH_HANDBACK))
        if second is not None and first != second:
            out[arm] += 1
    return dict(sorted(out.items()))


# ------------------------------------------------------------------ the sample


@dataclass(frozen=True)
class SampledRun:
    key: Key
    grade: str
    text: str


@dataclass
class Sample:
    seed: int
    reading: str
    size: int
    runs: list[SampledRun] = field(default_factory=list)
    short: bool = False
    message: str = ""


def draw_sample(
    records: Sequence[Mapping[str, Any]],
    seed: int,
    size: int = SAMPLE_SIZE,
    reading: str = READING_ANSWER,
) -> Sample:
    """A fixed-seed draw of ``size`` runs that count in the table, in key order."""
    _check_reading(reading)
    pool = []
    for record in records:
        category = _category(record, reading)
        if category in (_NOT_GRADED, _CONTAMINATED):
            continue
        used = _reading(record, _used_reading(record, reading))
        pool.append(SampledRun(_key_of(record), category, _stored_text(record, used)))
    pool.sort(key=lambda run: run.key)
    sample = Sample(seed=seed, reading=reading, size=size)
    if len(pool) <= size:
        sample.runs = pool
        sample.short = len(pool) < size
        verb = "the sample is short" if sample.short else "the sample is every graded run"
        sample.message = f"{verb}: {len(pool)} graded runs exist and {size} were asked for"
        return sample
    chosen = random.Random(seed).sample(range(len(pool)), size)  # nosec B311
    sample.runs = [pool[i] for i in sorted(chosen)]
    sample.message = f"{size} of {len(pool)} graded runs drawn with seed {seed}"
    return sample


def write_blank_sheet(sample: Sample, path: str | Path) -> None:
    """Write the sheet to hand grade: no grader grade on it, ``hand_grade`` null."""
    entries = [
        {
            "task": run.key[0],
            "arm": run.key[1],
            "repeat": run.key[2],
            "answer_text": run.text,
            "hand_grade": None,
            "note": "",
        }
        for run in sample.runs
    ]
    doc = {
        "format": SHEET_FORMAT,
        "seed": sample.seed,
        "reading": sample.reading,
        "choices": list(VERDICTS),
        "entries": entries,
    }
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(doc, indent=2) + "\n", encoding=_UTF8)


# ------------------------------------------------------------------- agreement


@dataclass
class Agreement:
    sampled: int
    hand_graded: int = 0
    agreed: int = 0
    disagreed: int = 0
    missing: list[Key] = field(default_factory=list)
    invalid: list[Key] = field(default_factory=list)
    extra: list[Key] = field(default_factory=list)
    disagreements: list[Key] = field(default_factory=list)
    share: float | None = None
    problem: str | None = None


def _read_sheet(path: str | Path) -> tuple[dict[Key, Any], str | None]:
    try:
        doc = json.loads(Path(path).read_text(encoding=_UTF8))
    except (OSError, ValueError) as exc:
        return {}, f"the hand-grade file cannot be read: {exc}"
    entries = doc.get("entries") if isinstance(doc, dict) else None
    if not isinstance(entries, list):
        return {}, "the hand-grade file has no entries list"
    found: dict[Key, Any] = {}
    for entry in entries:
        if isinstance(entry, dict) and isinstance(entry.get("repeat"), int):
            key = (str(entry.get("task")), str(entry.get("arm")), entry["repeat"])
            found[key] = entry.get("hand_grade")
    return found, None


def compare_hand_grades(sample: Sample, path: str | Path) -> Agreement:
    """Read the hand grades back and report agreement with the grader.

    The share is agreed over hand-graded runs (those with a valid hand grade);
    a missing or invalid hand grade is never agreement.
    """
    hand, problem = _read_sheet(path)
    result = Agreement(sampled=len(sample.runs), problem=problem)
    keys = {run.key for run in sample.runs}
    result.extra = sorted(k for k in hand if k not in keys)
    for run in sample.runs:
        value = hand.get(run.key)
        if value is None:
            result.missing.append(run.key)
        elif value not in VERDICTS:
            result.invalid.append(run.key)
        elif value == run.grade:
            result.agreed += 1
        else:
            result.disagreed += 1
            result.disagreements.append(run.key)
    result.hand_graded = result.agreed + result.disagreed
    if result.hand_graded:
        result.share = result.agreed / result.hand_graded
    return result


def render_agreement(agreement: Agreement) -> str:
    lines = ["Agreement of the grader with hand grades", INTERNAL_LINE, ""]
    if agreement.problem:
        lines.append(agreement.problem)
    lines.append(f"sampled runs: {agreement.sampled}")
    lines.append(f"hand graded: {agreement.hand_graded}")
    lines.append(f"agree: {agreement.agreed} of {agreement.hand_graded} hand-graded runs")
    lines.append(f"disagree: {agreement.disagreed}")
    lines.append(f"{len(agreement.missing)} missing (no hand grade; not counted as agreement)")
    lines.append(f"{len(agreement.invalid)} invalid (not matches, does_not_match or cannot_tell)")
    if agreement.extra:
        lines.append(f"{len(agreement.extra)} hand grades for runs not in the sample (ignored)")
    for task, arm, repeat in agreement.disagreements:
        lines.append(f"disagreement: {task} {arm} r{repeat}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------- success numbers


def _regrade_changed(record: Mapping[str, Any], tasks: Mapping[str, Mapping[str, Any]]) -> bool:
    task = tasks.get(_task_of(record))
    first = _reading(record, READING_ANSWER)
    stored = _verdict(first)
    if task is None or stored is None:
        return False
    return evidence_grade(_stored_text(record, first), task["expected"])["verdict"] != stored


def _load_tasks(tasks: Mapping[str, Mapping[str, Any]] | None) -> Mapping[str, Mapping[str, Any]]:
    if tasks is not None:
        return tasks
    from associate.measure.tasks import load_task_file

    return {task["id"]: task for task in load_task_file()["tasks"]}


def _reads_key(record: Mapping[str, Any]) -> bool:
    reasons = (record.get(_K_CONTAMINATION) or {}).get("reasons") or []
    return any(isinstance(r, dict) and r.get("kind") == ANSWER_KEY for r in reasons)


def success_numbers(
    records: Sequence[Mapping[str, Any]],
    tasks: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """The three success numbers, per arm and in total.

    * ``graded`` over ``runs``: runs that were graded (not a failed launch or a
      timeout), contaminated runs included;
    * ``regrade_changes``: graded runs whose stored answer text, graded again
      now against the task's expected values, gets a different verdict than the
      stored one (a run whose task is not in ``tasks`` is not re-graded);
    * ``key_reads``: runs whose contamination verdict has a reason of kind
      ``answer_key``.
    """
    known = _load_tasks(tasks)
    arms: dict[str, dict[str, int]] = {}
    for record in records:
        row = arms.setdefault(_arm_of(record), dict.fromkeys(_SUCCESS_KEYS, 0))
        row["runs"] += 1
        if _category(record, READING_ANSWER) == _NOT_GRADED:
            continue
        row["graded"] += 1
        row["regrade_changes"] += int(_regrade_changed(record, known))
        row["key_reads"] += int(_reads_key(record))
    total = {key: sum(row[key] for row in arms.values()) for key in _SUCCESS_KEYS}
    return {"arms": dict(sorted(arms.items())), "total": total}


def _success_lines(name: str, row: Mapping[str, int]) -> list[str]:
    return [
        name,
        f"  runs graded: {row['graded']} of {row['runs']}",
        f"  grade changes on re-grade: {row['regrade_changes']}",
        f"  walks reading the key: {row['key_reads']}",
    ]


def render_success_numbers(numbers: Mapping[str, Any]) -> str:
    lines = ["Counts of stored runs", INTERNAL_LINE, ""]
    for arm, row in numbers["arms"].items():
        lines += _success_lines(arm, row)
    lines += _success_lines(_TOTAL, numbers["total"])
    return "\n".join(lines) + "\n"
