"""The one-run-per-checkout lock, held by the run itself. Stdlib only.

Why it exists
-------------
``delegate_run`` (``.pi/extensions/associate/tools/delegate.ts``, deviation d18)
starts ``associate run`` detached: the run outlives the call, and may outlive
the session that started it. A lock kept in that session's memory therefore
ends before the run does, and a second delegated run on the same checkout —
from a restarted session, or from another process — would race the first to
merge into ``main``. So the lock is taken by the delegated run's own process
(``associate run --checkout-lock``) and held until that process ends.

Path and protocol
-----------------
The lock is a kernel ``flock`` (``LOCK_EX | LOCK_NB``) on::

    <state>/locks/<sha256 hex of the checkout's real path>.lock

``<state>`` is ``$ASSOCIATE_RUNS_DIR`` when set, else
``$XDG_STATE_HOME/associate/runs`` (an absolute ``XDG_STATE_HOME`` only), else
``~/.local/state/associate/runs`` — never inside a checkout. The holder writes
its run id into the file; that text only names the holder in a refusal, and
holding the ``flock`` is what counts. The kernel drops a ``flock`` when the
last descriptor on it closes, so a run that finishes, crashes or is killed
frees its checkout with nothing to clean up: there is no stale lock to detect.

:func:`probe` answers "is it held, and by whom" without taking it for longer
than the question; ``python -m associate.harness.checkoutlock <checkout>``
prints that answer as JSON, which is how the extension (Node has no ``flock``)
asks before it starts a run.

The directory, the file name and the ``flock`` are the same ones the HTTP
bridge's run service uses for the runs it starts, so a holder of either kind
excludes the other.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

__all__ = [
    "STATE_DIR_ENV",
    "CheckoutBusy",
    "acquire",
    "lock_path",
    "probe",
    "state_dir",
]

#: The state directory holding ``locks/``; relative values resolve against the cwd.
STATE_DIR_ENV = "ASSOCIATE_RUNS_DIR"

#: Bytes of the lock file read back as the holder's run id.
_HOLDER_BYTES = 128


class CheckoutBusy(Exception):
    """Another run holds the checkout's lock; ``holder`` is its run id when readable."""

    def __init__(self, holder: str | None) -> None:
        super().__init__(holder or "unknown")
        self.holder = holder


def state_dir() -> Path:
    """``$ASSOCIATE_RUNS_DIR``, else the XDG state directory's ``associate/runs``."""
    raw = os.environ.get(STATE_DIR_ENV, "").strip()
    if raw:
        return Path(raw).resolve()
    xdg = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg) if xdg and os.path.isabs(xdg) else Path.home() / ".local" / "state"
    return (base / "associate" / "runs").resolve()


def lock_path(checkout: Path | str) -> Path:
    """The lock file for *checkout*, keyed by its real path."""
    real = Path(checkout).resolve()
    digest = hashlib.sha256(str(real).encode("utf-8", "surrogateescape")).hexdigest()
    return state_dir() / "locks" / f"{digest}.lock"


def _holder(fd: int) -> str | None:
    try:
        text = os.pread(fd, _HOLDER_BYTES, 0).decode("utf-8", "replace").strip()
    except OSError:
        return None
    return text or None


def acquire(checkout: Path | str, holder: str) -> int:
    """Take *checkout*'s lock for *holder*; returns the descriptor that holds it.

    The lock lasts until that descriptor is closed or the process ends. Raises
    :class:`CheckoutBusy` when another run has it, ``OSError`` when the lock
    file cannot be made.
    """
    import fcntl

    path = lock_path(checkout)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # O_NOFOLLOW: a link planted at the lock's name must not move the lock elsewhere
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        try:
            raise CheckoutBusy(_holder(fd)) from None
        finally:
            os.close(fd)
    except BaseException:
        os.close(fd)
        raise
    os.ftruncate(fd, 0)
    os.pwrite(fd, holder.encode("utf-8"), 0)
    return fd


def probe(checkout: Path | str) -> dict[str, Any]:
    """``{"held", "holder", "path"}`` for *checkout*'s lock, taking nothing and creating nothing."""
    import fcntl

    path = lock_path(checkout)
    answer: dict[str, Any] = {"held": False, "holder": None, "path": str(path)}
    try:
        fd = os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        return answer
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            answer["held"] = True
            answer["holder"] = _holder(fd)
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)
    return answer


def _main(argv: list[str]) -> int:
    if len(argv) != 1:
        sys.stderr.write("usage: python -m associate.harness.checkoutlock <checkout>\n")
        return 1
    try:
        answer = probe(argv[0])
    except (OSError, ImportError) as err:
        sys.stderr.write(f"the checkout lock could not be read: {err}\n")
        return 2
    sys.stdout.write(json.dumps(answer) + "\n")
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised as a subprocess
    raise SystemExit(_main(sys.argv[1:]))
