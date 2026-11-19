# Build Plan — associate decider fact score

slug: `associate-decider-fact-score` · status: `exported` · from frame: `associate-decider-fact-score`

> associate scores each reported fact with the decider: for every fact whose quote was found, it asks whether the quote supports the value and records the answer beside the quote check, so a reader and the model itself can tell a backed claim from a merely cited one

## Tasks

### t1 — Contract settings for the support score

- instruction: Files: associate/contract/accuracy.json, schemas/accuracy.schema.json, schemas/report.schema.json, associate/contract/validate.py, .pi/extensions/associate/lib/contract.ts and their tests. The cut-off is a first value marked tentative in the file's comment; task t9 replaces it. gate.json is not touched and stays version 9. Bump accuracy.json's version only if the schema change makes an older file invalid, and say which in the changelog.
- covers: c4, h13, c9, h18
- acceptance:
  - accuracy.json holds the question wording, the cut-off, the per-fact timeout, the cap on scored facts, the total scoring time and a per-model on/off switch, each declared in accuracy.schema.json and read through lib/contract.ts and the Python contract validator
  - report.schema.json declares the new count of scored facts under its own name
  - a test fails if the question wording, the cut-off or the timeout appears as a literal in the extension's TypeScript or in associate's Python
  - every model is still in report mode and the switch is off for every model until the labelled set fixes the cut-off

### t2 — The support-score client

- instruction: New file .pi/extensions/associate/lib/support.ts with its own test file; reuse buildClefRequest and deciderUrl from lib/gate.ts or copy their pattern, without changing gate.ts behaviour. All settings come from the contract (t1). Tests use a fake decider only; no live call.
- depends on: t1
- covers: c3, h12, c22, h8, c25, h20, c28, h23
- acceptance:
  - a new module asks the decider one yes/no question for one value and quote and returns a score or a not-scored result with a reason; it never calls createGate().evaluate, writes no gate line and has no Super tier or read-only fallback
  - a missing key, a timeout, a non-2xx answer and a malformed answer each return not scored, never a pass
  - value and quote pass through the policy redaction filter before sending; a test shows a redacted string replaced in the request a fake decider receives
  - an empty value, or a value and quote over the decider's input limit, returns not scored with a size or empty reason and the fake decider receives no request
  - a batch call honours the cap on scored facts and the total time from the contract; facts beyond either are returned as not scored, and the call returns within the total time when the fake decider is slow
  - the same value and quote asked twice in one session produce one request

### t3 — Score at finish, stored beside the quote check

- instruction: Files: .pi/extensions/associate/index.ts and lib/handback.ts only where the saved object is built, plus tests. Do not edit lib/facts.ts or lib/matcher.ts. With the switch off, nothing is sent and the files carry no score field.
- depends on: t1, t2
- covers: c1, c2, h11, h19, c8, h17, c27, h22, c17
- acceptance:
  - after checkHandback, finish scores each fact that passed the quote check and writes the score or a not-scored mark per fact in check.json in a field of its own, and a count in report.json
  - accepted, the refusal list and the passed, refused and unchecked counts are byte-identical to the same hand-back with the score switched off
  - the `message_end` rewrite keeps the scores from the saved object and sends no new request; a hand-back refused and answered again with the same fact produces one decider request, counted by a fake decider
  - with the fake decider failing in each of the four ways, finish still writes facts.json, check.json, report.json and answer.md
  - the shared matcher and hand-back vectors pass unchanged, and a test fails if lib/facts.ts or lib/matcher.ts imports a module that performs a network call
  - no code path refuses or retries a hand-back because of a score

### t4 — `check_quote` returns the support score

- instruction: Files: .pi/extensions/associate/tools/check.ts and its test; check.test.ts lines pinning the existing keys must still pass unedited. Uses the client from t2 and its session reuse.
- depends on: t3
- covers: c6, h15
- acceptance:
  - `check_quote` returns the same verdict and nearest text as before for the same inputs, plus one added key holding the score or a not-scored reason
  - the added key is present only when a value is given and the model's switch is on; with the decider unreachable it reports not scored
  - the wording of the added key can be acted on by a reader who does not know what the decider is

