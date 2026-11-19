"""``associate measure`` — run a comparison, follow it, report it, draw a sample (plan task t11).

A comparison runs every task for every arm and repeat and stores one graded
result per key (:mod:`associate.measure.runner`); ``report`` prints the table of
the stored results and ``sample`` writes the sheet to hand grade
(:mod:`associate.measure.report`). This module wires those to the command line.

Sub-verbs
---------
``run``     start a comparison (foreground, or ``--detach`` in the background).
``status``  read-only: how many of the expected runs are stored, whether a runner
            holds the lock, and where the log is.
``report``  the table of the stored results, text or ``--json``.
``sample``  the blank hand-grading sheet for a fixed-seed draw of the stored runs.
``agreement`` read-only: a filled sheet against the grader, and whether the sample meets
            the two conditions the comparison needs (48 hand-graded runs, 95% agreement).
``sheet``, ``sheet-check`` and ``run --broad``: the broad tasks, in
            :mod:`associate.cli._commands.measure_broad`; ``report`` on a broad
            comparison is that module's too.
``overview`` describe these verbs.

The difference note
-------------------
``run`` on any harness except ``stub`` refuses to start unless a note stating the
difference that will be called a change is committed: the file
``docs/accuracy/difference-threshold.md`` (``--difference-note`` names another
path), tracked by git and unmodified in the working tree. A stub comparison is
plumbing only: it needs no note, and its output says so, the way
``associate run --harness stub`` labels itself ``plumbing_only``.

The manifest and detaching
--------------------------
``run`` writes ``manifest.json`` into the output directory when it starts: the
task ids, the arm names, the repeats, the harness, the log path and (once the
runner process is running) its process id. ``status`` takes the expected runs from
it. ``--detach`` starts the same command without ``--detach`` as a child in its own
session with stdin closed and stdout and stderr appended to ``measure-run.log``
in the output directory, prints where things are and the child's process id, and
returns. Only one runner may work on an output directory; the runner's lock file
refuses a second one.

Nothing here prints a count as a score; a count is a count of stored runs.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import subprocess  # nosec B404 - fixed argv, no shell
import sys
import time
from collections import Counter
from itertools import product
from pathlib import Path
from subprocess import Popen  # nosec B404 - fixed argv, no shell
from types import ModuleType
from typing import TYPE_CHECKING, Any

from associate.cli._commands.overview import emit_overview
from associate.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from associate.cli._output import emit_diagnostic, emit_result

if TYPE_CHECKING:
    from associate.measure.runner import Arm

REPO_ROOT = Path(__file__).resolve().parents[3]
DIFFERENCE_NOTE = REPO_ROOT / "docs" / "accuracy" / "difference-threshold.md"
MANIFEST_FILE = "manifest.json"
LOG_FILE = "measure-run.log"
MANIFEST_FORMAT = 1
DEFAULT_TIMEOUT_S = 3600.0
DEFAULT_SHEET = "hand-grading-sheet.json"
DEFAULT_SEED = 1
# The most repeats one comparison may ask for. `run` refuses more, and so does every verb
# that reads the number back from a manifest, so a number in a file never sets an unbounded loop.
MAX_REPEATS = 1000
STUB = "stub"
# The report module's own values, repeated so that building the parser imports nothing that
# needs evidence-cli; a test pins them to the report module's.
READING_ANSWER = "answer_text"
READING_WITH_HANDBACK = "answer_text_plus_handback_values"
SAMPLE_SIZE = 48
PLUMBING_LINE = (
    "Plumbing only: this comparison used the stub harness; it shows the wiring works "
    "and says nothing about any model."
)

_UTF8 = "utf-8"
_K_HARNESS_COMMIT = "harness_commit"
_ARM_REQUIRED = ("name", _K_HARNESS_COMMIT, "model")
_K_SUPPORT = "support_score"
_ARM_OPTIONAL = ("check_mode", "reasoning", _K_SUPPORT)
_ARM_KEYS = frozenset(_ARM_REQUIRED + _ARM_OPTIONAL)
_COLUMN_NAMES = {
    "runs": "runs",
    "matches": "matching",
    "does_not_match": "not_matching",
    "cannot_tell": "cannot_tell",
    "not_graded": "not_graded",
    "contaminated": "contaminated",
}
_ARMS_HINT = (
    "write the arms file as a JSON list of objects with name, harness_commit and model, "
    "and optionally check_mode (report or enforce), reasoning (model-default, on or off) and "
    "support_score (on or off)"
)
_STATUS_HINT = "start the comparison with `associate measure run` first"
_POSITIVE_HINT = "give a positive whole number"
_REPEATS_HINT = f"give a whole number from 1 to {MAX_REPEATS}"
_K_REPEATS = "repeats"
_FLAG_REPEATS = "--repeats"
_K_SHEET = "sheet"
_K_JSON = "json"
_K_TASKS = "tasks"
_K_ARMS = "arms"
_K_LOG = "log"
_K_PID = "pid"
_K_RESULTS = "results"
_K_PLUMBING = "plumbing_only"
_K_EXPECTED = "expected_runs"
_K_MISSING = "missing_checkouts"
_K_READING = "reading"
_K_FINISHED = "finished"
_K_FAILED = "launch_failed"
_K_NOT_STORED = "not_stored"
_K_BROAD = "broad"
_FLAG_BROAD = "--broad"


def _broad_verbs() -> ModuleType:
    """The broad-task verbs (imported when used: that module imports this one)."""
    from associate.cli._commands import measure_broad

    return measure_broad


def _runner() -> ModuleType:
    """The runner module. evidence-cli is imported by it; without a usable one this raises
    the exit-2 CliError naming the install command, from the verb's handler (never at import)."""
    from associate.accuracy import require_evidence

    require_evidence()
    from associate.measure import runner

    return runner


