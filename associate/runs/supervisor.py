"""The detached supervisor of one run: ``python -m associate.runs.supervisor <run dir> <lock fd>``.

Started by :func:`associate.runs.service.start` in a new session (so it outlives the process
that started it), it runs the argv recorded in ``request.json`` — never through a shell — with
stdout and stderr to files in the run directory, waits for it, and writes ``result.json``:
the exit code, the child's parsed ``--json`` result, the base commit and the changed paths read
from git. The checkout lock descriptor is inherited by the child too, so the checkout stays
locked for exactly as long as either process lives. Stdlib only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from associate.runs.state import atomic_write_json, read_json

#: Changed paths kept in ``result.json`` (``runs show`` cuts further, to its reply limit).
STORED_PATHS = 5000
#: Characters kept of one stored path.
STORED_PATH_CHARS = 4096
#: Characters of the child's stderr tail searched for its ``--json`` error object.
STDERR_TAIL = 16_000
_GIT_TIMEOUT = 60


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _git(cwd: str | Path, *args: str) -> str | None:
    """``git -C cwd args`` stdout, or None when git fails."""
    try:
        done = subprocess.run(  # nosec B603 B607 - fixed argv, shell=False
            ["git", "-c", "core.quotepath=off", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=_GIT_TIMEOUT,
            check=False,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def _z(text: str | None) -> list[str]:
    return [p for p in (text or "").split("\0") if p]


def parse_result(stdout: str) -> dict[str, Any] | None:
    """The ``associate run --json`` result: the last stdout line that is a JSON object."""
    for line in reversed(stdout.strip().splitlines()):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def cli_error(stderr: str) -> str | None:
    """The message of the last ``{code, message, remediation}`` line on stderr, if any."""
    for line in reversed(stderr.strip().splitlines()):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and isinstance(value.get("message"), str):
            return value["message"]
    return None


def _merge_commit(checkout: str, run_id: str) -> str | None:
    """The merge ``associate.harness.worktree`` made on ``main`` for this run (session id)."""
    out = _git(
        checkout,
        "log",
        "refs/heads/main",
        "--format=%H",
        "--fixed-strings",
        f"--grep=Merge associate run {run_id} (",
        "-n",
        "1",
    )
    if out is None:
        return None
    return out.strip() or None


def git_facts(request: dict[str, Any], result: dict[str, Any] | None) -> dict[str, Any]:
    """``base_commit`` and ``changed_paths`` for the finished run, read from git.

    - merged: the merge commit on ``main`` (found by the session id in its message); the base
      is the merge base of its parents and the paths are ``base..<second parent>``;
    - kept (refused or not attempted): the kept worktree's tracked changes against the base
      recorded at start (committed or not) plus its untracked files;
    - anything else (nothing to merge, a read-only run, no result): the base recorded at start
      and no paths.
    """
    checkout = request["checkout"]
    base = request.get("base_commit")
    facts: dict[str, Any] = {"base_commit": base, "changed_paths": [], "changed_paths_error": None}
    merge = (result or {}).get("merge")
    if merge == "merged":
        commit = _merge_commit(checkout, request["run_id"])
        merged_base = _git(checkout, "merge-base", f"{commit}^1", f"{commit}^2") if commit else None
        if commit and merged_base:
            facts["base_commit"] = merged_base.strip()
            facts["changed_paths"] = _z(
                _git(checkout, "diff", "--name-only", "-z", merged_base.strip(), f"{commit}^2")
            )
        else:
            facts["changed_paths_error"] = "the merge commit for this run was not found on main"
    elif merge == "kept" and isinstance((result or {}).get("worktree"), str) and base:
        worktree = result["worktree"]  # type: ignore[index]
        tracked = _git(worktree, "diff", "--name-only", "-z", base)
        untracked = _git(worktree, "ls-files", "--others", "--exclude-standard", "-z")
        if tracked is None or untracked is None:
            facts["changed_paths_error"] = f"the kept worktree {worktree} could not be read"
        else:
            facts["changed_paths"] = sorted(set(_z(tracked)) | set(_z(untracked)))
    paths = facts["changed_paths"]
    facts["changed_paths_total"] = len(paths)
    facts["changed_paths"] = [p[:STORED_PATH_CHARS] for p in paths[:STORED_PATHS]]
    return facts


def _tail(path: Path) -> str:
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - STDERR_TAIL * 4))
            return fh.read().decode("utf-8", "replace")[-STDERR_TAIL:]
    except OSError:
        return ""


def supervise(run: Path, lock_fd: int | None) -> int:
    request = read_json(run / "request.json")
    if not isinstance(request, dict):
        atomic_write_json(
            run / "result.json",
            {"status": "failed-to-start", "error": "request.json is missing or unreadable"},
        )
        return 1
    pass_fds = (lock_fd,) if lock_fd is not None else ()
    try:
        with (run / "stdout.json").open("wb") as out, (run / "stderr.log").open("wb") as err:
            child = subprocess.Popen(  # nosec B603 - argv recorded by start(), shell=False
                request["argv"],
                cwd=request["cwd"],
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                pass_fds=pass_fds,
                close_fds=True,
            )
    except OSError as exc:
        atomic_write_json(
            run / "result.json",
            {
                "status": "failed-to-start",
                "finished_at": _now(),
                "error": f"the run could not be started: {exc.strerror or exc}",
            },
        )
        return 1
    atomic_write_json(run / "child.json", {"pid": child.pid})
    code = child.wait()
    record: dict[str, Any] = {
        "status": "finished",
        "finished_at": _now(),
        "exit_code": code if code >= 0 else None,
        "signal": -code if code < 0 else None,
    }
    try:
        stdout = (run / "stdout.json").read_text(encoding="utf-8", errors="replace")
        result = parse_result(stdout)
        record["run_result"] = result
        record["error"] = cli_error(_tail(run / "stderr.log")) if code != 0 else None
        record.update(git_facts(request, result))
    except Exception as exc:  # noqa: BLE001 - the result file is always written
        record["error"] = f"the run's result could not be read: {exc.__class__.__name__}: {exc}"
    atomic_write_json(run / "result.json", record)
    return 0


def main(argv: list[str]) -> int:
    run = Path(argv[0])
    lock_fd = int(argv[1]) if len(argv) > 1 and argv[1] != "-" else None
    try:
        return supervise(run, lock_fd)
    finally:
        if lock_fd is not None:
            try:
                os.close(lock_fd)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
