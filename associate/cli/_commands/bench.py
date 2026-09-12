"""``associate bench`` — run the behavioral suite against one adapter (claim c48).

Prints one table row per behavioral category, each stamped with the complete
configuration it was measured on, and exits non-zero if any category failed. A
stub run is labelled ``plumbing-only``: it verifies the wiring and says nothing
about model reliability.

Contract notes: the table is the *result* and goes to stdout; per-case failure
detail is a diagnostic and goes to stderr. An unknown adapter or a missing
corpus raises :class:`CliError` (exit 1 and 2 respectively) — a failing case is
not an error in that sense, it is a reported result with exit code 1.
"""

from __future__ import annotations

import argparse

from associate.bench.corpus import CorpusError
from associate.bench.runner import run_suite
from associate.bench.table import render
from associate.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from associate.cli._output import emit_diagnostic, emit_result
from associate.harness import available_harnesses


def cmd_bench(args: argparse.Namespace) -> int:
    json_mode = bool(getattr(args, "json", False))
    try:
        suite = run_suite(args.harness, cases_dir=args.cases, workdir=args.workdir)
    except KeyError as err:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"unknown harness {args.harness!r}",
            remediation=f"available adapters: {', '.join(available_harnesses())}",
        ) from err
    except CorpusError as err:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=str(err),
            remediation="run bench from a source checkout, or pass --cases <dir>",
        ) from err

    if json_mode:
        emit_result(suite.as_dict(), json_mode=True)
    else:
        emit_result(render(suite), json_mode=False)

    for row in suite.rows:
        for failure in row.failures:
            emit_diagnostic(f"{row.case_id}: {failure}")
    return 0 if suite.passed else 1


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "bench",
        help="Run the behavioral suite against a harness adapter and print the table.",
    )
    p.add_argument(
        "--harness",
        default="stub",
        help=f"Adapter to evaluate (default: stub). Available: {', '.join(available_harnesses())}.",
    )
    p.add_argument(
        "--cases",
        default=None,
        help="Corpus directory (default: tests/behavioral/cases in this checkout).",
    )
    p.add_argument(
        "--workdir",
        default=None,
        help="Directory for fixture checkouts and exports (default: a temporary directory).",
    )
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_bench)
