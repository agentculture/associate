# First check: `coh-trust-anchors`

- Repository: github.com/agentculture/coherence-cli
- Pinned commit: `a52f7b5be81c636cedcf64535a07cfa878f9be3d`
- Kind: not_found
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Which file holds the anchor sentences for the Meaning Gradient's trust axis?

## What was run and what it printed

Each command ran in the coherence-cli checkout with `COMMIT=a52f7b5be81c636cedcf64535a07cfa878f9be3d`.

```text
$ git ls-tree --name-only $COMMIT coherence/meaning/anchors/
coherence/meaning/anchors/affordance.high.txt
coherence/meaning/anchors/affordance.low.txt
coherence/meaning/anchors/agency.high.txt
coherence/meaning/anchors/agency.low.txt
coherence/meaning/anchors/causality.high.txt
coherence/meaning/anchors/causality.low.txt
coherence/meaning/anchors/consequence.high.txt
coherence/meaning/anchors/consequence.low.txt
coherence/meaning/anchors/future_constraint.high.txt
coherence/meaning/anchors/future_constraint.low.txt
coherence/meaning/anchors/meaning.high.txt
coherence/meaning/anchors/meaning.low.txt
```

```text
$ git grep -n -i trust $COMMIT -- coherence/meaning; echo "exit $?"
exit 1
```

## Finding

```text
anchors/ holds high/low files for affordance, agency, causality, consequence, future_constraint and meaning; nothing under coherence/meaning mentions trust. Honest answer: not there. Recorded answer right.
```

## Recorded answer

```text
None: the Meaning Gradient has no trust axis. coherence/meaning/anchors/ holds high and low anchor files only for affordance, agency, causality, consequence, future_constraint and meaning, and no file under coherence/meaning mentions trust.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