### t5 — The rendered answer shows both signals

- instruction: Files: .pi/extensions/associate/lib/render.ts (factLine) and its tests.
- depends on: t3
- covers: c7, h16, h1, c15
- acceptance:
  - answer.md shows, for a scored fact, the quote-found marker and the support marker with its score as separate text, and not scored with its reason otherwise
  - the text never contains the word accuracy and reads without knowledge of the decider
  - with the switch off answer.md is byte-identical to today's

### t6 — Python side copies the score from the export

- instruction: The re-check now lives in evidence-cli. Do the copy in associate (associate/accuracy/`__init__.py` or the run and check commands), not in evidence-cli; if that proves impossible, stop and report, do not change evidence-cli. Update associate/explain/catalog.py and learn where the output is described.
- depends on: t3
- covers: c5, h14
- acceptance:
  - associate run --json and associate check show each fact's score copied from the export's check.json with a label naming the extension as its source
  - the Python side makes no network call for it, shown by a test
  - an export written before this change, and one written with the switch off, load without error and show no score

### t7 — A per-run switch for the score, usable as a measurement arm

- instruction: Files: associate/cli/`_commands`/run.py, associate/harness/pi.py, associate/measure/runner.py, the extension's reader of the variable, explain catalog, learn, and the variable table in CLAUDE.md. Follow the pattern of --check-mode and `ASSOCIATE_CHECK_MODE`.
- depends on: t1
- covers: h6
- acceptance:
  - associate run --support-score on|off overrides the model's contract switch for one run through one environment variable set by the launcher and never inherited; any other value is refused
  - an arm in a measure arms file can set it, and the stored record of each run names the setting used
  - two arms that differ only in this setting run the same tasks, model, reasoning setting and repeats, checked by the runner before the first run

### t8 — Prompts name `check_quote` as the way to learn the score

- instruction: Files: .pi/extensions/associate/prompts/ and AGENTS.md if it describes `check_quote`. Keep the change to a few lines per prompt.
- depends on: t4
- covers: c29, h24
- acceptance:
  - each model prompt that offers `check_quote` says it returns whether the quote supports the value, and that the model should use it before handing back
  - no prompt text promises the model a second chance after finish in report mode; a test reads the prompt files for both

### t9 — Labelled set, cut-off and calibration note

- instruction: Run by the main agent. Pairs come from the two pilots, the earlier live runs and harvest runs on the six repositories; the dropped comparison supplies none (risk r1). Two raters label without seeing each other's labels or the scores.
- depends on: t1
- covers: c19, h5, c21, h7, c26, h21, c16, h2
- acceptance:
  - at least 300 real value-and-quote pairs from stored exports are committed with two independent labels each; who the raters were is stated
  - the set includes a separately reported group of quotes carrying text addressed to the scorer, and planted wrong values are reported apart from real ones
  - a committed script computes, from the committed labels and scores, the share passed of pairs both raters call supported and of pairs both call unsupported
  - the contract cut-off is set from the set, and docs/notes/ gains a note naming the set size, the raters, the wording, the cut-off, both shares, and the served model read from a live response
  - the result is reported whether or not it meets 90% and 10%; if it does not, the switch stays off and the operator decides
  - the replay numbers quoted in the spec are checked against issue #29

### t10 — Six broad tasks with twice-checked fact checklists

- instruction: New files under docs/accuracy/ beside tasks.json; reuse facts from the 24 short tasks where they fit. Pins: workledger-cli 71ef513, coherence-cli a52f7b5, and origin/main of the others on the day the checklists are written.
- covers: h4
- acceptance:
  - one broad explanation task per repository for culture, culture-rules, colleague, associate, coherence-cli and workledger-cli, each pinned to a commit and stored in a committed file
  - each repository has a checklist of at least 8 facts a good explanation should state, each with the file and line that shows it, and each checked independently by a second checker who did not see the first one's answer
  - a fact the two checkers disagree on is dropped or settled by the operator, and the file records which
  - the sibling repositories are read as pinned clones only; no file in them is changed

