"""``associate measure`` for the broad tasks: the grading sheet, its check, the report (t11).

A broad comparison (``associate measure run --broad``) stores, per run, the
whole answer and a first marking of the task's checklist facts
(:mod:`associate.measure.broad`). The verbs here are the hand-grading side:

``sheet``        write the grading sheet (statements of every run, runs in shuffled
                 order under ids that hide the arm) and, in a separate file, the key
                 that maps ids to runs and arms and holds the shuffle's seed.
``sheet-check``  list what a filled sheet still lacks; exit 1 until it is acceptable.
``report``       (for a broad comparison) per run, grouped by repository and arm: the
                 checklist facts marked as stated and, once every run is graded, the
                 statements counted false. The sheet and the key are joined only then.

The rule file
-------------
``docs/accuracy/broad-difference-threshold.md`` states the difference that will
be called a change. ``run --broad`` on any harness except ``stub`` is refused
while that file is missing, not committed, modified, or still a draft. The
report applies the rule to each count only when the file is committed,
unmodified and confirmed; otherwise it says the verdict is not computed.

Nothing here prints a count as a score, adds counts up over runs, or prints a
percentage.
"""

from __future__ import annotations

import argparse
import secrets
from pathlib import Path
from types import ModuleType
from typing import Any

from associate.cli._commands import measure as base
from associate.cli._output import emit_result

DEFAULT_SHEET = "broad-grading-sheet.json"
DEFAULT_KEY = "broad-grading-key.json"
#: How many problems a refusal names; `sheet-check` lists all of them.
SHOWN_PROBLEMS = 10

_UTF8 = "utf-8"
_K_SHEET = "sheet"
_K_KEY = "key"
_K_RUNS = "runs"
_K_STATEMENTS = "statements"
_K_PROBLEMS = "problems"
_K_PLUMBING = "plumbing_only"
_K_BROAD = "broad"
_K_APPLIED = "applied"
_K_VERDICT = "verdict"
_K_ACCEPTABLE = "acceptable"
_K_CLONE_ROOT = "clone_root"
_K_WHY_NOT = "why_not"
_K_COUNTS = "counts"
_K_NOT_FINISHED = "not_finished"
_CHECK_HINT = "list every problem with `associate measure sheet-check`"
_SHEET_HINT = "write the sheet with `associate measure sheet <output-dir>` first"
#: The counts the rule is applied to: name, label, whether more is better.
_RULE_COUNTS = (
    ("facts_stated", "facts marked as stated", True),
    ("statements_false", "statements counted false", False),
)


def _broad() -> ModuleType:
    base._runner()
    from associate.measure import broad

    return broad


def _sheet() -> ModuleType:
    base._runner()
    from associate.measure import sheet

    return sheet


def __getattr__(name: str) -> Any:
    """``BROAD_NOTE`` is the one in ``associate.measure.broad``, loaded when first asked for."""
    if name == "BROAD_NOTE":
        return _broad().BROAD_NOTE
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# ------------------------------------------------------------------ run --broad


def load_tasks(path: Path | None, only: list[str]) -> tuple[list[dict[str, Any]], str]:
    """The broad tasks to run (file order, filtered by id) and the task file's path."""
    broad = _broad()
    target = path if path is not None else broad.BROAD_TASKS_PATH
    try:
        loaded = broad.load_broad_tasks(target)
    except broad.BroadFileError as exc:
        raise base._user_error(
            f"the broad task file {target} is not valid: {'; '.join(exc.problems)}",
            "fix the file; `associate measure run --broad` reads "
            "docs/accuracy/broad-tasks.json by default",
        ) from exc
    shown = str(Path(target).resolve())
    unknown = sorted(set(only) - {task["id"] for task in loaded})
    if unknown:
        raise base._user_error(
            f"--tasks-filter names a task not in {target}: {', '.join(unknown)}",
            "known ids: " + ", ".join(task["id"] for task in loaded),
        )
    return [task for task in loaded if not only or task["id"] in set(only)], shown


def rule_problem(note: Path) -> str | None:
    """Why *note* is not a committed, unmodified, confirmed rule file, or None."""
    problem = base.note_problem(note)
    if problem is not None:
        return problem
    try:
        text = note.read_text(encoding=_UTF8)
    except (OSError, UnicodeDecodeError) as exc:
        return f"the file cannot be read: {exc}"
    draft = _broad().draft_problem(text)
    return f"the file is still a draft: {draft}" if draft is not None else None


