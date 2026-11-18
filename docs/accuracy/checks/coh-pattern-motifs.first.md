# First check: `coh-pattern-motifs`

- Repository: github.com/agentculture/coherence-cli
- Pinned commit: `a52f7b5be81c636cedcf64535a07cfa878f9be3d`
- Kind: find
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Which motifs does `coherence signal pattern` detect, and in which module are they defined?

## What was run and what it printed

Each command ran in the coherence-cli checkout with `COMMIT=a52f7b5be81c636cedcf64535a07cfa878f9be3d`.

```text
$ git show $COMMIT:coherence/signal/pattern.py | grep -n -E '^MOTIF_[A-Z_]+ ='
89:MOTIF_INCREASING = "increasing"
90:MOTIF_DECREASING = "decreasing"
91:MOTIF_PLATEAU = "plateau"
92:MOTIF_SPIKE = "spike"
93:MOTIF_REVERSAL = "reversal"
94:MOTIF_STAIR_STEP = "stair_step"
```

## Finding

```text
Six motifs in coherence/signal/pattern.py: increasing, decreasing, plateau, spike, reversal, stair_step. Recorded answer right.
```

## Recorded answer

```text
Six motifs, defined in coherence/signal/pattern.py: increasing, decreasing, plateau, spike, reversal and stair_step (MOTIF_INCREASING ... MOTIF_STAIR_STEP).
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
