"""The comparison runner: arms by tasks by repeats, resumable (plan task t9).

An :class:`Arm` names a harness commit, a model, a check mode and a reasoning
setting. :func:`run_comparison` runs every task for every arm and repeat, in
the order repeat, then task, then arm (so the arms of one task and repeat run
next to each other), and stores one result file per (task, arm, repeat).

One run
-------
1. A fresh filtered clone of the task's repository at its pinned commit
   (:func:`associate.measure.clone.make_clone`, from the local checkout the
   caller maps the repository's name to), without the excluded paths
   (default ``docs/accuracy``, the answer key).
2. A new, empty memory directory and ledger file for the run
   (:func:`associate.measure.isolation.isolate_run`).
3. ``<python> -m associate run ... --json`` started with its working directory
   in a worktree of the arm's harness commit, ``PYTHONPATH`` set to that
   worktree and ``ASSOCIATE_EXTENSION_PATH`` to its
   ``.pi/extensions/associate/index.ts``, so the Python package and the Pi
   extension both come from the arm's commit. The rest of the environment is
   the runner's own, passed through unread: the runner never reads, stores or
   prints a key, and no stored file holds an environment value.
4. The launcher waits for ``timeout_s`` (passed as ``--timeout``) plus
   ``grace_s``; past that the run is killed and stored as a failed launch.
5. One result file: task, arm, repeat, model, reasoning, harness commit, clone
   HEAD, outcome, contamination (:mod:`associate.measure.contamination`), the
   model's answer text (:mod:`associate.measure.answer`), the grade and, where
   the export has facts, the re-check counts.

The harness worktree
--------------------
One per harness commit, detached, at
``<dirname(repo)>/.worktrees.<repo name>/measure-harness-<12 hex>`` where repo
is the main checkout of ``harness_repo`` (never inside it, never a shared
``../worktrees/``). It is created on first use and reused; the runner never
removes a worktree. A worktree whose tracked files or contract directory
differ from its commit is refused, and a run after which the contract
directory (``associate/contract``) differs stops the comparison once its
result is stored: no contract file is edited between runs.

What the arm's commit accepts
-----------------------------
The command line is built per harness commit from that commit's own
``associate run --help``. ``--reasoning``, ``--check-mode`` and
``--untrusted-checkout`` are passed only when the commit has them; the
reasoning in effect is otherwise the registry's value at that commit, read
from its ``associate/contract/models.json``. Every stored run lists under
``settings`` what was requested, what was applied and how, and in
``settings.not_applied`` each requested setting the commit could not honour
(reasoning, check mode, the untrusted-checkout flag, and the pi version the
commit pins when the pi on PATH is another). The commit before PR #27 has no
``--reasoning`` and no ``--check-mode``, writes no hand-back, and pins pi
1.1.0.

How a run ends
--------------
``status`` is ``finished`` (graded) or ``launch_failed`` (not graded, ``grade``
null, ``reason`` saying why: no local checkout, the pinned commit missing, a
clone that failed, a harness tree that could not be prepared, a process that
could not start or passed the wall clock, no result on stdout, or a result
naming an export directory outside the run's own export root).

A run that printed a result object is ``finished`` whatever its exit code
(0, 3 for a refused hand-back, 4 for a timeout). A harness that prints no
result when the task turn times out (the commit before PR #27: exit 2, the
error ``pi did not finish within <timeout>s`` on stderr) is stored as
``finished`` with ``outcome: timeout``, ``result_source: none`` and the reason,
graded from whatever its export holds. Any other run without a result is a
failed launch.

Two readings of the grade
-------------------------
``grades`` holds labelled readings and ``grade`` is the first:

* ``answer_text``: ``evidence.answer.grade`` of the model's own answer text
  from :mod:`associate.measure.answer`, unchanged;
* ``answer_text_plus_handback_values``: the same text followed by the values
  of the facts and the texts of the verdicts the model wrote in its hand-back
  (the export's ``facts.json``, the model's own strings, no harness line).
  Stored only when the export has a ``facts.json``, so never for a harness
  without a hand-back.

Results directory
-----------------
::

    <results>/records/<task>/<arm>/r<repeat>.json    the stored result, one per key
    <results>/work/<task>/<arm>/r<repeat>/a<n>/      attempt n of that key:
        clones/  export-root/  memory/  ledger/      the run's clone, export, stores
        plan.json                                    what is launched (written before)
        launch.json                                  exit code, stdout, stderr, times
    <results>/.runner.lock                           held while a runner works

The key for "already stored" is (task id, arm name, repeat): the file
``records/<task>/<arm>/r<repeat>.json``. Every JSON file is written atomically
(a temporary file in the same directory, flushed and synced, then renamed), so
a killed runner leaves either the whole file or none; a leftover temporary
file is never read. A stored key is never run again when its status is
``finished``. A stored failed launch is run again when ``retry_failed`` is true
(the default); the new record carries the earlier ones in ``history``, so each
key still counts once. A stored record whose arm or task (repository, commit,
prompt) differs from what the runner was given is refused, not overwritten.

Restarting after a kill: ``plan.json`` is written before the launch and
``launch.json`` after the process ends. An attempt with both but no stored
record is stored from them without a new launch, so a run that finished is
never started twice; an attempt with no ``launch.json`` was interrupted and is
listed in the next record's ``history`` as ``interrupted``. A second runner on
the same results directory is refused while the first holds the lock.

Values read back from files
---------------------------
An arm's ``harness_commit`` must be a commit id written in hexadecimal (7 to
64 characters, abbreviated or full); a branch, tag or other revision
expression is refused before git is run. A stored ``plan.json`` is checked
before it is used again: its harness directory must lie in the harness
worktrees directory, its export root in its own attempt directory, and its
session id must be a plain name. The export directory a run reports is read
only when it lies in the export root the runner gave that run.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Sequence

from evidence.answer import grade as evidence_grade

from associate.measure import answer as answer_mod
from associate.measure.clone import CloneError, make_clone
from associate.measure.contamination import check_walk, load_walk
from associate.measure.isolation import isolate_run

DEFAULT_EXCLUDED = ("docs/accuracy",)
RECORD_FORMAT = 1
STATUS_FINISHED = "finished"
STATUS_LAUNCH_FAILED = "launch_failed"
STATUS_INTERRUPTED = "interrupted"
READING_ANSWER = "answer_text"
READING_WITH_HANDBACK = "answer_text_plus_handback_values"
REASONING_CHOICES = ("model-default", "on", "off")
CHECK_MODES = ("report", "enforce")
EXTENSION_RELATIVE = Path(".pi") / "extensions" / "associate" / "index.ts"
CONTRACT_DIR = "associate/contract"
FACTS_FILE = "facts.json"
WALK_FILE = "walk.jsonl"
PLAN_FILE = "plan.json"
LAUNCH_FILE = "launch.json"
LOCK_FILE = ".runner.lock"
PROBE_TIMEOUT_S = 120.0

_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", re.ASCII)
_SAFE_SESSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}", re.ASCII)
_COMMIT_ID = re.compile(r"[\da-fA-F]{7,64}", re.ASCII)
_OPTION = re.compile(r"^\s+(?:-\w+,\s+)?(--[a-z][a-z0-9-]*)", re.ASCII | re.MULTILINE)
_PI_PIN = re.compile(r'^PINNED_PI_VERSION\s*=\s*"([^"]+)"', re.MULTILINE)
_REQUIRED_FLAGS = ("--harness", "--model", "--checkout", "--export-root", "--session-id")
_REQUIRED_FLAGS += ("--timeout", "--json")
_PACKAGE_PROBE = "import associate; print(associate.__file__)"
_FLAG_CHECK_MODE = "--check-mode"
_FLAG_UNTRUSTED = "--untrusted-checkout"
_UTF8 = "utf-8"
_REV_PARSE = "rev-parse"

_K_REASONING = "reasoning"
_K_CHECK_MODE = "check_mode"
_K_UNTRUSTED = "untrusted_checkout"
_K_PI_VERSION = "pi_version"
_K_STATUS = "status"
_K_REASON = "reason"
_K_ATTEMPT = "attempt"
_K_HISTORY = "history"
_K_EFFECTIVE = "effective"
_K_REQUESTED = "requested"
_K_SOURCE = "source"
_K_EXPORT_DIR = "export_dir"
_K_EXPORT_ROOT = "export_root"
_K_SESSION_ID = "session_id"
_K_SETTINGS = "settings"
_END_OF_OPTIONS = "--end-of-options"
_IN_PLAN = f"in {PLAN_FILE}"


class RunnerError(RuntimeError):
    """The comparison cannot go on (bad input, a held lock, a changed contract)."""


class LaunchTimeout(Exception):
    """The launched process passed the runner's wall clock and was killed."""


