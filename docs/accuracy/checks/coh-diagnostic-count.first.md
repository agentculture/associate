# First check: `coh-diagnostic-count`

- Repository: github.com/agentculture/coherence-cli
- Pinned commit: `a52f7b5be81c636cedcf64535a07cfa878f9be3d`
- Kind: count
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

How many diagnostic codes does the message catalog in coherence-cli's quality heuristics module define, and what are they?

## What was run and what it printed

Each command ran in the coherence-cli checkout with `COMMIT=a52f7b5be81c636cedcf64535a07cfa878f9be3d`.

```text
$ git show $COMMIT:coherence/quality/heuristics.py | sed -n '/^DIAGNOSTIC_MESSAGES/,/^}/p' | grep -n -E '^    "[a-z_]+": \($'
2:    "no_dateable_statements": (
7:    "age_not_derivable": (
12:    "publication_date_unverified": (
16:    "source_liveness_unverified": (
20:    "no_source_attribution": (
24:    "quote_accuracy_unverified": (
28:    "no_verbatim_signal": (
```

## Finding

```text
DIAGNOSTIC_MESSAGES holds 7 codes: no_dateable_statements, age_not_derivable, publication_date_unverified, source_liveness_unverified, no_source_attribution, quote_accuracy_unverified, no_verbatim_signal. Recorded answer right. (quality/score.py also names rule_based_no_embedding_frame, a frame reason, not a catalog entry.)
```

## Recorded answer

```text
7 codes in DIAGNOSTIC_MESSAGES (coherence/quality/heuristics.py): no_dateable_statements, age_not_derivable, publication_date_unverified, source_liveness_unverified, no_source_attribution, quote_accuracy_unverified, no_verbatim_signal.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