def _report() -> ModuleType:
    _runner()
    from associate.measure import report

    return report


def _tasks_module() -> ModuleType:
    _runner()
    from associate.measure import tasks

    return tasks


def run_comparison(*args: Any, **kwargs: Any) -> Any:
    """The runner's ``run_comparison``, imported when called."""
    return _runner().run_comparison(*args, **kwargs)


# ------------------------------------------------------------------ small helpers


def _user_error(message: str, remediation: str) -> CliError:
    return CliError(code=EXIT_USER_ERROR, message=message, remediation=remediation)


def _json_mode(args: argparse.Namespace) -> bool:
    return bool(getattr(args, _K_JSON, False))


def _write_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding=_UTF8)
    os.replace(temporary, path)


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding=_UTF8))
    except (OSError, ValueError):
        return None


def _git(cwd: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(  # nosec B603 B607 - fixed argv, no shell
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=False
    )


def _positive_seconds(value: float) -> float:
    if not math.isfinite(value) or value <= 0:
        raise _user_error(
            f"--timeout must be a positive number of seconds, not {value:g}",
            "there is no unlimited value; give the longest one run may take, for example 3600",
        )
    return value


# --------------------------------------------------------------- arms and tasks


def _arm_label(index: int, item: Any) -> str:
    name = item.get("name") if isinstance(item, dict) else None
    return f"arm {name!r}" if isinstance(name, str) else f"arms[{index}]"


def _arm_value_problems(label: str, item: dict[str, Any]) -> list[str]:
    problems = []
    for key in _ARM_REQUIRED:
        if not isinstance(item.get(key), str) or not item[key].strip():
            problems.append(f"{label}: {key} must be a non-empty string")
    runner = _runner()
    commit = item.get(_K_HARNESS_COMMIT)
    if isinstance(commit, str) and commit.strip() and not runner.is_commit_id(commit):
        problems.append(
            f"{label}: {_K_HARNESS_COMMIT} must be a commit id of 7 to 64 hexadecimal "
            f"characters, not {commit!r} (a branch or tag name is not accepted)"
        )
    for key, choices in (
        ("check_mode", runner.CHECK_MODES),
        ("reasoning", runner.REASONING_CHOICES),
        (_K_SUPPORT, runner.SUPPORT_SCORE_CHOICES),
    ):
        if key in item and item[key] not in choices:
            problems.append(f"{label}: {key} must be one of {', '.join(choices)}")
    return problems


def _arm_problems(index: int, item: Any) -> list[str]:
    label = _arm_label(index, item)
    if not isinstance(item, dict):
        return [f"{label} is not an object"]
    unknown = sorted(str(k) for k in set(item) - _ARM_KEYS)
    problems = [f"{label}: unknown key {', '.join(unknown)}"] if unknown else []
    return problems + _arm_value_problems(label, item)


def _duplicate_names(items: list[Any]) -> list[str]:
    names = [i["name"] for i in items if isinstance(i, dict) and isinstance(i.get("name"), str)]
    return [f"duplicate arm name {n!r}" for n in sorted(set(names)) if names.count(n) > 1]


def load_arms(path: Path) -> list[Arm]:
    """Read and validate an arms file; raise a user error naming every problem."""
    try:
        doc = json.loads(path.read_text(encoding=_UTF8))
    except (OSError, ValueError) as exc:
        raise _user_error(f"cannot read the arms file {path}: {exc}", _ARMS_HINT) from exc
    if not isinstance(doc, list) or not doc:
        raise _user_error(f"the arms file {path} must be a non-empty list of arms", _ARMS_HINT)
    problems = [p for i, item in enumerate(doc) for p in _arm_problems(i, item)]
    problems += _duplicate_names(doc)
    if problems:
        raise _user_error(f"the arms file {path} is not valid: " + "; ".join(problems), _ARMS_HINT)
    return [
        _runner().Arm(
            name=item["name"],
            harness_commit=item[_K_HARNESS_COMMIT],
            model=item["model"],
            check_mode=item.get("check_mode"),
            reasoning=item.get("reasoning"),
            support_score=item.get(_K_SUPPORT),
        )
        for item in doc
    ]


def load_tasks(path: Path | None, only: list[str]) -> tuple[list[dict[str, Any]], str]:
    """The tasks to run (task-file order, filtered by id) and the task file's path."""
    tasks = _tasks_module()
    target = path if path is not None else tasks.TASKS_PATH
    try:
        loaded = tasks.load_task_file(target)["tasks"]
    except tasks.TaskFileError as exc:
        raise _user_error(
            f"the task file {target} is not valid: {'; '.join(exc.problems)}",
            "fix the task file; `associate measure run` reads docs/accuracy/tasks.json by default",
        ) from exc
    shown = str(Path(target).resolve())
    if not only:
        return loaded, shown
    known = {task["id"] for task in loaded}
    unknown = sorted(set(only) - known)
    if unknown:
        raise _user_error(
            f"--tasks-filter names a task not in {target}: {', '.join(unknown)}",
            "known ids: " + ", ".join(sorted(known)),
        )
    return [task for task in loaded if task["id"] in set(only)], shown


# ------------------------------------------------------------------ checkouts


def main_checkout(path: Path) -> Path:
    """The main checkout of the repository *path* belongs to (a worktree resolves to it)."""
    path = Path(path)
    done = _git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    common = Path(done.stdout.strip()) if done.returncode == 0 and done.stdout.strip() else None
    if common is not None and common.name == ".git":
        return common.parent
    return path.resolve()


def parse_checkout_flags(values: list[str]) -> dict[str, Path]:
    """``--checkout-of NAME=PATH`` flags as a mapping; a bad flag is a user error."""
    mapping: dict[str, Path] = {}
    for value in values:
        name, sep, raw = value.partition("=")
        if not sep or not name.strip() or not raw.strip():
            raise _user_error(
                f"--checkout-of must be NAME=PATH, not {value!r}",
                "for example --checkout-of workledger-cli=/path/to/workledger-cli",
            )
        path = Path(raw).expanduser()
        if not path.is_dir():
            raise _user_error(
                f"--checkout-of {name}: {path} is not a directory",
                "give the path of a local checkout holding the task's pinned commit",
            )
        if name in mapping:
            raise _user_error(f"--checkout-of names {name} twice", "give each repository once")
        mapping[name] = path.resolve()
    return mapping


def resolve_checkouts(
    names: list[str], explicit: dict[str, Path], this_repo: Path, beside: Path
) -> tuple[dict[str, Path], list[str]]:
    """The checkout of each named repository, and the names that have none.

    An explicit mapping wins. Otherwise ``associate`` is this repository and any
    other name is the directory of that name inside ``beside`` when it exists.
    """
    found = dict(explicit)
    missing = []
    for name in names:
        if name in found:
            continue
        if name == "associate":
            found[name] = this_repo
        elif (beside / name).is_dir():
            found[name] = beside / name
        else:
            missing.append(name)
    return found, missing


# ------------------------------------------------------------- the difference note


def note_problem(note: Path) -> str | None:
    """Why *note* is not a committed, unmodified file, or None when it is."""
    if not note.is_file():
        return "the file does not exist"
    try:
        tracked = _git(note.parent, "ls-files", "--error-unmatch", "--", note.name)
        if tracked.returncode != 0:
            return "the file is not tracked by git (it is not in a git repository, or not added)"
        status = _git(note.parent, "status", "--porcelain", "--", note.name)
    except OSError as exc:
        return f"git could not be run: {exc}"
    if status.returncode != 0 or status.stdout.strip():
        return "the file has changes that are not committed"
    return None


def require_note(note: Path) -> None:
    problem = note_problem(note)
    if problem is not None:
        raise _user_error(
            f"no committed difference note at {note}: {problem}",
            f"write {note.name} stating the difference between two arms that will be called "
            f"a change, commit it at {note}, and leave it unmodified; "
            "a stub comparison (--harness stub) is plumbing only and needs no note",
        )


# ------------------------------------------------------- lock, manifest, counts


def lock_held(results: Path) -> bool:
    """Whether a runner holds the lock on *results*. Reads only; never creates the file.

    The look takes a shared lock for a moment. A runner starting at that moment
    is not refused by it: it keeps trying for ``runner.LOCK_WAIT_S`` seconds.
    """
    try:
        fd = os.open(results / _runner().LOCK_FILE, os.O_RDONLY)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    except OSError:
        return False
    finally:
        os.close(fd)
    return False


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _lock_refusal(results: Path) -> CliError:
    return _user_error(
        f"another runner holds the lock on {results}; one runner per output directory",
        f"wait for it (`associate measure status {results}`), stop it, or use another "
        "--output-dir",
    )


def _bounded_repeats(count: int, where: str) -> int:
    """*count* when it is at most MAX_REPEATS; a user error naming *where* it came from."""
    if count > MAX_REPEATS:
        raise _user_error(
            f"{where} asks for {count} repeats; the most one comparison may have is "
            f"{MAX_REPEATS}",
            _REPEATS_HINT,
        )
    return count


def _expected_keys(manifest: dict[str, Any]) -> list[tuple[str, str, int]]:
    count = _bounded_repeats(int(manifest[_K_REPEATS]), f"the manifest ({MANIFEST_FILE})")
    repeats = range(1, min(count, MAX_REPEATS) + 1)
    return [(t, a, r) for r, t, a in product(repeats, manifest[_K_TASKS], manifest[_K_ARMS])]


def stored_counts(results: Path, manifest: dict[str, Any]) -> dict[str, int]:
    """How many expected runs are stored as finished, stored as failed launches, not stored."""
    counts = {_K_FINISHED: 0, _K_FAILED: 0, _K_NOT_STORED: 0}
    for task_id, arm, repeat in _expected_keys(manifest):
        record = _read_json(_runner().record_path(results, task_id, arm, repeat))
        status = record.get("status") if isinstance(record, dict) else None
        counts[status if status in (_K_FINISHED, _K_FAILED) else _K_NOT_STORED] += 1
    return counts


def load_manifest(results: Path) -> dict[str, Any]:
    manifest = _read_json(results / MANIFEST_FILE)
    if not isinstance(manifest, dict) or _K_REPEATS not in manifest:
        raise _user_error(
            f"no manifest in {results}: `associate measure run` writes {MANIFEST_FILE} "
            "when it starts",
            _STATUS_HINT,
        )
    return manifest


def _manifest(
    args: argparse.Namespace, ids: list[str], arms: list[Arm], tasks_path: str, missing: list[str]
) -> dict[str, Any]:
    return {
        "format": MANIFEST_FORMAT,
        _K_TASKS: ids,
        _K_ARMS: [arm.name for arm in arms],
        _K_REPEATS: args.repeats,
        _K_EXPECTED: len(ids) * len(arms) * args.repeats,
        "harness": args.harness,
        _K_BROAD: bool(args.broad),
        _K_PLUMBING: args.harness == STUB,
        "timeout_s": args.timeout,
        "tasks_file": tasks_path,
        "arms_file": str(Path(args.arms).resolve()),
        _K_LOG: args.log_file,
        _K_PID: None,
        "started_at": time.time(),
        _K_MISSING: missing,
    }


# ----------------------------------------------------------------------- run


def _start_up_text(manifest: dict[str, Any], results: Path) -> list[str]:
    lines = [
        f"measure run: {len(manifest[_K_TASKS])} tasks x {len(manifest[_K_ARMS])} arms x "
        f"{manifest[_K_REPEATS]} repeats = {manifest[_K_EXPECTED]} runs; results in {results}"
    ]
    if manifest[_K_PLUMBING]:
        lines.append(PLUMBING_LINE)
    if manifest[_K_MISSING]:
        lines.append(
            f"No local checkout for: {', '.join(manifest[_K_MISSING])}. Their runs will be "
            "stored as failed launches (no local checkout); give --checkout-of NAME=PATH "
            "to run them."
        )
    return lines


def _summary_payload(
    manifest: dict[str, Any], results: Path, counts: dict[str, int]
) -> dict[str, Any]:
    return {
        _K_RESULTS: str(results),
        _K_EXPECTED: manifest[_K_EXPECTED],
        "stored": {_K_FINISHED: counts[_K_FINISHED], _K_FAILED: counts[_K_FAILED]},
        _K_NOT_STORED: counts[_K_NOT_STORED],
        _K_PLUMBING: manifest[_K_PLUMBING],
        _K_MISSING: manifest[_K_MISSING],
        "detached": False,
        _K_LOG: manifest[_K_LOG],
    }


def _summary_text(payload: dict[str, Any]) -> str:
    lines = []
    if payload[_K_PLUMBING]:
        lines.append(PLUMBING_LINE)
    stored = payload["stored"]
    lines += [
        f"results: {payload[_K_RESULTS]}",
        f"expected runs: {payload[_K_EXPECTED]}",
        f"stored as finished: {stored[_K_FINISHED]}",
        f"stored as failed launches: {stored[_K_FAILED]}",
        f"not yet stored: {payload[_K_NOT_STORED]}",
        f"next: associate measure report {payload[_K_RESULTS]}",
    ]
    return "\n".join(lines)


def _child_argv(args: argparse.Namespace, results: Path, log: Path) -> list[str]:
    argv = [sys.executable, "-m", "associate", "measure", "run"]
    argv += ["--arms", str(Path(args.arms).resolve()), _FLAG_REPEATS, str(args.repeats)]
    argv += ["--output-dir", str(results), "--timeout", repr(args.timeout)]
    argv += ["--harness", args.harness, "--log-file", str(log)]
    argv += [_FLAG_BROAD] if args.broad else []
    for flag, value in (
        ("--tasks", args.tasks),
        ("--difference-note", args.difference_note),
        ("--harness-repo", args.harness_repo),
    ):
        if value:
            argv += [flag, str(Path(value).resolve())]
    for task_id in args.tasks_filter or []:
        argv += ["--tasks-filter", task_id]
    for flag in args.checkout_of or []:
        argv += ["--checkout-of", flag]
    return argv


def _spawn(argv: list[str], log: Path) -> Popen:
    """Start *argv* in its own session, stdin closed, stdout and stderr appended to *log*."""
    try:
        with open(log, "ab") as handle:  # the child inherits the descriptor
            return Popen(  # nosec B603 - fixed argv, no shell
                argv,
                stdin=subprocess.DEVNULL,
                stdout=handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
    except OSError as exc:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=f"cannot start the background comparison: {exc}",
            remediation="run it in the foreground (without --detach) to see the error",
        ) from exc


def _detach_text(payload: dict[str, Any]) -> str:
    lines = [f"Started in the background: process id {payload[_K_PID]}."]
    if payload[_K_PLUMBING]:
        lines.append(PLUMBING_LINE)
    if payload[_K_MISSING]:
        lines.append(
            f"No local checkout for: {', '.join(payload[_K_MISSING])} (stored as failed launches)."
        )
    lines += [
        f"results: {payload[_K_RESULTS]}",
        f"log: {payload[_K_LOG]}",
        f"follow it with: {payload['status_command']}",
    ]
    return "\n".join(lines)


def _detach(args: argparse.Namespace, results: Path, manifest: dict[str, Any]) -> int:
    log = results / LOG_FILE
    manifest[_K_LOG] = str(log)
    _write_atomic(results / MANIFEST_FILE, manifest)
    proc = _spawn(_child_argv(args, results, log), log)
    payload = {
        "detached": True,
        _K_PID: proc.pid,
        _K_RESULTS: str(results),
        _K_LOG: str(log),
        _K_EXPECTED: manifest[_K_EXPECTED],
        _K_PLUMBING: manifest[_K_PLUMBING],
        _K_MISSING: manifest[_K_MISSING],
        "status_command": f"associate measure status {results}",
    }
    emit_result(payload if _json_mode(args) else _detach_text(payload), json_mode=_json_mode(args))
    return 0


def _foreground(args: argparse.Namespace, results: Path, ctx: dict[str, Any]) -> int:
    manifest = ctx["manifest"]
    manifest[_K_PID] = os.getpid()
    _write_atomic(results / MANIFEST_FILE, manifest)
    for line in _start_up_text(manifest, results):
        emit_diagnostic(line)
    try:
        run_comparison(
            ctx[_K_ARMS],
            ctx[_K_TASKS],
            args.repeats,
            results,
            ctx["checkouts"],
            harness_repo=args.harness_repo,
            options=_runner().RunOptions(timeout_s=args.timeout, harness=args.harness),
            progress=emit_diagnostic,
        )
    except _runner().RunnerError as exc:
        raise _user_error(str(exc), f"see `associate measure status {results}`") from exc
    payload = _summary_payload(manifest, results, stored_counts(results, manifest))
    emit_result(payload if _json_mode(args) else _summary_text(payload), json_mode=_json_mode(args))
    return 0


def _plan(args: argparse.Namespace) -> tuple[Path, dict[str, Any]]:
    """Check everything that can be checked before anything starts."""
    if not isinstance(args.repeats, int) or args.repeats < 1:
        raise _user_error("--repeats must be a positive whole number", _POSITIVE_HINT)
    _bounded_repeats(args.repeats, _FLAG_REPEATS)
    _positive_seconds(args.timeout)
    arms = load_arms(Path(args.arms))
    only = args.tasks_filter or []
    tasks_file = Path(args.tasks) if args.tasks else None
    note = Path(args.difference_note) if args.difference_note else None
    if args.broad:
        tasks, tasks_path = _broad_verbs().load_tasks(tasks_file, only)
        if args.harness != STUB:
            _broad_verbs().require_rule(note or _broad_verbs().BROAD_NOTE)
    else:
        tasks, tasks_path = load_tasks(tasks_file, only)
        if args.harness != STUB:
            require_note(note or DIFFERENCE_NOTE)
    primary = main_checkout(REPO_ROOT)
    names = list(dict.fromkeys(t["repository"]["name"] for t in tasks))
    checkouts, missing = resolve_checkouts(
        names, parse_checkout_flags(args.checkout_of or []), primary, primary.parent
    )
    results = Path(args.output_dir).resolve()
    if lock_held(results):
        raise _lock_refusal(results)
    manifest = _manifest(args, [t["id"] for t in tasks], arms, tasks_path, missing)
    return results, {
        "manifest": manifest,
        _K_ARMS: arms,
        _K_TASKS: tasks,
        "checkouts": checkouts,
    }


def cmd_run(args: argparse.Namespace) -> int:
    results, ctx = _plan(args)
    if args.detach:
        return _detach(args, results, ctx["manifest"])
    return _foreground(args, results, ctx)


# -------------------------------------------------------------------- status


def _lock_report(results: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    if not lock_held(results):
        return {"held": False, _K_PID: None, "alive": None}
    pid = manifest.get(_K_PID)
    if not isinstance(pid, int):
        return {"held": True, _K_PID: None, "alive": None}
    return {"held": True, _K_PID: pid, "alive": _pid_alive(pid)}


def _lock_text(lock: dict[str, Any]) -> str:
    if not lock["held"]:
        return "no runner holds the lock"
    if lock[_K_PID] is None:
        return "a runner holds the lock (its process id is not recorded yet)"
    state = "is alive" if lock["alive"] else "is not alive; the runner died, run it again to resume"
    return f"a runner holds the lock; process {lock[_K_PID]} {state}"


def _status_text(payload: dict[str, Any]) -> str:
    lines = [f"comparison in {payload[_K_RESULTS]}"]
    if payload[_K_PLUMBING]:
        lines.append(PLUMBING_LINE)
    stored = payload[_K_FINISHED] + payload[_K_FAILED]
    lines += [
        f"stored: {stored} of {payload[_K_EXPECTED]} expected runs",
        f"  finished: {payload[_K_FINISHED]}",
        f"  failed launches: {payload[_K_FAILED]}",
        f"  not yet stored: {payload[_K_NOT_STORED]}",
        _lock_text(payload["lock"]),
        f"log: {payload[_K_LOG] or 'none (the comparison was started in the foreground)'}",
    ]
    return "\n".join(lines)


def cmd_status(args: argparse.Namespace) -> int:
    results = Path(args.output_dir).resolve()
    manifest = load_manifest(results)
    counts = stored_counts(results, manifest)
    payload = {
        _K_RESULTS: str(results),
        _K_EXPECTED: manifest[_K_EXPECTED],
        _K_FINISHED: counts[_K_FINISHED],
        _K_FAILED: counts[_K_FAILED],
        _K_NOT_STORED: counts[_K_NOT_STORED],
        "lock": _lock_report(results, manifest),
        _K_LOG: manifest.get(_K_LOG),
        _K_PLUMBING: bool(manifest.get(_K_PLUMBING)),
    }
    emit_result(payload if _json_mode(args) else _status_text(payload), json_mode=_json_mode(args))
    return 0


# ------------------------------------------------------------ report and sample


def _stored_records(results: Path) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    try:
        records = _runner().load_records(results)
    except (OSError, ValueError) as exc:
        raise _user_error(
            f"cannot read the stored results in {results}: {exc}",
            "pass the --output-dir of a comparison",
        ) from exc
    if not records:
        raise _user_error(
            f"no stored results in {results}",
            "pass the --output-dir of a comparison that has stored at least one run",
        )
    manifest = _read_json(results / MANIFEST_FILE)
    return records, manifest if isinstance(manifest, dict) else None


def _known_tasks(manifest: dict[str, Any] | None) -> dict[str, Any] | None:
    path = (manifest or {}).get("tasks_file")
    if not path:
        return None
    tasks = _tasks_module()
    try:
        return {task["id"]: task for task in tasks.load_task_file(path)["tasks"]}
    except tasks.TaskFileError:
        return None


def _counter_dict(cell: Counter) -> dict[str, int]:
    return {name: int(cell[key]) for key, name in _COLUMN_NAMES.items()}


def _report_payload(
    records: list[dict[str, Any]], manifest: dict[str, Any] | None, reading: str
) -> dict[str, Any]:
    arms = {}
    for arm, cells in sorted(_report().count_runs(records, reading).items()):
        arms[arm] = {
            "tasks": {task: _counter_dict(cell) for task, cell in sorted(cells.items())},
            "total": _counter_dict(sum(cells.values(), Counter())),
        }
    return {
        _K_READING: reading,
        "note": _report().INTERNAL_LINE,
        _K_PLUMBING: bool((manifest or {}).get(_K_PLUMBING)),
        _K_ARMS: arms,
        "readings_differences": _report().readings_differences(records),
        "counts_of_stored_runs": _report().success_numbers(records, _known_tasks(manifest)),
    }


def _differences_text(differences: dict[str, int]) -> str:
    lines = ["Runs whose verdict differs between the two readings"]
    lines += [f"  {arm}: {count}" for arm, count in differences.items()]
    return "\n".join(lines)


def _report_text(records: list[dict[str, Any]], payload: dict[str, Any], reading: str) -> str:
    parts = [
        _report().render_table(records, reading).rstrip("\n"),
        _report().render_success_numbers(payload["counts_of_stored_runs"]).rstrip("\n"),
        _differences_text(payload["readings_differences"]),
    ]
    if payload[_K_PLUMBING]:
        parts.append(PLUMBING_LINE)
    return "\n\n".join(parts)


def cmd_report(args: argparse.Namespace) -> int:
    records, manifest = _stored_records(Path(args.output_dir).resolve())
    if _broad_verbs().is_broad_comparison(records, manifest):
        return _broad_verbs().cmd_report(args, records, manifest)
    payload = _report_payload(records, manifest, args.reading)
    json_mode = _json_mode(args)
    emit_result(
        payload if json_mode else _report_text(records, payload, args.reading),
        json_mode=json_mode,
    )
    return 0


def _sample_payload(sample: Any, sheet: Path, manifest: dict[str, Any] | None) -> dict[str, Any]:
    return {
        _K_SHEET: str(sheet),
        "seed": sample.seed,
        "size": sample.size,
        _K_READING: sample.reading,
        "drawn": len(sample.runs),
        "short": sample.short,
        "message": sample.message,
        _K_PLUMBING: bool((manifest or {}).get(_K_PLUMBING)),
    }


def _sample_text(payload: dict[str, Any]) -> str:
    lines = [
        payload["message"],
        f"sheet: {payload[_K_SHEET]}",
        "fill in hand_grade for each entry.",
    ]
    if payload[_K_PLUMBING]:
        lines.insert(1, PLUMBING_LINE)
    return "\n".join(lines)


def cmd_sample(args: argparse.Namespace) -> int:
    results = Path(args.output_dir).resolve()
    records, manifest = _stored_records(results)
    sheet = Path(args.sheet) if args.sheet else results / DEFAULT_SHEET
    if args.size < 1:
        raise _user_error("--size must be a positive whole number", _POSITIVE_HINT)
    if sheet.exists() and not args.overwrite:
        raise _user_error(
            f"{sheet} already exists and may hold hand grades",
            "pass --overwrite to replace it, or name another --sheet",
        )
    sample = _report().draw_sample(records, args.seed, args.size, args.reading)
    if not sample.runs:
        raise _user_error(
            f"no graded runs to sample in {results}", "wait for runs to finish, then draw again"
        )
    _report().write_blank_sheet(sample, sheet)
    payload = _sample_payload(sample, sheet, manifest)
    json_mode = _json_mode(args)
    emit_result(payload if json_mode else _sample_text(payload), json_mode=json_mode)
    return 0


# ------------------------------------------------------------------- agreement

AGREEMENT_MIN_HAND_GRADED = 48
AGREEMENT_MIN_PERCENT = 95
_K_SEED = "seed"
_K_AGREED = "agreed"
_K_HAND_GRADED = "hand_graded"
_K_REQUIRED = "required"
_K_MET = "met"


def _sheet_refusal(sheet: Path, why: str) -> CliError:
    return _user_error(
        f"the hand-grading sheet {sheet} {why}",
        "pass the sheet written by `associate measure sample`, with hand_grade filled in",
    )


def _sheet_entry_key(entry: Any) -> tuple[str, str, int] | None:
    if not isinstance(entry, dict) or not isinstance(entry.get("repeat"), int):
        return None
    return (str(entry.get("task")), str(entry.get("arm")), entry["repeat"])


def _load_sheet(sheet: Path) -> tuple[int, str, list[tuple[str, str, int]]]:
    """The sheet's seed, reading and entry keys; a CliError when it is not a usable sheet."""
    try:
        doc = json.loads(sheet.read_text(encoding=_UTF8))
    except (OSError, ValueError) as exc:
        raise _sheet_refusal(sheet, f"cannot be read as JSON: {exc}") from exc
    entries = doc.get("entries") if isinstance(doc, dict) else None
    seed = doc.get(_K_SEED) if isinstance(doc, dict) else None
    reading = doc.get(_K_READING) if isinstance(doc, dict) else None
    if not isinstance(entries, list) or not entries:
        raise _sheet_refusal(sheet, "has no entries")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise _sheet_refusal(sheet, "has no whole-number seed")
    if reading not in (READING_ANSWER, READING_WITH_HANDBACK):
        raise _sheet_refusal(sheet, "has no known reading")
    keys = [_sheet_entry_key(entry) for entry in entries]
    if any(key is None for key in keys):
        raise _sheet_refusal(sheet, "has an entry without task, arm and a whole-number repeat")
    return seed, reading, [key for key in keys if key is not None]


def _redraw(records: list[dict[str, Any]], sheet: Path) -> Any:
    seed, reading, keys = _load_sheet(sheet)
    sample = _report().draw_sample(records, seed, len(keys), reading)
    if sorted(run.key for run in sample.runs) != sorted(keys):
        raise _user_error(
            f"the stored results changed since {sheet} was drawn: redrawing with seed {seed} "
            "gives different runs",
            "grade against the results the sheet was drawn from, or draw a new sheet with "
            "`associate measure sample`",
        )
    return sample


def _share_percent_floor(agreed: int, graded: int) -> str:
    """The share as a percentage with one decimal, cut down and never rounded up."""
    tenths = agreed * 1000 // graded
    return f"{tenths // 10}.{tenths % 10}%"


def _conditions(found: Any) -> dict[str, dict[str, Any]]:
    met_share = found.agreed * 100 >= AGREEMENT_MIN_PERCENT * found.hand_graded
    return {
        "enough_hand_graded": {
            _K_REQUIRED: AGREEMENT_MIN_HAND_GRADED,
            "actual": found.hand_graded,
            _K_MET: found.hand_graded >= AGREEMENT_MIN_HAND_GRADED,
        },
        "enough_agreement": {
            "required_percent": AGREEMENT_MIN_PERCENT,
            _K_AGREED: found.agreed,
            _K_HAND_GRADED: found.hand_graded,
            "share": found.share,
            _K_MET: bool(found.hand_graded) and met_share,
        },
    }


def _agreement_payload(found: Any, sample: Any, sheet: Path) -> dict[str, Any]:
    return {
        _K_SHEET: str(sheet),
        _K_SEED: sample.seed,
        _K_READING: sample.reading,
        "sampled": found.sampled,
        _K_HAND_GRADED: found.hand_graded,
        _K_AGREED: found.agreed,
        "disagreed": found.disagreed,
        "missing": [list(key) for key in found.missing],
        "invalid": [list(key) for key in found.invalid],
        "extra": [list(key) for key in found.extra],
        "disagreements": [list(key) for key in found.disagreements],
        "share": found.share,
        "conditions": _conditions(found),
        "note": _report().INTERNAL_LINE,
    }


def _met_word(met: bool) -> str:
    return _K_MET if met else "not met"


def _condition_lines(conditions: dict[str, dict[str, Any]]) -> list[str]:
    count = conditions["enough_hand_graded"]
    share = conditions["enough_agreement"]
    graded = share[_K_HAND_GRADED]
    state = _met_word(count[_K_MET])
    lines = [f"at least {count[_K_REQUIRED]} hand-graded runs: {state} ({count['actual']})"]
    state = _met_word(share[_K_MET])
    seen = f"{share[_K_AGREED]} of {graded}"
    if graded:
        seen += f", {_share_percent_floor(share[_K_AGREED], graded)}"
    lines.append(f"agreement on at least {share['required_percent']}%: {state} ({seen})")
    return lines


def _agreement_text(found: Any, payload: dict[str, Any]) -> str:
    text = _report().render_agreement(found).rstrip("\n")
    return "\n".join([text, "", *_condition_lines(payload["conditions"])])


def cmd_agreement(args: argparse.Namespace) -> int:
    results = Path(args.output_dir).resolve()
    records, _manifest_unused = _stored_records(results)
    sheet = Path(args.sheet)
    sample = _redraw(records, sheet)
    found = _report().compare_hand_grades(sample, sheet)
    payload = _agreement_payload(found, sample, sheet)
    json_mode = _json_mode(args)
    emit_result(payload if json_mode else _agreement_text(found, payload), json_mode=json_mode)
    return 0


# ------------------------------------------------------------ overview, parser

_VERBS = [
    "measure run — run a comparison: --arms, --tasks, --repeats, --output-dir; --detach for "
    "the background; refuses without the committed difference note except on the stub harness",
    "measure status <output-dir> — runs stored, failed and not yet stored; the lock; the log",
    "measure report <output-dir> — the table of stored results (--reading, --json)",
    "measure sample <output-dir> — the blank hand-grading sheet for a fixed-seed draw",
    "measure agreement <output-dir> --sheet PATH — a filled sheet against the grader; the 48 "
    "hand-graded runs and 95% agreement conditions, met or not met",
    "measure overview — describe these verbs",
]
_RUN_BROAD = (
    "measure run --broad — the broad tasks (docs/accuracy/broad-tasks.json): each run stores "
    "its whole answer and a first marking of the checklist facts; a real run needs the "
    "committed, confirmed rule file docs/accuracy/broad-difference-threshold.md"
)


def cmd_overview(args: argparse.Namespace) -> int:
    emit_overview(
        "associate measure",
        [
            {
                "title": "Verbs",
                "items": [
                    *_VERBS[:1],
                    _RUN_BROAD,
                    *_VERBS[1:-1],
                    *_broad_verbs().VERBS,
                    _VERBS[-1],
                ],
            }
        ],
        json_mode=_json_mode(args),
    )
    return 0


def _add_json(p: argparse.ArgumentParser) -> None:
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")


def _register_run(noun_sub: Any) -> None:
    p = noun_sub.add_parser(
        "run",
        help="Run a comparison of arms over tasks and store one graded result per run.",
        description=(
            "Run every task for every arm and repeat and store one graded result per key. "
            "Without --detach it runs in the foreground; with --detach it starts in the "
            "background and returns at once. It refuses to start unless a note stating the "
            "difference that will be called a change is committed "
            "(docs/accuracy/difference-threshold.md), except with --harness stub: a stub "
            "comparison is plumbing only and is labelled so in its output."
        ),
    )
    p.add_argument("--arms", required=True, help="JSON list of arms (see the explain page).")
    p.add_argument(
        "--tasks",
        help="Task file (default docs/accuracy/tasks.json; with --broad, "
        "docs/accuracy/broad-tasks.json).",
    )
    p.add_argument(
        _FLAG_BROAD,
        action="store_true",
        help="Run the broad tasks: each run stores its whole answer and a first marking of "
        "the task's checklist facts. A real run needs the committed, confirmed rule file "
        "docs/accuracy/broad-difference-threshold.md.",
    )
    p.add_argument(_FLAG_REPEATS, type=int, default=1, help="Repeats per task and arm (default 1).")
    p.add_argument("--output-dir", required=True, help="Where results, manifest and log go.")
    p.add_argument("--tasks-filter", action="append", metavar="ID", help="Run only this task id.")
    p.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help="Seconds one run may take (default 3600); there is no unlimited value.",
    )
    p.add_argument(
        "--checkout-of",
        action="append",
        metavar="NAME=PATH",
        help="Local checkout of a task repository; others default to a directory of that "
        "name beside this repository's main checkout. A repository with no checkout "
        "is stored as failed launches.",
    )
    p.add_argument("--detach", action="store_true", help="Run in the background.")
    p.add_argument("--harness", default="pi", help="Harness adapter (default pi; stub: plumbing).")
    p.add_argument("--difference-note", help="The committed note (default the repository's).")
    p.add_argument("--harness-repo", help="Repository holding the arms' harness commits.")
    p.add_argument("--log-file", help=argparse.SUPPRESS)
    _add_json(p)
    p.set_defaults(func=cmd_run)


def _add_output_dir(p: argparse.ArgumentParser) -> None:
    p.add_argument("output_dir", help="The comparison's output directory.")


def _register_reading(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--reading",
        choices=(READING_ANSWER, READING_WITH_HANDBACK),
        default=READING_ANSWER,
        help="Which grade reading to count (default answer_text).",
    )


def _register_read_verbs(noun_sub: Any) -> None:
    st = noun_sub.add_parser("status", help="Read-only: runs stored, failed and not yet stored.")
    _add_output_dir(st)
    _add_json(st)
    st.set_defaults(func=cmd_status)
    rp = noun_sub.add_parser(
        "report",
        help="Print the table of the stored results; for a broad comparison, the counts per run.",
        description=(
            "Print the table of the stored results. For a broad comparison it prints, per "
            "run and grouped by repository and arm, the checklist facts marked as stated (a "
            "first marking) and, once every run on the grading sheet is graded, the "
            "statements counted false. It refuses to join a sheet that is not fully graded. "
            "--sheet, --key, --clone-root and --difference-note apply to a broad comparison "
            "only."
        ),
    )
    _add_output_dir(rp)
    _register_reading(rp)
    _broad_verbs().add_sheet_paths(rp)
    _broad_verbs().add_clone_root(rp)
    rp.add_argument("--difference-note", help="The broad rule file (default the repository's).")
    _add_json(rp)
    rp.set_defaults(func=cmd_report)
    sp = noun_sub.add_parser("sample", help="Write the blank hand-grading sheet.")
    _add_output_dir(sp)
    sp.add_argument("--sheet", help=f"Sheet path (default <output-dir>/{DEFAULT_SHEET}).")
    sp.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Draw seed (default 1).")
    sp.add_argument("--size", type=int, default=SAMPLE_SIZE, help="Runs to draw (48).")
    sp.add_argument("--overwrite", action="store_true", help="Replace an existing sheet.")
    _register_reading(sp)
    _add_json(sp)
    sp.set_defaults(func=cmd_sample)
    ag = noun_sub.add_parser("agreement", help="Read a filled sheet back; compare with the grader.")
    _add_output_dir(ag)
    ag.add_argument("--sheet", required=True, help="The hand-graded sheet to read (never written).")
    _add_json(ag)
    ag.set_defaults(func=cmd_agreement)


def _no_verb(args: argparse.Namespace) -> int:
    return cmd_overview(args)


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "measure",
        help="Run, follow, report and sample a comparison of arms (see 'measure overview').",
    )
    _add_json(p)
    p.set_defaults(func=_no_verb, json=False)
    # Propagate the structured-error parser class, as `associate cli` does.
    noun_sub = p.add_subparsers(dest="measure_command", parser_class=type(p))
    ov = noun_sub.add_parser("overview", help="Describe the measure verbs.")
    _add_json(ov)
    ov.set_defaults(func=cmd_overview)
    _register_run(noun_sub)
    _register_read_verbs(noun_sub)
    _broad_verbs().register(noun_sub)
