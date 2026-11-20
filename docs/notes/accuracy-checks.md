# The accuracy checks and the failure behind each

Every check the accuracy method runs on a hand-back is listed in
`associate/contract/accuracy.json` (`checks`), each with the recorded failure
that motivated it. This note is that list in readable form (issue #20, spec
claim c20). A check whose reason no longer holds can be removed; a new check
needs a recorded failure first. The contract test
`tests/test_accuracy_contract.py` fails when a check has no
`motivating_failure`.

`strength` is `refuse` (in enforce mode the hand-back is refused with the fix)
or `flag` (recorded in the report only). In report mode nothing is refused:
the report lists what would have been.

A passed fact means its quote was found in the saved result of the entry it
cites. It does not mean the value is true.

## `unknown_source` (refuse)

A worker cited w19 (an ls of the lib directory) for a claim about walk.ts: it counted its calls, was wrong, and the harness recorded the statement as referenced (live run scope20-worker-t2).

Checker reasons that map to it: `source_malformed`, `source_unknown`.

## `quote_not_in_result` (refuse)

A cited line only had to fall inside a read range, so a sentence that quoted example markers from AGENTS.md was recorded as referenced on w3 and w7 (live run scope20-worker-t2).

Checker reasons that map to it: `quote_absent`.

## `quote_too_short` (refuse)

A one-word quote matches almost any saved result, so a fact could pass without being tied to the entry it cites.

Checker reasons that map to it: `quote_short`.

## `ambiguous_run_label` (flag)

Walk ids restart at w1 in every run, so a continued run's citations of the prior run's ids resolved against the wrong entries and all were recorded as referenced (live run scope20-worker-t5).

Checker reasons that map to it: `ambiguous_reference`.

## `closing_conclusion_unread` (refuse)

A worker closed with 'Nothing was concluded without reading' while its run was marked not_fully_read (live run scope20-worker-t2).

Checker reasons that map to it: `verdict_with_unread`.

## `literal_outside_quote` (refuse)

A fact with value 'version 10' and quote '"version": 9' passes a quote match alone (docs/specs/2026-11-17-associate-accuracy-method.md, scope entry s38).

Checker reasons that map to it: `literal_not_in_quote`.

## `source_is_path` (refuse)

Prior-run and child-run results live outside the session root, and nothing stopped the model naming a location instead of an entry (docs/specs/2026-11-17-associate-accuracy-method.md, scope entry s44).

Checker reasons that map to it: `source_path`.

## `action_without_call` (refuse)

A senses run reported 'Eidetic remember: Success' with no eidetic_remember call in its walk (docs/notes/t20-live-acceptance.md:53, t20 run A2).

Checker reasons that map to it: `action_failed`, `action_tool_missing`, `action_wrong_tool`.

## `conclusion_without_fact` (refuse)

cortex carried 'a content-identical copy of the same table also sits in pyproject.toml' in its finish summary with no fact behind it, from a file it never read (live run scope20-cortex-t1).

Checker reasons that map to it: `basis_refused`, `no_basis`, `unknown_fact`.

## `open_item_undecided` (refuse)

A worker review marked a finding 'CANNOT TELL' with no check that would decide it, carried only in the argument of a failed ledger call (live run scope20-worker-t3).

Checker reasons that map to it: `open_without_check`.

## `closing_conclusion_second_hand` (refuse)

A spawn_subagent hand-back or a delegate_status final_reply is the child model's own account, not something the harness measured (tools/delegate.ts, cited in docs/specs/2026-11-17-associate-accuracy-method.md scope entry s13).

Checker reasons that map to it: `closing_second_hand`.

## The support score (report only; not in `checks`)

The support score is not a check of the list above. It has no entry in
`checks`, no checker reason and no `strength`: it refuses nothing in either
mode and never enters `accepted`, the refusal list or the passed, refused and
unchecked counts. Its settings are in `accuracy.json` under `support_score`
(issue #31; spec `docs/specs/2026-11-18-associate-decider-fact-score.md`,
plan `docs/plans/2026-11-19-associate-decider-fact-score.md`).