def require_rule(note: Path) -> None:
    """Refuse a real broad run while the rule file is missing, modified or a draft."""
    problem = rule_problem(note)
    if problem is not None:
        raise base._user_error(
            f"no committed, confirmed rule for broad tasks at {note}: {problem}",
            f"the operator confirms {note.name}: set status to confirmed in its parameters, "
            "remove the word DRAFT, commit it and leave it unmodified; a stub comparison "
            "(--harness stub) is plumbing only and needs no rule file",
        )


# ------------------------------------------------------------------ files


def _paths(args: argparse.Namespace, results: Path) -> tuple[Path, Path]:
    sheet = Path(args.sheet) if getattr(args, _K_SHEET, None) else results / DEFAULT_SHEET
    key = Path(args.key) if getattr(args, _K_KEY, None) else results / DEFAULT_KEY
    return sheet, key


def _read_document(path: Path, what: str, hint: str) -> Any:
    if not path.is_file():
        raise base._user_error(f"the {what} {path} does not exist", hint)
    value = base._read_json(path)
    if value is None:
        raise base._user_error(f"the {what} {path} cannot be read as JSON", hint)
    return value


def _clone_root(args: argparse.Namespace) -> Path | None:
    raw = getattr(args, _K_CLONE_ROOT, None)
    if not raw:
        return None
    root = Path(raw).expanduser()
    if not root.is_dir():
        raise base._user_error(
            f"--clone-root {root} is not a directory",
            "give a directory that holds one checkout per repository, each named as its "
            "repository and holding the task's pinned commit",
        )
    return root.resolve()


def _shown(problems: list[str]) -> str:
    more = len(problems) - SHOWN_PROBLEMS
    text = "; ".join(problems[:SHOWN_PROBLEMS])
    return text + (f"; and {more} more" if more > 0 else "")


# ------------------------------------------------------------------ sheet


def _sheet_text(payload: dict[str, Any]) -> str:
    lines = [
        f"sheet: {payload[_K_SHEET]}",
        f"key: {payload[_K_KEY]} (the grader must not open it until every run is graded)",
        f"runs on the sheet: {payload[_K_RUNS]}; statements: {payload[_K_STATEMENTS]}",
        "give every statement a verdict (true, false or not_checkable); a false needs the "
        "file and line that contradict it.",
        f"next: associate measure sheet-check {payload['results']}",
    ]
    if payload[_K_PLUMBING]:
        lines.insert(0, base.PLUMBING_LINE)
    return "\n".join(lines)


def cmd_sheet(args: argparse.Namespace) -> int:
    results = Path(args.output_dir).resolve()
    records, manifest = base._stored_records(results)
    sheet_path, key_path = _paths(args, results)
    if sheet_path.resolve() == key_path.resolve():
        raise base._user_error(
            "the sheet and the key must be two separate files",
            "name different paths with --sheet and --key",
        )
    for path in (sheet_path, key_path):
        if path.exists() and not args.overwrite:
            raise base._user_error(
                f"{path} already exists and may hold verdicts or the key they are joined with",
                "pass --overwrite to replace both files, or name other paths with --sheet "
                "and --key",
            )
    seed = args.seed if args.seed is not None else secrets.randbelow(2**32)
    try:
        sheet, key = _sheet().build(records, seed)
    except _sheet().SheetError as exc:
        raise base._user_error(
            f"no grading sheet can be written for {results}: {'; '.join(exc.problems)}",
            "pass the --output-dir of a broad comparison (`associate measure run --broad`) "
            "with at least one finished run",
        ) from exc
    base._write_atomic(key_path, key)
    base._write_atomic(sheet_path, sheet)
    payload = {
        _K_SHEET: str(sheet_path),
        _K_KEY: str(key_path),
        "results": str(results),
        _K_RUNS: len(sheet[_K_RUNS]),
        _K_STATEMENTS: sum(len(run[_K_STATEMENTS]) for run in sheet[_K_RUNS]),
        _K_PLUMBING: bool((manifest or {}).get(_K_PLUMBING)),
    }
    json_mode = base._json_mode(args)
    emit_result(payload if json_mode else _sheet_text(payload), json_mode=json_mode)
    return 0


# ------------------------------------------------------------------ sheet-check


