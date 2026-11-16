"""Where run state lives, how it is written, and the one-run-per-checkout lock. Stdlib only.

Layout (``<state>`` is :attr:`RunsConfig.state_dir`, never inside a checkout)::

    <state>/locks/<sha256 of the checkout's real path>.lock   the checkout lock (holds a run id)
    <state>/runs/<run id>/request.json      what was asked, the argv, the base commit
    <state>/runs/<run id>/supervisor.json   the detached supervisor's pid
    <state>/runs/<run id>/child.json        the ``associate run`` child's pid
    <state>/runs/<run id>/stdout.json       the child's stdout (its ``--json`` result)
    <state>/runs/<run id>/stderr.log        the child's stderr
    <state>/runs/<run id>/supervisor.log    the supervisor's own output
    <state>/runs/<run id>/export/           the run's ``--export-root`` (walk, statements)
    <state>/runs/<run id>/result.json       written last, by the supervisor, once the child ends

Every JSON file is written whole to a temporary name and renamed into place, so a reader sees
the old file or the new one, never half of one. Directories are ``0700`` and files ``0600``.

The checkout lock is an ``fcntl.flock`` on the lock file, taken non-blocking by the starter
and inherited by the detached supervisor and its child (``pass_fds``); the starter then closes
its own descriptor. The kernel drops a flock when the last descriptor on it closes, so a run
that ends, crashes or is killed frees its checkout with nothing left to clean up: there is no
stale lock to detect. The lock file's content (the run id) only names the holder for a refusal
message; holding the flock is what counts.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import secrets
from pathlib import Path
from typing import Any

__all__ = [
    "REQUEST_FILE",
    "RESULT_FILE",
    "RUN_ID",
    "CheckoutBusy",
    "acquire_checkout_lock",
    "atomic_write_json",
    "new_run_id",
    "pid_alive",
    "read_json",
    "run_dir",
]

#: ``run-`` and 128 random bits in hex: unguessable, and one safe path segment.
RUN_ID = re.compile(r"run-[0-9a-f]{32}")
#: The files of a run directory: what was asked, and how it ended.
REQUEST_FILE = "request.json"
RESULT_FILE = "result.json"


class CheckoutBusy(Exception):
    """Another run holds the checkout's lock; ``holder`` is its run id when readable."""

    def __init__(self, holder: str | None) -> None:
        super().__init__(holder or "unknown")
        self.holder = holder


def new_run_id() -> str:
    return f"run-{secrets.token_hex(16)}"


def run_dir(state_dir: Path, run_id: str) -> Path:
    """The run's directory; ``ValueError`` unless ``run_id`` is exactly a run id."""
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise ValueError("a run id is 'run-' followed by 32 lowercase hex digits")
    return state_dir / "runs" / run_id


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def atomic_write_json(path: Path, data: Any) -> None:
    """Write ``data`` as JSON to a temporary file beside ``path``, then rename it into place."""
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def read_json(path: Path) -> Any:
    """The JSON in ``path``, or ``None`` when it is absent or unreadable."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _lock_path(state_dir: Path, checkout_real: Path) -> Path:
    digest = hashlib.sha256(str(checkout_real).encode("utf-8", "surrogateescape")).hexdigest()
    return ensure_dir(state_dir / "locks") / f"{digest}.lock"


def acquire_checkout_lock(state_dir: Path, checkout_real: Path, run_id: str) -> int:
    """Take the checkout's lock for ``run_id``; returns the locked descriptor.

    Raises :class:`CheckoutBusy` naming the holder when another run has it. The caller hands
    the descriptor to the detached process (``pass_fds``) and closes its own copy.
    """
    path = _lock_path(state_dir, checkout_real)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        try:
            holder = os.pread(fd, 64, 0).decode("ascii", "replace").strip() or None
        finally:
            os.close(fd)
        raise CheckoutBusy(holder if holder and RUN_ID.fullmatch(holder) else None) from None
    except BaseException:
        os.close(fd)
        raise
    os.ftruncate(fd, 0)
    os.pwrite(fd, run_id.encode("ascii"), 0)
    return fd


def pid_alive(pid: Any, marker: str) -> bool:
    """Whether ``pid`` is a live process whose command line carries ``marker`` (the run id).

    The marker check guards against pid reuse: a recycled pid belongs to another command line.
    A zombie has an empty command line and so reads as dead. Where ``/proc`` is unavailable
    only the signal-0 probe is used.
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
    except FileNotFoundError:
        return not Path("/proc/self").exists()
    except OSError:
        return True
    return marker.encode() in cmdline