**What it asks.** For each fact whose quote was found, the extension can ask
the lobes decider one question: "How much of the value does the quote, on its
own, show?" The decider picks one of five options (`all`, `mostly`, `part`,
`little`, `none`); `all` or `mostly` is reported as the quote supporting the
value. The answer is stored beside the quote check and shown in words. It says
how much of the value the quote shows. It does not say the value is true, and
neither it nor any count of it is accuracy.

**Its state.** The switch (`support_score.enabled`) is off for every model.
The options and the pass rule are tentative. The client, the scoring at
`finish`, the `check_quote` key, the mark in `answer.md` and the per-run switch
are built and unit-tested against a fake decider.

**No motivating failure.** The spec records none and says none is needed while
the score only reports: "a report-only signal with no refusal reason needs no
entry in the checks list and so no motivating failure yet; a real recorded
case of a found quote that does not support its value is needed before it can
ever refuse". What the spec starts from is a statement about the quote check,
not a recorded run: "it cannot tell whether the quote supports the value, so a
fact with a real quote and a wrong value passes".

**Measured: the labelled set** (2026-11-19,
`docs/notes/support-score-calibration.md`). 554 value-and-quote pairs (454
real, 60 with a planted wrong value, 40 with text addressed to the scorer),
each labelled by two model raters; no person labelled the set. The two raters
gave the same label to 405 of the 454 real pairs (253 supported, 152
unsupported).

| Setup, on real pairs | Supported pairs passed | Unsupported pairs passed |
|---|---|---|
| Yes/no question, cut-off 0.5 (first labels) | 275 of 309 (89.0%) | 35 of 113 (31.0%) |
| Five options with the background, `all` or `mostly` passes | 229 of 253 (90.5%) | 12 of 152 (7.9%) |
| The same, development half | 106 of 120 (88.3%) | 8 of 64 (12.5%) |
| The same, held-out half | 123 of 133 (92.5%) | 4 of 88 (4.5%) |

The spec's target was at least 90% of supported pairs and at most 10% of
unsupported pairs passed. **The target is not met as specified.** The whole
set reads 90.5% and 7.9%, and the development half 88.3% and 12.5%. No part of
the set is a held-out result, because the wording was written after looking
at it, and both raters are models. Of the 60 planted wrong values, 1 passed. Of the 20
wrong pairs whose quote ends with a plea for yes, none passed. The background,
the labelling guideline and the five options were all written after looking at
pairs of this set. These shares say how often the decider's answer went with
the two raters' labels on this set, and nothing more.

**Measured: six broad tasks** (2026-11-19,
`docs/notes/support-score-broad-measurement.md`). 36 `worker` runs in report
mode with reasoning on, three per repository per arm, with the score off and
on. Result under the committed rule
(`docs/accuracy/broad-difference-threshold.md`): no difference shown, on
checklist facts marked as stated or on statements counted false, on both
gradings. The 1,657 statements were graded by model graders, not by a person:
the Claude grading counts 71 false, the Gemini grading 150. In the 18 runs with
the score on the decider answered for 98 facts: `part` 39, `all` 35, `little`
14, `mostly` 10, `none` 0. About nine in ten statements graded false are in
the model's unchecked text, which no check reads.

**Not measured.**

- Any labelling or grading by a person.
- A run with the score on for `senses`, with reasoning off, in enforce mode,
  on the mesh path, in a spawned child or in a delegated run: none is
  recorded. For `cortex` there is one run and no more (below).
- More than one decider on one day, and more than three runs per repository
  per arm.
- How often a model passed a value to `check_quote` in the measured runs: the
  note does not give it.
- Whether a fact the decider passes is true. In the broad measurement the
  statements matched to a passed fact were graded true 54 times and false 5
  times, and those matched to a `part` or `little` answer 63 and 6, by a text
  match made after the fact.

One `cortex` run with the score on was recorded on 2026-11-20 (report mode,
reasoning on, harness at 0.14.2 before release, one small task: read
`accuracy.json` and report three settings). It handed back 3 facts, the quote
of each was found, and the decider answered `all` for all 3; `check.json`
holds a `support` record for each and `report.json` says `support_scored` 3.
It is one run on an easy task. It shows the files are written on `cortex`,
and nothing about how the answers go on harder facts.
