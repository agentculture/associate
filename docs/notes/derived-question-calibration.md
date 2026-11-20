# The derived-fact question against a labelled set

Measured on 2026-11-20 for plan task t11
(`docs/plans/2026-11-20-associate-strict-facts.md`). A derived fact is a
conclusion that lists the facts it is based on. The lobes decider is asked:
does the conclusion follow from the listed facts, taken together?

**Result: the decider's answer does not separate conclusions that follow from
conclusions that do not well enough to decide a drop.** With five options and
`yes` or `mostly` as the pass, 14 of 28 conclusions with one wrong number
passed, and 41 of 91 real conclusions that two raters called `partly` passed.
The answer is shown beside a derived fact and decides nothing
(`strict.derived_decides_drops` is false).

None of the numbers below is accuracy. They say how the decider's answer went
with two raters' labels, on this set.

## The set

`docs/accuracy/derived-labelled-set.json` holds 342 items in four groups that
are never added together.

| Group | Items | What it is |
|---|---|---|
| `real` | 252 | A conclusion a model handed back, with the values of the facts it named as its basis, from stored exports |
| `planted_swapped_basis` | 40 | A real conclusion beside the listed facts of an item from another run |
| `planted_changed_number` | 30 | A real item with one whole number changed in the conclusion only |
| `planted_negated` | 20 | A real item whose conclusion a script negated in one place: `not` added in 18, removed in 2 |

The real items come from eleven families of stored runs; 88 are from the 36
broad runs of 2026-11-19 and 80 from one batch of harvest runs. 52 exact
duplicates, 10 conclusions whose basis did not resolve and 2 items holding a
machine path were left out. The planted items were built by a seeded script;
each names the items it was made from. Some scripted negations read oddly and
may not be a real contradiction.

Each item is in one of two halves, `development` or `held_out`, by a hash of
its id, fixed when the set was built. Nothing was tuned on either half.

`python3 scripts/derived_set.py shares` prints the counts below from the
committed file.

## The raters

Two models, not people: a Claude model (rater `a`) and a Gemini model through
Antigravity (rater `b`). Each was given the items in one shuffled order with
only an id, the conclusion and the listed facts: no group, no answer of the
decider and not the other rater's labels. Both used
`docs/accuracy/derived-labelling-guideline.md` and the labels `yes`, `partly`
and `no`.

| | Rater a | Rater b |
|---|---|---|
| yes | 144 | 110 |
| partly | 105 | 120 |
| no | 93 | 112 |
| marked borderline | 93 | 97 |

The raters gave the same label to 289 of 342 items, and to 204 of 252 real
items (105 `yes`, 91 `partly`, 8 `no`). An item the raters disagree on is in
no count below. Rater `b` was stricter: 29 real items are `yes` for `a` and
`partly` for `b`.

On the planted items both raters labelled all 40 swapped-basis items `no`.
Rater `b` labelled every changed-number and negated item `no`; rater `a`
labelled 28 of 30 and 17 of 20 `no`.

## What the decider answered

The decider was asked twice on the same items, one item per request, with no
failures: first with three options (`yes`, `partly`, `no`), the form the
contract had that morning, then with the five options the contract has now
(`yes`, `mostly`, `partly`, `little`, `no`; plan deviation d4).

Real items the raters agree on:

| Raters say | Items | Five options: yes / mostly / partly / little / no | Three options: yes / partly / no |
|---|---|---|---|
| yes | 105 | 58 / 40 / 7 / 0 / 0 | 90 / 13 / 2 |
| partly | 91 | 4 / 37 / 50 / 0 / 0 | 16 / 75 / 0 |
| no | 8 | 0 / 0 / 5 / 1 / 2 | 0 / 4 / 4 |

Planted items the raters agree are `no`:

| Group | Items | Five options: yes / mostly / partly / little / no | Three options: yes / partly / no |
|---|---|---|---|
| swapped basis | 40 | 0 / 0 / 10 / 1 / 29 | 0 / 8 / 32 |
| changed number | 28 | 0 / 14 / 8 / 0 / 6 | 0 / 12 / 16 |
| negated | 17 | 2 / 3 / 6 / 1 / 5 | 3 / 8 / 6 |

Read as a pass rule:

| Pass rule | Raters-yes passed | Raters-partly passed | Changed number passed | Negated passed | Swapped basis passed |
|---|---|---|---|---|---|
| Five options, `yes` or `mostly` | 98 of 105 | 41 of 91 | 14 of 28 | 5 of 17 | 0 of 40 |
| Five options, `yes` alone | 58 of 105 | 4 of 91 | 0 of 28 | 2 of 17 | 0 of 40 |
| Three options, `yes` | 90 of 105 | 16 of 91 | 0 of 28 | 3 of 17 | 0 of 40 |

The two halves, real items, five options with `yes` or `mostly` as the pass:

| Half | Raters-yes passed | Raters-partly passed |
|---|---|---|
| development | 52 of 55 | 17 of 47 |
| held_out | 46 of 50 | 24 of 44 |

## What this shows

- A conclusion beside facts about something else is caught: none of the 40
  passed under any rule.
- A wrong number is not caught by the five-option pass. The decider answered
  `mostly` for 14 of 28, so it read a different number as a minor detail.
  Under three options none of those was answered `yes`.
- `mostly` does not tell a conclusion that follows from one that claims more
  than its facts show: it was the answer for 40 of 105 raters-yes items and 37
  of 91 raters-partly items.
- No rule here passes most of what follows and few of what does not. Three
  options with `yes` as the pass comes closest (90 of 105 against 16 of 91),
  and still passes 3 of 17 negated conclusions.
- The option itself carries information a reader can use: of the 62 real
  agreed items answered `yes` under five options, 58 are raters-yes.

## Limits

- Both raters are models, one of them a Claude model. No person labelled the
  set.
- One decider, one day. Every response named its model as `clef`; that is the
  name the gateway gave on that day, not a pin.
- The real items are conclusions from old-form hand-backs (verdicts with a
  basis). No derived fact from a live strict run is in the set, because none
  existed when it was built.
- The request was built by a script that follows the extension's code; the
  contract's redaction filter was not applied to the text.
- The raters labelled with three labels and the decider answered with five, so
  `mostly` and `little` have no label of their own to be compared with.
- The planted items are easier than real conclusions that claim too much, and
  the scripted negations are uneven.
- Eight real items were agreed `no`: too few to read.

## What was decided, and what would change it

The decider's answer to this question is stored and shown beside each derived
fact, with the option named, and it never drops one
(`strict.derived_decides_drops` false; spec claim c36). A derived fact is
dropped only when a fact it lists fails.

Before the answer decides a drop, a setup would have to pass, on the raters'
agreed items of the held-out half, at least 90% of the conclusions that follow
and at most 10% of those labelled `partly` or `no`, with none of the
changed-number items passing. That is the target the support question was held
to. No setup tried here meets it. Candidates not tried: a background text for
this question, as the support question has; sending each listed fact's copied
evidence as well as its value; and asking about numbers in a separate step.