@dataclass(frozen=True)
class Arm:
    """One side of the comparison.

    ``reasoning`` None and ``check_mode`` None pass nothing: the harness
    commit's own registry value and check mode apply.
    """

    name: str
    harness_commit: str
    model: str
    check_mode: str | None = None
    reasoning: str | None = None


@dataclass(frozen=True)
class Launch:
    """What the launcher is asked to run."""

    argv: list[str]
    cwd: Path
    env: dict[str, str]
    timeout_s: float | None


@dataclass(frozen=True)
class Completed:
    """What the launcher hands back."""

    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class RunOptions:
    """How every run of a comparison is launched.

    ``python`` must import ``evidence`` for a current harness. ``timeout_s`` is
    passed as ``--timeout`` and the launcher waits ``grace_s`` longer.
    ``excluded`` are the paths left out of every clone. ``retry_failed`` runs a
    stored failed launch again. ``harness`` is passed as ``--harness`` (``stub``
    for plumbing).
    """

    python: str = sys.executable
    timeout_s: float = 1500.0
    grace_s: float = 600.0
    excluded: Sequence[str] = DEFAULT_EXCLUDED
    retry_failed: bool = True
    untrusted_checkout: bool = True
    harness: str = "pi"


Key = tuple[str, str, int]


@dataclass
class Summary:
    """Keys handled by one invocation, by what happened to them."""

    finished: list[Key] = field(default_factory=list)
    failed: list[Key] = field(default_factory=list)
    skipped: list[Key] = field(default_factory=list)
    recovered: list[Key] = field(default_factory=list)


@dataclass
class _Harness:
    """A harness commit prepared for launching, or the reason it is not."""

    commit: str
    worktree: Path | None = None
    flags: frozenset[str] = frozenset()
    registry_reasoning: dict[str, Any] = field(default_factory=dict)
    pi_pin: str | None = None
    error: str | None = None


@dataclass
class _Context:
    results: Path
    harness_root: Path
    checkouts: dict[str, Path]
    python: str
    timeout_s: float
    grace_s: float
    excluded: list[str]
    retry_failed: bool
    untrusted_checkout: bool
    harness: str
    launcher: Callable[[Launch], Completed]
    pi_on_path: str | None
    progress: Callable[[str], None]
    summary: Summary = field(default_factory=Summary)


