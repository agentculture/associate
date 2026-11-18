"""``associate check`` — re-check an export directory's hand-back facts.

Reads ``walk.jsonl``, the saved results beside it and the facts payload, runs
the Python re-check and prints the counts per kind and per source kind, each
call's purpose and outcome, and each fact with its source kind. A passed fact
means its quote was found in the saved result it cites, nothing more.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from associate.accuracy.check import ExportError, inspect_export
from associate.accuracy.counts import SOURCE_KINDS
from associate.cli._errors import EXIT_USER_ERROR, CliError
from associate.cli._output import emit_result
from associate.contract import load_accuracy


def _counts_line(label: str, counts: dict[str, int]) -> str:
    return (
        f"  {label:<8} made {counts['made']}  checked {counts['checked']}  "
        f"passed {counts['passed']}  refused {counts['refused']}  unchecked {counts['unchecked']}"
    )


def render(result: dict[str, Any]) -> str:
    """The text form of :func:`associate.accuracy.check.inspect_export`."""
    out = [f"export: {result['export']} (walk format {result['walk_format']})", "", "Calls"]
    if not result["calls"]:
        out.append("  none")
    for call in result["calls"]:
        purpose = call["purpose"] if call["purpose"] is not None else "(no purpose stated)"
        detail = f" - {call['error']}" if call["error"] else ""
        out.append(f"  {call['id']}  {call['tool']}  {call['outcome']}{detail}  purpose: {purpose}")
    out += ["", "Facts"]
    if not result["applicable"]:
        out.append(f"  not applicable: {result['not_applicable_reason']}")
        return "\n".join(out)
    report = result["report"]
    out.append(_counts_line("all", report["facts"]))
    out.append("  By source kind")
    for kind in SOURCE_KINDS:
        out.append(_counts_line(kind, report["by_source_kind"][kind]))
    out.append("  Each fact")
    for fact in result["facts"]:
        reason = f" ({fact['reason']})" if fact["reason"] else ""
        out.append(
            f"  {fact['id']}  {fact['source']}  source kind: {fact['source_kind'] or 'none'}  "
            f"{fact['verdict']}{reason}"
        )
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
    return "\n".join(out)


def cmd_check(args: argparse.Namespace) -> int:
    json_mode = bool(getattr(args, "json", False))
    try:
        result = inspect_export(Path(args.export_dir), load_accuracy())
    except ExportError as err:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=str(err),
            remediation="pass an export directory holding walk.jsonl (<session>/export)",
        ) from err
    emit_result(result if json_mode else render(result), json_mode=json_mode)
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "check",
        help="Re-check an export directory's hand-back facts and print the counts.",
    )
    p.add_argument("export_dir", help="An export directory holding walk.jsonl.")
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_check)
