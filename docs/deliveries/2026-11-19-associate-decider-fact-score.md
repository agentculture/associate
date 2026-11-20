# Delivery Summary — associate decider fact score

plan: `associate-decider-fact-score` · run: `partial` · date: `2026-11-19`
baseline: `devague summary skeleton`

## Intent

> associate scores each reported fact with the decider: for every fact whose quote was found, it asks whether the quote supports the value and records the answer beside the quote check, so a reader and the model itself can tell a backed claim from a merely cited one

After: a finished run's files say, for each fact whose quote was found, whether the decider judged the quote to support the value, with the score, or that it was not scored; the model can get the same judgement during the run from `check_quote`; nothing is refused on it

The run is `partial`. The support score is built, unit-tested and was used in live runs. The labelled-set target (spec claim c19) is not met as specified. The broad measurement (c20) ran on `worker` and shows no difference, graded by models and not by a person. The switch is off for every model. The plan is `docs/plans/2026-11-19-associate-decider-fact-score.md`, from the spec `docs/specs/2026-11-18-associate-decider-fact-score.md` (issue #31).

## Planned Work

Quoted verbatim from the `devague summary` skeleton:

- `t1` — Contract settings for the support score
- `t2` — The support-score client
- `t3` — Score at finish, stored beside the quote check
- `t4` — `check_quote` returns the support score
- `t5` — The rendered answer shows both signals
- `t6` — Python side copies the score from the export
- `t7` — A per-run switch for the score, usable as a measurement arm
- `t8` — Prompts name `check_quote` as the way to learn the score
- `t9` — Labelled set, cut-off and calibration note
- `t10` — Six broad tasks with twice-checked fact checklists
- `t11` — Grading tools for the broad tasks
- `t12` — Live runs and the measurement
- `t13` — Docs, wording check, lobes-cli issues and release

## Actual Delivery

Ten tasks are delivered and three are partial. None is dropped or blocked.

| Plan task | Status | What actually landed |
|-----------|--------|----------------------|
| `t1` | delivered | `associate/contract/accuracy.json` gains a `support_score` section: the question, a background, five options with their wording, which answers pass, a per-fact timeout, a cap on scored facts, a total time and a switch per model. A test fails on a setting written as a literal in code. The planned cut-off became the list of passing answers (d4). Every model stays in report mode with the switch off. |
| `t2` | delivered | `.pi/extensions/associate/lib/support.ts`: a client of its own, not the gate's path. A missing key, a timeout, a non-2xx answer and a malformed answer are each recorded as not scored. Value and quote are redacted first; an empty or over-long pair is not sent; a scored pair is asked once in a session. It asks a five-option question, not the planned yes/no question (d4). |
| `t3` | delivered | At `finish`, `check.json` gains `facts[i].support` for each quote-found fact and `report.json` gains `support_scored` and `support_answers`. With the score off no file changes by a byte. Nothing is refused or retried on an answer. `finish` writes its files first and writes them again with the answers. |
| `t4` | delivered | `check_quote` takes an optional `value` and adds one `support` key, in plain words, when the quote is found and the score is on. The other keys are unchanged. |
| `t5` | delivered | `answer.md` shows a second, separate mark on a scored fact and a legend line saying neither mark means the value is true. The mark is in words and never a number; the plan asked for the score to be shown (d4). |
| `t6` | delivered | `associate run --json` and `associate check` show each answer copied from the export, labelled `support_source: extension`. The Python side makes no network call for it. An export without the answer still loads. |
| `t7` | delivered | `associate run --support-score on\|off` (variable `ASSOCIATE_SUPPORT_SCORE`, set per run, never inherited). An arm in a measure arms file can carry the setting, and each stored run names it. |
| `t8` | delivered | The model prompts say `check_quote` returns whether the quote supports the value and that the model should use it before `finish`. A test reads the prompt files. |
| `t9` | partial | `docs/accuracy/support-labelled-set.json`: 554 pairs (454 real, 60 with a planted wrong value, 40 with text addressed to the scorer), two labels each from two model raters. `scripts/support_shares.py` computes the shares. `docs/notes/support-score-calibration.md` records three rounds. The target of 90% and 10% is not met as specified: the whole set gives 90.5% and 7.9% on real pairs, the development half 88.3% and 12.5%, both raters are models, and the wording was written after looking at the set. The served model is recorded only as the name the gateway gave. |
| `t10` | delivered | `docs/accuracy/broad-tasks.json`: one explanation task for each of six pinned repositories, 71 checklist facts (11 or 12 per repository), each written by one checker and answered again by a second. Both checkers were model subagents. One fact was dropped and the file records why. |
| `t11` | delivered | `associate measure run --broad`, `measure sheet`, `measure sheet-check` and `measure report`. The sheet hides the arm; a statement counted false needs a file and line; a real run is refused while the difference rule is a draft, missing or modified. A run that ended without `finish` is read from its whole last message (d1). |
| `t12` | partial | 36 `worker` runs in report mode, three per repository per arm, score off and on (`docs/notes/support-score-broad-measurement.md`). Under the committed rule no difference is shown on either count. In the 18 runs with the score on the decider answered for 98 facts. Two rounds of trial runs, one run per repository per round, came first. Not as planned: no person graded (d5); the facts-stated count is a word match that was not read by hand (l3); the second trial round changed harness code part way (l2). The cortex run the first acceptance criterion asks for: One `cortex` run with the score on was made on 2026-11-20, during the closing work and after PR 40 merged (report mode, reasoning on, one small read task): 3 facts, each quote found, each answered `all`; `check.json` holds a `support` record for each (`docs/notes/accuracy-checks.md`, last paragraph). It is one run on an easy task; its export is committed as `tests/fixtures/accuracy/cortex_support_score_on_export`. |
| `t13` | partial | `tests/test_support_wording.py`, the support-score section of `docs/notes/accuracy-checks.md`, `CLAUDE.md`, the changelog entries 0.14.0 to 0.14.2 and the version bumps. Of the four lobes-cli needs the plan lists, one is filed as an issue and three are not (d6). No commit touched lobes-cli. This record closes the task. PR to be opened from `clef/decider-close`. |

## Mid-work Decisions

- `d1` — t11/t12: a broad run that ends without finish is graded on its full final message, read from the export, not on the 2000-character final reply; the report shows per arm how many runs ended without finish. The reminder to call finish is not built here; it is a separate issue — Operator, 2026-11-19: 'I prefer we don't have to rely on the model's opinion. For now, option 1. Open issue for option 2.' 2 of 6 trial runs ended without finish
- `d2` — The planned measurement (t12) runs although the labelled set did not meet the 90% and 10% target, and before it the scorer's setup is improved (background for the decider, question wording, a review of the labelled pairs) and re-measured on the set. — Operator, 2026-11-19: run the planned measurement; improve the setup so results are better. The switch stays off by default.
- `d3` — The harness reminds a model once to call finish when its task turn ends without it (issue 38), built inside this plan. Not in the confirmed plan. — Operator, 2026-11-19: go on the finish reminder. Two of six broad trial runs ended without finish. A live check showed pi 1.5.2 in headless JSON mode continues after one reminder returned from `agent_before_settle`.
- `d4` — The support check asks the decider a five-option question (all, mostly, part, little, none) with a background, in place of a yes/no probability cut at a number. A fact passes when the answer is all or mostly. The model is shown the option, not a number. — Operator, 2026-11-19: approved after the labelled set showed the yes/no score at 0.5 passing about a third of unsupported real pairs; with the background and five options, 229 of 253 supported and 12 of 152 unsupported real pairs passed.
- `d5` — t12's statements were graded by model graders, not by hand: two blind Claude graders with a third for 121 statements, and one outside grader (Antigravity on a Gemini model) over all 1,657; the Gemini grading is the main reading with the Claude grading beside it; no person graded — Operator, 2026-11-19: 'subagent graders as with labelling'; then 'You also have agy (Antigravity - google) to run agent as judge'; then accepted the recommendation to take Gemini's stricter reading as the main one
- `d6` — Of the four needs t13 lists for lobes-cli, one is filed as an issue (lobes-cli 344: measure decider builds on associate's two evidence-question sets, published as the private dataset culture-dev/associate-evidence-questions). Priority between callers is not filed. Several states per request is not filed: a test on 2026-11-20 showed 24 requests take about 21 seconds whether 1, 4 or 8 are in flight, and 9 of 24 get 503 when all 24 are in flight. Naming the served model is not decided. — Operator decisions of 2026-11-20: only one decider model exists, so the calibration need becomes a dataset lobes can measure on; no priority issue; batching saves only the network round trip.

Decisions that no deviation record covers:

- The finish reminder was first merged with a guard that never let it fire on pi 1.5.2, and was fixed after a trial run ended without `finish` and without a reminder. — Lapse l1 (approved). The guard came from reading pi's documentation, and the unit tests used a fake event.
- The labelled set was labelled twice. A guideline (`docs/accuracy/support-labelling-guideline.md`) was written after the first labelling and both raters labelled every pair again, blind. — The raters differed mostly on two things the first instructions left open (`docs/notes/support-score-calibration.md`). The first labels are kept in the set under `earlier`.
- `accuracy.json` stays at version 1 with the `support_score` section added. — The section is optional and a file without it reads as score off (`CHANGELOG.md`, 0.14.0).
- After one unreachable, timed-out or refused request, the rest of that call's pairs are not sent and are recorded as `skipped_after_failure`. — Stated in `CHANGELOG.md` (0.14.0); the sources read for this record give no reason.
- `finish` writes its files and ends the session before it asks for any answer, then writes them again. — Stated in `CHANGELOG.md` (0.14.0); the sources read for this record give no reason.
- The wording test found two sentences from 0.12.0 (a description in `report.schema.json`, a docstring in `associate/harness/pi.py`). Both were reworded in 0.14.2. — Neither changes what a schema accepts or what the code does.
- A Codex grader was tried for t12 and did not run. — Its sandbox does not start on the measuring machine (`docs/notes/support-score-broad-measurement.md`).
- The measurement's follow-up became its own work: issue #39 (strict facts), with its own spec and plan. — About nine in ten statements graded false were in the model's unchecked text, which the support score does not read.

## Drift From Plan

The first six entries are the approved deviation records, with their reason and classification as recorded. The five after them are drift no deviation record covers; their classification is this record's.

| Plan item | Reason for divergence | Classification |
|-----------|------------------------|-----------------|
| `t12` (`d1`) | Operator, 2026-11-19: 'I prefer we don't have to rely on the model's opinion. For now, option 1. Open issue for option 2.' 2 of 6 trial runs ended without finish | `acceptable` |
| `t9` (`d2`) | Operator, 2026-11-19: run the planned measurement; improve the setup so results are better. The switch stays off by default. | `risky` |
| `t12` (`d3`) | Operator, 2026-11-19: go on the finish reminder. Two of six broad trial runs ended without finish. A live check showed pi 1.5.2 in headless JSON mode continues after one reminder returned from `agent_before_settle`. | `risky` |
| `t9` (`d4`) | Operator, 2026-11-19: approved after the labelled set showed the yes/no score at 0.5 passing about a third of unsupported real pairs; with the background and five options, 229 of 253 supported and 12 of 152 unsupported real pairs passed. | `risky` |
| `t12` (`d5`) | Operator, 2026-11-19: 'subagent graders as with labelling'; then 'You also have agy (Antigravity - google) to run agent as judge'; then accepted the recommendation to take Gemini's stricter reading as the main one | `acceptable` |
| `t13` (`d6`) | Operator decisions of 2026-11-20: only one decider model exists, so the calibration need becomes a dataset lobes can measure on; no priority issue; batching saves only the network round trip. | `acceptable` |
| `t9` (claim c19) | The labelled-set target is not met as specified. Evidence e6 is filed as `fail` (proposed, not yet confirmed by the operator). The whole set gives 90.5% and 7.9% on real pairs; the development half gives 88.3% and 12.5%; both raters are models; the wording was written after looking at the set, so no part of it is a held-out result. | `needs-follow-up` |
| `t12` (lapse `l3`) | The checklist facts marked as stated are a first marking by word match that was not read by hand. `docs/accuracy/broad-difference-threshold.md` says every marking is read by hand. | `risky` |
| `t12` (lapse `l2`) | The second round of trial runs changed harness code part way: its first two runs used the reminder that could not fire, the later ones the fixed one. The strictness of the difference rule rests on these two rounds. | `risky` |
| `t12` (first acceptance criterion) | The criterion asks for one live run with the score on for `cortex`. None was in the record when PR 40 merged; the 18 runs with the score on are all `worker`. One was made during the closing work, on 2026-11-20; its result is in the `t12` row above. The criterion is met late, by one run. | `acceptable` |
| `t12` (the measurement note) | Two tables of `docs/notes/support-score-broad-measurement.md` match statements to facts by text similarity, done after the runs. A later count by the structure of the answer gives different numbers (see Remaining Work). The note is not yet corrected. | `needs-follow-up` |

## Evidence

- tests: `uv run pytest -n auto -q` on the closing branch on 2026-11-20 — 2093 passed at `a4d6ccc`; after the review fixes of `6ecc877` and the export fixture, see the PR's checks for the count at its head
- tests: `uv run pytest -q tests/test_support_wording.py` on the same tree — pass
- tests: `bash .pi/extensions/associate/tests/run.sh` — started for this record; it stalled and was stopped after about ten minutes, so no result is given here. The four support test files are covered by the proposed evidence below.
- script: `python3 scripts/support_shares.py` on the committed set, run for this record — real pairs: 229 of 253 supported passed (90.5%), 12 of 152 unsupported passed (7.9%); planted wrong values: 1 of 60 passed
- lint: `markdownlint-cli2 docs/deliveries/2026-11-19-associate-decider-fact-score.md` with the repository's config — 0 errors
- live: 36 `worker` runs and their gradings, `docs/notes/support-score-broad-measurement.md` and `docs/accuracy/broad-graded-statements.json`; they were not repeated for this record
- commits: `a06884a..a4d6ccc` — `eae1b7d` (0.14.0), `60c3975` (0.14.1), `a4d6ccc` (0.14.2, on `clef/decider-close`)
- PRs / issues: #37 (merged by the operator, squash, 0.14.0), #40 (merged by the operator, squash, 0.14.1); PR to be opened from `clef/decider-close` for 0.14.2; issue #31 (this work, open), #29 (the offline replay), #38 (the finish reminder), #39 (strict facts, separate work); [lobes-cli 344](https://github.com/agentculture/lobes-cli/issues/344) (open)
- proposed evidence, filed by an agent in `.devague/deliveries/associate-decider-fact-score.json` and not yet confirmed by the operator. The obligations `o1` to `o7` they answer are also still proposed:
  - `e1` (o1, claim c2) — `.pi/extensions/associate/tests/support-finish.test.ts`, 23 tests against a fake decider — pass
  - `e2` (o2, claim c3) — `.pi/extensions/associate/tests/support.test.ts`, 38 tests against a fake decider — pass
  - `e3` (o3, claim c6) — `.pi/extensions/associate/tests/check-support.test.ts`, 19 tests against a fake decider — pass
  - `e4` (o4, claim c7) — `.pi/extensions/associate/tests/render-support.test.ts`, 11 tests — pass
  - `e5` (o5, claim c23) — `tests/test_support_wording.py`, 72 cases at `a4d6ccc`; shown to fail on planted bad sentences — pass. Superseded by `e8`: the test was rewritten in `6ecc877` after a code review found it too loose (24 bad and 22 good sentences, 115 cases)
  - `e6` (o6, claim c19) — `scripts/support_shares.py` on the committed set — **fail**
  - `e7` (o7, claim c20) — the measurement note and the graded statements, read and not re-run — pass, with the limits of d5 and l3
- proposed behaviour deltas, also not yet confirmed: `b1` (amended: the five-option question, from d4), `b2` (added: the finish reminder, from d3; it names no evidence), `b3` (amended: model graders, from d5)

## Delivery Claims

A passed fact means its quote was found. A support answer says how much of the value the quote shows. Neither says the value is true, and no count in this record is accuracy.

"Built and unit-tested" below means tested against a fake decider or a fake pi. Evidence `e1` to `e7` is proposed, not confirmed.

| Claim | Confidence | Evidence |
|-------|------------|----------|
| `c2` — at `finish` the extension asks the decider one question per quote-found fact and stores the answer per fact in `check.json` and counts in `report.json`; the answer never enters `accepted`, the refusal list or the passed, refused and unchecked counts. Built and unit-tested; 98 facts were answered in 18 live `worker` runs. | `high` | `.pi/extensions/associate/tests/support-finish.test.ts` (e1, proposed); `docs/notes/support-score-broad-measurement.md` |
| `c3`, `c22`, `c25`, `c27`, `c28` — the client is its own path (no Super tier, no fallback, no gate line); each failure is recorded as not scored; calls are bounded by the contract; pairs are redacted, asked once in a session, and not sent when empty or over-long. Built and unit-tested. | `high` | `.pi/extensions/associate/tests/support.test.ts` (e2, proposed) |
| `c4` — the question, the options, the passing answers, the timeout, the caps and the per-model switch live in `accuracy.json` and its schema, not in code. The cut-off the claim names was replaced by the passing answers (d4). | `high` | `tests/test_support_score_contract.py`; `associate/contract/accuracy.json` |
| `c5` — the Python side copies the answer from the export with a label naming the extension, calls no decider, and loads an export without it. | `high` | `tests/test_support_copy.py` |
| `c6` — `check_quote` returns the support answer as one added key and its other keys do not change. Built and unit-tested. How often a model passed a value to it in the live runs is not recorded. | `medium` | `.pi/extensions/associate/tests/check-support.test.ts` (e3, proposed) |
| `c7` — the rendered answer marks each scored fact with both signals separately. The mark is in words, not a number (d4). Built and unit-tested. | `high` | `.pi/extensions/associate/tests/render-support.test.ts` (e4, proposed) |
| `c8` — the hand-back check and the matcher import no module that makes a network call; the shared vectors pass unchanged. | `high` | `.pi/extensions/associate/tests/support-finish.test.ts` (the two `AC5` tests) |
| `c9` — no model is in enforce mode, the switch is off for every model, and nothing is refused on a support answer. | `high` | `associate/contract/accuracy.json` (`mode`, `support_score.enabled`); `tests/test_support_score_contract.py` |
| `c29` — the prompts name `check_quote` as the way to learn the answer during a run and promise no second chance after `finish` in report mode. | `high` | `.pi/extensions/associate/tests/prompt-support.test.ts` |
| The per-run switch (`--support-score`, plan task t7) overrides the contract for one run and can be a measurement arm. It was used for the 36 measured runs. | `high` | `.pi/extensions/associate/tests/supportswitch.test.ts`; `tests/test_run_accuracy.py`; `tests/test_measure_runner.py` |
| `c19` as specified — the decider's answer passes at least 90% of supported and at most 10% of unsupported real pairs on a set labelled by two raters. **Not met as specified, and not claimed.** | `unverified` | e6 (proposed, outcome `fail`); `docs/notes/support-score-calibration.md` |
| The labelled set is committed (554 pairs, 454 real) and its shares can be recomputed: 229 of 253 supported and 12 of 152 unsupported real pairs passed; 106 of 120 and 8 of 64 on the development half; 123 of 133 and 4 of 88 on the held-out half. Both raters are models. | `medium` | `docs/accuracy/support-labelled-set.json`; `scripts/support_shares.py` (run for this record); `tests/test_support_shares.py` |
| `c21` — the question, the options and the passing answers in the contract are the ones measured on the set, and the note records the set, the raters and the wording. The served model is recorded only as `clef`, the name the gateway gave, so a change of what serves it cannot be seen (open item v3). | `medium` | `docs/notes/support-score-calibration.md`; `associate/contract/accuracy.json` |
| `c26` — the set includes pairs with text addressed to the scorer and reports them apart: none of the 20 wrong pairs with a plea for yes passed. Twenty pairs, one decider, one day. | `medium` | `docs/notes/support-score-calibration.md`; `docs/accuracy/support-labelled-set.json` |
| Six broad tasks with 71 checklist facts are committed, each fact checked by a second checker. Both checkers were model subagents. | `medium` | `docs/accuracy/broad-tasks.json`; `tests/test_measure_broad.py` |
| The grading tools (blind sheet, sheet check, per-run report, the refusal without a confirmed rule) are built, unit-tested and were used on the 36 runs. | `high` | `tests/test_measure_sheet.py`; `tests/test_measure_broad_command.py`; `docs/accuracy/broad-graded-statements.json` |
| `c20` — 36 `worker` runs, three per repository per arm; under the committed rule no difference is shown on either count, on both gradings. Capped: no person graded (d5), and the facts-stated count was not read by hand (approved lapse l3, `grader-unverified`). It does not show that there is no difference. | `low` | `docs/notes/support-score-broad-measurement.md` (e7, proposed); `docs/accuracy/broad-difference-threshold.md` |
| About nine in ten statements graded false were in the model's unchecked text. Capped: it rests on a table built by text matching, and a later count by structure gives different numbers that are not yet in the note. | `low` | `docs/notes/support-score-broad-measurement.md` ("Where the false statements are"); issue #39 |
| A passed support answer goes with a true statement more often than a failed one. **Not claimed.** The note's table (54 true and 5 false against 63 and 6) shows no clear gap and rests on the same text matching. | `unverified` | `docs/notes/support-score-broad-measurement.md` ("What the decider answered") |
| `c23` — no text of this work calls the support score or a count of it accuracy. The test is by sentence and by word; it does not see a claim made through a pronoun alone in a mixed file. | `high` | `tests/test_support_wording.py` (e5, proposed; run for this record) |
| `c24` — nothing in lobes-cli is changed, and each need is an issue there. Partly met: one issue filed; priority between callers and several states per request not filed by the operator's decision; naming the served model undecided. That no commit touched lobes-cli is stated by the session that ran the work and was not checked against that repository for this record. | `low` | deviation d6; [lobes-cli 344](https://github.com/agentculture/lobes-cli/issues/344); `CHANGELOG.md` (0.14.2) |
| The finish reminder (d3, delta b2) is built and unit-tested against a fake pi. Capped by approved lapse l1 (`assumption-for-measurement`): its first merged form could not fire. The measurement note says one run in each arm was reminded and every run ended with an accepted `finish`; `CLAUDE.md` said until 0.14.2 that a `finish` after a reminder had not been seen, and now gives the note's two runs. The two reminded runs were not re-read from the stored exports for this record. | `low` | `.pi/extensions/associate/tests/finish-reminder.test.ts`; `tests/test_finish_reminder_run.py`; `docs/notes/support-score-broad-measurement.md` |
| The export holds `final_message.md`, and a broad run without `finish` is graded on it (d1). Built and unit-tested against a fake pi. None of the 36 measured runs ended without `finish`, so the path was not used in the measurement. | `medium` | `.pi/extensions/associate/tests/final-message.test.ts`; `tests/test_measure_broad_answer.py` |
| The support score on `cortex`, `senses`, with reasoning off, in enforce mode, on the mesh path, in a spawned child or in a delegated run. Not measured, apart from the one `cortex` run in the `t12` row. | `unverified` | (no evidence — not claimed) |
| Whether end-of-run scoring delays safety-gate calls of other sessions (open item v2). Not measured. | `unverified` | (no evidence — not claimed) |

Lapse ledger evidence:

| Lapse | Code | What |
|-------|------|------|
| `l1` | `assumption-for-measurement` | The finish reminder was merged with a guard that never lets it fire on pi 1.5.2: it skipped the reminder when the settle event said canContinue false, which pi reports on every ordinary settle. The guard came from reading pi's documentation; the unit tests used a fake event with canContinue true. Found when a trial run ended without finish and without a reminder. |
| `l2` | `instrument-changed-mid-series` | The second round of trial runs changed harness code part way: runs 1 and 2 (workledger-cli, coherence-cli) used the reminder that could not fire; later runs use the fixed one. |
| `l3` | `grader-unverified` | the checklist facts marked as stated in the t12 report are a word-match first marking that was not read by hand, though the report says every marking is read by hand |

All three lapses are approved. `l1` caps the finish reminder claim, `l2` the trial runs behind the difference rule, and `l3` claim c20.

## Remaining Work / Follow-up

- `t9`: the labelled-set target (c19) is not met as specified. — A result that counts needs pairs the wording was not written from, and labels from a person. Not planned in this record; the switch stays off until the operator decides. The options and the pass rule stay tentative.
- `t12`: the `cortex` run with the score on is one run on an easy task. — A run on a task with harder facts is still owed before anything is said about how the answers go on `cortex`.
- `t12`: no person graded a statement, and the facts-stated count was not read by hand (l3). — Open. Of the 97 statements the two gradings differ on, the cited lines of 43 were read by the measuring session and 54 were not.
- `t12`: a correction owed to `docs/notes/support-score-broad-measurement.md`. — Attributing statements to facts by the structure of the answer, not by text matching, gives 272 statements on answer items, with the Claude grading 234 true, 8 false and 30 not checkable. The note's text matching gave 274, with 261, 6 and 7 (its rows for a fact whose quote was found and for one whose quote was refused, added). The exact mapping of rows was not re-derived for this record. The recomputation is task t13 of the strict-facts plan (issue #39). Until then, read the note's two matching tables as approximate.
- `t13`: the lobes-cli needs. — [lobes-cli 344](https://github.com/agentculture/lobes-cli/issues/344) is open and owned by that repository. Naming the served model in the decider's response is undecided (open item v3): the operator decides whether to file it. Priority between callers and several states per request are closed by decision (d6); in the test of 2026-11-20 the answers were identical under load.
- `t13`: the 0.14.2 work has no PR yet. — PR to be opened from `clef/decider-close`; it carries the wording test, the accuracy-checks entry and this record.
- The measurement's conclusion: no difference shown, and the switch stays off for every model. — What it pointed at, the unchecked text, is taken up by issue #39 (strict facts). That is separate work with its own spec and plan.
- The finish reminder (issue #38) is still open. — Two reminded runs that then finished are in the measurement note; no rate is known, and a reminded `worker` run on 2026-11-20 still ended without `finish`.
- Evidence `e1` to `e7`, deltas `b1` to `b3` and obligations `o1` to `o7` are proposed. — The operator confirms or rejects each.
- Plan risks left unresolved in the plan file: `r1` (harvest runs were needed to reach 300 real pairs; 48 were run), `r3` (in report mode the arms can differ only if the model calls `check_quote` with a value; counted afterwards from the stored walks: in 14 of the 18 `check-on` runs the model was shown at least one answer, in 4 none), `r4` (time limit or context on a large repository; no measured run timed out), `r5` (three runs per arm can show only a large difference), `r6` (the copy was done on associate's side). — `r3` and `r5` stand as limits of the measurement; the others can be closed by the operator.
- Open item `v2`: whether end-of-run scoring delays safety-gate calls from other sessions enough to trip their timeout. — Not measured.
- Not run with the score on: `senses`, reasoning off, enforce mode, the mesh path, a spawned child, a delegated run. — No plan covers these yet.
