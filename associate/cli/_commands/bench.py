"""``associate bench`` — run public benchmark suites (none configured yet).

The in-house behavioral suite was dropped; benchmarks are public suites only
(BFCL, MMMU, LiveCodeBench), added later as data. Until one is configured there
is nothing to run, and the verb says so rather than reporting a vacuous pass:
it exits 2 (setup incomplete), with the message on stderr.
"""

from __future__ import annotations

import argparse

from associate.cli._errors import EXIT_ENV_ERROR, CliError


def cmd_bench(args: argparse.Namespace) -> int:
    raise CliError(
        code=EXIT_ENV_ERROR,
        message="no public benchmark suites are configured; nothing to run",
        remediation=(
            "public suites (BFCL, MMMU, LiveCodeBench) are not wired in yet; "
            "see `associate explain bench`"
        ),
    )


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "bench",
        help="Run public benchmark suites (none configured yet; exits 2).",
    )
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_bench)
