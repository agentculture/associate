"""The filtered clone a measured run examines (plan task t4).

A measured run must not be able to read its own answer key. A plain
``git clone`` would carry every past revision of the key, so this module does
not clone: it exports the pinned commit's files with ``git archive`` (a read
of the source's object store, nothing written there), deletes the excluded
paths, and makes a brand-new repository with a single commit. The result has
no history, no remote and no alternates link back to the source.

The commit is made with a fixed identity and fixed dates, so the same source
commit and the same exclusions give the same commit id every time. A fresh
clone is made for every call; nothing is reused.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

_IDENTITY = "associate-measure"
_DATE = "2000-01-01T00:00:00+0000"
_GIT_ENV = {
    "GIT_AUTHOR_NAME": _IDENTITY,
    "GIT_AUTHOR_EMAIL": "measure@example.invalid",
    "GIT_AUTHOR_DATE": _DATE,
    "GIT_COMMITTER_NAME": _IDENTITY,
    "GIT_COMMITTER_EMAIL": "measure@example.invalid",
    "GIT_COMMITTER_DATE": _DATE,
}
_NO_CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"]


class CloneError(Exception):
    """The clone could not be made; nothing is left behind."""


@dataclass(frozen=True)
class CloneResult:
    """What a measured run stores about its clone."""

    path: Path
    head: str  # the clone's one commit
    tree: str  # that commit's tree id
    source_commit: str  # the full id of the pinned commit in the source
    removed: list[str] = field(default_factory=list)
    not_found: list[str] = field(default_factory=list)


def _run(args: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    full_env = {**os.environ, **(env or {})}
    try:
        done = subprocess.run(  # nosec B603 B607 - fixed argv, no shell
            args, cwd=cwd, env=full_env, check=True, capture_output=True, text=True
        )
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip().splitlines()
        raise CloneError(f"{' '.join(args[:4])} failed: {detail[-1] if detail else exc}") from exc
    except OSError as exc:
        raise CloneError(f"cannot run {args[0]}: {exc}") from exc
    return done.stdout


def _clean_excluded(paths: list[str]) -> list[str]:
    cleaned = []
    for raw in paths:
        pure = PurePosixPath(raw)
        parts = pure.parts
        if not raw or pure.is_absolute() or ".." in parts or "." in parts:
            raise CloneError(f"excluded path must be relative and inside the repository: {raw!r}")
        if parts[0] == ".git":
            raise CloneError(f"excluded path may not name .git: {raw!r}")
        cleaned.append(pure.as_posix())
    return cleaned


def _resolve_commit(source: Path, commit: str) -> str:
    if commit.startswith("-"):
        raise CloneError(f"not a commit: {commit!r}")
    out = _run(
        ["git", "-C", str(source), "rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}"]
    )
    return out.strip()


def _export(source: Path, commit: str, dest: Path) -> None:
    archive = _run_bytes(["git", "-C", str(source), "archive", "--format=tar", commit])
    try:
        subprocess.run(  # nosec B603 B607 - fixed argv, no shell
            ["tar", "-x", "-C", str(dest)], input=archive, check=True, capture_output=True
        )
    except (subprocess.CalledProcessError, OSError) as exc:
        raise CloneError(f"cannot unpack the archive: {exc}") from exc


def _run_bytes(args: list[str]) -> bytes:
    try:
        return subprocess.run(  # nosec B603 B607 - fixed argv, no shell
            args, check=True, capture_output=True
        ).stdout
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise CloneError(f"git archive failed: {detail[-1] if detail else exc}") from exc


def _remove(root: Path, excluded: list[str]) -> tuple[list[str], list[str]]:
    removed, missing = [], []
    for rel in excluded:
        target = root / rel
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)
        else:
            missing.append(rel)
            continue
        removed.append(rel)
    return removed, missing


def _check_outside(source: Path, dest_parent: Path) -> None:
    src, dst = source.resolve(), dest_parent.resolve()
    if dst == src or src in dst.parents:
        raise CloneError("the clone must be made outside the source repository")


def make_clone(
    source: str | Path,
    commit: str,
    excluded: list[str],
    dest_parent: str | Path,
) -> CloneResult:
    """Make a fresh one-commit clone of ``source`` at ``commit`` without ``excluded``.

    The clone is a new directory under ``dest_parent`` (created if absent,
    never inside ``source``). Excluded paths that are not in the commit are
    listed in ``not_found``, not treated as errors. The source is only read.
    """
    source = Path(source)
    dest_parent = Path(dest_parent)
    _check_outside(source, dest_parent)
    wanted = _clean_excluded(list(excluded))
    full = _resolve_commit(source, commit)
    dest_parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="clone-", dir=dest_parent))
    try:
        _export(source, full, root)
        removed, missing = _remove(root, wanted)
        _run(["git", "init", "-q", "-b", "main", str(root)])
        _run(["git", "-C", str(root), *_NO_CONFIG, "add", "-f", "-A"])
        _run(
            [
                "git",
                "-C",
                str(root),
                *_NO_CONFIG,
                "commit",
                "-q",
                "--no-verify",
                "-m",
                "measured snapshot",
            ],
            env=_GIT_ENV,
        )
        head = _run(["git", "-C", str(root), "rev-parse", "HEAD"]).strip()
        tree = _run(["git", "-C", str(root), "rev-parse", "HEAD^{tree}"]).strip()
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise
    return CloneResult(root, head, tree, full, removed, missing)
