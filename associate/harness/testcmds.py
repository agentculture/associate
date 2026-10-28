"""Operator-named test commands, run by the harness after the model (deviation d12).

A model that may change code cannot be trusted to say its edits work; the
operator names the exact commands that decide it (``associate run
--test-command "<command line>"``, repeatable) and the *harness* runs them once
the model's run has finished, before the worktree merge decision. A mutating
worktree run is merged only when every command exits ``0``.

How a command runs
------------------
Each command is an argv list (``shlex.split`` of what the operator typed) run
with ``shell=False`` in the run checkout, stdin closed, combined stdout+stderr
captured to a temporary file, and a per-command timeout
(:data:`TEST_TIMEOUT_SECONDS` by default). It starts in its own session, and
the whole process group is killed when it times out or exits, so a straggler
cannot keep writing after the revert below. The environment is the operator's
minus every ``ASSOCIATE_*`` variable — test code never sees the lane key. A
failure does not stop the run: every command runs and every result is reported.

Side effects never become the model's work
------------------------------------------
Test commands write — ``uv run`` rewrites ``uv.lock``, tests drop fixtures —
and a worktree run commits with ``git add -A``. So, in a git checkout, the
harness snapshots ``git status --porcelain=v1 -z --untracked-files=all`` and
the exact bytes (and mode) of every listed path before the tests, then restores
every path dirty before *or* after:

* dirty before — back to its saved bytes, or deleted again if it was absent;
* clean before — back to the pre-test ``HEAD`` (``git checkout``) when tracked
  there, otherwise removed.

Gitignored files are not listed by ``git status`` and are left alone (caches
are fine). Every restored path is listed in ``reverted``. A snapshot larger than
:data:`MAX_SNAPSHOT_BYTES` is not taken and the tests are **not run** — they are
reported failed with the reason, never run unprotected. A test that moves
``HEAD`` (commits) fails the tests too: its commit is not undone here, and the
run is kept for inspection rather than merged. In a non-git checkout there is
nothing to restore from; the tests run unprotected and a diagnostic says so.
"""

from __future__ import annotations

import os
import shlex
import shutil
import signal
import stat
import subprocess  # nosec B404 - operator-named argv, shell=False
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from associate.harness.base import HarnessError

__all__ = [
    "MAX_SNAPSHOT_BYTES",
    "OUTPUT_TAIL_CHARS",
    "TEST_TIMEOUT_SECONDS",
    "describe_failures",
    "parse_test_command",
    "run_test_commands",
    "scrubbed_environment",
]

#: Default seconds one test command may run before its process group is killed.
TEST_TIMEOUT_SECONDS = 900.0
#: Characters of combined stdout+stderr kept per command, after redaction.
OUTPUT_TAIL_CHARS = 2000
#: Most bytes of dirty files the pre-test snapshot may hold; above it, no tests run.
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

#: Bytes read back from the end of a command's output (UTF-8 is at most 4 bytes
#: a character; the redaction window is 8x the kept tail, see ``output_tail``).
_READ_BACK_BYTES = OUTPUT_TAIL_CHARS * 8 * 4


def parse_test_command(value: str) -> list[str]:
    """``shlex.split`` one ``--test-command`` value; ``ValueError`` when unusable."""
    argv = shlex.split(value)  # raises ValueError on an unclosed quote
    if not argv:
        raise ValueError("an empty test command")
    return argv


def scrubbed_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    """The operator's environment with every ``ASSOCIATE_*`` variable removed."""
    source = os.environ if base is None else base
    return {key: value for key, value in source.items() if not key.startswith("ASSOCIATE_")}


# ------------------------------------------------------------- snapshot


@dataclass(frozen=True)
class _Saved:
    kind: str  #: "file", "link", "absent" or "dir" (a nested repo: not touched)
    data: bytes = b""
    mode: int = 0


def _git(args: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    from associate.harness import worktree

    return worktree._git(["--literal-pathspecs", *args], cwd, check=check)


def _toplevel(checkout: Path) -> Path | None:
    if shutil.which("git") is None:
        return None
    try:
        probe = _git(["rev-parse", "--show-toplevel"], checkout, check=False)
    except HarnessError:
        return None
    if probe.returncode != 0 or not probe.stdout.strip():
        return None
    return Path(probe.stdout.strip()).resolve()


def _head(top: Path) -> str | None:
    probe = _git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], top, check=False)
    if probe.returncode != 0:
        return None
    return probe.stdout.strip() or None


def _dirty(top: Path) -> list[str]:
    """Every path ``git status`` lists, renames' original paths included."""
    raw = _git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], top).stdout
    entries = raw.split("\0")
    paths: list[str] = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        paths.append(entry[3:])
        if entry[0] in "RC":  # the next NUL field is the rename/copy source
            if index < len(entries) and entries[index]:
                paths.append(entries[index])
            index += 1
    return sorted(set(paths))


def _save(path: Path) -> _Saved:
    if path.is_symlink():
        return _Saved("link", os.fsencode(os.readlink(path)))
    if not path.exists():
        return _Saved("absent")
    if path.is_dir():
        return _Saved("dir")
    return _Saved("file", path.read_bytes(), stat.S_IMODE(path.stat().st_mode))


def _size(path: Path) -> int:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return 0
    return info.st_size if stat.S_ISREG(info.st_mode) else 0


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def _matches(path: Path, saved: _Saved) -> bool:
    if saved.kind == "absent":
        return not path.exists() and not path.is_symlink()
    if saved.kind == "link":
        return path.is_symlink() and os.fsencode(os.readlink(path)) == saved.data
    if path.is_symlink() or not path.is_file():
        return False
    return path.read_bytes() == saved.data and stat.S_IMODE(path.stat().st_mode) == saved.mode


