"""Runs: start a detached ``associate run`` on a checkout, then read its status and result.

One module holds the logic; the CLI (``associate runs start|show|list``) and the HTTP API
(``associate.server.app``) are thin layers over :func:`start`, :func:`show` and
:func:`list_runs`, and :data:`VERBS` lists them with their parameter schemas so a later MCP
surface and a parity test can reuse the same table.

How a run is started (the shape of ``.pi/extensions/associate/tools/delegate.ts``)
--------------------------------------------------------------------------------------
:func:`start` validates everything, takes the checkout's lock, records ``request.json`` and
starts ``python -m associate.runs.supervisor`` in a **new session** (it outlives the caller),
then returns the run id at once. The supervisor runs the in-tree CLI —
``<this interpreter> -m associate run --json --model M --checkout C --export-root E
--session-id <run id> --timeout T --untrusted-checkout --test-command ... -- <instruction>`` —
as an argv list, never through a shell: the instruction is one argument after ``--`` and each
test command one ``--test-command`` value that ``associate run`` itself splits with ``shlex``
(and runs without a shell). The environment drops the per-run ``ASSOCIATE_*`` variables
``associate run`` sets itself and every ``ASSOCIATE_RUNS_*`` / ``ASSOCIATE_SERVER_*`` value,
and points ``PYTHONPATH`` at the tree this package was imported from.

What ``associate run`` does with it
-----------------------------------
For a writing model it makes a worktree, runs the model, runs the test commands, and when the
outcome is ``ok`` and every test passed commits and merges into the checkout's **local**
``main``. It exits 0 even when the merge is refused, and it never pushes; neither does this
module. :func:`show` therefore never trusts the exit code alone: ``ok`` is true only when the
exit code is 0, the outcome is ``ok``, the tests passed and the merge is ``merged`` or
``nothing_to_merge`` (a clean run that changed nothing).

Configuration (environment)
---------------------------
``ASSOCIATE_RUNS_DIR``    the state directory (default ``$XDG_STATE_HOME/associate/runs``,
                          else ``~/.local/state/associate/runs``); refused inside the checkout.
``ASSOCIATE_RUNS_ROOTS``  the checkout allowlist, ``os.pathsep``-separated directories; a
                          checkout's real path must be one of them or below one. Empty: the
                          HTTP API refuses every start; the local CLI is not restricted.
Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from associate.runs import state

__all__ = [
    "REPLY_LIMIT_BYTES",
    "RUN_ID",
    "VERBS",
    "RunsConfig",
    "RunsError",
    "Verb",
    "default_child_command",
    "list_runs",
    "show",
    "start",
]

RUN_ID = state.RUN_ID
#: ``runs show`` (CLI or HTTP) always answers in fewer bytes than this.
REPLY_LIMIT_BYTES = 64 * 1024
_REPLY_BUDGET = REPLY_LIMIT_BYTES - 2048

MODEL_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
MAX_INSTRUCTION_BYTES = 100_000  # one argv string as UTF-8; Linux caps one at 128 KiB
MAX_TEST_COMMANDS = 16
MAX_TEST_COMMAND_CHARS = 4096
MAX_TIMEOUT_SECONDS = 4 * 3600.0
MAX_CHECKOUT_CHARS = 4096
SHOWN_PATHS = 200
SHOWN_PATH_CHARS = 512
SHOWN_TEXT_CHARS = 2000
SHOWN_REPLY_CHARS = 4000
#: ``runs show``: characters of the instruction (the run page's title and full text).
SHOWN_INSTRUCTION_CHARS = 4000
#: ``runs show``: per-command results (the command line and its exit code, never its output).
SHOWN_TEST_RESULTS = MAX_TEST_COMMANDS
SHOWN_TEST_COMMAND_CHARS = 512
LIST_LIMIT = 100
#: ``runs list``: characters of a run's title (the instruction's first non-empty line).
LIST_TITLE_CHARS = 120
#: ``runs list``: characters of the short words a card shows (model, timestamps, outcome).
LIST_WORD_CHARS = 64

#: Variables ``associate run`` sets per run (or a parent session would leak), never inherited.
NOT_INHERITED = frozenset(
    {
        "ASSOCIATE_CHECKOUT_ROOT",
        "ASSOCIATE_CONTINUE_FROM",
        "ASSOCIATE_SESSION_ID",
        "ASSOCIATE_EXPORT_ROOT",
        "ASSOCIATE_MODEL",
        "ASSOCIATE_ISOLATION",
        "ASSOCIATE_RUN_DEADLINE",
        "ASSOCIATE_TEST_COMMANDS",
        "ASSOCIATE_INJECT_PROMPT",
        "ASSOCIATE_PI_TRUST",
        "ASSOCIATE_CONTRACT_DIR",
        "ASSOCIATE_EXTENSION_PATH",
        "PI_ACP_SESSION_ID",
        "ACP_SESSION_ID",
        "PYTHONPATH",
        "PYTHONSAFEPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "PYTHONUSERBASE",
    }
)
_NOT_INHERITED_PREFIXES = ("ASSOCIATE_RUNS_", "ASSOCIATE_SERVER_")


# ------------------------------------------------------------------ configuration and errors


def _default_state_dir() -> Path:
    xdg = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg) if xdg and os.path.isabs(xdg) else Path.home() / ".local" / "state"
    return base / "associate" / "runs"


@dataclass(frozen=True)
class RunsConfig:
    """Where state lives and which checkouts a start may name."""

    state_dir: Path
    allowed_roots: tuple[Path, ...] = field(default_factory=tuple)

    @classmethod
    def from_env(cls) -> RunsConfig:
        raw_dir = os.environ.get("ASSOCIATE_RUNS_DIR", "").strip()
        state_dir = Path(raw_dir) if raw_dir else _default_state_dir()
        roots = tuple(
            Path(part)
            for part in os.environ.get("ASSOCIATE_RUNS_ROOTS", "").split(os.pathsep)
            if part.strip()
        )
        return cls(state_dir=state_dir, allowed_roots=roots)


class RunsError(Exception):
    """A refused or failed runs request.

    ``kind``: ``invalid`` (bad input; CLI exit 1, HTTP 400), ``forbidden`` (checkout not
    allowed; exit 1, 403), ``busy`` (a run holds the checkout; exit 1, 409), ``not_found``
    (exit 1, 404) or ``env`` (state dir, git or process trouble; exit 2, 500).
    """

    def __init__(self, kind: str, message: str, remediation: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.remediation = remediation

    def to_dict(self) -> dict[str, str]:
        return {"code": self.kind, "message": self.message, "remediation": self.remediation}


@dataclass(frozen=True)
class Verb:
    """One runs verb: its name, summary, JSON-schema params, HTTP route and required role."""

    name: str
    summary: str
    params: dict[str, Any]
    http: tuple[str, str]
    role: str


_RUN_ID_SCHEMA = {"type": "string", "pattern": f"^{RUN_ID.pattern}$"}

VERBS: tuple[Verb, ...] = (
    Verb(
        name="start",
        summary="Start a detached associate run on a checkout; returns its run id at once.",
        params={
            "type": "object",
            "properties": {
                "checkout": {"type": "string", "description": "A git work tree to run in."},
                "model": {"type": "string", "pattern": f"^{MODEL_PATTERN.pattern}$"},
                "instruction": {"type": "string", "minLength": 1},
                "test_commands": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                    "minItems": 1,
                    "maxItems": MAX_TEST_COMMANDS,
                },
                "timeout": {"type": "number", "exclusiveMinimum": 0},
            },
            "required": ["checkout", "model", "instruction", "test_commands"],
            "additionalProperties": False,
        },
        http=("POST", "/runs"),
        role="admin",
    ),
    Verb(
        name="show",
        summary="A run's status and, once finished, its outcome, merge, tests and changes.",
        params={
            "type": "object",
            "properties": {"run_id": _RUN_ID_SCHEMA},
            "required": ["run_id"],
            "additionalProperties": False,
        },
        http=("GET", "/runs/{run_id}"),
        role="viewer",
    ),
    Verb(
        name="list",
        summary="The most recent runs, newest first, with their status.",
        params={
            "type": "object",
            "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": LIST_LIMIT}},
            "additionalProperties": False,
        },
        http=("GET", "/runs"),
        role="viewer",
    ),
)


def default_child_command() -> list[str]:
    """The in-tree CLI: this interpreter, ``-m associate`` (never the PATH ``associate``)."""
    return [sys.executable, "-m", "associate"]


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# ------------------------------------------------------------------ validation


def _validate_model(model: Any) -> str:
    if not isinstance(model, str) or not MODEL_PATTERN.fullmatch(model):
        raise RunsError(
            "invalid",
            "model must be a registry key (lowercase letters, digits and '-')",
            "pass a model from associate/contract/models.json, e.g. worker",
        )
    from associate import contract

    registry = contract.load_models()
    entry = registry["models"].get(model)
    names = ", ".join(registry["models"])
    if entry is None or entry.get("status") == "pending":
        raise RunsError(
            "invalid",
            f"model {model!r} is not an active registry model",
            f"registry models: {names}",
        )
    return model


def _validate_instruction(instruction: Any) -> str:
    if not isinstance(instruction, str) or not instruction.strip():
        raise RunsError("invalid", "instruction must be a non-empty string")
    if "\x00" in instruction:
        raise RunsError("invalid", "instruction must not contain a NUL character")
    if len(instruction.encode("utf-8", "surrogatepass")) > MAX_INSTRUCTION_BYTES:
        raise RunsError("invalid", f"instruction is longer than {MAX_INSTRUCTION_BYTES} bytes")
    return instruction


def _validate_tests(test_commands: Any) -> list[str]:
    from associate.harness.testcmds import parse_test_command

    if not isinstance(test_commands, list) or not test_commands:
        raise RunsError(
            "invalid",
            "test_commands must name at least one command line",
            "a run merges only when the operator's tests pass, so a start needs them",
        )
    if len(test_commands) > MAX_TEST_COMMANDS:
        raise RunsError("invalid", f"at most {MAX_TEST_COMMANDS} test commands")
    for value in test_commands:
        if not isinstance(value, str) or "\x00" in value or len(value) > MAX_TEST_COMMAND_CHARS:
            raise RunsError("invalid", "each test command is a string without NUL, ≤4096 chars")
        try:
            parse_test_command(value)
        except ValueError as err:
            raise RunsError(
                "invalid",
                f"test command {value!r} is not a usable command line: {err}",
                'pass "<program> <args...>" (split like a shell would, run without one)',
            ) from err
    return list(test_commands)


def _validate_timeout(timeout: Any) -> float:
    if timeout is None:
        from associate import contract

        budget = contract.load_policy().get("budgets", {}).get("delegate", {})
        return float(budget.get("timeout_ms", 1_800_000)) / 1000
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise RunsError("invalid", "timeout must be a number of seconds")
    if not 0 < timeout <= MAX_TIMEOUT_SECONDS:
        raise RunsError("invalid", f"timeout must be > 0 and ≤ {MAX_TIMEOUT_SECONDS:g} seconds")
    return float(timeout)


def _git(cwd: Path, *args: str) -> str | None:
    try:
        done = subprocess.run(  # nosec B603 B607 - fixed argv, shell=False
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=30,
            check=False,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def _within(path: Path, root: Path) -> bool:
    return path == root or path.is_relative_to(root)


def _validate_checkout(
    checkout: Any, config: RunsConfig, require_allowlist: bool
) -> tuple[Path, Path, str]:
    """``(checkout real path, its work tree root, HEAD commit)``, or a refusal."""
    if not isinstance(checkout, str) or not checkout or "\x00" in checkout:
        raise RunsError("invalid", "checkout must be a non-empty path")
    if len(checkout) > MAX_CHECKOUT_CHARS:
        raise RunsError("invalid", f"checkout path is longer than {MAX_CHECKOUT_CHARS} chars")
    try:
        real = Path(checkout).resolve(strict=True)
    except (OSError, RuntimeError):
        raise RunsError("invalid", f"checkout {checkout!r} does not exist") from None
    if not real.is_dir():
        raise RunsError("invalid", f"checkout {checkout!r} is not a directory")
    roots = [Path(r).resolve() for r in config.allowed_roots]
    if roots:
        if not any(_within(real, root) for root in roots):
            raise RunsError(
                "forbidden",
                f"checkout {checkout!r} is not under an allowed root",
                "the operator lists allowed roots in ASSOCIATE_RUNS_ROOTS",
            )
    elif require_allowlist:
        raise RunsError(
            "forbidden",
            "no checkout root is allowed (ASSOCIATE_RUNS_ROOTS is empty), so no run is started",
            "the operator sets ASSOCIATE_RUNS_ROOTS to the directories runs may use",
        )
    toplevel = _git(real, "rev-parse", "--show-toplevel")
    if not toplevel:
        raise RunsError(
            "invalid",
            f"checkout {checkout!r} is not a git work tree",
            "a run commits and merges in git; pass a git checkout",
        )
    if Path(toplevel).resolve() != real:
        # a subdirectory would take its own lock and pass the allowlist on its own path, while
        # the run commits and merges in the whole work tree
        raise RunsError(
            "invalid",
            f"checkout {checkout!r} is inside a git work tree, not its root",
            f"pass the work tree's root: {toplevel}",
        )
    head = _git(real, "rev-parse", "--verify", "HEAD^{commit}")
    if not head:
        raise RunsError("invalid", f"checkout {checkout!r} has no commit to base a run on")
    return real, Path(toplevel).resolve(), head


def _child_env(package_root: Path) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in NOT_INHERITED and not key.startswith(_NOT_INHERITED_PREFIXES)
    }
    env["PYTHONPATH"] = str(package_root)
    return env


# ------------------------------------------------------------------ start


def start(
    *,
    checkout: Any,
    model: Any,
    instruction: Any,
    test_commands: Any,
    timeout: Any = None,
    config: RunsConfig | None = None,
    require_allowlist: bool = False,
    child_command: list[str] | None = None,
) -> dict[str, Any]:
    """Validate, lock the checkout, start the detached run, return its id at once.

    ``require_allowlist`` (the HTTP API sets it) refuses every start while no root is allowed.
    ``child_command`` replaces ``[python, -m, associate]`` (tests); it is never caller input.
    """
    config = config or RunsConfig.from_env()
    model = _validate_model(model)
    instruction = _validate_instruction(instruction)
    tests = _validate_tests(test_commands)
    seconds = _validate_timeout(timeout)
    real, toplevel, head = _validate_checkout(checkout, config, require_allowlist)

    state_dir = Path(config.state_dir).resolve()
    if _within(state_dir, toplevel) or _within(state_dir, real):
        raise RunsError(
            "env",
            f"the runs state directory {state_dir} is inside the checkout",
            "set ASSOCIATE_RUNS_DIR to a directory outside every checkout",
        )
    try:
        state.ensure_dir(state_dir / "runs")
    except OSError as err:
        raise RunsError("env", f"the runs state directory cannot be created: {err}") from err

    run_id = state.new_run_id()
    try:
        lock_fd = state.acquire_checkout_lock(state_dir, real, run_id)
    except state.CheckoutBusy as busy:
        holder = f"run {busy.holder}" if busy.holder else "another run"
        raise RunsError(
            "busy",
            f"{holder} is still in progress on {real}; one run per checkout at a time",
            f"check it with `associate runs show {busy.holder or '<run id>'}` and start again "
            "once it has finished",
        ) from None
    except OSError as err:
        raise RunsError("env", f"the checkout lock cannot be taken: {err}") from err

    try:
        return _launch(
            run_id,
            lock_fd,
            state_dir,
            real,
            model,
            instruction,
            tests,
            seconds,
            head,
            child_command,
        )
    except OSError as err:
        raise RunsError("env", f"run {run_id} could not be recorded: {err}") from err
    finally:
        os.close(lock_fd)


def _launch(
    run_id: str,
    lock_fd: int,
    state_dir: Path,
    real: Path,
    model: str,
    instruction: str,
    tests: list[str],
    seconds: float,
    head: str,
    child_command: list[str] | None,
) -> dict[str, Any]:
    run = state.run_dir(state_dir, run_id)
    run.mkdir(mode=0o700)
    argv = [
        *(child_command or default_child_command()),
        "run",
        "--json",
        "--model",
        model,
        "--checkout",
        str(real),
        "--export-root",
        str(run / "export"),
        "--session-id",
        run_id,
        "--timeout",
        f"{seconds:g}",
        "--untrusted-checkout",
    ]
    for command in tests:
        argv += ["--test-command", command]
    argv += ["--", instruction]
    started_at = _now()
    state.atomic_write_json(
        run / "request.json",
        {
            "run_id": run_id,
            "checkout": str(real),
            "model": model,
            "instruction": instruction,
            "test_commands": tests,
            "timeout": seconds,
            "base_commit": head,
            "started_at": started_at,
            "cwd": str(run),
            "argv": argv,
        },
    )
    package_root = Path(__file__).resolve().parents[2]
    try:
        with (run / "supervisor.log").open("wb") as log:
            proc = subprocess.Popen(  # nosec B603 - fixed argv, shell=False
                [sys.executable, "-m", "associate.runs.supervisor", str(run), str(lock_fd)],
                cwd=str(run),
                env=_child_env(package_root),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                pass_fds=(lock_fd,),
                close_fds=True,
            )
    except OSError as err:
        state.atomic_write_json(
            run / "result.json",
            {"status": "failed-to-start", "finished_at": _now(), "error": str(err)},
        )
        raise RunsError("env", f"run {run_id} could not be started: {err}") from err
    state.atomic_write_json(run / "supervisor.json", {"pid": proc.pid})
    return {
        "run_id": run_id,
        "status": "running",
        "checkout": str(real),
        "model": model,
        "base_commit": head,
        "started_at": started_at,
        "pushed": False,
        "note": "the run continues after this returns; read it with `associate runs show "
        f"{run_id}`. A clean run with passing tests is merged into the checkout's local main; "
        "nothing is ever pushed.",
    }


# ------------------------------------------------------------------ show and list


def _status(run: Path, run_id: str) -> tuple[str, dict[str, Any] | None]:
    result = state.read_json(run / "result.json")
    if isinstance(result, dict):
        return str(result.get("status", "finished")), result
    for name in ("supervisor.json", "child.json"):
        record = state.read_json(run / name)
        if isinstance(record, dict) and state.pid_alive(record.get("pid"), run_id):
            return "running", None
    # the supervisor may have written its result and exited between the two reads
    result = state.read_json(run / "result.json")
    if isinstance(result, dict):
        return str(result.get("status", "finished")), result
    return "lost", None


def _cut(value: Any, chars: int) -> Any:
    if isinstance(value, str) and len(value) > chars:
        return value[:chars] + "…"
    return value


def _merge_word(raw: Any, outcome: Any, tests_passed: Any) -> str:
    """``merged`` / ``refused`` / ``nothing_to_merge`` / ``not_attempted``."""
    if raw == "merged":
        return "merged"
    if raw == "nothing_to_merge":
        return "nothing_to_merge"
    if raw == "kept":
        # associate run keeps a run unmerged either because it was not clean (outcome not ok,
        # or tests failed: no merge attempted) or because the merge itself was refused.
        return "refused" if outcome == "ok" and tests_passed is True else "not_attempted"
    return "not_attempted"


def _finished(reply: dict[str, Any], result: dict[str, Any]) -> None:
    run_result = result.get("run_result")
    run_result = run_result if isinstance(run_result, dict) else {}
    tests = run_result.get("tests") if isinstance(run_result.get("tests"), dict) else None
    passed = tests.get("passed") if tests else None
    passed = passed if isinstance(passed, bool) else None
    commands = tests.get("commands") if tests and isinstance(tests.get("commands"), list) else []
    outcome = _cut(run_result.get("outcome"), 64)  # a short word; never trusted to be one
    exit_code = result.get("exit_code")
    merge = _merge_word(run_result.get("merge"), outcome, passed)
    reasons = []
    if exit_code != 0:
        reasons.append(f"the run exited with {exit_code if exit_code is not None else 'a signal'}")
    if outcome != "ok":
        reasons.append(f"the outcome is {outcome!r}, not 'ok'")
    if passed is not True:
        reasons.append("the tests did not pass" if passed is False else "no test result")
    if merge not in ("merged", "nothing_to_merge"):  # nothing to merge: a clean run, no change
        reasons.append(f"the merge is {merge}")
    reply.update(
        {
            "finished_at": result.get("finished_at"),
            "exit_code": exit_code,
            "signal": result.get("signal"),
            "ok": not reasons,
            "not_ok_because": "; ".join(reasons) or None,
            "outcome": outcome,
            "merge": merge,
            "merge_reason": _cut(run_result.get("merge_reason"), SHOWN_TEXT_CHARS),
            "worktree": _cut(run_result.get("worktree"), SHOWN_PATH_CHARS),
            "run_branch": _cut(run_result.get("run_branch"), SHOWN_PATH_CHARS),
            "tests": {
                "passed": passed,
                "commands": len(commands),
                "failed": sum(
                    1 for c in commands if isinstance(c, dict) and c.get("exit_code") != 0
                ),
                "error": _cut(tests.get("error"), SHOWN_TEXT_CHARS) if tests else None,
                **_test_results(commands),
            },
            "base_commit": result.get("base_commit"),
            "changed_paths_total": result.get("changed_paths_total", 0),
            "changed_paths_error": _cut(result.get("changed_paths_error"), SHOWN_TEXT_CHARS),
            "final_reply": _cut(run_result.get("final_reply"), SHOWN_REPLY_CHARS),
            "error": _cut(result.get("error"), SHOWN_TEXT_CHARS),
        }
    )
    _bound_paths(reply, result.get("changed_paths"))


def _test_results(commands: list[Any]) -> dict[str, Any]:
    """Each stored test command's line and exit code (capped), never its output or env.

    The stored entry (``associate.harness.testcmds``) also holds ``output_tail`` and timing;
    only the argv (joined as a shell would quote it) and how it ended are shown.
    """
    results = []
    for command in commands:
        argv = command.get("argv") if isinstance(command, dict) else None
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            continue
        code = command.get("exit_code")
        results.append(
            {
                "command": _cut(shlex.join(argv), SHOWN_TEST_COMMAND_CHARS),
                "exit_code": _int_or_none(code),
                "timed_out": command.get("timed_out") is True,
            }
        )
    return {
        "results": results[:SHOWN_TEST_RESULTS],
        "results_truncated": len(results) > SHOWN_TEST_RESULTS,
    }


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _size(reply: dict[str, Any]) -> int:
    # ensure_ascii=True is the larger encoding (non-ASCII becomes \\uXXXX), so it bounds both.
    return len(json.dumps(reply, ensure_ascii=True).encode("ascii"))


def _bound_paths(reply: dict[str, Any], stored: Any) -> None:
    paths = [p for p in stored if isinstance(p, str)] if isinstance(stored, list) else []
    total = max(_count(reply.get("changed_paths_total")), len(paths))
    shown = [_cut(p, SHOWN_PATH_CHARS) for p in paths[:SHOWN_PATHS]]
    cut_any = len(shown) < total or any(s != p for s, p in zip(shown, paths))
    reply["changed_paths"] = shown
    reply["changed_paths_truncated"] = cut_any
    reply["changed_paths_total"] = total
    while _size(reply) >= _REPLY_BUDGET and reply["changed_paths"]:
        reply["changed_paths"] = reply["changed_paths"][: len(reply["changed_paths"]) // 2]
        reply["changed_paths_truncated"] = True
    if _size(reply) >= _REPLY_BUDGET:
        reply["final_reply"] = None
        reply["final_reply_dropped"] = True
    tests = reply.get("tests") if isinstance(reply.get("tests"), dict) else {}
    if _size(reply) >= _REPLY_BUDGET and tests.get("results"):
        tests["results"] = [{**r, "command": _cut(r["command"], 80)} for r in tests["results"]]
        tests["results_truncated"] = True
    if _size(reply) >= _REPLY_BUDGET and isinstance(reply.get("instruction"), str):
        _cut_instruction(reply, 500)
    if _size(reply) >= _REPLY_BUDGET:  # the last resort: every free-text detail goes
        for key in ("merge_reason", "changed_paths_error", "error", "not_ok_because"):
            reply[key] = None
        reply["worktree"] = reply["run_branch"] = None
        if tests:
            tests["error"] = None
            tests["results"] = None
            tests["results_truncated"] = True
        if isinstance(reply.get("instruction"), str):
            _cut_instruction(reply, 200)
        reply["details_dropped"] = True


def _cut_instruction(reply: dict[str, Any], chars: int) -> None:
    text = reply["instruction"]
    if len(text) > chars:
        reply["instruction"] = text[: chars - 1].rstrip("…") + "…"
        reply["instruction_truncated"] = True


def _instruction(value: Any) -> dict[str, Any]:
    if not isinstance(value, str):
        return {"instruction": None, "instruction_truncated": False}
    return {
        "instruction": _cut(value, SHOWN_INSTRUCTION_CHARS),
        "instruction_truncated": len(value) > SHOWN_INSTRUCTION_CHARS,
    }


def _command_count(value: Any) -> int:
    return len(value) if isinstance(value, list) else 0


def _title(value: Any) -> str | None:
    """The instruction's first non-empty line, stripped and cut (a card's title)."""
    if not isinstance(value, str):
        return None
    for line in value.splitlines():
        if line.strip():
            return _cut(line.strip(), LIST_TITLE_CHARS)
    return None


def show(run_id: Any, *, config: RunsConfig | None = None) -> dict[str, Any]:
    """The run's status (``running | finished | failed-to-start | lost``) and its result."""
    config = config or RunsConfig.from_env()
    try:
        run = state.run_dir(Path(config.state_dir), run_id)
    except ValueError as err:
        raise RunsError("invalid", str(err), "pass the run id `runs start` returned") from None
    request = state.read_json(run / "request.json")
    if not isinstance(request, dict):
        raise RunsError("not_found", f"no run {run_id}", "list runs with `associate runs list`")
    status, result = _status(run, run_id)
    reply: dict[str, Any] = {
        "run_id": run_id,
        "status": status,
        "ok": False,
        "checkout": _cut(request.get("checkout"), SHOWN_PATH_CHARS),
        "model": request.get("model"),
        "started_at": request.get("started_at"),
        "base_commit": request.get("base_commit"),
        "pushed": False,
        **_instruction(request.get("instruction")),
        "test_command_count": _command_count(request.get("test_commands")),
    }
    if status == "finished" and result is not None:
        _finished(reply, result)
    elif status == "failed-to-start" and result is not None:
        reply["error"] = _cut(result.get("error"), SHOWN_TEXT_CHARS)
        reply["finished_at"] = result.get("finished_at")
    elif status == "lost":
        reply["error"] = (
            "the run is no longer running and left no result (its supervisor ended first); "
            "its checkout is free again"
        )
    return reply


