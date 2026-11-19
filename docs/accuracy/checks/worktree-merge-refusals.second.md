# worktree-merge-refusals: second check

## What I was given

The question "Four conditions for refusing merge per worktree.py" about associate at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

Read associate/harness/worktree.py module docstring lines 26-30 and finish() lines ~336-385.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

Docstring step 4 'merge' says it is refused (branch and worktree kept, reason reported) when: (1) the repository has no `main` branch; (2) the run's base commit is not on `main` (merging would drag the operator's unmerged branch into main); (3) `main` is checked out somewhere with uncommitted tracked changes; (4) the merge does not apply cleanly (it is aborted first, main untouched). In code these are the show-ref check, `merge-base --is-ancestor run.base main`, the `git status --porcelain --untracked-files=no` dirty check on the holder worktree, and the failed `_merge_in`/`_merge_detached`.
Not one of the four but also keeps the run: a run that is not clean (adapter raised or outcome not ok, or test commands failed) is never committed (`finish`, `if not clean`). A run with no commits beyond base is discarded as `nothing_to_merge`.

## Confidence and doubts

high
