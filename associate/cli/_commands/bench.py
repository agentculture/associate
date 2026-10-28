"""``associate bench`` — run a public benchmark suite against a registry model.

Suites are data (``associate/bench/suites.json``): upstream runner, upstream
scorer, and the models it applies to. ``--suite`` with no name lists them;
``--suite NAME --model KEY`` runs the upstream runner against the gateway and
prints one row carrying suite, version, scorer, score and the config stamp.
Bare ``bench`` also lists the suites (exit 0).
"""

from __future__ import annotations

import argparse

from associate.bench import public
from associate.cli._errors import EXIT_USER_ERROR, CliError
from associate.cli._output import emit_result


def _listing(suites: dict) -> dict:
    return {
        "suites": [
            {
                "name": s["name"],
                "version": s["version"],
                "homepage": s["homepage"],
                "scorer": s["scorer"]["name"],
                "models": s["models"],
                "verified": bool(s.get("verified", True)),
            }
            for s in suites.values()
        ]
    }


def _listing_text(listing: dict) -> str:
    lines = ["Public benchmark suites:"]
    for s in listing["suites"]:
        flag = "" if s["verified"] else " [unverified entry point]"
        lines.append(
            f"  {s['name']:<14} {s['version']}  scorer: {s['scorer']}  "
            f"models: {', '.join(s['models'])}{flag}"
        )
    lines.append("Run: associate bench --suite <name> --model <key>")
    return "\n".join(lines)


def cmd_bench(args: argparse.Namespace) -> int:
    if not args.suite:
        listing = _listing(public.load_suites())
        emit_result(listing if args.json else _listing_text(listing), json_mode=args.json)
        return 0
    if not args.model:
        raise CliError(
            code=EXIT_USER_ERROR,
            message="--model is required with --suite NAME",
            remediation="e.g. associate bench --suite bfcl --model worker",
        )
    row = public.run_suite(args.suite, args.model, args.output_dir)
    emit_result(row if args.json else public.render(row), json_mode=args.json)
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "bench",
        help="Run a public suite (--suite NAME --model KEY); lists suites without a name.",
    )
    p.add_argument(
        "--suite",
        nargs="?",
        const="",
        default=None,
        help="Suite name; omit the value to list suites.",
    )
    p.add_argument("--model", help="Registry model key (see models.json).")
    p.add_argument("--output-dir", help="Where the upstream runner writes (default: temp dir).")
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_bench)