class _LaunchFailed(Exception):
    def __init__(self, reason: str, partial: dict[str, Any] | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.partial = partial or {}


# --------------------------------------------------------------------- launching


def _signal_group(proc: subprocess.Popen, sig: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, sig)


def _stop(proc: subprocess.Popen) -> None:
    """SIGINT first (``associate run`` then kills its own pi), SIGKILL after 15 s."""
    _signal_group(proc, signal.SIGINT)
    try:
        proc.communicate(timeout=15)
        return
    except subprocess.TimeoutExpired:
        _signal_group(proc, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.communicate(timeout=10)


def subprocess_launcher(launch: Launch) -> Completed:
    """Run *launch* in its own process group; raise :class:`LaunchTimeout` past its clock.

    Raises ``OSError`` when the process cannot start. An interruption of the
    runner stops the process before it propagates.
    """
    proc = subprocess.Popen(  # nosec B603 - argv list, no shell
        launch.argv,
        cwd=launch.cwd,
        env=launch.env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=launch.timeout_s)
    except subprocess.TimeoutExpired:
        _stop(proc)
        raise LaunchTimeout(f"killed after {launch.timeout_s:g}s") from None
    except BaseException:
        _stop(proc)
        raise
    return Completed(proc.returncode, stdout, stderr)


def _probe_pi_version() -> str | None:
    try:
        done = subprocess.run(  # nosec B603 B607 - fixed argv, no shell
            ["pi", "--version"], capture_output=True, text=True, timeout=60, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = (done.stdout or "").strip().splitlines()
    return lines[0].strip() if done.returncode == 0 and lines else None


# --------------------------------------------------------------------- storage


def _write_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Not a ``with`` on the call: the file is closed below and then renamed.
    handle = tempfile.NamedTemporaryFile(
        "w", encoding=_UTF8, dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    )
    try:
        with handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(handle.name)
        raise
    _sync_dir(path.parent)


def _sync_dir(directory: Path) -> None:
    with contextlib.suppress(OSError):
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _store_record(path: Path, record: dict[str, Any]) -> None:
    """Store one result file atomically (the only writer of ``records/``)."""
    _write_atomic(path, record)


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding=_UTF8))
    except (OSError, ValueError) as exc:
        raise RunnerError(f"{path} cannot be read ({exc}); move it aside by hand") from exc
    if not isinstance(value, dict):
        raise RunnerError(f"{path} is not a JSON object; move it aside by hand")
    return value


def record_path(results_dir: str | Path, task_id: str, arm_name: str, repeat: int) -> Path:
    """Where the result for (task, arm, repeat) is stored."""
    return Path(results_dir) / "records" / task_id / arm_name / f"r{repeat}.json"


def _work_dir(results: Path, key: Key) -> Path:
    return results / "work" / key[0] / key[1] / f"r{key[2]}"


def load_records(results_dir: str | Path) -> list[dict[str, Any]]:
    """Every stored result, in path order. A temporary file is never read."""
    root = Path(results_dir) / "records"
    if not root.is_dir():
        return []
    paths = sorted(p for p in root.glob("*/*/r*.json") if not p.name.startswith("."))
    return [json.loads(p.read_text(encoding=_UTF8)) for p in paths]


@contextlib.contextmanager
def _locked(results: Path) -> Iterator[None]:
    results.mkdir(parents=True, exist_ok=True)
    fd = os.open(results / LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RunnerError(
                f"another runner holds the lock on {results}; one runner per results directory"
            ) from None
        yield
    finally:
        os.close(fd)


def _raise_interrupt(signum: int, _frame: Any) -> None:
    raise KeyboardInterrupt(f"signal {signum}")


@contextlib.contextmanager
def _term_as_interrupt() -> Iterator[None]:
    """SIGTERM stops the runner like Ctrl-C, so the launched run is stopped too."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous = signal.signal(signal.SIGTERM, _raise_interrupt)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


# --------------------------------------------------------------------- git


def _git(repo: Path, *args: str) -> str:
    try:
        done = subprocess.run(  # nosec B603 B607 - fixed argv, no shell
            ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
        )
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip().splitlines()
        last = detail[-1] if detail else exc
        raise RunnerError(f"git {args[0]} failed in {repo}: {last}") from exc
    except OSError as exc:
        raise RunnerError(f"cannot run git: {exc}") from exc
    return done.stdout


def _main_checkout(repo: Path) -> Path:
    """The main checkout of *repo* (a worktree resolves to the repository it belongs to)."""
    common = Path(_git(repo, _REV_PARSE, "--path-format=absolute", "--git-common-dir").strip())
    return common.parent if common.name == ".git" else Path(repo).resolve()


def is_commit_id(value: Any) -> bool:
    """Whether *value* is a commit id in hexadecimal, abbreviated (7 or more) or full."""
    return isinstance(value, str) and _COMMIT_ID.fullmatch(value) is not None


def _commit_id(value: Any) -> str:
    """*value* when it is a hexadecimal commit id; nothing else is ever passed to git."""
    if not isinstance(value, str) or _COMMIT_ID.fullmatch(value) is None:
        raise RunnerError(
            f"not a commit id: {value!r} (give 7 to 64 hexadecimal characters, not a branch, "
            "a tag or another revision expression)"
        )
    return value


def _resolve_commit(repo: Path, commit: str) -> str:
    wanted = _commit_id(commit)
    found = _git(repo, _REV_PARSE, "--verify", "--quiet", _END_OF_OPTIONS, f"{wanted}^{{commit}}")
    return _commit_id(found.strip())


def _inside(path: Path, parent: Path, what: str) -> Path:
    """*path* resolved, when it lies in *parent*; a :class:`RunnerError` naming it otherwise."""
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(Path(parent).resolve()):
        raise RunnerError(f"{what} is {resolved}, which is outside {parent}; it is not used")
    return resolved


def _harness_root(main: Path) -> Path:
    """Where the harness worktrees of the repository at *main* live (beside it, never inside)."""
    return main.parent / f".worktrees.{main.name}"


def _tree_changes(worktree: Path) -> list[str]:
    out = _git(worktree, "status", "--porcelain")
    return [line[3:] for line in out.splitlines() if line.strip()]


def _tracked_changes(worktree: Path) -> list[str]:
    out = _git(worktree, "status", "--porcelain")
    return [line[3:] for line in out.splitlines() if line.strip() and not line.startswith("??")]


def _contract_paths(paths: list[str]) -> list[str]:
    return [p for p in paths if p == CONTRACT_DIR or p.startswith(CONTRACT_DIR + "/")]


def _ensure_worktree(main: Path, full_commit: str) -> Path:
    commit = _commit_id(full_commit)
    root = _harness_root(main)
    path = root / f"measure-harness-{commit[:12]}"
    if path.exists():
        head = _git(path, _REV_PARSE, "HEAD").strip()
        if head != commit:
            raise RunnerError(f"{path} is at {head}, not {commit}; it is left as it is")
    else:
        root.mkdir(parents=True, exist_ok=True)
        _git(main, "worktree", "add", "--detach", "--", str(path), commit)
    dirty = _tracked_changes(path) + _contract_paths(_tree_changes(path))
    if dirty:
        raise RunnerError(
            f"the harness worktree {path} differs from {commit}: {sorted(set(dirty))}"
        )
    return path


# --------------------------------------------------------------------- harness setup


def _base_env(worktree: Path) -> dict[str, str]:
    return {
        **os.environ,
        "PYTHONPATH": str(worktree),
        "ASSOCIATE_EXTENSION_PATH": str(worktree / EXTENSION_RELATIVE),
    }


def _probe(ctx: _Context, worktree: Path, argv: list[str]) -> Completed:
    launch = Launch(argv, worktree, _base_env(worktree), PROBE_TIMEOUT_S)
    try:
        return ctx.launcher(launch)
    except (OSError, LaunchTimeout) as exc:
        raise RunnerError(f"probe {argv[1:]} failed: {exc}") from exc


def _check_package(ctx: _Context, worktree: Path) -> None:
    done = _probe(ctx, worktree, [ctx.python, "-c", _PACKAGE_PROBE])
    found = Path(done.stdout.strip() or ".").resolve()
    if done.returncode != 0 or not found.is_relative_to(worktree.resolve()):
        raise RunnerError(
            f"{ctx.python} does not import associate from {worktree} (got {found}); "
            "the run would not be the arm's harness"
        )
    if not (worktree / EXTENSION_RELATIVE).is_file():
        raise RunnerError(f"{worktree / EXTENSION_RELATIVE} does not exist")


def _run_flags(ctx: _Context, worktree: Path) -> frozenset[str]:
    done = _probe(ctx, worktree, [ctx.python, "-m", "associate", "run", "--help"])
    flags = frozenset(_OPTION.findall(done.stdout))
    missing = [flag for flag in _REQUIRED_FLAGS if flag not in flags]
    if done.returncode != 0 or missing:
        raise RunnerError(
            f"`associate run --help` at this commit lacks {missing or 'a usable help'}"
        )
    return flags


def _show(main: Path, commit: str, path: str) -> str:
    """The file at *path* in *commit*."""
    return _git(main, "show", _END_OF_OPTIONS, f"{_commit_id(commit)}:{path}")


def _registry_reasoning(main: Path, commit: str) -> dict[str, Any]:
    try:
        registry = json.loads(_show(main, commit, f"{CONTRACT_DIR}/models.json"))
        return {key: entry.get(_K_REASONING) for key, entry in registry["models"].items()}
    except (ValueError, KeyError, AttributeError, TypeError) as exc:
        raise RunnerError(f"models.json at {commit} cannot be read: {exc}") from exc


def _pi_pin(main: Path, commit: str) -> str | None:
    try:
        source = _show(main, commit, "associate/harness/pi.py")
    except RunnerError:
        return None
    match = _PI_PIN.search(source)
    return match.group(1) if match else None


def _prepare_harness(ctx: _Context, main: Path, commit: str) -> _Harness:
    prepared = _Harness(commit)
    try:
        prepared.worktree = _ensure_worktree(main, commit)
        _check_package(ctx, prepared.worktree)
        prepared.flags = _run_flags(ctx, prepared.worktree)
        prepared.registry_reasoning = _registry_reasoning(main, commit)
        prepared.pi_pin = _pi_pin(main, commit)
    except RunnerError as exc:
        prepared.error = f"the harness at {commit[:12]} could not be prepared: {exc}"
        ctx.progress(prepared.error)
    return prepared


# --------------------------------------------------------------------- settings


def _reasoning_setting(arm: Arm, harness: _Harness) -> tuple[list[str], dict, dict | None]:
    registry = harness.registry_reasoning.get(arm.model)
    if arm.reasoning is None:
        return [], {_K_REQUESTED: None, _K_EFFECTIVE: registry, _K_SOURCE: "registry"}, None
    if "--reasoning" in harness.flags:
        state = {_K_REQUESTED: arm.reasoning, _K_EFFECTIVE: arm.reasoning, _K_SOURCE: "run"}
        return ["--reasoning", arm.reasoning], state, None
    state = {
        _K_REQUESTED: arm.reasoning,
        _K_EFFECTIVE: registry,
        _K_SOURCE: "registry_at_harness_commit",
    }
    if registry == arm.reasoning:
        return [], state, None
    why = (
        f"`associate run` at {harness.commit[:12]} has no --reasoning; the run uses that "
        f"commit's models.json reasoning for {arm.model}"
    )
    return [], state, _not_applied(_K_REASONING, arm.reasoning, registry, why)


def _not_applied(setting: str, requested: Any, effective: Any, why: str) -> dict[str, Any]:
    return {"setting": setting, _K_REQUESTED: requested, _K_EFFECTIVE: effective, "why": why}


def _flag_setting(
    harness: _Harness, flag: str, args: list[str], setting: str, requested: Any
) -> tuple[list[str], dict | None]:
    if flag in harness.flags:
        return args, None
    why = f"`associate run` at {harness.commit[:12]} has no {flag}"
    return [], _not_applied(setting, requested, None, why)


def _optional_flags(ctx: _Context, arm: Arm) -> list[tuple]:
    """(setting, flag, flag arguments, requested value) for each optional setting asked for."""
    wanted = []
    if arm.check_mode is not None:
        wanted.append((_K_CHECK_MODE, _FLAG_CHECK_MODE, [arm.check_mode], arm.check_mode))
    if ctx.untrusted_checkout:
        wanted.append((_K_UNTRUSTED, _FLAG_UNTRUSTED, [], True))
    return wanted


def _pi_setting(ctx: _Context, harness: _Harness) -> dict | None:
    pin, found = harness.pi_pin, ctx.pi_on_path
    if not pin or not found or pin == found:
        return None
    why = f"the commit pins pi {pin}; pi {found} is on PATH"
    return _not_applied(_K_PI_VERSION, pin, found, why)


def _settings(ctx: _Context, arm: Arm, harness: _Harness) -> tuple[list[str], dict, dict]:
    """The flags for this arm's commit, and what was and was not applied."""
    args, reasoning, missed = _reasoning_setting(arm, harness)
    missing = [missed]
    applied: dict[str, Any] = {_K_REASONING: reasoning[_K_SOURCE]}
    for setting, flag, values, requested in _optional_flags(ctx, arm):
        extra, missed = _flag_setting(harness, flag, [flag, *values], setting, requested)
        args += extra
        applied[setting] = flag if extra else None
        missing.append(missed)
    missing.append(_pi_setting(ctx, harness))
    requested = {
        "model": arm.model,
        _K_REASONING: arm.reasoning,
        _K_CHECK_MODE: arm.check_mode,
        _K_UNTRUSTED: ctx.untrusted_checkout,
        "timeout_s": ctx.timeout_s,
        "harness": ctx.harness,
    }
    settings = {
        _K_REQUESTED: requested,
        "applied": applied,
        "not_applied": [item for item in missing if item],
        "pi": {"pinned_at_harness_commit": harness.pi_pin, "on_path": ctx.pi_on_path},
    }
    return args, settings, reasoning


# --------------------------------------------------------------------- one run


def _arm_identity(arm: Arm, harness: _Harness) -> dict[str, Any]:
    return {
        "name": arm.name,
        "harness_commit": harness.commit,
        "model": arm.model,
        _K_CHECK_MODE: arm.check_mode,
        _K_REASONING: arm.reasoning,
    }


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode(_UTF8)).hexdigest()


def _task_identity(task: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": task["id"],
        "repository": dict(task["repository"]),
        "commit": task["commit"],
        "prompt_sha256": _digest(task["prompt"]),
        "expected_sha256": _digest(task["expected"]),
    }


def _check_same(existing: dict, arm_id: dict, task_id: dict, path: Path) -> None:
    if existing.get("arm") != arm_id:
        raise RunnerError(
            f"{path} was stored for arm {existing.get('arm')}, not {arm_id}; use another results "
            "directory or another arm name"
        )
    stored = existing.get("task") or {}
    for name in ("repository", "commit", "prompt_sha256"):
        if stored.get(name) != task_id[name]:
            raise RunnerError(f"{path} was stored for a task whose {name} differs from this one")


def _history_entry(record: dict[str, Any]) -> dict[str, Any]:
    return {
        _K_ATTEMPT: record.get(_K_ATTEMPT),
        _K_STATUS: record.get(_K_STATUS),
        _K_REASON: record.get(_K_REASON),
        "stored_at": record.get("stored_at"),
    }


def _attempts(work: Path) -> list[int]:
    if not work.is_dir():
        return []
    found = (p.name[1:] for p in work.iterdir() if p.is_dir() and p.name.startswith("a"))
    return sorted(int(n) for n in found if n.isdigit())


def _session_id(key: Key, attempt: int) -> str:
    return f"m-{key[0]}-{key[1]}-r{key[2]}-a{attempt}"


def _make_clone(ctx: _Context, task: Mapping[str, Any], attempt_dir: Path) -> dict[str, Any]:
    repo = task["repository"]
    source = ctx.checkouts.get(repo["name"])
    slug = f"{repo['owner']}/{repo['name']}"
    if source is None:
        raise _LaunchFailed(f"no local checkout was given for repository {slug} ({repo['name']!r})")
    if not Path(source).is_dir():
        raise _LaunchFailed(f"the local checkout {source} for {slug} is not a directory")
    try:
        made = make_clone(source, task["commit"], ctx.excluded, attempt_dir / "clones")
    except CloneError as exc:
        raise _LaunchFailed(f"clone failed for {slug} at {task['commit']}: {exc}") from exc
    return {
        "path": str(made.path),
        "head": made.head,
        "tree": made.tree,
        "source_commit": made.source_commit,
        "removed": made.removed,
        "not_found": made.not_found,
    }


def _plan(
    ctx: _Context, arm: Arm, harness: _Harness, task: Mapping[str, Any], key: Key, attempt: int
) -> tuple[dict[str, Any], dict[str, str]]:
    """Make the clone and the stores; return the plan and the run's environment."""
    attempt_dir = _work_dir(ctx.results, key) / f"a{attempt}"
    if harness.error is not None or harness.worktree is None:
        raise _LaunchFailed(harness.error or "the harness worktree is missing")
    args, settings, reasoning = _settings(ctx, arm, harness)
    partial = {_K_SETTINGS: settings, _K_REASONING: reasoning}
    try:
        clone = _make_clone(ctx, task, attempt_dir)
    except _LaunchFailed as failed:
        raise _LaunchFailed(failed.reason, partial) from failed
    stores = isolate_run(attempt_dir)
    export_root = attempt_dir / "export-root"
    session = _session_id(key, attempt)
    argv = [ctx.python, "-m", "associate", "run", "--harness", ctx.harness, "--model", arm.model]
    argv += ["--checkout", clone["path"], "--export-root", str(export_root)]
    argv += ["--session-id", session, "--timeout", f"{ctx.timeout_s:g}"]
    argv += ["--task-id", str(task["id"])] if "--task-id" in harness.flags else []
    argv += [*args, "--json", "--", str(task["prompt"])]
    plan = {
        **partial,
        "clone": clone,
        "argv": argv,
        "cwd": str(harness.worktree),
        _K_EXPORT_ROOT: str(export_root),
        _K_SESSION_ID: session,
        "timeout_s": ctx.timeout_s,
    }
    env = {**_base_env(harness.worktree), **stores}
    return plan, env


def _launch(ctx: _Context, plan: dict[str, Any], env: dict[str, str], attempt_dir: Path) -> None:
    """Run the plan and write ``launch.json`` with what happened (not on interruption)."""
    started = time.time()
    launch = Launch(list(plan["argv"]), Path(plan["cwd"]), env, ctx.timeout_s + ctx.grace_s)
    info: dict[str, Any] = {"started": started}
    try:
        done = ctx.launcher(launch)
    except LaunchTimeout as exc:
        info["error"] = f"the run passed the runner's wall clock and was killed ({exc})"
    except OSError as exc:
        info["error"] = f"the run could not be started: {exc}"
    else:
        # Kept in launch.json itself, so the whole outcome lands in one atomic write.
        info.update(exit_code=done.returncode, stdout=done.stdout or "", stderr=done.stderr or "")
    info["ended"] = time.time()
    info["duration_s"] = round(info["ended"] - started, 3)
    _write_atomic(attempt_dir / LAUNCH_FILE, info)


# --------------------------------------------------------------------- reading a run


def _parse_result(stdout: str) -> dict[str, Any] | None:
    text = stdout.strip()
    candidates = [text] + text.splitlines()[::-1]
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _stderr_message(stderr: str) -> str:
    for line in reversed(stderr.strip().splitlines()):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and isinstance(value.get("message"), str):
            return value["message"]
    lines = [line for line in stderr.strip().splitlines() if line.strip()]
    return lines[-1][:500] if lines else "nothing on stderr"


def _reported_export(result: dict[str, Any] | None) -> Path | None:
    """The export directory the run's own result names, unchecked."""
    if result and isinstance(result.get(_K_EXPORT_DIR), str):
        return Path(result[_K_EXPORT_DIR])
    if result and isinstance(result.get("walk_path"), str):
        return Path(result["walk_path"]).parent
    return None


def _plan_export_root(plan: dict[str, Any], attempt_dir: Path) -> Path:
    """The plan's export root, which must lie in the attempt directory it was written to."""
    return _inside(Path(str(plan[_K_EXPORT_ROOT])), attempt_dir, f"{_K_EXPORT_ROOT} {_IN_PLAN}")


def _plan_session(plan: dict[str, Any]) -> str:
    session = plan[_K_SESSION_ID]
    if not isinstance(session, str) or _SAFE_SESSION.fullmatch(session) is None:
        raise RunnerError(f"{_K_SESSION_ID} {_IN_PLAN} is not a safe name: {session!r}")
    return session


def _export_dir(result: dict[str, Any] | None, root: Path, session: str) -> Path | None:
    """Where the run's export is: what the result names, else where the runner asked for it.

    *root* is the export root the runner gave the run. A result naming a
    directory outside it is not read: the run is stored as a failed launch.
    """
    reported = _reported_export(result)
    if reported is not None:
        try:
            return _inside(reported, root, "the export directory the run reported")
        except RunnerError as exc:
            raise _LaunchFailed(str(exc)) from exc
    nested = _inside(root / session / "export", root, "the export directory of the session")
    if nested.is_dir():
        return nested
    return root if (root / WALK_FILE).exists() else None


def _contamination(
    export_dir: Path | None, task: Mapping[str, Any], excluded: list[str]
) -> dict[str, Any]:
    walk = export_dir / WALK_FILE if export_dir is not None else None
    if walk is None or not walk.is_file():
        return {"checked": False, "contaminated": None, "why": "no walk.jsonl in the export"}
    repo = task["repository"]
    try:
        verdict = check_walk(
            load_walk(walk),
            answer_key_paths=list(excluded),
            host=repo["host"],
            owner=repo["owner"],
            name=repo["name"],
            export_dir=export_dir,
        )
    except (OSError, ValueError) as exc:
        return {"checked": False, "contaminated": None, "why": f"the walk cannot be read: {exc}"}
    reasons = [asdict(reason) for reason in verdict.reasons]
    return {"checked": True, "contaminated": verdict.contaminated, "reasons": reasons}


def _handback_strings(export_dir: Path | None) -> list[str] | None:
    """The fact values and verdict texts the model wrote, or None without ``facts.json``."""
    path = export_dir / FACTS_FILE if export_dir is not None else None
    if path is None or not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding=_UTF8))
    except (OSError, ValueError):
        return []
    if not isinstance(payload, dict):
        return []
    strings = [_field(item, "value") for item in _items(payload, "facts")]
    strings += [_field(item, "text") for item in _items(payload, "verdicts")]
    return [s for s in strings if s]