def _restore_saved(path: Path, saved: _Saved) -> bool:
    """Put *path* back as *saved*; ``True`` when anything had to change."""
    if saved.kind == "dir" or _matches(path, saved):
        return False
    _remove(path)
    if saved.kind == "absent":
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    if saved.kind == "link":
        os.symlink(os.fsdecode(saved.data), path)
    else:
        path.write_bytes(saved.data)
        path.chmod(saved.mode)
    return True


def _restore_head(top: Path, rel: str, head: str | None) -> None:
    """Put a path that was clean before the tests back to the pre-test ``HEAD``."""
    if (
        head is not None
        and _git(["cat-file", "-e", f"{head}:{rel}"], top, check=False).returncode == 0
    ):
        target = top / rel
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        _git(["checkout", head, "--", rel], top)
        return
    _git(["rm", "-q", "--cached", "--ignore-unmatch", "--", rel], top, check=False)
    _remove(top / rel)


# ------------------------------------------------------------- running


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    killpg = getattr(os, "killpg", None)
    if killpg is None:  # pragma: no cover - POSIX only in practice
        proc.kill()
        return
    try:
        killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def output_tail(text: str, chars: int) -> str:
    """The harness's one redaction (``pi.output_tail``), imported only when used.

    Kept lazy so ``associate run``'s parser — which reads this module's
    timeout default — does not load the Pi adapter on every CLI start.
    """
    from associate.harness import pi

    return pi.output_tail(text, chars)


def _read_tail(handle: Any) -> str:
    handle.flush()
    size = handle.seek(0, os.SEEK_END)
    handle.seek(max(0, size - _READ_BACK_BYTES))
    return output_tail(handle.read().decode("utf-8", errors="replace"), OUTPUT_TAIL_CHARS)


def _run_one(argv: list[str], cwd: Path, env: dict[str, str], timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    exit_code: int | None = None
    timed_out = False
    with tempfile.TemporaryFile() as out:
        try:
            proc = subprocess.Popen(  # nosec B603 - argv named by the operator, shell=False
                argv,
                cwd=str(cwd),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as err:
            tail = output_tail(f"could not start {argv[0]!r}: {err}", OUTPUT_TAIL_CHARS)
        else:
            try:
                exit_code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                _kill_group(proc)
                proc.wait()
            else:
                _kill_group(proc)  # stragglers must not write after the revert
            tail = _read_tail(out)
    return {
        "argv": list(argv),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_ms": int((time.monotonic() - started) * 1000),
        "output_tail": tail,
    }


def _failed(command: dict[str, Any]) -> bool:
    return command["exit_code"] != 0


def describe_failures(tests: dict[str, Any]) -> str:
    """One line naming what failed: each failing argv and how, or the error."""
    parts = []
    for command in tests.get("commands", []):
        if not _failed(command):
            continue
        if command["timed_out"]:
            how = "timed out"
        elif command["exit_code"] is None:
            how = "did not start"
        else:
            how = f"exit {command['exit_code']}"
        parts.append(f"`{shlex.join(command['argv'])}` ({how})")
    if tests.get("error"):
        parts.append(str(tests["error"]))
    return "; ".join(parts)


def run_test_commands(
    commands: list[list[str]],
    checkout: Path,
    *,
    timeout: float = TEST_TIMEOUT_SECONDS,
    warn: Callable[[str], None],
) -> dict[str, Any]:
    """Run every command in *checkout*, revert their side effects, report all.

    Returns ``{"passed", "commands", "reverted"}``, plus ``"error"`` when the
    tests were not run (snapshot over the cap) or their side effects could not
    be fully undone — either of which makes ``passed`` false.
    """
    checkout = Path(checkout)
    env = scrubbed_environment()
    top = _toplevel(checkout)
    if top is None:
        warn(
            f"associate: {checkout} is not a git work tree; test commands run there and "
            "their side effects are not reverted"
        )
        results = [_run_one(argv, checkout, env, timeout) for argv in commands]
        return {"passed": not any(map(_failed, results)), "commands": results, "reverted": []}

    head = _head(top)
    before = _dirty(top)
    total = sum(_size(top / rel) for rel in before)
    if total > MAX_SNAPSHOT_BYTES:
        return {
            "passed": False,
            "commands": [],
            "reverted": [],
            "error": (
                f"not run: the uncommitted files to protect total {total} bytes, over the "
                f"{MAX_SNAPSHOT_BYTES // (1024 * 1024)} MiB snapshot cap; tests are never "
                "run without a way to revert their side effects"
            ),
        }
    saved = {rel: _save(top / rel) for rel in before}

    results = [_run_one(argv, checkout, env, timeout) for argv in commands]

    report: dict[str, Any] = {"passed": not any(map(_failed, results)), "commands": results}
    errors: list[str] = []
    if _head(top) != head:
        errors.append(
            "a test command moved HEAD (made a commit); that commit is not undone, so the "
            "run is not merged"
        )
    reverted: list[str] = []
    for rel in sorted(set(before) | set(_dirty(top))):
        try:
            if rel in saved:
                if _restore_saved(top / rel, saved[rel]):
                    reverted.append(rel)
            else:
                _restore_head(top, rel, head)
                reverted.append(rel)
        except (OSError, HarnessError) as err:
            errors.append(f"could not revert {rel}: {err}")
    report["reverted"] = reverted
    if errors:
        report["passed"] = False
        report["error"] = "; ".join(errors)
    return report
