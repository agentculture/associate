# Disagreements between the two checks

The second check was done on 2026-11-18 by a separate agent. It was given the
24 prompts with each task's id, repository and pinned commit, and a clone of
each repository at that commit with `docs/accuracy` removed. It was not given
the first check, the recorded answers or the expected values.

## How the two were compared

1. The `Answer` section of each `<task-id>.second.md` was marked by the answer
   check against the task's expected values. All 24 were marked as matching.
2. Six second answers were read beside the recorded answer of the first
   check: `spawn-holders`, `spawn-writer-limit-env`, `coh-url-check-timeout`,
   `wl-since-precision`, `coh-freshness-decay` and `coh-resonance-sign`. Each
   says the same thing as the recorded answer.

The other 18 were compared by the answer check only, not read side by side.

## Disagreements

None were found, so none is unsettled.

## Doubts the second checker stated

These are not disagreements; they are recorded because they bear on how a
model's answer may be marked.

- `worktree-merge-refusals`: the docstring lists four conditions. The code
  also keeps a run that is not clean, which an answer could count as a fifth.
- `gate-thresholds`: the reversibility question is a choice, and its threshold
  applies to the `irreversible` option. Both checks counted it as one of five.
- `decider-retry-count`: both checks found no retry. An answer that treats the
  fall through to the next tier as a retry would be a different reading.
- `spawn-writer-limit-env`: the second checker's wide search was blocked by
  its sandbox, so it read the spawn tool, the policy file and the contract
  files one by one. Its confidence was medium.
