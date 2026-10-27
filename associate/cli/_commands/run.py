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

Worktree isolation (spec c51, t15)
----------------------------------
A model the registry marks ``may_mutate`` runs in its own git worktree under
``dirname(repo)/.worktrees.<name>/run-<session>`` on branch
``associate-run/<session>``; a clean run (outcome ``ok``) is committed there and
merged to ``main`` locally, anything else is kept and its location printed. See
``associate.harness.worktree`` for every branch of that decision. A read-only
model runs in place; a mutating run on a non-git directory runs in place with a
stderr warning. A merge that is refused does not change the exit code — the run
served — and is reported as ``merge=kept`` with ``merge_reason``.

Operator-named test commands (deviation d12)
--------------------------------------------
``--test-command "<command line>"`` (repeatable) names a command the harness
runs in the run checkout after the model finishes — every one, in order, even
after a failure — and reports as ``tests``. A worktree run is merged only when
the outcome is ``ok`` *and* every command exited ``0``; otherwise it is kept
and ``merge_reason`` names the failing command. Side effects of the commands
are reverted before any commit. See ``associate.harness.testcmds``. The same
commands reach the extension as ``ASSOCIATE_TEST_COMMANDS`` for its
``run_tests`` tool.

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
from associate.cli._output import emit_diagnostic, emit_result
from associate.harness import available_harnesses, get_harness
from associate.harness.base import HarnessError
from associate.harness.testcmds import TEST_TIMEOUT_SECONDS

#: Keys printed, in this order, when a key is present in the adapter's result.
_RESULT_KEYS = (
    "walk_path",
    "statements_path",
    "statements_md_path",
    "export_dir",
    "outcome",
    "session_id",
    "plumbing_only",
    "isolation",
    "merge",
    "merge_reason",
    "worktree",
    "run_branch",
    "tests",
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
        "model": args.model,
        "untrusted_checkout": args.untrusted_checkout,
    }
    try:
        parameters = inspect.signature(harness_cls).parameters
    except (TypeError, ValueError):  # pragma: no cover - exotic callables
        parameters = {}
    kwargs = {key: value for key, value in candidates.items() if key in parameters}
    return harness_cls(**kwargs)


def _resolve_model(requested: str | None) -> str:
    """Return the registry key to run, or refuse (exit 1) an unknown/pending one."""
    registry = contract.load_models()
    models = registry["models"]
    key = requested or str(registry["default"])
    entry = models.get(key)
    names = ", ".join(models)
    if entry is None:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"unknown model {key!r}",
            remediation=f"registry models: {names}",
        )
    if entry.get("status") == "pending":
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"model {key!r} is pending (no lobes role yet) and cannot be run",
            remediation=f"registry models: {names}",
        )
    return key


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

    args.model = _resolve_model(args.model)
    test_commands = _parse_test_commands(args.test_commands)
    if args.test_timeout <= 0:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"--test-timeout must be positive, got {args.test_timeout}",
            remediation="pass --test-timeout <seconds greater than 0>",
        )

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

    harness = _build(harness_cls, args)
    run_wt = _isolate(checkout, session_id) if _may_mutate(args.model) else None
    run_checkout = run_wt.run_checkout if run_wt is not None else checkout

    task = {
        "id": args.task_id or session_id,
        "prompt": args.prompt or _default_prompt(),
        "checkout": str(run_checkout),
        "session_id": session_id,
        "export_dir": str(export_root),
        # d8: told to the safety gate's decider as the state's isolation line.
        "isolation": "worktree" if run_wt is not None else "in-place",
    }
    if test_commands:
        task["test_commands"] = test_commands
    if args.continue_from:
        task["continue_from"] = str(Path(args.continue_from).expanduser().resolve())

    try:
        harness.start(
            checkout=run_checkout,
            contract_dir=contract.contract_dir(),
            session_id=session_id,
            export_dir=export_root,
        )
        harness.submit(task)
        result = harness.collect()
    except HarnessError as err:
        kept = (
            f" (nothing was merged; the run worktree is kept at {run_wt.path} on branch "
            f"{run_wt.branch})"
            if run_wt is not None
            else ""
        )
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=str(err) + kept,
            remediation=err.remediation,
        ) from err

    tests = _run_tests(test_commands, run_checkout, args.test_timeout)
    if tests is not None:
        result = {**result, "tests": tests}

    if run_wt is not None:
        finished = _finish(run_wt, result, session_id, tests)
        result = {**result, "isolation": "worktree", **finished}
    elif _may_mutate(args.model):
        result = {**result, "isolation": "in-place"}

    emit_result(result if json_mode else _render(result), json_mode=json_mode)
    return 0


def _parse_test_commands(values: list[str] | None) -> list[list[str]]:
    """Each ``--test-command`` value as an argv list, in order; exit 1 on a bad one."""
    from associate.harness.testcmds import parse_test_command

    commands: list[list[str]] = []
    for value in values or []:
        try:
            commands.append(parse_test_command(value))
        except ValueError as err:
            raise CliError(
                code=EXIT_USER_ERROR,
                message=f"--test-command {value!r} is not a usable command line: {err}",
                remediation='pass --test-command "<program> <args...>" (split like a shell '
                "would, but run without one)",
            ) from err
    return commands


