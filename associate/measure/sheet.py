"""The broad grading sheet: statements under hidden arms, its check and its join (t11).

A broad run stores a whole answer (:mod:`associate.measure.runner`,
:mod:`associate.measure.broad`). A person, or an agent, then counts the
statements in it that are false. Two rules hold for that count:

* the grader does not see which arm a run came from until every run is graded;
* every statement counted false is recorded with the file and the line that
  contradicts it.

The sheet and the key
---------------------
:func:`build` splits each finished broad run's answer into statements
(:func:`split_statements`) and returns two documents. The **sheet** lists the
runs in shuffled order under ids (``s01``, ``s02``, ...) with the task, the
repository and the pinned commit, and no arm, repeat, model or setting::

    {"format": 1, "kind": "broad_grading_sheet", "instructions": [...],
     "verdicts": ["true", "false", "not_checkable"],
     "runs": [{"id": "s01", "task": ..., "repository": "owner/name", "commit": ...,
               "statements": [{"n": 1, "text": ..., "verdict": null,
                               "file": null, "line": null, "note": ""}, ...]}, ...]}

The **key** maps each id to its run and arm and holds the seed of the shuffle
(the sheet does not), with a digest of each run's statements::

    {"format": 1, "kind": "broad_grading_key", "seed": ..., "warning": ...,
     "runs": {"s01": {"task": ..., "arm": ..., "repeat": ..., "support_score": ...,
                      "statements": 12, "statements_sha256": ...}, ...}}

The same records and seed always give the same two documents.

Where a statement came from
---------------------------
A record written from the structure of its export (``answer.parts``) lets the
key say, per statement and in order, what it came from: ``tags`` in the key's run
entry, a list the length of the run's statements. Each tag has ``origin``
(``answer``, ``summary`` or ``final_reply``); for an item of a strict answer also
``item`` (``f1``, ``v1``, ``o1``), ``strict_outcome``, ``kind_checked`` and
``option`` (the decider's). The tags are the harness's own record and are never
matched on text. They go in the key, never on the sheet, so a grader does not see
them. A record with no parts has no ``tags`` in its key entry and is split as it
always was.

Statements
----------
Nothing in an answer is dropped except blank lines, horizontal rules and the
separator row of a table. A heading is one statement, a table row is one, a
fenced code block is one; a paragraph and a list item (with its continuation
lines) are split into sentences at ``.``, ``!`` or ``?`` followed by white
space and a capital letter, a digit or an opening mark. A few abbreviations
(``e.g.``, ``i.e.``, ``etc.``, ``vs.``, ``cf.``) do not end a sentence. The
order within a run is the answer's.

The check
---------
:func:`check_sheet` lists every problem of a filled sheet: a statement with no
verdict, a verdict that is not ``true``, ``false`` or ``not_checkable`` (the
words, as strings), a ``false`` without a ``file`` and a positive whole
``line``. With ``clone_root`` (a directory holding one checkout per
repository, named as the repository) it also looks the file up at the task's
pinned commit and checks that it has that line. The file name written on the
sheet is only compared with the names git lists; it is never used as a path.

The join
--------
:func:`join` gives each run its counts only when the sheet passes the check,
every run of the key is on the sheet with its statements unchanged, and the
key covers exactly the stored finished broad runs with their answers unchanged.
Otherwise it raises :class:`SheetError` with every reason.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import statistics
import subprocess
from pathlib import Path
from typing import Any, Mapping, Sequence

from associate.measure.broad import COMMIT_ID, FIRST_MARKING

SHEET_FORMAT = 1
KIND_SHEET = "broad_grading_sheet"
KIND_KEY = "broad_grading_key"
VERDICT_TRUE = "true"
VERDICT_FALSE = "false"
VERDICT_NOT_CHECKABLE = "not_checkable"
VERDICTS = (VERDICT_TRUE, VERDICT_FALSE, VERDICT_NOT_CHECKABLE)
INTERNAL_LINE = "This is an internal measurement and not a benchmark score."
INSTRUCTIONS = (
    "Give every statement a verdict: the string true, false or not_checkable.",
    "For false, fill in file (a path in the repository at the pinned commit) and line "
    "(a positive whole number): the place that contradicts the statement. A note is optional.",
    "Do not open the key file and do not look at the stored results while grading; "
    "they say which run each id is.",
    "Do not change id, n or text. Check the sheet with `associate measure sheet-check`.",
)
KEY_WARNING = (
    "This file says which run and arm each sheet id is. The grader must not open it "
    "until every run is graded."
)

Key = tuple[str, str, int]

_UTF8 = "utf-8"
_FINISHED = "finished"
_K_RUNS = "runs"
_K_STATEMENTS = "statements"
_K_VERDICT = "verdict"
_K_BROAD = "broad"
_K_REPEAT = "repeat"
_K_DIGEST = "statements_sha256"
_K_CONTAMINATED = "contaminated"
_K_REPOSITORY = "repository"
_K_SUPPORT = "support_score"
_K_AT_CAP = "at_cap"
_K_FALSE = "statements_false"
_K_COMMIT = "commit"
_K_FACTS_STATED = "facts_stated"
_K_FACTS_TOTAL = "facts_total"
_K_ANSWER_SOURCE = "answer_source"
_K_REPLY_CAP = "final_reply_cap"
_K_BROAD_FINISHED = "finished"
_K_WITHOUT_FINISH = "without_finish"
_K_NOT_RECORDED = "finish_not_recorded"
_K_REMINDED = "reminded"
_K_REMINDER_NOT_RECORDED = "reminder_not_recorded"
_K_TAGS = "tags"
_K_ORIGIN = "origin"
_K_ITEM = "item"
_K_OUTCOME = "strict_outcome"
_K_ANSWER_FALSE = "answer_false"
ORIGIN_ANSWER = "answer"
#: The origins that are the model's words outside the checked items; counted as the final reply.
REPLY_ORIGINS = ("final_reply", "summary")
OUTCOME_PASS = "pass"  # nosec B105 - a strict outcome name, not a password
OUTCOME_KEEP_MARKED = "keep_marked"
REMINDED_WORDS = "reminded to finish"
NO_CHECKED_FACTS_LINE = (
    "A run that ended without finish is graded like the others (first marking, sheet, "
    "statements counted false) on its final message; it handed back no checked facts."
)
_ABBREVIATIONS = frozenset({"e.g.", "i.e.", "etc.", "vs.", "cf."})
_FENCE = re.compile(r"^\s*(```|~~~)")
_HEADING = re.compile(r"^\s*#{1,6}\s+")
# One whitespace character after the marker, then the rest of the line: the caller
# strips the rest, so nothing here repeats over the same characters twice.
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d{1,9}[.)])\s(.*)$", re.ASCII)
_RULE_MARKS = "-*_"
_TABLE_ROW = re.compile(r"^\s*\|")
_TABLE_SEPARATOR = re.compile(r"^[\s|:-]+$")
_SENTENCE_END = re.compile(r"[.!?][\"')\]]*\s+(?=[A-Z\d`\"'(\[*_])", re.ASCII)
_OBJECT_ID = re.compile(r"[0-9a-f]{40,64}", re.ASCII)
_GIT_TIMEOUT_S = 120


class SheetError(ValueError):
    """The sheet cannot be written or joined; ``problems`` lists every reason."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("; ".join(problems))


