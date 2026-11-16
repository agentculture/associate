"""``associate runs`` — start a detached run on a checkout and read its result by id.

A thin layer over :mod:`associate.runs.service`; the HTTP API (``associate.server``) calls
the same functions. ``runs start`` returns at once with a run id; ``runs show`` reports
``running | finished | failed-to-start | lost`` and, once finished, ``ok`` (true only when the
outcome is ok, the merge into the checkout's local ``main`` happened and the tests passed),
the merge, the tests, the base commit and the changed paths. Nothing is ever pushed.

Exit codes: ``0`` the request was served (a finished run that is not ok still exits 0 — read
``ok``); ``1`` bad input, a checkout outside ``ASSOCIATE_RUNS_ROOTS``, a checkout with a run in
progress, an unknown run id; ``2`` the state directory, git or the process could not be used.
"""

from __future__ import annotations

import argparse
from typing import Any

from associate.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from associate.cli._output import emit_result

_JSON_HELP = "Emit structured JSON."

_TEXT_ORDER = (
    "run_id",
    "status",
    "ok",
    "not_ok_because",
    "outcome",
    "merge",
    "merge_reason",
    "tests",
    "base_commit",
    "changed_paths_total",
    "changed_paths_truncated",
    "checkout",
    "model",
    "started_at",
    "finished_at",
    "exit_code",
    "worktree",
    "run_branch",
    "error",
    "note",
)


def _call(fn: Any, **kwargs: Any) -> dict[str, Any]:
    from associate.runs.service import RunsError

    try:
        return fn(**kwargs)
    except RunsError as err:
        raise CliError(
            code=EXIT_ENV_ERROR if err.kind == "env" else EXIT_USER_ERROR,
            message=err.message,
            remediation=err.remediation or "see `associate explain runs`",
        ) from err


def _render(reply: dict[str, Any]) -> str:
    lines = []
    for key in _TEXT_ORDER:
        value = reply.get(key)
        if value is None:
            continue
        if key == "tests" and isinstance(value, dict):
            value = (
                f"passed={value.get('passed')} commands={value.get('commands')} "
                f"failed={value.get('failed')}"
            )
        lines.append(f"{key}={value}")
    for path in reply.get("changed_paths") or []:
        lines.append(f"changed: {path}")
    return "\n".join(lines)


def cmd_start(args: argparse.Namespace) -> int:
    from associate.runs import service

    reply = _call(
        service.start,
        checkout=args.checkout,
        model=args.model,
        instruction=args.instruction,
        test_commands=args.test_commands or [],
        timeout=args.timeout,
    )
    emit_result(reply if args.json else _render(reply), json_mode=args.json)
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    from associate.runs import service

    reply = _call(service.show, run_id=args.run_id)
    emit_result(reply if args.json else _render(reply), json_mode=args.json)
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    from associate.runs import service

    reply = _call(service.list_runs, limit=args.limit)
    if args.json:
        emit_result(reply, json_mode=True)
    else:
        rows = [
            f"{r['run_id']}  {r['status']:<15} ok={r['ok']}  {r['model']}  {r['checkout']}"
            for r in reply["runs"]
        ]
        emit_result("\n".join(rows) or "no runs", json_mode=False)
    return 0


def _sections() -> list[dict[str, object]]:
    from associate.runs.service import VERBS

    return [
        {
            "title": "Verbs",
            "items": [f"runs {v.name} — {v.summary} (HTTP {' '.join(v.http)})" for v in VERBS]
            + ["runs overview — this description"],
        },
        {
            "title": "Rules",
            "items": [
                "one run per checkout at a time (a second start is refused)",
                "ok is true only when the outcome is ok, tests passed and the merge is merged or "
                "nothing_to_merge (a clean run that changed nothing)",
                "a clean run is merged into the checkout's local main; nothing is pushed",
                "state lives in ASSOCIATE_RUNS_DIR, outside every checkout",
            ],
        },
    ]


def cmd_overview(args: argparse.Namespace) -> int:
    from associate.cli._commands.overview import emit_overview

    emit_overview("associate runs", _sections(), json_mode=bool(getattr(args, "json", False)))
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "runs",
        help="Start a detached run on a checkout and read its result (see 'runs overview').",
    )
    p.add_argument("--json", action="store_true", help=_JSON_HELP)
    p.set_defaults(func=cmd_overview, json=False)
    noun = p.add_subparsers(dest="runs_command", parser_class=type(p))

    st = noun.add_parser(
        "start",
        help="Start a detached associate run on a checkout; prints its run id at once.",
    )
    st.add_argument("--checkout", required=True, help="A git work tree (under an allowed root).")
    st.add_argument("--model", required=True, help="Registry model to run, e.g. worker.")
    st.add_argument(
        "--test-command",
        dest="test_commands",
        action="append",
        required=True,
        metavar="COMMAND_LINE",
        help="A test command the run must pass before it merges (repeatable, at least one).",
    )
    st.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="Seconds the model may run (default: the contract's budgets.delegate.timeout_ms).",
    )
    st.add_argument("instruction", help="The task, complete and self-contained.")
    st.add_argument("--json", action="store_true", help=_JSON_HELP)
    st.set_defaults(func=cmd_start)

    sh = noun.add_parser("show", help="A run's status and, once finished, its result.")
    sh.add_argument("run_id", help="The run id `runs start` printed.")
    sh.add_argument("--json", action="store_true", help=_JSON_HELP)
    sh.set_defaults(func=cmd_show)

    ls = noun.add_parser("list", help="The most recent runs, newest first.")
    ls.add_argument("--limit", type=int, default=20, help="How many runs (1-100, default 20).")
    ls.add_argument("--json", action="store_true", help=_JSON_HELP)
    ls.set_defaults(func=cmd_list)

    ov = noun.add_parser("overview", help="Describe the runs verbs.")
    ov.add_argument("--json", action="store_true", help=_JSON_HELP)
    ov.set_defaults(func=cmd_overview)