def _items(payload: dict[str, Any], name: str) -> list[Any]:
    value = payload.get(name)
    return value if isinstance(value, list) else []


def _field(item: Any, name: str) -> str:
    value = item.get(name) if isinstance(item, dict) else None
    return value.strip() if isinstance(value, str) else ""


def _grades(
    result: dict[str, Any] | None, export_dir: Path | None, expected: Any
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    answer = answer_mod.model_answer(result, export_dir)
    first = answer_mod.grade_run(result, export_dir, expected)
    readings = [{"reading": READING_ANSWER, "grade": first, "text": answer.text}]
    strings = _handback_strings(export_dir)
    if strings is not None:
        text = "\n".join([answer.text, *strings]).strip()
        readings.append(
            {
                "reading": READING_WITH_HANDBACK,
                "grade": evidence_grade(text, expected),
                "text": text,
                "handback_strings": strings,
            }
        )
    answer_info = {
        "text": answer.text,
        _K_SOURCE: answer.source,
        "empty_reason": answer.empty_reason,
    }
    return answer_info, readings


def _counts(result: dict[str, Any] | None, export_dir: Path | None) -> dict[str, Any] | None:
    if result and isinstance(result.get("accuracy"), dict):
        return {_K_SOURCE: "result", "value": result["accuracy"]}
    if export_dir is None or not (export_dir / FACTS_FILE).is_file():
        return None
    from associate.accuracy import ExportError, inspect_export
    from associate.contract import load_accuracy

    try:
        value = inspect_export(export_dir, load_accuracy())
    except (ExportError, OSError, ValueError) as exc:
        return {_K_SOURCE: "none", "value": None, "why": str(exc)}
    return {_K_SOURCE: "runner_recheck_with_current_code", "value": value}


def _outcome(
    plan: dict[str, Any], launch: dict[str, Any], stdout: str, stderr: str
) -> tuple[str, dict[str, Any] | None, str | None]:
    """(status, result, reason) for a launched run."""
    if launch.get("error"):
        return STATUS_LAUNCH_FAILED, None, launch["error"]
    result = _parse_result(stdout)
    if result is not None:
        return STATUS_FINISHED, result, None
    message = _stderr_message(stderr)
    code = launch.get("exit_code")
    if f"pi did not finish within {plan['timeout_s']:g}s" in message:
        reason = f"the harness printed no result (exit {code}) after the task turn timed out: "
        return STATUS_FINISHED, None, reason + message
    return STATUS_LAUNCH_FAILED, None, f"no result on stdout (exit {code}): {message}"


# --------------------------------------------------------------------- records


def _base_record(
    key: Key, arm_id: dict, task_id: dict, attempt: int, history: list[dict]
) -> dict[str, Any]:
    return {
        "record_format": RECORD_FORMAT,
        "task": task_id,
        "arm": arm_id,
        "repeat": key[2],
        "model": arm_id["model"],
        "harness_commit": arm_id["harness_commit"],
        _K_ATTEMPT: attempt,
        _K_HISTORY: history,
        "stored_at": time.time(),
        "grade": None,
        "grades": [],
        "graded": False,
        "clone": None,
        "clone_head": None,
        "launch": None,
        "outcome": None,
        "result_source": None,
        _K_REASON: None,
    }


def _failed_record(base: dict[str, Any], reason: str, partial: dict[str, Any]) -> dict[str, Any]:
    return {
        **base,
        _K_STATUS: STATUS_LAUNCH_FAILED,
        _K_REASON: reason,
        _K_SETTINGS: partial.get(_K_SETTINGS),
        _K_REASONING: partial.get(_K_REASONING),
        "harness_tree": None,
    }


def _finished_fields(
    plan: dict[str, Any],
    result: dict[str, Any] | None,
    task: Mapping[str, Any],
    excluded: list,
    export_root: Path,
) -> dict[str, Any]:
    export_dir = _export_dir(result, export_root, _plan_session(plan))
    answer, readings = _grades(result, export_dir, task["expected"])
    reasoning = dict(plan[_K_REASONING])
    if result and result.get(_K_REASONING) is not None:
        reasoning[_K_EFFECTIVE] = result[_K_REASONING]
        reasoning[_K_SOURCE] = result.get("reasoning_source") or reasoning[_K_SOURCE]
    return {
        _K_STATUS: STATUS_FINISHED,
        "graded": True,
        "grade": readings[0]["grade"],
        "grades": readings,
        "answer": answer,
        "outcome": (result or {}).get("outcome", "timeout" if result is None else None),
        "result_source": "stdout" if result is not None else "none",
        "run_result": result,
        _K_EXPORT_DIR: str(export_dir) if export_dir else None,
        "contamination": _contamination(export_dir, task, excluded),
        "counts": _counts(result, export_dir),
        _K_REASONING: reasoning,
    }


def _launched_record(
    ctx: _Context, base: dict, plan: dict, task: Mapping[str, Any], attempt_dir: Path
) -> dict[str, Any]:
    cwd = _inside(Path(str(plan["cwd"])), ctx.harness_root, f"the harness directory {_IN_PLAN}")
    export_root = _plan_export_root(plan, attempt_dir)
    session = _plan_session(plan)
    launch = _read_json(attempt_dir / LAUNCH_FILE) or {}
    stdout, stderr = str(launch.get("stdout") or ""), str(launch.get("stderr") or "")
    status, result, reason = _outcome(plan, launch, stdout, stderr)
    record = {
        **base,
        _K_SETTINGS: plan[_K_SETTINGS],
        _K_REASONING: plan[_K_REASONING],
        "clone": plan["clone"],
        "clone_head": plan["clone"]["head"],
        "launch": {
            "argv": plan["argv"],
            "cwd": plan["cwd"],
            _K_SESSION_ID: session,
            "exit_code": launch.get("exit_code"),
            "started": launch.get("started"),
            "ended": launch.get("ended"),
            "duration_s": launch.get("duration_s"),
            "launch_file": str(attempt_dir / LAUNCH_FILE),
        },
        _K_STATUS: status,
        _K_REASON: reason,
    }
    if status == STATUS_FINISHED:
        try:
            record.update(_finished_fields(plan, result, task, ctx.excluded, export_root))
        except _LaunchFailed as failed:
            record.update({_K_STATUS: STATUS_LAUNCH_FAILED, _K_REASON: failed.reason})
    changed = _tree_changes(cwd)
    record["harness_tree"] = {
        "changed": changed,
        "contract_unchanged": not _contract_paths(changed),
    }
    return record


def _store(ctx: _Context, key: Key, record: dict[str, Any], recovered: bool = False) -> None:
    _store_record(record_path(ctx.results, *key), record)
    bucket = ctx.summary.finished if record[_K_STATUS] == STATUS_FINISHED else ctx.summary.failed
    bucket.append(key)
    if recovered:
        ctx.summary.recovered.append(key)
    ctx.progress(
        f"{key}: {record[_K_STATUS]}" + (f" ({record[_K_REASON]})" if record[_K_REASON] else "")
    )
    tree = record.get("harness_tree") or {}
    if tree and not tree.get("contract_unchanged"):
        raise RunnerError(
            f"the contract directory of the harness worktree changed during {key}: "
            f"{_contract_paths(tree['changed'])}; the comparison is stopped"
        )


def _pending_history(
    work: Path, existing: dict[str, Any] | None
) -> tuple[list[dict], int | None, int]:
    """History so far, an attempt that ended but was not stored, and the next attempt number."""
    history = list(existing.get(_K_HISTORY) or []) + [_history_entry(existing)] if existing else []
    stored = int(existing.get(_K_ATTEMPT) or 0) if existing else 0
    attempts = _attempts(work)
    for number in (n for n in attempts if n > stored):
        attempt_dir = work / f"a{number}"
        if (attempt_dir / LAUNCH_FILE).exists() and (attempt_dir / PLAN_FILE).exists():
            return history, number, number
        why = "the runner stopped before this attempt's run ended; it was not stored"
        history.append({_K_ATTEMPT: number, _K_STATUS: STATUS_INTERRUPTED, _K_REASON: why})
    return history, None, max(attempts, default=0) + 1


def _run_key(
    ctx: _Context, arm: Arm, harness: _Harness, task: Mapping[str, Any], repeat: int
) -> None:
    key: Key = (str(task["id"]), arm.name, repeat)
    arm_id, task_id = _arm_identity(arm, harness), _task_identity(task)
    path = record_path(ctx.results, *key)
    existing = _read_json(path)
    if existing is not None:
        _check_same(existing, arm_id, task_id, path)
        if existing.get(_K_STATUS) == STATUS_FINISHED or not ctx.retry_failed:
            ctx.summary.skipped.append(key)
            return
    work = _work_dir(ctx.results, key)
    history, ended, attempt = _pending_history(work, existing)
    attempt_dir = work / f"a{attempt}"
    base = _base_record(key, arm_id, task_id, attempt, history)
    if ended is not None:
        plan = _read_json(attempt_dir / PLAN_FILE) or {}
        _store(ctx, key, _launched_record(ctx, base, plan, task, attempt_dir), recovered=True)
        return
    attempt_dir.mkdir(parents=True)
    try:
        plan, env = _plan(ctx, arm, harness, task, key, attempt)
    except _LaunchFailed as failed:
        _store(ctx, key, _failed_record(base, failed.reason, failed.partial))
        return
    _write_atomic(attempt_dir / PLAN_FILE, plan)
    ctx.progress(f"{key}: launching attempt {attempt}")
    _launch(ctx, plan, env, attempt_dir)
    _store(ctx, key, _launched_record(ctx, base, plan, task, attempt_dir))


# --------------------------------------------------------------------- the comparison


def _name_problems(label: str, values: list[str]) -> list[str]:
    problems = [f"{label} {v!r} is not a safe name" for v in values if not _SAFE_NAME.fullmatch(v)]
    return problems + [f"{label} {v!r} is given twice" for v in set(values) if values.count(v) > 1]


def _arm_problems(arm: Arm) -> list[str]:
    problems = []
    if arm.reasoning is not None and arm.reasoning not in REASONING_CHOICES:
        problems.append(f"arm {arm.name}: reasoning must be one of {REASONING_CHOICES}")
    if arm.check_mode is not None and arm.check_mode not in CHECK_MODES:
        problems.append(f"arm {arm.name}: check_mode must be one of {CHECK_MODES}")
    return problems


def _task_problems(task: Mapping[str, Any]) -> list[str]:
    missing = [k for k in ("repository", "commit", "prompt", "expected") if k not in task]
    return [f"task {task.get('id')!r} has no {', '.join(missing)}"] if missing else []


def _validate(arms: Sequence[Arm], tasks: Sequence[Mapping[str, Any]], repeats: int) -> None:
    problems = []
    if not isinstance(repeats, int) or repeats < 1:
        problems.append("repeats must be a positive integer")
    problems += _name_problems("arm name", [arm.name for arm in arms])
    problems += _name_problems("task id", [str(task.get("id")) for task in tasks])
    for arm in arms:
        problems += _arm_problems(arm)
    for task in tasks:
        problems += _task_problems(task)
    if problems:
        raise RunnerError("; ".join(problems))


def _remove_stale_temporaries(results: Path) -> None:
    for stale in (results / "records").glob("*/*/.*.tmp"):
        with contextlib.suppress(OSError):
            stale.unlink()


def run_comparison(
    arms: Sequence[Arm],
    tasks: Sequence[Mapping[str, Any]],
    repeats: int,
    results_dir: str | Path,
    checkouts: Mapping[str, str | Path],
    *,
    harness_repo: str | Path | None = None,
    options: RunOptions | None = None,
    launcher: Callable[[Launch], Completed] = subprocess_launcher,
    pi_version: Callable[[], str | None] | None = None,
    progress: Callable[[str], None] | None = None,
) -> Summary:
    """Run every task for every arm and repeat; store one result per key.

    ``checkouts`` maps a task's ``repository.name`` to a local checkout holding
    its pinned commit. ``harness_repo`` is the repository the arms' commits are
    in (default: this one). ``options`` (default ``RunOptions()``) holds the
    settings every run is launched with: the interpreter, the time limits, the
    excluded paths, the retry and trust switches and the harness adapter.
    ``pi_version`` reports the pi on PATH (default: ``pi --version``). Returns
    the keys this invocation stored, recovered and skipped.
    """
    chosen = options if options is not None else RunOptions()
    _validate(arms, tasks, repeats)
    results = Path(results_dir).resolve()
    repo = Path(harness_repo) if harness_repo is not None else Path(__file__).resolve().parents[2]
    main = _main_checkout(repo)
    commits = {arm.harness_commit: _resolve_commit(main, arm.harness_commit) for arm in arms}
    with _locked(results), _term_as_interrupt():
        _remove_stale_temporaries(results)
        ctx = _Context(
            results=results,
            harness_root=_harness_root(main),
            checkouts={name: Path(path) for name, path in checkouts.items()},
            python=chosen.python,
            timeout_s=float(chosen.timeout_s),
            grace_s=float(chosen.grace_s),
            excluded=list(chosen.excluded),
            retry_failed=chosen.retry_failed,
            untrusted_checkout=chosen.untrusted_checkout,
            harness=chosen.harness,
            launcher=launcher,
            pi_on_path=(pi_version or _probe_pi_version)(),
            progress=progress or (lambda _message: None),
        )
        prepared = {full: _prepare_harness(ctx, main, full) for full in set(commits.values())}
        for repeat in range(1, repeats + 1):
            for task in tasks:
                for arm in arms:
                    _run_key(ctx, arm, prepared[commits[arm.harness_commit]], task, repeat)
        return ctx.summary