# ------------------------------------------------------------------ statements


def _sentences(text: str) -> list[str]:
    pieces, start = [], 0
    for found in _SENTENCE_END.finditer(text):
        words = text[start : found.start() + 1].split()
        if words and words[-1].lower() in _ABBREVIATIONS:
            continue
        pieces.append(text[start : found.end()].strip())
        start = found.end()
    pieces.append(text[start:].strip())
    return [piece for piece in pieces if piece]


class _Splitter:
    """Walks the lines of an answer and collects its statements in order."""

    def __init__(self) -> None:
        self.statements: list[str] = []
        self._block: list[str] = []
        self._fence: list[str] | None = None

    def _flush(self) -> None:
        if self._block:
            self.statements.extend(_sentences(" ".join(self._block)))
        self._block = []

    def _own_line(self, line: str) -> str | None:
        """The statement a heading or a table row is on its own, '' to drop the line."""
        marks = "".join(line.split())
        if len(marks) >= 3 and marks[0] in _RULE_MARKS and marks == marks[0] * len(marks):
            return ""
        heading = _HEADING.match(line)
        if heading:
            return line[heading.end() :].strip().rstrip("#").strip()
        if _TABLE_ROW.match(line):
            return "" if _TABLE_SEPARATOR.match(line) else line.strip()
        return None

    def feed(self, line: str) -> None:
        if self._fence is not None:
            self._fence.append(line.rstrip())
            if _FENCE.match(line):
                self.statements.append("\n".join(self._fence).strip())
                self._fence = None
            return
        if _FENCE.match(line):
            self._flush()
            self._fence = [line.rstrip()]
            return
        own = self._own_line(line) if line.strip() else ""
        if own is not None:
            self._flush()
            if own:
                self.statements.append(own)
            return
        item = _LIST_ITEM.match(line)
        if item:
            self._flush()
            self._block = [item.group(1).strip()]
        else:
            self._block.append(line.strip())

    def end(self) -> list[str]:
        if self._fence is not None:
            self.statements.append("\n".join(self._fence).strip())
        self._flush()
        return self.statements


def split_statements(text: str) -> list[str]:
    """The statements of an answer, in the answer's order (see the module text)."""
    splitter = _Splitter()
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        splitter.feed(line)
    return splitter.end()


def _digest(statements: Sequence[str]) -> str:
    return hashlib.sha256(json.dumps(list(statements)).encode(_UTF8)).hexdigest()


# ------------------------------------------------------------------ records


def run_key(record: Mapping[str, Any]) -> Key:
    """The (task id, arm name, repeat) a stored record is for."""
    task = str((record.get("task") or {}).get("id", ""))
    arm = str((record.get("arm") or {}).get("name", ""))
    return (task, arm, int(record.get(_K_REPEAT, 0)))


def _slug(record: Mapping[str, Any]) -> str:
    repo = (record.get("task") or {}).get(_K_REPOSITORY) or {}
    return f"{repo.get('owner', '')}/{repo.get('name', '')}"


