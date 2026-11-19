# First check: `worktree-merge-refusals`

- Repository: github.com/agentculture/associate
- Pinned commit: `266dad376813baa8a92a2f34b457222ae7d9d481`
- Kind: find
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Under what four conditions does the harness refuse to merge a mutating run's worktree branch into main, per associate/harness/worktree.py?

## What was run and what it printed

Each command ran in the associate checkout with `COMMIT=266dad376813baa8a92a2f34b457222ae7d9d481`.

```text
$ git show $COMMIT:associate/harness/worktree.py | sed -n '24,32p'
   and the worktree and branch are removed (nothing is lost by that).
4. **merge** — local only; nothing here ever pushes, fetches or names a remote.
   Refused (branch and worktree kept, reason reported) when: the repository has
   no ``main`` branch; the run's base commit is not on ``main`` (merging would
   drag the operator's unmerged branch into ``main``); ``main`` is checked out
   somewhere with uncommitted tracked changes; or the merge does not apply
   cleanly (it is aborted first, so ``main`` is untouched). Otherwise:

   * ``main`` checked out (clean) in some worktree — ``git merge --no-ff`` there;
```

```text
$ git show $COMMIT:associate/harness/worktree.py | grep -n -E 'show-ref|is-ancestor|porcelain|merge", "--no-ff|merge --abort|_kept'
159:    """``git worktree list --porcelain`` as a list of ``{worktree, HEAD, branch}``."""
162:    for line in _out(["worktree", "list", "--porcelain"], repo).splitlines() + [""]:
228:    if path.exists() or _ok(["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], repo):
254:def _kept(run: RunWorktree, reason: str) -> dict[str, Any]:
345:        return _kept(run, f"{why}; nothing committed")
354:    if not _ok(["show-ref", "--verify", "--quiet", main_ref], run.repo):
355:        return _kept(run, f"the repository has no {TARGET_BRANCH!r} branch to merge into")
356:    if not _ok(["merge-base", "--is-ancestor", run.base, TARGET_BRANCH], run.repo):
357:        return _kept(
366:        dirty = _out(["status", "--porcelain", "--untracked-files=no"], holder)
368:            return _kept(
378:        return _kept(
```

## Finding

```text
The module docstring, step 4, names the four refusals: no main branch; the base commit is not on main; main checked out somewhere with uncommitted tracked changes; the merge does not apply cleanly (aborted first). finish() implements them in that order (show-ref, merge-base --is-ancestor, status --porcelain --untracked-files=no, merge --no-ff then merge --abort). Recorded answer right. Expected values widened in t8 to one group per condition with paraphrases ("no `main` branch", "base commit not on", "dirty", "conflict", ...): the saved worker enforce answer wrote "No `main` branch" and the saved cortex answer wrote "run's base commit not on main", both right, both marked wrong before.
```

## Recorded answer

```text
It keeps the branch and worktree and reports the reason when: the repository has no main branch; the run's base commit is not on main; main is checked out somewhere with uncommitted tracked changes; or the merge does not apply cleanly (it is aborted first, so main is untouched). Source: the module docstring, step 4.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (4 judged right, 2 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
