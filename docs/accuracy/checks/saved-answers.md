# Saved model answers to the six converted tasks: before and after

The 14 saved answers from the 2026-11-18 t20 live runs (8 worker, 6 cortex; the two `review` runs answer a different prompt and are not tasks of the set). Each answer text is the model's own words, extracted with `associate.measure.answer.model_answer` from the saved result and export (read only, with `python3 -I`; nothing from there was executed). The full texts are in `docs/accuracy/answer-cases.json` (`source` `saved:...`).

Hand judgement: each answer was read against the repository at the pinned commit (see the task's `.first.md`). All 14 are right: each names every value the task asks for, correctly.

| Task | Saved answer | Hand | Before t8 | After t8 | Why it was marked wrong before |
|---|---|---|---|---|---|
| decider-retry-count | t20/worker/decider-retry-count.result.json | right | matches | matches | - |
| forbidden-decisions | t20/worker/forbidden-decisions.result.json | right | matches | matches | - |
| gate-thresholds | t20/worker/gate-thresholds-enforce.result.json | right | does_not_match | matches | missing `irreversible <= 0.2` |
| gate-thresholds | t20/worker/gate-thresholds.result.json | right | does_not_match | matches | missing `irreversible <= 0.2` |
| read-budget | t20/worker/read-budget.result.json | right | matches | matches | - |
| senses-rights | t20/worker/senses-rights.result.json | right | matches | matches | - |
| worktree-merge-refusals | t20/worker/worktree-merge-refusals-enforce.result.json | right | does_not_match | matches | missing `no main branch` |
| worktree-merge-refusals | t20/worker/worktree-merge-refusals.result.json | right | matches | matches | - |
| decider-retry-count | t20/cortex/decider-retry-count.result.json | right | matches | matches | - |
| forbidden-decisions | t20/cortex/forbidden-decisions.result.json | right | matches | matches | - |
| gate-thresholds | t20/cortex/gate-thresholds.result.json | right | does_not_match | matches | missing `safe_unattended >= 0.5`; `destructive <= 0.2`; `exfiltrates <= 0.1`; `matches_task >= 0.5`; `irreversible <= 0.2` |
| read-budget | t20/cortex/read-budget.result.json | right | does_not_match | matches | missing `max_lines 1000`; `max_output_chars 25000`; `max_bytes 1048576`; `spill_to_disk true` |
| senses-rights | t20/cortex/senses-rights.result.json | right | does_not_match | matches | missing one of `may_mutate false` / `"may_mutate": false`; one of `may_delegate ["worker"]` / `"may_delegate": ["worker"]` |
| worktree-merge-refusals | t20/cortex/worktree-merge-refusals.result.json | right | does_not_match | matches | missing `base commit is not on` |

Before t8, 7 of 14 right answers were marked right and 7 were marked wrong. After t8, 14 of 14 are marked right, and every hand-written wrong answer for these tasks (`source` `hand`, `hand_verdict` `does_not_match`, plus the six in `tests/test_measure_tasks.py`) is still marked wrong.

What the widening costs (accepted, recorded in the tasks' first-check notes): in gate-thresholds the values are no longer tied to their question names, and in read-budget the three limits are not tied to their key names, so an answer that swaps two values with each other is marked right. No saved answer does this.
