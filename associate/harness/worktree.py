"""A mutating run works in its own git worktree, then merges to main (spec c51).

User decision q18: *worktrees by default, then merge to main.* A run whose
model the registry marks ``may_mutate`` never writes into the operator's
checkout. It gets a worktree of its own, and only a clean run's result reaches
``main``; a bad write before the merge is undone by removing the worktree
(:func:`discard`).

Lifecycle
---------
1. **create** (:func:`create_run_worktree`) — resolve the repository the
   checkout belongs to (its *main* worktree, even when the checkout is a linked
   worktree), then ``git worktree add -b associate-run/<session>`` at
   ``dirname(repo)/.worktrees.<basename(repo)>/run-<session>``, based on the
   checkout's ``HEAD`` commit. The run's checkout is the same relative
   subdirectory inside it. Uncommitted operator changes are *not* carried in.
2. **run** — the harness is started against the worktree; pi's cwd is there.
3. **commit** (:func:`finish`, clean runs only) — "clean" means the adapter
   raised nothing *and* the walk's run outcome is ``ok``. The harness then
   stages everything in the worktree (``git add -A``) and commits it on the run
   branch with a generated message naming the session id. A failed run is never
   committed: its writes stay as uncommitted changes in the kept worktree.
   If the branch then has no commit beyond its base, there is nothing to merge
   and the worktree and branch are removed (nothing is lost by that).
4. **merge** — local only; nothing here ever pushes, fetches or names a remote.
   Refused (branch and worktree kept, reason reported) when: the repository has
   no ``main`` branch; the run's base commit is not on ``main`` (merging would
   drag the operator's unmerged branch into ``main``); ``main`` is checked out
   somewhere with uncommitted tracked changes; or the merge does not apply
   cleanly (it is aborted first, so ``main`` is untouched). Otherwise:

   * ``main`` checked out (clean) in some worktree — ``git merge --no-ff`` there;
   * ``main`` checked out nowhere — the merge is made in a temporary *detached*
     worktree at ``main`` under the same root, and ``refs/heads/main`` is moved
     with ``git update-ref <new> <old>`` (a compare-and-swap, so a concurrent
     update of ``main`` makes it fail rather than be lost). The operator's
     working tree, index and ``HEAD`` are never touched; the temporary worktree
     is always removed.

   Untracked operator files do not block a merge; git itself refuses a merge
   that would overwrite one, and that refusal is reported like a conflict.
5. **cleanup** — after a merge, the run worktree is removed and the run branch
   deleted. On every other outcome both are kept and their location reported.
   The ``.worktrees.<name>`` root itself is never removed.

Commits and merges the harness makes pass ``--no-verify`` and
``commit.gpgsign=false`` (a hook or a signing prompt must not hang a headless
run), and fall back to a fixed ``associate`` identity only when the repository
has none configured.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from associate.harness.base import HarnessError

__all__ = [
    "BRANCH_PREFIX",
    "TARGET_BRANCH",
    "NotAGitRepository",
    "RunWorktree",
    "WorktreeError",
    "create_run_worktree",
    "discard",
    "finish",
    "worktree_root",
]

#: Scoped prefix for run branches — never a bare ``agent/*`` (see CLAUDE.md).
BRANCH_PREFIX = "associate-run/"
#: The only branch a run is ever merged into.
TARGET_BRANCH = "main"

_FALLBACK_IDENTITY = ("associate", "associate@localhost")
_GIT_TIMEOUT = 120


class WorktreeError(HarnessError):
    """A git step of the worktree lifecycle failed."""


class NotAGitRepository(WorktreeError):
    """The checkout is not inside a git work tree, so no worktree can be made."""


@dataclass(frozen=True)
class RunWorktree:
    repo: Path  #: the repository's main worktree
    path: Path  #: the run worktree
    branch: str
    base: str  #: commit the run branch was created at
    subdir: Path  #: the checkout's path relative to its work tree root

    @property
    def run_checkout(self) -> Path:
        """Where the harness runs: the checkout's own subdirectory of the worktree."""
        return self.path / self.subdir


# ------------------------------------------------------------------ git


