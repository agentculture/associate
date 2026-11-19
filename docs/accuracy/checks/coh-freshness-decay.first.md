# First check: `coh-freshness-decay`

- Repository: github.com/agentculture/coherence-cli
- Pinned commit: `a52f7b5be81c636cedcf64535a07cfa878f9be3d`
- Kind: read
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

In coherence-cli's quality domain, how does the freshness score fall as a dated statement gets older, and which diagnostic code does a text with no date marker at all get?

## What was run and what it printed

Each command ran in the coherence-cli checkout with `COMMIT=a52f7b5be81c636cedcf64535a07cfa878f9be3d`.

```text
$ git show $COMMIT:coherence/quality/heuristics.py | grep -n -E '_HALF_LIFE_DAYS|0.5 \*\*|no_dateable_statements",\)\)'
17:  :data:`_HALF_LIFE_DAYS`). When a marker is present but no age can be computed,
52:_HALF_LIFE_DAYS = 365.0
311:    return 0.5 ** (age_days / _HALF_LIFE_DAYS)
334:        return ComponentScore(0.0, CONFIDENCE_LOW, ("no_dateable_statements",))
```

## Finding

```text
_decay returns 0.5 ** (age_days / _HALF_LIFE_DAYS), _HALF_LIFE_DAYS = 365.0 (1.0 for age <= 0); no dateable marker gives ComponentScore(0.0, CONFIDENCE_LOW, ("no_dateable_statements",)). Recorded answer right. 365 is a number item with the 365.0 form beside it, since the grader does not find 365 inside 365.0.
```

## Recorded answer

```text
Exponential decay with a half-life of 365 days: _decay returns 0.5 ** (age_days / _HALF_LIFE_DAYS) with _HALF_LIFE_DAYS = 365.0, and 1.0 for an age of zero or less. A text with no dateable marker scores 0.0 at low confidence with the code no_dateable_statements (coherence/quality/heuristics.py).
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