def is_broad(record: Mapping[str, Any]) -> bool:
    """Whether *record* is a stored broad run (it carries the first marking)."""
    return isinstance(record.get(_K_BROAD), dict)


def broad_runs(records: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The finished broad runs, sorted by task, arm and repeat."""
    runs = [r for r in records if is_broad(r) and r.get("status") == _FINISHED]
    return sorted(runs, key=run_key)


def _answer_statements(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The statements of a stored answer, each ``{"text", ...tags}``.

    A record that stored the answer's parts (``answer.parts``, written from the
    structure of the export) is read part by part: a part that is one answer item
    (it has an ``item``) is one statement, any other part is split into sentences,
    and every statement carries its part's tags. A record without parts, or whose
    parts do not make its text, is split as before and carries no tags.
    """
    answer = record.get("answer") or {}
    text = answer.get("text")
    parts = answer.get("parts")
    if isinstance(parts, list) and parts and all(_is_part(part) for part in parts):
        found: list[dict[str, Any]] = []
        for part in parts:
            tags = {key: value for key, value in part.items() if key != "text"}
            pieces = [part["text"]] if part.get(_K_ITEM) else split_statements(part["text"])
            found.extend({"text": piece, **tags} for piece in pieces)
        return found
    return [{"text": piece} for piece in split_statements(text if isinstance(text, str) else "")]


def _is_part(part: Any) -> bool:
    return isinstance(part, dict) and isinstance(part.get("text"), str)


def _texts(statements: Sequence[Mapping[str, Any]]) -> list[str]:
    return [statement["text"] for statement in statements]


def _tag_list(statements: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]] | None:
    """What each statement came from, in order; None when no statement carries a tag."""
    tags = [{key: value for key, value in s.items() if key != "text"} for s in statements]
    return tags if any(tags) else None


# ------------------------------------------------------------------ building