def _run_tests(
    commands: list[list[str]], run_checkout: Path, timeout: float
) -> dict[str, Any] | None:
    """Run the operator's test commands after the model (d12); ``None`` when none given."""
    if not commands:
        return None
    from associate.harness.testcmds import describe_failures, run_test_commands

    tests = run_test_commands(commands, run_checkout, timeout=timeout, warn=emit_diagnostic)
    if not tests["passed"]:
        emit_diagnostic(f"associate: tests failed: {describe_failures(tests)}")
    return tests


def _may_mutate(model_key: str) -> bool:
    """The registry's ``may_mutate`` for the resolved model (spec c51)."""
    return contract.load_models()["models"][model_key].get("may_mutate") is True


def _isolate(checkout: Path, session_id: str) -> Any:
    """Give a mutating run its own worktree; ``None`` when the checkout is not git.

    A non-git checkout has no ``main`` and no worktree to give, so the run goes
    ahead in place with a stderr warning — there is nothing a merge could
    protect, and refusing would make every plain directory unexaminable.
    """
    from associate.harness import worktree

    try:
        run_wt = worktree.create_run_worktree(checkout, session_id)
    except worktree.NotAGitRepository:
        emit_diagnostic(
            f"associate: {checkout} is not a git work tree; this mutating run is not "
            "isolated in a worktree and writes in place"
        )
        return None
    except HarnessError as err:
        raise CliError(code=EXIT_ENV_ERROR, message=str(err), remediation=err.remediation) from err
    emit_diagnostic(f"associate: run worktree {run_wt.path} on branch {run_wt.branch}")
    return run_wt


def _finish(
    run_wt: Any, result: dict[str, Any], session_id: str, tests: dict[str, Any] | None
) -> dict[str, Any]:
    """Commit + merge a clean run, keep anything else; never raises a traceback.

    Clean means the outcome is ``ok`` and, when test commands were named, every
    one passed (d12) — a run whose tests failed is kept, never committed.
    """
    from associate.harness import worktree
    from associate.harness.testcmds import describe_failures

    outcome = str(result.get("outcome"))
    reason = None
    if outcome == "ok" and tests is not None and not tests["passed"]:
        reason = f"tests failed: {describe_failures(tests)}"
    try:
        report = worktree.finish(
            run_wt,
            clean=outcome == "ok" and reason is None,
            session_id=session_id,
            outcome=outcome,
            reason=reason,
        )
    except HarnessError as err:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=f"{err} (the run worktree is kept at {run_wt.path} on branch {run_wt.branch})",
            remediation=err.remediation,
        ) from err
    if report["merge"] == "kept":
        emit_diagnostic(
            f"associate: not merged ({report['merge_reason']}); worktree kept at "
            f"{report['worktree']} on branch {report['run_branch']}"
        )
    return report


def _default_prompt() -> str:
    from associate.harness.pi import READINESS_PROMPT

    return READINESS_PROMPT


def _render(result: dict[str, Any]) -> str:
    """``key=value`` lines — the artifact paths first, so a reader sees them."""
    ordered = [key for key in _RESULT_KEYS if key in result]
    ordered += [key for key in result if key not in _RESULT_KEYS and key != "active_tools"]
    shown = {**result}
    if isinstance(result.get("tests"), dict):
        shown["tests"] = _render_tests(result["tests"])
    return "\n".join(f"{key}={shown[key]}" for key in ordered if shown[key] is not None)


def _render_tests(tests: dict[str, Any]) -> str:
    """One line: passed/failed, how many, which failed, how many paths reverted."""
    from associate.harness.testcmds import describe_failures

    count = len(tests.get("commands", []))
    reverted = len(tests.get("reverted", []))
    line = f"{'passed' if tests['passed'] else 'failed'} ({count} command(s)"
    line += f", {reverted} path(s) reverted)" if reverted else ")"
    if not tests["passed"]:
        line += f": {describe_failures(tests)}"
    return line


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
    p.add_argument(
        "--model",
        default=None,
        help="Registry model to run (from the contract's models.json; default: the "
        "registry's default). Unknown or pending models exit 1.",
    )
    p.add_argument(
        "--untrusted-checkout",
        action="store_true",
        help="Ignore the examined checkout's own .pi settings, extensions and MCP "
        "config (pi --no-approve --no-extensions). Off by default.",
    )
    p.add_argument(
        "--test-command",
        dest="test_commands",
        action="append",
        default=None,
        metavar="COMMAND_LINE",
        help="A test command the harness runs in the run checkout after the model "
        "finishes (split like a shell would, run without one). Repeatable; all run, in "
        "order. A worktree run merges only when every one exits 0; their side effects "
        "are reverted. Also offered to the model as the run_tests tool.",
    )
    p.add_argument(
        "--test-timeout",
        type=float,
        default=TEST_TIMEOUT_SECONDS,
        help=f"Seconds each --test-command may run (default: {TEST_TIMEOUT_SECONDS:g}).",
    )
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_run)
