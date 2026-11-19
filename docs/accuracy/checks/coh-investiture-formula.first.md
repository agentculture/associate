# First check: `coh-investiture-formula`

- Repository: github.com/agentculture/coherence-cli
- Pinned commit: `a52f7b5be81c636cedcf64535a07cfa878f9be3d`
- Kind: review
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Review how coherence-cli's investiture domain turns meaning values into investiture_score: how are they combined, which values are used, and which of the meaning engine's subdimensions are left out?

## What was run and what it printed

Each command ran in the coherence-cli checkout with `COMMIT=a52f7b5be81c636cedcf64535a07cfa878f9be3d`.

```text
$ git show $COMMIT:coherence/investiture/score.py | grep -n -E 'estimated_investiture =|value \*=|consequence|causality|_MEANING_DENSITY =|_AGENCY_COUPLING ='
25:    estimated_investiture = meaning_score * agency * future_constraint * affordance
39:``consequence`` and ``causality`` (the meaning engine's other two
102:_MEANING_DENSITY = "meaning_density"
103:_AGENCY_COUPLING = "agency_coupling"
157:        value *= numeric_components[name]
```

## Finding

```text
_investiture_score multiplies meaning_density (meaning_score), agency_coupling (agency), future_constraint and affordance; the docstring says consequence and causality are not part of the MVP formula. Recorded answer right.
```

## Recorded answer

```text
It multiplies four values: investiture_score = meaning_density x agency_coupling x future_constraint x affordance, where meaning_density is meaning's meaning_score and agency_coupling is the agency subdimension (coherence/investiture/score.py, _investiture_score). The meaning engine's consequence and causality subdimensions are not part of the formula.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