def _check_text(payload: dict[str, Any]) -> str:
    lines = [
        f"sheet: {payload[_K_SHEET]}",
        f"runs: {payload[_K_RUNS]}; statements: {payload[_K_STATEMENTS]}; with a verdict: "
        f"{payload['with_verdict']}",
    ]
    if payload[_K_CLONE_ROOT] is None:
        lines.append("files and lines were not looked up (no --clone-root)")
    lines += [f"  - {problem}" for problem in payload[_K_PROBLEMS]]
    if payload[_K_ACCEPTABLE]:
        lines.append("acceptable: every statement has a verdict and every false its file and line")
    else:
        lines.append(f"not acceptable: {len(payload[_K_PROBLEMS])} problem(s)")
    return "\n".join(lines)


def cmd_sheet_check(args: argparse.Namespace) -> int:
    results = Path(args.output_dir).resolve()
    sheet_path, _key_path = _paths(args, results)
    sheet = _read_document(sheet_path, "grading sheet", _SHEET_HINT)
    root = _clone_root(args)
    problems = _sheet().check_sheet(sheet, root)
    payload = {
        _K_SHEET: str(sheet_path),
        _K_CLONE_ROOT: str(root) if root is not None else None,
        _K_ACCEPTABLE: not problems,
        _K_PROBLEMS: problems,
        **_sheet().sheet_counts(sheet),
    }
    json_mode = base._json_mode(args)
    emit_result(payload if json_mode else _check_text(payload), json_mode=json_mode)
    return 0 if not problems else 1


# ------------------------------------------------------------------ report


def _joined(args: argparse.Namespace, results: Path, records: list[dict[str, Any]]) -> Any:
    """The statement counts per run, None when no sheet was written; refuses a sheet that
    is not fully graded, not acceptable, or does not match its key and the stored runs."""
    sheet_path, key_path = _paths(args, results)
    if not sheet_path.exists() and not getattr(args, _K_SHEET, None):
        return None
    sheet = _read_document(sheet_path, "grading sheet", _SHEET_HINT)
    key = _read_document(key_path, "grading key", "the key is written beside the sheet; --key PATH")
    try:
        return _sheet().join(sheet, key, records, _clone_root(args))
    except _sheet().SheetError as exc:
        raise base._user_error(
            f"the grading sheet {sheet_path} is not joined with its key: it is not fully "
            f"graded, or not acceptable ({len(exc.problems)} problem(s)): {_shown(exc.problems)}",
            f"{_CHECK_HINT}; the report prints nothing until every run of the key is graded",
        ) from exc


def _rule(note: Path, rows: list[dict[str, Any]], joined: bool) -> dict[str, Any]:
    state: dict[str, Any] = {"file": str(note), _K_APPLIED: False, _K_WHY_NOT: None, _K_COUNTS: {}}
    problem = rule_problem(note)
    if problem is not None:
        state[_K_WHY_NOT] = problem
        return state
    rule = _broad().read_rule(note.read_text(encoding=_UTF8))
    state[_K_APPLIED] = True
    for name, _label, higher in _RULE_COUNTS:
        if name == "statements_false" and not joined:
            continue
        counts = _sheet().rule_counts(rows, name)
        state[_K_COUNTS][name] = _broad().rule_verdict(rule, counts, higher_is_better=higher)
    return state


def _verdict_text(found: dict[str, Any]) -> str:
    wins = ", ".join(f"{arm} {n}" for arm, n in found["repositories_for"].items())
    if found[_K_VERDICT] == _broad().VERDICT_NOT_APPLICABLE:
        return f"the rule is not applicable ({found['why']})"
    if found["better_arm"] is not None:
        arm = found["better_arm"]
        return (
            f"{found[_K_VERDICT]} (arm {arm} is better in {found['repositories_for'][arm]} "
            f"repositories; {found['why']})"
        )
    return f"{found[_K_VERDICT]} (repositories an arm is better in: {wins}; {found['why']})"


def _rule_lines(state: dict[str, Any]) -> list[str]:
    if not state[_K_APPLIED]:
        return [
            f"The committed rule's verdict is not computed: {state['file']}: {state[_K_WHY_NOT]}.",
            "Read the counts above against the rule by hand.",
        ]
    lines = [f"The committed rule ({state['file']}), applied to each count on its own:"]
    for name, label, _higher in _RULE_COUNTS:
        if name in state[_K_COUNTS]:
            lines.append(f"  {label}: {_verdict_text(state['counts'][name])}")
        else:
            lines.append(f"  {label}: not joined, so the rule is not applied to it")
    return lines