def build(records: Sequence[Mapping[str, Any]], seed: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """The blank sheet and its key for the finished broad runs of *records*."""
    runs = broad_runs(records)
    if not runs:
        raise SheetError(["no finished broad run is stored; there is nothing to grade"])
    random.Random(seed).shuffle(runs)  # nosec B311
    width = max(2, len(str(len(runs))))
    sheet_runs, key_runs = [], {}
    for index, record in enumerate(runs, start=1):
        run_id = f"s{index:0{width}d}"
        task, arm, repeat = run_key(record)
        found = _answer_statements(record)
        statements = _texts(found)
        tags = _tag_list(found)
        sheet_runs.append(
            {
                "id": run_id,
                "task": task,
                _K_REPOSITORY: _slug(record),
                _K_COMMIT: (record.get("task") or {}).get(_K_COMMIT),
                _K_STATEMENTS: [
                    {"n": n, "text": text, _K_VERDICT: None, "file": None, "line": None, "note": ""}
                    for n, text in enumerate(statements, start=1)
                ],
            }
        )
        key_runs[run_id] = {
            "task": task,
            "arm": arm,
            _K_REPEAT: repeat,
            _K_SUPPORT: record.get(_K_SUPPORT),
            _K_STATEMENTS: len(statements),
            _K_DIGEST: _digest(statements),
            **({_K_TAGS: tags} if tags is not None else {}),
        }
    sheet = {
        "format": SHEET_FORMAT,
        "kind": KIND_SHEET,
        "instructions": list(INSTRUCTIONS),
        "verdicts": list(VERDICTS),
        _K_RUNS: sheet_runs,
    }
    key = {
        "format": SHEET_FORMAT,
        "kind": KIND_KEY,
        "seed": seed,
        "warning": KEY_WARNING,
        _K_RUNS: key_runs,
    }
    return sheet, key


# ------------------------------------------------------------------ the pinned files


class _Checkouts:
    """Reads, per repository and pinned commit, which files exist and how many lines each has.

    A repository's checkout is the directory of *root* with the repository's
    name, found by listing *root*. Names and line numbers from a sheet are only
    compared with what git lists.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        self._own = {p.name: p for p in sorted(root.iterdir()) if p.is_dir()}
        self._files: dict[tuple[str, str], dict[str, str] | str] = {}
        self._lines: dict[tuple[str, str], int] = {}

    def _git(self, checkout: Path, *args: str) -> bytes | None:
        try:
            done = subprocess.run(  # nosec B603 B607 - fixed argv, no shell
                ["git", "-C", str(checkout), *args],
                capture_output=True,
                check=False,
                timeout=_GIT_TIMEOUT_S,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return done.stdout if done.returncode == 0 else None

    def _listing(self, name: str, commit: str) -> dict[str, str] | str:
        """Path to blob id for every file at the commit, or the reason there is none."""
        checkout = self._own.get(name)
        if checkout is None:
            return f"no checkout of {name} in {self._root}"
        if COMMIT_ID.fullmatch(commit) is None:
            return f"the commit on the sheet for {name} is not a full commit id"
        out = self._git(checkout, "ls-tree", "-r", "-z", "--end-of-options", commit)
        if out is None:
            return f"the checkout of {name} in {self._root} does not hold commit {commit[:12]}"
        files = {}
        for entry in out.split(b"\0"):
            meta, _tab, path = entry.partition(b"\t")
            fields = meta.split()
            if len(fields) == 3 and fields[1] == b"blob":
                files[path.decode(_UTF8, "surrogateescape")] = fields[2].decode("ascii")
        return files

    def _line_count(self, name: str, blob: str) -> int | None:
        if (name, blob) not in self._lines:
            if _OBJECT_ID.fullmatch(blob) is None:
                return None
            data = self._git(self._own[name], "cat-file", "blob", blob)
            if data is None:
                return None
            self._lines[(name, blob)] = data.count(b"\n") + (
                1 if data and not data.endswith(b"\n") else 0
            )
        return self._lines[(name, blob)]

    def problem(self, name: str, commit: str, file: str, line: int) -> str | None:
        """Why *file* line *line* is not in the repository at the commit, or None."""
        if (name, commit) not in self._files:
            self._files[(name, commit)] = self._listing(name, commit)
        files = self._files[(name, commit)]
        if isinstance(files, str):
            return files
        blob = files.get(file)
        if blob is None:
            return f"{file!r} is not a file of {name} at the pinned commit"
        count = self._line_count(name, blob)
        if count is None:
            return f"{file!r} could not be read at the pinned commit"
        if line > count:
            return f"{file!r} has {count} lines at the pinned commit, so there is no line {line}"
        return None


# ------------------------------------------------------------------ the check


def _whole_positive(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _statement_problem(
    statement: Any, run: Mapping[str, Any], checkouts: _Checkouts | None
) -> str | None:
    if not isinstance(statement, dict):
        return "is not an object"
    verdict = statement.get(_K_VERDICT)
    if verdict is None:
        return "has no verdict"
    if not isinstance(verdict, str) or verdict not in VERDICTS:
        return f"verdict must be the string true, false or not_checkable, not {verdict!r}"
    if verdict != VERDICT_FALSE:
        return None
    file, line = statement.get("file"), statement.get("line")
    if not isinstance(file, str) or not file.strip() or not _whole_positive(line):
        return (
            "is counted false and needs a file and a positive whole line that contradict it "
            f"(file {file!r}, line {line!r})"
        )
    if checkouts is None:
        return None
    name = str(run.get(_K_REPOSITORY) or "").rpartition("/")[2]
    return checkouts.problem(name, str(run.get(_K_COMMIT) or ""), file, line)


def _run_problems(run: Any, index: int, checkouts: _Checkouts | None) -> list[str]:
    if not isinstance(run, dict) or not isinstance(run.get("id"), str):
        return [f"runs[{index}] is not a run with an id"]
    statements = run.get(_K_STATEMENTS)
    if not isinstance(statements, list):
        return [f"{run['id']} has no statements list"]
    problems = []
    for position, statement in enumerate(statements, start=1):
        problem = _statement_problem(statement, run, checkouts)
        if problem is not None:
            problems.append(f"{run['id']} statement {position} {problem}")
    return problems


def check_sheet(sheet: Any, clone_root: Path | str | None = None) -> list[str]:
    """Every problem of a filled sheet, empty when it is acceptable."""
    runs = sheet.get(_K_RUNS) if isinstance(sheet, dict) else None
    if not isinstance(runs, list) or not runs:
        return ["the sheet has no runs list"]
    checkouts = None
    if clone_root is not None:
        root = Path(clone_root)
        if not root.is_dir():
            return [f"the clone root {root} is not a directory"]
        checkouts = _Checkouts(root)
    problems: list[str] = []
    seen: set[str] = set()
    for index, run in enumerate(runs):
        problems.extend(_run_problems(run, index, checkouts))
        run_id = run.get("id") if isinstance(run, dict) else None
        if isinstance(run_id, str):
            if run_id in seen:
                problems.append(f"{run_id} is on the sheet twice")
            seen.add(run_id)
    return problems


def sheet_counts(sheet: Any) -> dict[str, int]:
    """How many runs and statements a sheet has, and how many statements have a verdict."""
    runs = sheet.get(_K_RUNS) if isinstance(sheet, dict) else None
    runs = [run for run in runs if isinstance(run, dict)] if isinstance(runs, list) else []
    statements = [
        s
        for run in runs
        for s in (run.get(_K_STATEMENTS) if isinstance(run.get(_K_STATEMENTS), list) else [])
    ]
    graded = sum(1 for s in statements if isinstance(s, dict) and s.get(_K_VERDICT) in VERDICTS)
    return {_K_RUNS: len(runs), _K_STATEMENTS: len(statements), "with_verdict": graded}


# ------------------------------------------------------------------ the join


def _sheet_texts(run: Mapping[str, Any]) -> list[str]:
    return [str(s.get("text")) for s in run.get(_K_STATEMENTS) or [] if isinstance(s, dict)]


def _key_runs(key: Any) -> dict[str, dict[str, Any]] | None:
    runs = key.get(_K_RUNS) if isinstance(key, dict) else None
    if not isinstance(runs, dict) or not all(isinstance(v, dict) for v in runs.values()):
        return None
    return runs


def _key_entry_key(entry: Mapping[str, Any]) -> Key | None:
    repeat = entry.get(_K_REPEAT)
    if not isinstance(repeat, int) or isinstance(repeat, bool):
        return None
    return (str(entry.get("task")), str(entry.get("arm")), repeat)


def _sheet_against_key(sheet: Mapping[str, Any], key_runs: Mapping[str, dict]) -> list[str]:
    # A run with no id is named by check_sheet; it cannot be compared with the key.
    on_sheet = {
        run["id"]: run
        for run in sheet[_K_RUNS]
        if isinstance(run, dict) and isinstance(run.get("id"), str)
    }
    problems = [f"{i} is in the key and not on the sheet" for i in key_runs if i not in on_sheet]
    problems += [f"{i} is on the sheet and not in the key" for i in on_sheet if i not in key_runs]
    for run_id, run in on_sheet.items():
        entry = key_runs.get(run_id)
        if entry is not None and _digest(_sheet_texts(run)) != entry.get(_K_DIGEST):
            problems.append(
                f"the statements of {run_id} were changed on the sheet (their number or their "
                "wording); the sheet's text must stay as it was written"
            )
    return problems


def _key_against_records(
    key_runs: Mapping[str, dict], records: Sequence[Mapping[str, Any]]
) -> list[str]:
    stored = {run_key(record): record for record in broad_runs(records)}
    in_key: dict[Key, str] = {}
    problems = []
    for run_id, entry in key_runs.items():
        named = _key_entry_key(entry)
        record = stored.get(named) if named is not None else None
        if named is None or record is None:
            problems.append(f"{run_id} in the key is not a stored finished broad run")
            continue
        in_key[named] = run_id
        if _digest(_texts(_answer_statements(record))) != entry.get(_K_DIGEST):
            problems.append(
                f"the stored answer of {run_id} changed since the sheet was written; "
                "write a new sheet"
            )
    missing = sorted(named for named in stored if named not in in_key)
    if missing:
        shown = ", ".join(f"{task} {arm} r{repeat}" for task, arm, repeat in missing[:10])
        problems.append(
            f"{len(missing)} stored run(s) are not in the key ({shown}); write a new sheet "
            "that has every run"
        )
    return problems


def join(
    sheet: Any, key: Any, records: Sequence[Mapping[str, Any]], clone_root: Path | str | None = None
) -> dict[Key, dict[str, int]]:
    """Each run's statement counts, once every run of the key is fully graded.

    Raises :class:`SheetError` with every reason while the sheet does not pass
    :func:`check_sheet`, differs from the key, or the key does not cover the
    stored runs.
    """
    key_runs = _key_runs(key)
    if key_runs is None:
        raise SheetError(["the key file has no runs object; it is not a grading key"])
    problems = check_sheet(sheet, clone_root)
    if isinstance(sheet, dict) and isinstance(sheet.get(_K_RUNS), list):
        problems += _sheet_against_key(sheet, key_runs)
    problems += _key_against_records(key_runs, records)
    if problems:
        raise SheetError(problems)
    joined = {}
    for run in sheet[_K_RUNS]:
        verdicts = [statement[_K_VERDICT] for statement in run[_K_STATEMENTS]]
        entry = key_runs[run["id"]]
        named = _key_entry_key(entry)
        assert named is not None  # nosec B101
        joined[named] = {
            _K_STATEMENTS: len(verdicts),
            **{verdict: verdicts.count(verdict) for verdict in VERDICTS},
            **_by_origin(verdicts, entry.get(_K_TAGS)),
        }
    return joined


def _tally(verdicts: Sequence[str]) -> dict[str, int]:
    return {_K_STATEMENTS: len(verdicts), **{v: verdicts.count(v) for v in VERDICTS}}


def _by_origin(verdicts: Sequence[str], tags: Any) -> dict[str, Any]:
    """The verdicts of one run split by what each statement came from, from the key's tags.

    Empty when the key entry has no tags (or they do not match the statements).
    ``answer`` and ``final_reply`` (the summary counts with it) are tallies of
    verdicts; ``answer_pass`` and ``answer_keep_marked`` tally the answer
    statements whose item has that ``strict_outcome``.
    """
    if not isinstance(tags, list) or len(tags) != len(verdicts):
        return {}
    pairs = [
        (verdict, tag if isinstance(tag, dict) else {}) for verdict, tag in zip(verdicts, tags)
    ]
    answer = [(v, t) for v, t in pairs if t.get(_K_ORIGIN) == ORIGIN_ANSWER]
    reply = [v for v, t in pairs if t.get(_K_ORIGIN) in REPLY_ORIGINS]
    by_outcome = {
        name: _tally([v for v, t in answer if t.get(_K_OUTCOME) == name])
        for name in (OUTCOME_PASS, OUTCOME_KEEP_MARKED)
    }
    return {
        ORIGIN_ANSWER: _tally([v for v, _t in answer]),
        "final_reply": _tally(reply),
        "answer_pass": by_outcome[OUTCOME_PASS],
        "answer_keep_marked": by_outcome[OUTCOME_KEEP_MARKED],
        "items_tagged": sum(1 for _v, t in pairs if t.get(_K_ITEM)),
    }


# ------------------------------------------------------------------ the report


def run_rows(
    records: Sequence[Mapping[str, Any]], joined: Mapping[Key, Mapping[str, int]] | None
) -> list[dict[str, Any]]:
    """One row per finished broad run, sorted by task, arm and repeat.

    The statement counts are None when *joined* is None (no fully graded sheet).
    """
    rows = []
    for record in broad_runs(records):
        task, arm, repeat = run_key(record)
        broad = record[_K_BROAD]
        counts = joined.get((task, arm, repeat)) if joined is not None else None
        rows.append(
            {
                "task": task,
                _K_REPOSITORY: _slug(record),
                "arm": arm,
                _K_SUPPORT: record.get(_K_SUPPORT),
                _K_REPEAT: repeat,
                _K_FACTS_STATED: broad.get(_K_FACTS_STATED),
                _K_FACTS_TOTAL: broad.get(_K_FACTS_TOTAL),
                "facts": broad.get("facts"),
                _K_FALSE: counts[VERDICT_FALSE] if counts else None,
                "statements_not_checkable": counts[VERDICT_NOT_CHECKABLE] if counts else None,
                _K_STATEMENTS: counts[_K_STATEMENTS] if counts else None,
                _K_ANSWER_SOURCE: broad.get(_K_ANSWER_SOURCE),
                _K_AT_CAP: bool(broad.get(_K_AT_CAP)),
                _K_REPLY_CAP: broad.get(_K_REPLY_CAP),
                _K_BROAD_FINISHED: _finished(broad),
                _K_REMINDED: _reminded(broad),
                _K_CONTAMINATED: (record.get("contamination") or {}).get(_K_CONTAMINATED) is True,
                **_strict_row(record, counts),
            }
        )
    return rows


def is_strict_comparison(records: Sequence[Mapping[str, Any]]) -> bool:
    """Whether any stored broad run was launched with the strict switch set on its arm."""
    return any(
        (record.get("arm") or {}).get(_K_STRICT) is not None for record in broad_runs(records)
    )


_K_STRICT = "strict"
#: The row keys a strict-pair run adds; all None while a count is not joined or not known.
_STRICT_ROW_KEYS = (
    "answer_statements",
    "answer_true",
    _K_ANSWER_FALSE,
    "answer_not_checkable",
    "reply_statements",
    "reply_true",
    "reply_false",
    "reply_not_checkable",
    "answer_pass",
    "answer_pass_false",
    "answer_keep_marked",
    "answer_keep_marked_false",
)


def _strict_row(record: Mapping[str, Any], counts: Mapping[str, Any] | None) -> dict[str, Any]:
    """The extra row keys of a run whose arm sets strict (none for any other run).

    The statement counts come from the key's tags through the join; the run time
    is the launch's, the rounds and drops are copied from the export's
    ``check.json`` as stored in the record.
    """
    arm = record.get("arm") or {}
    if arm.get(_K_STRICT) is None:
        return {}
    held = record[_K_BROAD].get(_K_STRICT)
    held = held if isinstance(held, dict) else {}
    row: dict[str, Any] = {
        _K_STRICT: arm[_K_STRICT],
        "duration_s": (record.get("launch") or {}).get("duration_s"),
        "rounds_used": held.get("rounds_used"),
        "items_dropped": held.get("dropped"),
        **dict.fromkeys(_STRICT_ROW_KEYS),
    }
    if counts and ORIGIN_ANSWER in counts:
        answer, reply = counts[ORIGIN_ANSWER], counts["final_reply"]
        passed, kept = counts["answer_pass"], counts["answer_keep_marked"]
        row.update(
            answer_statements=answer[_K_STATEMENTS],
            answer_true=answer[VERDICT_TRUE],
            answer_false=answer[VERDICT_FALSE],
            answer_not_checkable=answer[VERDICT_NOT_CHECKABLE],
            reply_statements=reply[_K_STATEMENTS],
            reply_true=reply[VERDICT_TRUE],
            reply_false=reply[VERDICT_FALSE],
            reply_not_checkable=reply[VERDICT_NOT_CHECKABLE],
            answer_pass=passed[_K_STATEMENTS],
            answer_pass_false=passed[VERDICT_FALSE],
            answer_keep_marked=kept[_K_STATEMENTS],
            answer_keep_marked_false=kept[VERDICT_FALSE],
        )
    return row


def _finished(broad: Mapping[str, Any]) -> bool | None:
    """Whether ``finish`` was accepted; None for a record stored before that was recorded."""
    value = broad.get(_K_BROAD_FINISHED)
    return value if isinstance(value, bool) else None


def _reminded(broad: Mapping[str, Any]) -> bool | None:
    """Whether the finish reminder was sent; None for a record that does not say."""
    value = broad.get(_K_REMINDED)
    return value if isinstance(value, bool) else None


def reminded_counts(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, int]]:
    """Per arm: its runs, those reminded to finish, those that do not say."""
    counts: dict[str, dict[str, int]] = {}
    for row in rows:
        arm = counts.setdefault(
            row["arm"], {_K_RUNS: 0, _K_REMINDED: 0, _K_REMINDER_NOT_RECORDED: 0}
        )
        arm[_K_RUNS] += 1
        reminded = row.get(_K_REMINDED)
        arm[_K_REMINDED] += 1 if reminded is True else 0
        arm[_K_REMINDER_NOT_RECORDED] += 1 if reminded is None else 0
    return dict(sorted(counts.items()))


def _reminded_words(found: Mapping[str, int]) -> str:
    unknown = found[_K_REMINDER_NOT_RECORDED]
    tail = f" ({unknown} not recorded)" if unknown else ""
    return f"; {found[_K_REMINDED]} of {found[_K_RUNS]} {REMINDED_WORDS}{tail}"


def finish_counts(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, int]]:
    """Per arm: its runs, those that ended without ``finish``, those that do not say."""
    counts: dict[str, dict[str, int]] = {}
    for row in rows:
        arm = counts.setdefault(row["arm"], {_K_RUNS: 0, _K_WITHOUT_FINISH: 0, _K_NOT_RECORDED: 0})
        arm[_K_RUNS] += 1
        ended = row.get(_K_BROAD_FINISHED)
        arm[_K_WITHOUT_FINISH] += 1 if ended is False else 0
        arm[_K_NOT_RECORDED] += 1 if ended is None else 0
    return dict(sorted(counts.items()))


def _finish_lines(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    lines = ["", "Runs that ended without finish (a count of runs, per arm):"]
    counts = finish_counts(rows)
    reminded = reminded_counts(rows)
    for arm, found in counts.items():
        unknown = f" ({found[_K_NOT_RECORDED]} not recorded)" if found[_K_NOT_RECORDED] else ""
        lines.append(
            f"  arm {arm}: {found[_K_WITHOUT_FINISH]} of {found[_K_RUNS]} runs ended without "
            f"finish{unknown}{_reminded_words(reminded[arm])}"
        )
    if any(found[_K_WITHOUT_FINISH] for found in counts.values()):
        lines.append(NO_CHECKED_FACTS_LINE)
    return lines


_FINISH_WORDS = {
    True: "finish accepted",
    False: "ended without finish",
    None: "finish not recorded",
}


def left_out(row: Mapping[str, Any], count: str) -> str | None:
    """Why a run is left out of the rule for *count*, or None when it is counted.

    A run that read the answer key is left out. So is one whose answer was cut
    at the cap: both counts would be of part of an answer. For the count of
    false statements a run with no statement is left out too: it has none
    counted false only because there was nothing to grade, and a lower count
    is the better one.
    """
    if row[_K_CONTAMINATED]:
        return "read the answer key"
    if row[_K_AT_CAP]:
        return "the answer was cut at the cap"
    if count == _K_FALSE and row[_K_STATEMENTS] == 0:
        return "no statement to grade"
    if count == _K_ANSWER_FALSE and row.get("answer_statements") == 0:
        return "no statement in the answer to grade"
    return None


def rule_counts(rows: Sequence[Mapping[str, Any]], count: str) -> dict[str, dict[str, list[int]]]:
    """Task, then arm, then one value of *count* per run that :func:`left_out` does not name."""
    counts: dict[str, dict[str, list[int]]] = {}
    for row in rows:
        if row.get(count) is not None and left_out(row, count) is None:
            counts.setdefault(row["task"], {}).setdefault(row["arm"], []).append(row[count])
    return counts


MIDDLE_COUNTS = (
    (_K_FACTS_STATED, "facts marked as stated"),
    (_K_FALSE, "statements counted false"),
)


#: The counts a strict pair's middle values are printed for.
STRICT_MIDDLE_COUNTS = (
    (_K_FACTS_STATED, "facts marked as stated"),
    (_K_ANSWER_FALSE, "answer statements graded false"),
)


def middle_values(rows: Sequence[Mapping[str, Any]], count: str) -> dict[str, dict[str, float]]:
    """Task, then arm, then the middle value of *count* over the runs the rule counts.

    The middle of an even number of runs is the mean of the two in the middle.
    It is printed beside the rule and carries no verdict.
    """
    return {
        task: {arm: statistics.median(values) for arm, values in sorted(by_arm.items())}
        for task, by_arm in sorted(rule_counts(rows, count).items())
    }


def render_middles(
    rows: Sequence[Mapping[str, Any]], counts: Sequence[tuple[str, str]] = MIDDLE_COUNTS
) -> str:
    """The middle values as text: one line per repository and count."""
    lines = [
        "Middle value of each arm's runs, per repository (for reading beside the rule; "
        "no verdict is drawn from it):"
    ]
    for count, label in counts:
        for task, by_arm in middle_values(rows, count).items():
            shown = ", ".join(f"{arm} {value:g}" for arm, value in by_arm.items())
            lines.append(f"  {task}: {label}: {shown}")
    return "\n".join(lines)


def _run_line(row: Mapping[str, Any]) -> str:
    parts = [
        f"facts marked as stated ({FIRST_MARKING}) {row[_K_FACTS_STATED]} of {row[_K_FACTS_TOTAL]}"
    ]
    if row[_K_STATEMENTS] is not None:
        parts += [
            f"statements counted false {row[_K_FALSE]}",
            f"not checkable {row['statements_not_checkable']}",
            f"statements {row[_K_STATEMENTS]}",
        ]
    cap = f"at the {row[_K_REPLY_CAP]}-character cap" if row[_K_AT_CAP] else "not at the cap"
    parts.append(f"answer from {row[_K_ANSWER_SOURCE]}, {cap}")
    parts.append(_FINISH_WORDS[row.get(_K_BROAD_FINISHED)])
    if row.get(_K_REMINDED) is True:
        parts.append(REMINDED_WORDS)
    whole = left_out(row, _K_FACTS_STATED)
    if whole is not None:
        parts.append(f"{whole} (left out of the rule)")
    elif row[_K_STATEMENTS] is not None and left_out(row, _K_FALSE) is not None:
        parts.append(f"{left_out(row, _K_FALSE)} (left out of the rule on false statements)")
    return f"    r{row[_K_REPEAT]}: " + "; ".join(parts)


def render_rows(rows: Sequence[Mapping[str, Any]]) -> str:
    """The per-run text: grouped by repository and arm, one line per run, counts only."""
    joined = any(row[_K_STATEMENTS] is not None for row in rows)
    lines = [
        "Broad tasks, per run. Each number is a count for one run; none is added up over runs.",
        f"The facts count is a {FIRST_MARKING}: the words were found in the answer text. "
        "Every marking is read by hand.",
        INTERNAL_LINE,
    ]
    if not joined:
        lines.append(
            "Statements counted by hand: not joined (there is no fully graded sheet for these "
            "runs)."
        )
    seen_task, seen_arm = None, None
    for row in rows:
        if row["task"] != seen_task:
            seen_task, seen_arm = row["task"], None
            lines += [
                "",
                f"{row['task']} ({row[_K_REPOSITORY]}), {row[_K_FACTS_TOTAL]} checklist facts",
            ]
        if row["arm"] != seen_arm:
            seen_arm = row["arm"]
            lines.append(f"  arm {row['arm']} (support_score {row[_K_SUPPORT]})")
        lines.append(_run_line(row))
    return "\n".join(lines + _finish_lines(rows))


# ------------------------------------------------------------------ the strict pair


def _opt(value: Any) -> str:
    return (
        "not recorded"
        if value is None
        else f"{value:g}" if isinstance(value, float) else str(value)
    )


def _strict_run_line(row: Mapping[str, Any]) -> str:
    if row["answer_statements"] is None:
        graded = "statements: not joined (no fully graded sheet)"
    else:
        graded = (
            f"answer statements: true {row['answer_true']}, false {row['answer_false']}, "
            f"not checkable {row['answer_not_checkable']}; "
            f"final reply statements: true {row['reply_true']}, false {row['reply_false']}, "
            f"not checkable {row['reply_not_checkable']}; "
            f"of the answer statements {row['answer_pass']} rest on a passed item, "
            f"{row['answer_pass_false']} of those graded false; "
            f"kept-with-mark items graded false {row['answer_keep_marked_false']} "
            f"of {row['answer_keep_marked']}"
        )
    parts = [
        f"checklist facts stated {row[_K_FACTS_STATED]} of {row[_K_FACTS_TOTAL]} ({FIRST_MARKING})",
        graded,
        f"run time {_opt(row['duration_s'])} s",
        f"retry rounds {_opt(row['rounds_used'])}",
        f"items dropped {_opt(row['items_dropped'])}",
    ]
    whole = left_out(row, _K_FACTS_STATED)
    if whole is not None:
        parts.append(f"{whole} (left out of the rule)")
    elif row["answer_statements"] is not None and left_out(row, _K_ANSWER_FALSE) is not None:
        parts.append(
            f"{left_out(row, _K_ANSWER_FALSE)} (left out of the rule on answer statements)"
        )
    return f"    r{row[_K_REPEAT]}: " + "; ".join(parts)


def render_strict_rows(rows: Sequence[Mapping[str, Any]]) -> str:
    """The strict pair's per-run text: counts of one run, none added up over runs.

    The final reply here is the model's finish summary and final message, the
    words the harness does not check. A statement of the answer is one item the
    export lists (a fact, a conclusion or an open item).
    """
    lines = [
        "Strict pair, per run. Each number is a count for one run; none is added up over runs.",
        "Answer statements are the items the export lists; final reply statements are the "
        "model's own words (finish summary and final message), which the harness does not check.",
        "Run time is the launch's wall clock. Retry rounds and items dropped are copied from the "
        "export's check.json; an arm with strict off has none.",
        INTERNAL_LINE,
    ]
    seen_task, seen_arm = None, None
    for row in rows:
        if _K_STRICT not in row:
            continue
        if row["task"] != seen_task:
            seen_task, seen_arm = row["task"], None
            lines += ["", f"{row['task']} ({row[_K_REPOSITORY]})"]
        if row["arm"] != seen_arm:
            seen_arm = row["arm"]
            lines.append(f"  arm {row['arm']} (strict {row[_K_STRICT]})")
        lines.append(_strict_run_line(row))
    return "\n".join(lines)
