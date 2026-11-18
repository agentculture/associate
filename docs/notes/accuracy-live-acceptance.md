# Accuracy method: live acceptance runs

Plan task **t20** (`docs/plans/2026-11-17-associate-accuracy-method.md`),
covering claims c1, c4, c30, c45, c61 and their honesty conditions. Recorded
2026-11-17 and 2026-11-18 (UTC) on pi 1.5.2, against harness commit
`0ccca36` of branch `accuracy/issue-20`, through the local lobes gateway.

These are single runs. They show what happened once; nothing here is a rate.
"Passed" means a fact's quote was found in the saved result of the walk entry
it cites. It does not mean the fact's value is true.

## How the runs were made

- Each run was `associate run --model <key> --untrusted-checkout --timeout 1500
  --json` on a scratch clone of the branch, with its own export root. No run
  touched the working checkout.
- **Reasoning was off for `worker` and `cortex` in every run below.** associate
  has no per-run reasoning switch (issue #22), so the harness tree used a
  contract copy with both models set to `off`. The committed registry still
  says `on`; with it on, 4 of 10 runs on 2026-11-17 ended at the time limit.
- **Mode was `report`** (the contract default for every model) unless a run is
  marked enforce. In report mode nothing is refused; the report says what
  would have been.
- The tasks are the six in `docs/accuracy/tasks.json`, committed with their
  hand-checked answers before any of these runs.
- None of these runs is a continuation, except the one marked so.
- The exports stay in the operator's scratch directory. They are not
  committed; trimmed fixtures from earlier runs are in
  `tests/fixtures/accuracy/`.

## worker, six tasks, report mode

| Task | Session | Seconds | Calls | Calls refused for no purpose | Facts made | Passed | Refused | Unchecked | Counts agree | Passed facts failing the separate re-check |
|---|---|---|---|---|---|---|---|---|---|---|
| gate-thresholds | `acc20-worker-gate-thresholds` | 139 | 16 | 0 | 9 | 0 | 9 | 0 | yes | 0 |
| worktree-merge-refusals | `acc20-worker-worktree-merge-refusals` | 152 | 12 | 3 | 6 | 0 | 6 | 0 | yes | 0 |
| read-budget | `acc20-worker-read-budget` | 67 | 15 | 2 | 1 | 1 | 0 | 0 | yes | 0 |
| senses-rights | `acc20-worker-senses-rights` | 82 | 13 | 1 | 3 | 2 | 1 | 0 | yes | 0 |
| forbidden-decisions | `acc20-worker-forbidden-decisions` | 61 | 9 | 0 | 2 | 1 | 1 | 0 | yes | 0 |
| decider-retry-count | `acc20-worker-decider-retry-count` | 138 | 18 | 1 | 5 | 3 | 2 | 0 | yes | 0 |

Totals: 26 facts made, 7 passed, 19 refused,
0 unchecked, over 83 tool calls of which
7 were refused for a missing purpose. Every run handed back
with walk outcome `ok`.

## cortex, six tasks, report mode

| Task | Session | Seconds | Calls | Calls refused for no purpose | Facts made | Passed | Refused | Unchecked | Counts agree | Passed facts failing the separate re-check |
|---|---|---|---|---|---|---|---|---|---|---|
| gate-thresholds | `acc20-cortex-gate-thresholds` | 238 | 17 | 0 | 9 | 8 | 1 | 0 | yes | 0 |
| worktree-merge-refusals | `acc20-cortex-worktree-merge-refusals` | 106 | 12 | 0 | 5 | 5 | 0 | 0 | yes | 0 |
| read-budget | `acc20-cortex-read-budget` | 35 | 5 | 0 | 1 | 1 | 0 | 0 | yes | 0 |
| senses-rights | `acc20-cortex-senses-rights` | 46 | 5 | 0 | 4 | 4 | 0 | 0 | yes | 0 |
| forbidden-decisions | `acc20-cortex-forbidden-decisions` | 145 | 19 | 0 | 9 | 5 | 4 | 0 | yes | 0 |
| decider-retry-count | `acc20-cortex-decider-retry-count` | 346 | 29 | 0 | 12 | 12 | 0 | 0 | yes | 0 |

Totals: 40 facts made, 35 passed, 5 refused,
0 unchecked, over 87 tool calls of which
0 were refused for a missing purpose. Every run handed back
with walk outcome `ok`.

## What the three columns on the right mean

- **Counts agree:** for each run, the extension's `report.json`, the Python
  re-check in the run result, and a hand count from `facts.json` and
  `check.json` give the same made, passed and refused numbers. They agreed in
  12 of 12 runs.
- **Separate re-check:** every fact the extension reported as passed was
  checked again with a plain substring test written for this note (whitespace
  collapsed, read line stamps dropped; not the shipped matcher).
  0 of the 42 passed facts failed it.
- The success signal's task count (at least 5 per model) is met by these
  twelve runs. Its "0 mismatches" is met for these runs.

## Why facts were refused

Flags across the twelve runs: `action_without_call` 3, `conclusion_without_fact` 7, `quote_not_in_result` 21.
Read from the exports:

- **Citing the wrong entry.** In `acc20-worker-gate-thresholds` the worker
  checked each quote with `check_quote` against the read (`w5`), then cited the
  `check_quote` calls themselves (`w7`, `w8`, ...) as the source of each fact.
  All nine facts were refused, with the read's text shown as the nearest match.
- **Quotes that were not word for word.** In
  `acc20-worker-worktree-merge-refusals` the worker dropped the double
  backticks around `main` in every quote; all six facts were refused.
- **Honest failure reports refused as action claims.** In
  `acc20-cortex-forbidden-decisions` cortex reported that `ledger_append`
  failed and that `eidetic_remember` was refused, marked those facts as
  actions, and the checker refused them, because an action fact must cite a
  call that succeeded. The statements were true. This is a limit of the
  action rule, not a model error.

## What the models did not do

- **Reply with the rendered answer.** In all twelve runs the final message
  differed from the answer the harness rendered, so it was counted as unchecked
  text (3 to 38 sentences per run). The prompts ask for an exact reply.
- **State a purpose first time, every time.** 7 calls were refused for
  a missing purpose and then repeated with one.

## Did the hand-backs carry the right evidence

For each task with recorded evidence lines, how many of those lines appear
inside a passed fact's quote:

| Task | worker | cortex |
|---|---|---|
| gate-thresholds | 0/8 | 8/8 |
| worktree-merge-refusals | 0/4 | 3/4 |
| read-budget | 4/5 | 4/5 |
| senses-rights | 2/3 | 2/3 |
| forbidden-decisions | 3/3 | 3/3 |

`decider-retry-count` is the not-found task and has no evidence line. Both
models answered it; whether each answer says "not found" was not graded here.

## Enforce mode, two worker runs

| Session | Result |
|---|---|
| `acc20-worker-gate-thresholds-enforce` | `finish` refused in round 1 (a quote not in its entry) and in round 2 (a value not inside its quote), accepted on the third call with 4 facts, 4 passed; 186 s, walk outcome `ok`. |
| `acc20-worker-worktree-merge-refusals-enforce` | The worker made 7 calls and stopped without calling `finish`; 57 s, no hand-back files. |

One run shows a model fixing a refused hand-back inside the allowed rounds.
The other is the known "worker sometimes ends without `finish`" behaviour;
enforce mode does not prevent it.

## An associate review of a real change

The change reviewed is the refusal-cap fix on this branch (the cap counts once
per turn and the outcome is pinned only when the run ends).

| Session | Result |
|---|---|
| `acc20-cortex-review-refusal-cap` | Ended at the 1500 s limit after 77 calls, 53 of them `check_quote`; exit 2, nothing handed back. |
| `acc20-cortex-review-refusal-cap-cont` (a continuation of the run above, `--continue-from`) | Handed back in 129 s after 9 calls: 15 facts made, 14 passed, 1 refused; 4 conclusions accepted, each with an alternative and what refutes it; one open item naming its deciding check. One fact cites the earlier run as `prior:w24`. |

The continuation's report carries 14 `ambiguous_run_label` flags: every bare
walk id that also exists in the prior run is flagged. The flag is noisy in a
continued run.

Reviews made earlier in this work, on the harness as it was before the
accuracy method (no facts, no counts): `accuracy-review-rev1-worker` and its
continuation found four stale version comments, all confirmed and fixed;
`accuracy-review-rev2-worker` and the continuation of
`accuracy-review-rev3-cortex` answered five questions each about the merged
code. A colleague review (a different model) found three checker defects, all
confirmed and fixed with shared test vectors.

## Defects these runs found

- **Refusal cap.** A first smoke run on an earlier commit
  (`acc20-worker-gate-thresholds`, kept apart as a smoke run and replaced by
  the run of the same name above) made four refused calls in one turn, tripped
  the cap, carried on, was accepted, and was still labelled `refused`. Fixed
  before the twelve runs; the fix is the change reviewed above.

## After the move onto main

The twelve runs above were made on harness commit `0ccca36`, on a branch that
did not yet contain the bridge (PR #19). The work was then applied onto `main`
as one change. From that combined tree, one more run:

| Session | Result |
|---|---|
| `acc20-onmain-worker-read-budget` | worker, reasoning off, report mode: handed back, 4 facts made, 4 passed, Python re-check `accepted`, walk outcome `ok`. |

No other run was repeated on the combined tree. The bridge's own surfaces
(`associate runs`, the HTTP API, the web UI) were not exercised with a run
under the accuracy method.

## senses

**Not measured.** `acc20-senses-forbidden-decisions` ended at once with a lane
error from the gateway: the `senses` role "is not feasible on this machine".
No senses run exists under the accuracy method.

## Not measured

- `senses`, on any task.
- Any run with reasoning on, under the accuracy method.
- Enforce mode on `cortex`, and on `worker` beyond the two runs above.
- The mesh resident path (pi-acp); spawned children and delegated runs under
  the accuracy method; a ledger call against a real `ledger` binary.
- Whether a refused call that pi rejects for its arguments is recorded (it is
  unit-tested against a fake pi only).
- Whether each model's unchecked prose answer was correct. The hand-checked
  answers were compared with passed fact quotes only.
- Any rate. Each line above is one run.

## Recommendation on enforce mode

Left to the operator; no model was moved to enforce.

- `cortex`: 35 of 40 facts passed in report mode. Three of the five refusals
  were true failure reports caught by the action rule. Settle that rule first.
- `worker`: 7 of 26 facts passed in report mode. Enforce mode would refuse
  most of its hand-backs; one enforce run recovered in three rounds and one
  ended with no hand-back. Keep it in report mode until the two refusal
  patterns above are addressed in its prompt and measured again.