def _report_text(payload: dict[str, Any]) -> str:
    parts = [_sheet().render_rows(payload[_K_RUNS])]
    if payload[_K_NOT_FINISHED]:
        shown = ", ".join(
            f"{task} {arm} r{repeat}" for task, arm, repeat in payload[_K_NOT_FINISHED]
        )
        parts.append(f"Stored runs that did not finish and have no answer: {shown}")
    parts.append("\n".join(_rule_lines(payload["rule"])))
    parts.append(_sheet().render_middles(payload[_K_RUNS]))
    if payload[_K_PLUMBING]:
        parts.append(base.PLUMBING_LINE)
    return "\n\n".join(parts)


def is_broad_comparison(records: list[dict[str, Any]], manifest: dict[str, Any] | None) -> bool:
    """Whether the stored results are a broad comparison's (the manifest or a record says so)."""
    if (manifest or {}).get(_K_BROAD) is True:
        return True
    return any(_sheet().is_broad(record) for record in records)


def cmd_report(
    args: argparse.Namespace, records: list[dict[str, Any]], manifest: dict[str, Any] | None
) -> int:
    results = Path(args.output_dir).resolve()
    joined = _joined(args, results, records)
    sheet = _sheet()
    rows = sheet.run_rows(records, joined)
    for row in rows:
        row["marking"] = _broad().FIRST_MARKING
    note = (
        Path(args.difference_note)
        if getattr(args, "difference_note", None)
        else _broad().BROAD_NOTE
    )
    not_finished = sorted(
        sheet.run_key(record) for record in records if record.get("status") != "finished"
    )
    payload = {
        _K_BROAD: True,
        "joined": joined is not None,
        "note": sheet.INTERNAL_LINE,
        _K_PLUMBING: bool((manifest or {}).get(_K_PLUMBING)),
        _K_RUNS: rows,
        "without_finish": sheet.finish_counts(rows),
        "middle_values": {
            count: sheet.middle_values(rows, count) for count, _label in sheet.MIDDLE_COUNTS
        },
        "rule": _rule(note, rows, joined is not None),
        _K_NOT_FINISHED: [list(key) for key in not_finished],
    }
    json_mode = base._json_mode(args)
    emit_result(payload if json_mode else _report_text(payload), json_mode=json_mode)
    return 0


# ------------------------------------------------------------------ parser

VERBS = [
    "measure sheet <output-dir> — broad tasks: write the grading sheet (statements per run, "
    "arms hidden, shuffled) and, separately, the key (--sheet, --key, --seed, --overwrite)",
    "measure sheet-check <output-dir> — list what a filled sheet lacks: a verdict per "
    "statement, a file and line per false (--clone-root looks them up); exit 1 until acceptable",
]


def add_sheet_paths(p: argparse.ArgumentParser) -> None:
    p.add_argument("--sheet", help=f"The grading sheet (default <output-dir>/{DEFAULT_SHEET}).")
    p.add_argument("--key", help=f"The key file (default <output-dir>/{DEFAULT_KEY}).")


def add_clone_root(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--clone-root",
        metavar="DIR",
        help="A directory with one checkout per repository (named as the repository): each "
        "false statement's file and line are looked up there at the task's pinned commit.",
    )


def register(noun_sub: Any) -> None:
    sh = noun_sub.add_parser(
        _K_SHEET,
        help="Broad tasks: write the grading sheet (arms hidden) and its separate key.",
        description=(
            "Split every finished broad run's answer into statements and write them to a "
            "sheet, runs in shuffled order under ids that hide the arm. The key that maps "
            "ids to runs and arms, with the seed of the shuffle, goes to a separate file "
            "the grader must not open until every run is graded."
        ),
    )
    base._add_output_dir(sh)
    add_sheet_paths(sh)
    sh.add_argument("--seed", type=int, help="Shuffle seed (default: a new random one).")
    sh.add_argument("--overwrite", action="store_true", help="Replace an existing sheet and key.")
    base._add_json(sh)
    sh.set_defaults(func=cmd_sheet)
    ck = noun_sub.add_parser(
        "sheet-check",
        help="Broad tasks: list what a filled grading sheet lacks; exit 1 until acceptable.",
        description=(
            "Read a filled grading sheet (never the key) and list every problem: a statement "
            "with no verdict, a verdict that is not true, false or not_checkable, a false "
            "without a file and a positive line. Exits 1 while there is a problem."
        ),
    )
    base._add_output_dir(ck)
    ck.add_argument("--sheet", help=f"The grading sheet (default <output-dir>/{DEFAULT_SHEET}).")
    add_clone_root(ck)
    base._add_json(ck)
    ck.set_defaults(func=cmd_sheet_check)
