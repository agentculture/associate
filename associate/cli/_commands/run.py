"""``associate run`` — execute one task on a harness adapter, or refuse.

The verb is a *launcher*, and the interesting half of a launcher is what it
declines to do. Spec claim c34: Pi's headless modes silently fall back to the
full built-in tool set — ``edit`` and ``write`` included — on a checkout whose
project files are not trusted, so a run that cannot prove the ``associate``
extension loaded must not be served at all. Honesty condition h26 pins how the
proof is obtained: from the tool list Pi itself reports, never from a config
file being on disk. The Pi adapter does that check and raises; this module only
maps the outcome onto the CLI's exit-code policy.

Exit codes
----------
``0`` the run served, and both artifact paths are on stdout.
``1`` an unknown ``--harness`` (the error lists the registered adapters).
``2`` the adapter failed closed, or its environment is not usable — pi absent,
      a timeout, an export root inside the examined checkout.

Everything the run *produced* goes to stdout; every diagnostic — the version
warning, the "no lane configured" note — goes to stderr, so a caller can parse
one without filtering the other.
"""

from __future__ import annotations

import argparse
import inspect
from pathlib import Path
from typing import Any

from associate import contract
from associate.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from associate.cli._output import emit_result
from associate.harness import available_harnesses, get_harness
from associate.harness.base import HarnessError

#: Keys printed, in this order, when a key is present in the adapter's result.
_RESULT_KEYS = (
    "walk_path",
    "statements_path",
    "statements_md_path",
    "export_dir",
    "outcome",
    "session_id",
    "plumbing_only",
)


def _build(harness_cls: type, args: argparse.Namespace) -> Any:
    """Instantiate the adapter, passing only what its constructor accepts.

    The stub takes none of these; the Pi adapter takes all of them. Selecting
    by signature keeps the verb adapter-agnostic, the same way
    ``associate.bench.runner`` does.
    """
    candidates = {
        "prompt": args.prompt,
        "continue_from": args.continue_from,
        "timeout": args.timeout,
    }
    try:
        parameters = inspect.signature(harness_cls).parameters
    except (TypeError, ValueError):  # pragma: no cover - exotic callables
        parameters = {}
    kwargs = {key: value for key, value in candidates.items() if key in parameters}
    return harness_cls(**kwargs)


def cmd_run(args: argparse.Namespace) -> int:
    from associate.harness.pi import generate_session_id, resolve_export_root, sanitize_session_id

    json_mode = bool(getattr(args, "json", False))

    try:
        harness_cls = get_harness(args.harness)
    except KeyError as err:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"unknown harness {args.harness!r}",
            remediation=f"available adapters: {', '.join(available_harnesses())}",
        ) from err

    checkout = Path(args.checkout).expanduser().resolve() if args.checkout else Path.cwd()
    if not checkout.is_dir():
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"checkout {checkout} is not a directory",
            remediation="pass --checkout <path to an existing checkout>",
        )

    session_id = sanitize_session_id(args.session_id) if args.session_id else generate_session_id()

    try:
        export_root = resolve_export_root(checkout, args.export_root)
    except ValueError as err:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=str(err),
            remediation="pass --export-root <dir> outside the examined checkout",
        ) from err

    task = {
        "id": args.task_id or session_id,
        "prompt": args.prompt or _default_prompt(),
        "checkout": str(checkout),
        "session_id": session_id,
        "export_dir": str(export_root),
    }
    if args.continue_from:
        task["continue_from"] = str(Path(args.continue_from).expanduser().resolve())

    harness = _build(harness_cls, args)
    try:
        harness.start(
            checkout=checkout,
            contract_dir=contract.contract_dir(),
            session_id=session_id,
            export_dir=export_root,
        )
        harness.submit(task)
        result = harness.collect()
    except HarnessError as err:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=str(err),
            remediation=err.remediation,
        ) from err

    emit_result(result if json_mode else _render(result), json_mode=json_mode)
    return 0


def _default_prompt() -> str:
    from associate.harness.pi import READINESS_PROMPT

    return READINESS_PROMPT


def _render(result: dict[str, Any]) -> str:
    """``key=value`` lines — the artifact paths first, so a reader sees them."""
    ordered = [key for key in _RESULT_KEYS if key in result]
    ordered += [key for key in result if key not in _RESULT_KEYS and key != "active_tools"]
    return "\n".join(f"{key}={result[key]}" for key in ordered if result[key] is not None)


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "run",
        help="Run one task on a harness adapter, or refuse if it cannot fail closed.",
    )
    p.add_argument(
        "prompt",
        nargs="?",
        default=None,
        help="The task text. Default: a readiness probe that calls associate_ready and finish.",
    )
    p.add_argument(
        "--harness",
        default="pi",
        help=f"Adapter to run on (default: pi). Available: {', '.join(available_harnesses())}.",
    )
    p.add_argument(
        "--checkout",
        default=None,
        help="Checkout to examine (default: the current directory).",
    )
    p.add_argument(
        "--export-root",
        default=None,
        help="Where this run's session directory is created (default: .associate-runs "
        "beside the checkout, per the contract's export section).",
    )
    p.add_argument(
        "--session-id",
        default=None,
        help="Pin the session id that keys the scratch and export directories.",
    )
    p.add_argument(
        "--continue-from",
        default=None,
        help="Export directory of a prior run whose walk is loaded as given context.",
    )
    p.add_argument("--task-id", default=None, help="Caller-assigned task id (default: session id).")
    p.add_argument(
        "--timeout",
        type=float,
        default=900.0,
        help="Seconds to wait for the harness (default: 900).",
    )
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_run)