def list_runs(*, config: RunsConfig | None = None, limit: Any = 20) -> dict[str, Any]:
    """The most recent runs (newest first), each with its status and ``ok``."""
    config = config or RunsConfig.from_env()
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= LIST_LIMIT:
        raise RunsError("invalid", f"limit must be an integer from 1 to {LIST_LIMIT}")
    runs_dir = Path(config.state_dir) / "runs"
    found = []
    try:
        entries = list(runs_dir.iterdir())
    except OSError:
        entries = []
    for entry in entries:
        if not RUN_ID.fullmatch(entry.name):
            continue
        request = state.read_json(entry / "request.json")
        if isinstance(request, dict):
            started = str(request.get("started_at", ""))
            found.append((started, entry.name, _title(request.get("instruction"))))
    found.sort(reverse=True)
    runs = [_card(show(run_id, config=config), title) for _s, run_id, title in found[:limit]]
    return _bound_list({"runs": runs, "total": len(found)})


def _word(value: Any, chars: int = LIST_WORD_CHARS) -> Any:
    """A short value a card shows: a string cut to ``chars``, an int, a bool or None."""
    if isinstance(value, str):
        return _cut(value, chars)
    return value if isinstance(value, (int, bool)) or value is None else None


def _card(shown: dict[str, Any], title: str | None) -> dict[str, Any]:
    """One run in ``runs list``: what a card shows, every value short."""
    tests = shown.get("tests")
    return {
        "run_id": shown.get("run_id"),
        "status": _word(shown.get("status"), 32),
        "ok": shown.get("ok") is True,
        "model": _word(shown.get("model")),
        "started_at": _word(shown.get("started_at")),
        "finished_at": _word(shown.get("finished_at")),
        "checkout": _cut(shown.get("checkout"), 256),
        "title": title,
        "merge": _word(shown.get("merge"), 32),
        "outcome": _word(shown.get("outcome"), 32),
        "exit_code": _int_or_none(shown.get("exit_code")),
        "tests": (
            {k: tests.get(k) for k in ("passed", "commands", "failed")}
            if isinstance(tests, dict)
            else None
        ),
        "changed_paths_total": shown.get("changed_paths_total"),
        "test_command_count": shown.get("test_command_count", 0),
    }


def _bound_list(reply: dict[str, Any]) -> dict[str, Any]:
    """Keep ``runs list`` under :data:`REPLY_LIMIT_BYTES`: shorter titles and checkouts, and
    only as a last resort fewer runs (``truncated``)."""
    runs = reply["runs"]
    for chars in (48, 16):
        if _size(reply) < _REPLY_BUDGET:
            break
        for run in runs:
            run["title"] = _cut(run["title"], chars)
            run["checkout"] = _cut(run["checkout"], chars * 2)
    while _size(reply) >= _REPLY_BUDGET and runs:
        runs.pop()
        reply["truncated"] = True
    return reply
