"""``associate check`` — re-check an export directory's hand-back facts.

Reads ``walk.jsonl``, the saved results beside it and the facts payload, runs
the Python re-check and prints the counts per kind and per source kind, each
call's purpose and outcome, and each fact with its source kind. A passed fact
means its quote was found in the saved result it cites, nothing more.

The re-check is evidence-cli's (see :mod:`associate.accuracy`), imported when
the verb runs: without a usable evidence-cli the verb exits 2 naming the
install command. Two of its results have no counterpart before the move: an
export whose walk format it does not support (``unsupported``) is not checked
and its calls are not listed, and a prior or child run in such a format is not
loaded (``unsupported_runs``).

When the export holds a support score (the extension's ``facts[i].support`` in
``check.json``), each fact's result is copied on as ``support`` and the output
says ``support_source: extension``. It is copied, not recomputed, and the verb
makes no network call for it (see :mod:`associate.accuracy.support`).

When the export holds ``reminder.json`` (the run was sent the finish reminder,
deviation d3), the result gains ``finish_reminder`` (``{"sent",
"finish_followed"}``) and the text form ends with one ``Finish reminder:`` line.
An export without it prints exactly what it printed before (see
:mod:`associate.accuracy.reminder`).

A strict export (``check.json`` mode ``strict``; its facts point with ``at``
and carry no quote) is not re-checked: evidence-cli 0.7.x knows only the quote
shape and would refuse every fact. The result says the re-check did not run
(``python_recheck_ran`` false and ``not_applicable_reason``), and carries the
extension's counts under ``strict``, labelled ``source: extension``
(:mod:`associate.accuracy.strict`).
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from associate.cli._errors import EXIT_USER_ERROR, CliError
from associate.cli._output import emit_result
from associate.contract import load_accuracy


def _counts_line(label: str, counts: dict[str, int]) -> str:
    return (
        f"  {label:<8} made {counts['made']}  checked {counts['checked']}  "
        f"passed {counts['passed']}  refused {counts['refused']}  unchecked {counts['unchecked']}"
    )


def _format_text(value: Any) -> str:
    """The walk format as found: a number, or the marker's value when it is not one."""
    if value is None:
        return "missing"
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else repr(value)


def _calls_lines(result: dict[str, Any]) -> list[str]:
    if result.get("unsupported") is True:
        return [f"  not listed: {result['not_applicable_reason']}"]
    if not result["calls"]:
        return ["  none"]
    lines = []
    for call in result["calls"]:
        purpose = call["purpose"] if call["purpose"] is not None else "(no purpose stated)"
        detail = f" - {call['error']}" if call["error"] else ""
        lines.append(
            f"  {call['id']}  {call['tool']}  {call['outcome']}{detail}  purpose: {purpose}"
        )
    return lines


def _unsupported_runs_lines(result: dict[str, Any]) -> list[str]:
    runs = result.get("unsupported_runs") or []
    if not runs:
        return []
    named = ", ".join(
        f"{run['label']} (walk format {_format_text(run['walk_format'])})" for run in runs
    )
    return ["", "Runs", f"  not loaded: {named}; its walk format is not supported"]


def _fact_lines(fact: dict[str, Any]) -> list[str]:
    """One fact's line, and under it its support result when the export held one."""
    from associate.accuracy.support import describe

    reason = f" ({fact['reason']})" if fact["reason"] else ""
    lines = [
        f"  {fact['id']}  {fact['source']}  source kind: {fact['source_kind'] or 'none'}  "
        f"{fact['verdict']}{reason}"
    ]
    if "support" in fact:
        lines.append(f"      {describe(fact['support'])}")
    return lines


def _closing_lines(result: dict[str, Any]) -> list[str]:
    """The support-score lines, then the finish-reminder line; each only when the export has it."""
    from associate.accuracy.reminder import RESULT_KEY, check_lines
    from associate.accuracy.support import summary_lines

    return [*summary_lines(result), *check_lines(result.get(RESULT_KEY))]


def render(result: dict[str, Any]) -> str:
    """The text form of evidence-cli's ``inspect_export`` result, with any copied support."""
    out = [f"export: {result['export']} (walk format {_format_text(result['walk_format'])})"]
    out += ["", "Calls", *_calls_lines(result), *_unsupported_runs_lines(result), "", "Facts"]
    if not result["applicable"]:
        out.append(f"  not applicable: {result['not_applicable_reason']}")
        if isinstance(result.get("strict"), dict):
            from associate.accuracy.strict import count_lines

            out += ["", *count_lines(result["strict"])]
        return "\n".join([*out, *_closing_lines(result)])
    report = result["report"]
    out.append(_counts_line("all", report["facts"]))
    out.append("  By source kind")
    for kind, counts in report["by_source_kind"].items():
        out.append(_counts_line(kind, counts))
    out.append("  Each fact")
    for fact in result["facts"]:
        out += _fact_lines(fact)
    concl, stmts = report["conclusions"], report["statements"]
    out += [
        "",
        f"Conclusions: made {concl['made']}  supported {concl['supported']}  "
        f"refuted {concl['refuted']}  open {concl['open']}",
        f"Statements: made {stmts['made']}  without a fact {stmts['without_fact']}",
        "",
        "passed means the quote was found in the saved result the fact cites; it is not a",
        "statement that the fact is true. Unchecked facts are never counted as passed.",
    ]
    return "\n".join([*out, *_closing_lines(result)])


def cmd_check(args: argparse.Namespace) -> int:
    # Imported here: without a usable evidence-cli this raises the exit-2 CliError.
    from associate.accuracy import ExportError, inspect_export
    from associate.accuracy.reminder import RESULT_KEY, read_reminder
    from associate.accuracy.strict import mask_inspected, read_strict
    from associate.accuracy.support import option_keys, with_support

    json_mode = bool(getattr(args, "json", False))
    try:
        prior = Path(args.continue_from) if getattr(args, "continue_from", None) else None
        accuracy = load_accuracy()
        inspected = inspect_export(Path(args.export_dir), accuracy, continue_from=prior)
    except ExportError as err:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=str(err),
            remediation="pass an export directory holding walk.jsonl (<session>/export)",
        ) from err
    strict = read_strict(Path(args.export_dir))
    if strict is not None:
        # evidence-cli reads only the quote shape: say it did not run, show the
        # extension's counts as the extension's (associate.accuracy.strict). It
        # holds no passed fact, so there is no support score to copy.
        result = mask_inspected(inspected, strict)
    else:
        # The support score is the extension's: copied from the export, never recomputed.
        result = with_support(inspected, Path(args.export_dir), option_keys(accuracy))
    held = read_reminder(Path(args.export_dir))
    if held is not None:
        result = {**result, RESULT_KEY: held}
    emit_result(result if json_mode else render(result), json_mode=json_mode)
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "check",
        help="Re-check an export directory's hand-back facts and print the counts.",
    )
    p.add_argument("export_dir", help="An export directory holding walk.jsonl.")
    p.add_argument(
        "--continue-from",
        metavar="DIR",
        help=(
            "The export directory the run continued from (what `associate run "
            "--continue-from` was given), so facts citing prior:wN can be checked."
        ),
    )
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_check)