### t11 — Grading tools for the broad tasks

- instruction: Files: associate/measure/ and its tests and command docs. The checklist count is a first marking by the existing grader per fact; the main agent reads every marking by hand.
- depends on: t10, t7
- covers: h25
- acceptance:
  - associate measure accepts a broad task and stores each run's answer; a report lists, per run, how many checklist facts the answer states correctly, never pooled into one percentage
  - a grading sheet command writes the runs' statements in shuffled order under ids that hide the arm; the key that maps ids to arms is written to a separate file
  - each statement counted false needs a contradicting file and line before the sheet is accepted
  - the report joins sheet and key only when every run is graded, and prints both counts per run
  - a real run is refused while the committed difference rule for broad tasks is missing or modified

### t12 — Live runs and the measurement

- instruction: Run by the main agent, in the background. The difference rule is proposed to the operator and committed before the first measured run.
- depends on: t5, t6, t8, t9, t11
- covers: c20, h3, c18
- acceptance:
  - one live run in report mode on worker and one on cortex with the score on each leave a check.json in which every quote-found fact is scored or marked not scored
  - one trial run per repository fixes the time limit before the difference rule is committed
  - at least 3 runs per repository on worker with the score off and 3 with it on, same task, model, reasoning setting and repeats
  - false statements are counted blind with file and line; the note reports both counts per run and states the result whichever way it comes out, including whether answers were more often correct with the score

### t13 — Docs, wording check, lobes-cli issues and release

- instruction: Run by the main agent with the user's go-ahead before filing issues on lobes-cli.
- depends on: t12
- covers: c23, h9, c24, h10
- acceptance:
  - a test fails if a user-facing string or document added by this work calls the score or its count accuracy
  - no commit touches lobes-cli; each need found (calibration for this use, several states per request, priority between callers, naming the served model) is an issue on that repository
  - CLAUDE.md, docs/notes/accuracy-checks.md and the changelog say what was built and what was measured, and the version is bumped

## Risks

- [unknown_nonblocking] the labelled set was to be built from the comparison's exports, and the comparison is not run; the pilots and earlier live runs hold roughly 150 facts, so harvest runs are needed to reach 300 (task t9)
- [unknown_nonblocking] the two raters of the labelled set are model subagents unless the operator labels; the note must say so (task t9)
- [unknown_nonblocking] in report mode the score reaches the model only through `check_quote`, so the on arm can differ from the off arm only if the model calls `check_quote` with a value (task t12)
- [unknown_nonblocking] a broad explanation of a 200,000-line repository may hit the time limit or the model's context (task t12)
- [unknown_nonblocking] 18 runs per arm in total, 3 per repository, can show only a large difference (task t12)
- [unknown_nonblocking] the Python re-check lives in evidence-cli; if the score cannot be copied on associate's side, evidence-cli needs a release first (task t6)
- [unknown_nonblocking] the support question is sent as type noul with the wording as instructions and the score read from answers.support.noul, copied from the gate's pattern; not yet checked against the live decider (t9 does) (task t2)
- [unknown_blocking] 2 of 6 trial runs of the broad task (culture-rules, colleague; worker, score off) ended without calling finish: the model wrote its hand-back as its final message, so the result holds no answer and only the last 2000 characters of the reply; statements.json holds the full text. A measured run that ends this way has no facts to score at finish and its answer is cut (task t12)
- [unknown_blocking] The labelled set (554 pairs, two model raters) does not meet the spec target at any cut-off: at 0.5 the score passed 275 of 309 real pairs both raters call supported (89.0%) and 35 of 113 both call unsupported (31.0%); docs/notes/support-score-calibration.md. The switch stays off and the cut-off stays 0.5 until the operator decides whether to measure anyway (t12), change the question wording, or stop. (task t9)