def _git(
    args: list[str], cwd: Path, *, check: bool = True, timeout: float = _GIT_TIMEOUT
) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        completed = subprocess.run(  # nosec B603 B607 - fixed argv, shell=False
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            env=env,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as err:
        raise WorktreeError(
            f"could not run git {args[0] if args else ''}: {err}",
            remediation="install git and make sure it is on PATH",
        ) from err
    if check and completed.returncode != 0:
        raise WorktreeError(
            f"git {' '.join(args)} failed in {cwd}: {completed.stderr.strip()}",
            remediation="inspect the repository state with `git status` and `git worktree list`",
        )
    return completed


def _out(args: list[str], cwd: Path) -> str:
    return _git(args, cwd).stdout.strip()


def _ok(args: list[str], cwd: Path) -> bool:
    return _git(args, cwd, check=False).returncode == 0


def _identity_args(cwd: Path) -> list[str]:
    """``-c`` flags for a harness-made commit; identity only when none is set."""
    flags = ["-c", "commit.gpgsign=false"]
    name = _git(["config", "user.name"], cwd, check=False).stdout.strip()
    email = _git(["config", "user.email"], cwd, check=False).stdout.strip()
    if not name:
        flags += ["-c", f"user.name={_FALLBACK_IDENTITY[0]}"]
    if not email:
        flags += ["-c", f"user.email={_FALLBACK_IDENTITY[1]}"]
    return flags


def _worktrees(repo: Path) -> list[dict[str, str]]:
    """``git worktree list --porcelain`` as a list of ``{worktree, HEAD, branch}``."""
    entries: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in _out(["worktree", "list", "--porcelain"], repo).splitlines() + [""]:
        if not line.strip():
            if current:
                entries.append(current)
            current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value
    return entries


# ---------------------------------------------------------------- create


def _main_worktree(checkout: Path) -> tuple[Path, Path]:
    """``(work tree root of checkout, the repository's main worktree)``.

    Without a git binary nothing can be isolated. A checkout that visibly *is*
    one (a ``.git`` in it or above it) is then refused rather than written in
    place; anything else is reported as not a repository.
    """
    if shutil.which("git") is None:
        if any((parent / ".git").exists() for parent in (checkout, *checkout.parents)):
            raise WorktreeError(
                f"{checkout} is a git checkout but git is not on PATH, so the run cannot be "
                "isolated in a worktree",
                remediation="install git and make sure it is on PATH",
            )
        raise NotAGitRepository(
            f"{checkout} is not a git work tree (and git is not on PATH)",
            remediation="run against a git checkout to get worktree isolation",
        )
    probe = _git(["rev-parse", "--show-toplevel"], checkout, check=False)
    if probe.returncode != 0 or not probe.stdout.strip():
        raise NotAGitRepository(
            f"{checkout} is not a git work tree, so the run cannot be isolated in a worktree",
            remediation="run against a git checkout to get worktree isolation",
        )
    toplevel = Path(probe.stdout.strip()).resolve()
    common = Path(
        _out(["rev-parse", "--path-format=absolute", "--git-common-dir"], checkout)
    ).resolve()
    repo = common.parent if common.name == ".git" else toplevel
    return toplevel, repo


def worktree_root(repo: Path) -> Path:
    """``dirname(repo)/.worktrees.<basename(repo)>`` — the repo-owned root."""
    repo = Path(repo).resolve()
    return repo.parent / f".worktrees.{repo.name}"


def create_run_worktree(checkout: Path, session_id: str) -> RunWorktree:
    """Create ``run-<session>`` on branch ``associate-run/<session>`` at HEAD."""
    checkout = Path(checkout).resolve()
    toplevel, repo = _main_worktree(checkout)
    subdir = checkout.relative_to(toplevel)
    base = _git(["rev-parse", "--verify", "HEAD^{commit}"], checkout, check=False)
    if base.returncode != 0:
        raise WorktreeError(
            f"{toplevel} has no commit yet, so there is nothing to base a run worktree on",
            remediation="make an initial commit first",
        )

    path = worktree_root(repo) / f"run-{session_id}"
    branch = BRANCH_PREFIX + session_id
    if path.exists() or _ok(["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], repo):
        raise WorktreeError(
            f"a run worktree or branch for session {session_id!r} already exists "
            f"({path}, {branch})",
            remediation="use a fresh --session-id, or remove the earlier run with "
            f"`git worktree remove {path}` and `git branch -D {branch}`",
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    _git(["worktree", "add", "-q", "-b", branch, str(path), base.stdout.strip()], repo)
    return RunWorktree(repo=repo, path=path, branch=branch, base=base.stdout.strip(), subdir=subdir)


# --------------------------------------------------------------- discard


def discard(run: RunWorktree) -> None:
    """Remove the run worktree and delete its branch — undoes every write in it."""
    if run.path.exists():
        _git(["worktree", "remove", "--force", str(run.path)], run.repo)
    _git(["worktree", "prune"], run.repo, check=False)
    _git(["branch", "-D", run.branch], run.repo, check=False)


# ---------------------------------------------------------------- finish


def _kept(run: RunWorktree, reason: str) -> dict[str, Any]:
    return {
        "merge": "kept",
        "merge_reason": reason,
        "worktree": str(run.path),
        "run_branch": run.branch,
    }


def _commit_run(run: RunWorktree, session_id: str) -> None:
    _git(["add", "-A"], run.path)
    if _ok(["diff", "--cached", "--quiet"], run.path):
        return
    _git(
        [
            *_identity_args(run.path),
            "commit",
            "-q",
            "--no-verify",
            "-m",
            f"associate run {session_id}",
            "-m",
            f"Writes of associate run {session_id}, committed by the harness after the run "
            f"finished clean (branch {run.branch}).",
        ],
        run.path,
    )


def _merge_in(where: Path, run: RunWorktree, session_id: str) -> bool:
    """``git merge --no-ff`` the run branch in *where*; abort and return False on failure."""
    merged = _git(
        [
            *_identity_args(where),
            "merge",
            "--no-ff",
            "--no-verify",
            "-q",
            "-m",
            f"Merge associate run {session_id} ({run.branch})",
            run.branch,
        ],
        where,
        check=False,
    )
    if merged.returncode == 0:
        return True
    # A merge git refused to start (e.g. an untracked file in the way) leaves
    # no MERGE_HEAD, and then there is nothing to abort.
    if _ok(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], where):
        _git(["merge", "--abort"], where)
    return False


def _merge_detached(run: RunWorktree, session_id: str, old_main: str) -> bool:
    """Merge into a ``main`` that is checked out nowhere, via a temporary worktree."""
    temp = worktree_root(run.repo) / f"merge-{session_id}"
    _git(["worktree", "add", "-q", "--detach", str(temp), old_main], run.repo)
    try:
        if not _merge_in(temp, run, session_id):
            return False
        new_main = _out(["rev-parse", "HEAD"], temp)
        moved = _git(
            ["update-ref", "-m", f"associate run {session_id}", f"refs/heads/{TARGET_BRANCH}"]
            + [new_main, old_main],
            run.repo,
            check=False,
        )
        return moved.returncode == 0
    finally:
        _git(["worktree", "remove", "--force", str(temp)], run.repo, check=False)
        _git(["worktree", "prune"], run.repo, check=False)


def finish(run: RunWorktree, *, clean: bool, session_id: str, outcome: str) -> dict[str, Any]:
    """Commit and merge a clean run, or keep the run; returns the report fields.

    Keys: ``merge`` (``merged`` / ``nothing_to_merge`` / ``kept``), and for a
    kept run ``merge_reason``, ``worktree`` and ``run_branch``.
    """
    if not clean:
        return _kept(run, f"run outcome {outcome!r} is not a clean finish; nothing committed")

    _commit_run(run, session_id)
    ahead = int(_out(["rev-list", "--count", f"{run.base}..{run.branch}"], run.repo) or "0")
    if ahead == 0:
        discard(run)
        return {"merge": "nothing_to_merge"}

    main_ref = f"refs/heads/{TARGET_BRANCH}"
    if not _ok(["show-ref", "--verify", "--quiet", main_ref], run.repo):
        return _kept(run, f"the repository has no {TARGET_BRANCH!r} branch to merge into")
    if not _ok(["merge-base", "--is-ancestor", run.base, TARGET_BRANCH], run.repo):
        return _kept(
            run,
            f"the run was based on {run.base[:12]}, which is not on {TARGET_BRANCH}; "
            f"merging would bring unmerged work into {TARGET_BRANCH}",
        )

    holders = [Path(e["worktree"]) for e in _worktrees(run.repo) if e.get("branch") == main_ref]
    if holders:
        holder = holders[0]
        dirty = _out(["status", "--porcelain", "--untracked-files=no"], holder)
        if dirty:
            return _kept(
                run,
                f"{TARGET_BRANCH} is checked out at {holder} with uncommitted changes; "
                "not merging over them",
            )
        merged = _merge_in(holder, run, session_id)
    else:
        merged = _merge_detached(run, session_id, _out(["rev-parse", main_ref], run.repo))

    if not merged:
        return _kept(
            run,
            f"merging {run.branch} into {TARGET_BRANCH} did not apply cleanly (conflict or "
            f"a file in the way); the merge was aborted and {TARGET_BRANCH} is untouched",
        )

    discard(run)
    return {"merge": "merged"}
