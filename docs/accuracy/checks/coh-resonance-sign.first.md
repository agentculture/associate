# First check: `coh-resonance-sign`

- Repository: github.com/agentculture/coherence-cli
- Pinned commit: `a52f7b5be81c636cedcf64535a07cfa878f9be3d`
- Kind: read
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

What statistic does `coherence signal resonance` compute for each pair of fields, and what sign of it is reported as interference?

## What was run and what it printed

Each command ran in the coherence-cli checkout with `COMMIT=a52f7b5be81c636cedcf64535a07cfa878f9be3d`.

```text
$ git show $COMMIT:coherence/signal/resonance.py | grep -n -E 'Pearson|\*\*negative\*\*|\*\*positive\*\*|NEUTRAL_BAND ='
7:Pearson correlation over the points where both fields are present — and the
10:* **positive** alignment → the fields reinforce each other → ``"resonance"``
11:* **negative** alignment → the fields conflict → ``"interference"``
24:A Pearson correlation is only meaningful when both fields actually vary and
69:# a Pearson correlation means anything more than a coincidence of few points.
79:NEUTRAL_BAND = 0.1
131:    """Return the Pearson correlation of ``xs``/``ys``, or ``None`` if non-finite.
```

## Finding

```text
One signed Pearson correlation per pair over the common points; positive is resonance, negative is interference, |r| <= NEUTRAL_BAND (0.1) is neutral. Recorded answer right.
```

## Recorded answer

```text
One signed Pearson correlation per field pair, over the points where both fields are present (coherence/signal/resonance.py, _alignment). A positive value is resonance, a negative one is interference, and values within the neutral band (|r| <= 0.1) are neutral.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
