# Delivery Summary — associate accuracy method

plan: `associate-accuracy-method` · run: `partial` · date: `2026-11-17`
baseline: `devague summary skeleton`

## Intent

> associate ships an accuracy method (issue #20): every tool call in a run carries a purpose the model stated before it ran and a harness-written record of what was asked, what was sent, how it ended and what came back; every fact the model reports cites the walk entry it came from and quotes that entry's saved result word for word, and a deterministic matcher in the harness checks each quote; conclusions carry the numbered facts they rest on and name their source kind (file read, tool call, agent conclusion, memory, web); and each run reports countable accuracy — how many facts and claims were made, checked, passed and refused, per kind — so an operator can follow any answer link by link back to saved results without re-running anything

After: a finished run hands back, beside its answer, a walk in which every action has a stated purpose and a harness-written record, a list of facts each tied to one walk entry by a quote the harness matched, conclusions that name the facts they rest on, and a count of what was made, checked, passed, refused and left unchecked; a hand-back that fails the check is refused in session and, if still failing, ends the run with a named reason

## Planned Work

- `t1` — Move the harness pin to pi 1.5.2 and record the migration
- `t2` — Add the accuracy contract: settings file, schemas for facts and report, loaders on both sides
- `t3` — Record the fixed measurement task set with hand-checked answers
- `t4` — Make the final-message route drop walk ids the walk never issued
- `t5` — Build the quote matcher in TypeScript and Python with shared test vectors
- `t6` — Extend the walk entry into the full action record and save every result
- `t7` — Enforce a purpose in the `tool_call` hook, give every refusal a fix, cap repeated refusals, keep the purpose out of the gate
- `t8` — Give every owned tool a purpose argument, report arguments as used, and stop search dropping totals
- `t9` — Stamp every tool result the model sees with its walk id
- `t10` — Write the hand-back checker as a pure library: facts, action claims, source rules, verdicts, counts
- `t11` — Wire the checker into finish: structured payload, report and enforce modes, retry rounds, harness-rendered answer, files written in every session
- `t12` — Offer the model a quote-check tool that uses the same matcher
- `t13` — Label prior-run and child-run entries so references stay unambiguous, and read old exports
- `t14` — Check ledger refs against the walk
- `t15` — Carry walk reference and quote in remembered records
- `t16` — Add the Python re-check and counts, with an associate check verb
- `t17` — Carry the result through associate run: answer, counts, named outcome, exit 3, stub shape
- `t18` — Tell the models: purpose on every call, ids as shown, facts with quotes, alternatives, cannot tell
- `t19` — Replay the six recorded failures as tests, with fixtures from the recorded runs
- `t20` — Measure live in report mode on worker, cortex and senses, and have associate review a real change
- `t21` — Update the repository docs, changelog and version; verify the boundaries

## Actual Delivery

| Plan task | Status | What actually landed |
|-----------|--------|----------------------|
| `t1` | delivered | Pin is pi 1.5.2 (`associate/harness/pi.py`); `docs/notes/pi-1.5.2-migration.md`. |
| `t2` | delivered | `associate/contract/accuracy.json`, schemas for accuracy, facts and report, loaders in `lib/contract.ts` and `associate/contract/`. |
| `t3` | delivered | `docs/accuracy/tasks.json`, six tasks with hand-checked answers. Flaw found later: the file is readable in the examined checkout (#30). |
| `t4` | delivered | `lib/statements.ts` drops walk ids the walk never issued. |
| `t5` | delivered | `lib/matcher.ts`, `associate/accuracy/matcher.py`, shared `associate/contract/matcher_vectors.json`. |
| `t6` | delivered | Walk format 2 in `lib/walk.ts`; every result saved by `lib/results.ts` as `results/wN.txt`. |
| `t7` | delivered | Purpose check, fix in every guard refusal, refusal cap counted once per turn (`index.ts`, `lib/guard.ts`); purpose stripped from what the gate is sent. |
| `t8` | delivered | Purpose and `args_used` on every owned tool; search tools report true totals. Two approved departures (d3, d4). |
| `t9` | delivered | `walk id: wN` first line on every tool result; calls pi rejects before the hook are also recorded (d1). |
| `t10` | delivered | `lib/facts.ts` `checkHandback`: facts, action claims, source rules, verdicts, counts. |
| `t11` | delivered | `finish` takes the structured payload; report and enforce modes; retry rounds; `answer.md`, `facts.json`, `check.json`, `report.json` written in every session. |
| `t12` | delivered | `check_quote` tool (`tools/check.ts`). |
| `t13` | delivered | `prior:wN` and `cN:wN` labels (`lib/torch.ts`); old exports read as not applicable. |
| `t14` | delivered | `ledger_append` refuses a walk id the walk never issued. |
| `t15` | delivered | `eidetic_remember` carries walk reference and quote. |
| `t16` | delivered | `associate/accuracy/` re-check and counts; `associate check` verb. Tests were written after the code (l3). |
| `t17` | delivered | `associate run --json` carries the answer, the re-check counts and `handback_outcome`; exit 3; stub writes the new shape. |
| `t18` | delivered | Prompts and `AGENTS.md` "Accuracy rules". |
| `t19` | delivered | `tests/fixtures/accuracy/` and replay tests on both sides. |
| `t20` | partial | worker and cortex measured, six tasks each, report mode, reasoning off; two enforce worker runs; one continued cortex review. senses not measured (role not feasible on the machine). Both models read the answer key on one task (#30). |
| `t21` | delivered | `CLAUDE.md`, `README.md`, `CHANGELOG.md`, version 0.12.0 (planned 0.11.0; d5). |

## Mid-work Decisions

- `d1` — t9 also records a call that pi rejected before the `tool_call` hook (invalid arguments or an unknown tool) as a walk entry, taken from `tool_execution_end`, with pi's error as the reason — pi 1.5.2 docs/extensions.md: "An unknown tool or invalid arguments skip `tool_call`"; found while writing the t1 migration note. Without it such a call has no walk entry, so the record claim (c8) and the refusal claim (c10) do not hold for it. Approved by the operator 2026-11-17.
- `d2` — t12 and t10 edit associate/contract/accuracy.json, which their confirmed instructions do not list: t12 adds the source kind of its new tool; t10 extends the checks list and adds a reason-to-check mapping, with schema, validator and loader changes — The t2 validator requires the source-kind table to equal `tool_names`, and an existing test forbids check ids as literals in the extension TypeScript, so both needs can only be met in the contract file. Approved by the operator 2026-11-17.
- `d3` — `run_tests`, `spawn_subagent`, `delegate_run` and `delegate_status` still refuse an unknown argument (other than purpose) instead of reporting it as dropped — The t8 instruction says an unknown argument is reported in used-args as dropped. The builder kept the existing refusal for these four tools because their tests and their security intent require it; a refusal with a fix is not a silent drop. Reported by the task agent; approved by the operator 2026-11-18.
- `d4` — grep, find and ls no longer stop the search process at the 200-result cap; they scan to the end or to caps.`max_raw_chars` to report a true total, and save the full list unredacted in the session scratch directory — The acceptance criterion asks for the true total and a saved full result; the builder met it by scanning further. Cost: a large repository is searched longer and up to 2,000,000 characters are held in memory. Reported by the task agent; approved by the operator 2026-11-18.
- `d5` — the finished work was moved from its integration branch onto origin/main as one change (branch accuracy/issue-20-on-main), and its version became 0.12.0 instead of 0.11.0 — The integration branch was created from a local base that predates PR #19 on origin/main (the bridge, also 0.11.0), which edits many of the same files; found only at PR time (lapse l4). The branch diff was applied onto origin/main with a three-way apply; 12 files conflicted and were resolved by keeping both sides; five merge fallouts in tests were fixed; the bridge surface-parity test learned the check verb. Both suites and every gate pass on the combined tree, and one live worker run from it was accepted. Not yet approved by the operator.

- No deviation record: after the PR opened, 30 SonarCloud issues on new code were fixed (one test comparing a call with itself, five digit patterns, four functions split, 21 test assertions). The split of `check_handback` was compared with the old function on 8,000 mutated inputs with identical output; `load_export` and `PiHarness.environment` were not compared that way.
- No deviation record: five findings from a code review of PR #27 were fixed before merge (the child's rendered `answer` counted as first-hand in a `delegate_status` result; `associate check` had no `--continue-from`; three wording errors). Five more were left for a decision in #24.
- No deviation record: unbacked summary and final-message text is kept under an unchecked label and counted, not omitted (operator decision at the challenge pass; behaviour delta `b1`).

## Drift From Plan

| Plan item | Reason for divergence | Classification |
|-----------|------------------------|-----------------|
| `t9` (`d1`) | pi 1.5.2 docs/extensions.md: "An unknown tool or invalid arguments skip `tool_call`"; found while writing the t1 migration note. Without it such a call has no walk entry, so the record claim (c8) and the refusal claim (c10) do not hold for it. Approved by the operator 2026-11-17. | `acceptable` |
| `t10` (`d2`) | The t2 validator requires the source-kind table to equal `tool_names`, and an existing test forbids check ids as literals in the extension TypeScript, so both needs can only be met in the contract file. Approved by the operator 2026-11-17. | `acceptable` |
| `t8` (`d3`) | The t8 instruction says an unknown argument is reported in used-args as dropped. The builder kept the existing refusal for these four tools because their tests and their security intent require it; a refusal with a fix is not a silent drop. Reported by the task agent; approved by the operator 2026-11-18. | `acceptable` |
| `t8` (`d4`) | The acceptance criterion asks for the true total and a saved full result; the builder met it by scanning further. Cost: a large repository is searched longer and up to 2,000,000 characters are held in memory. Reported by the task agent; approved by the operator 2026-11-18. | `risky` |
| `t21` (`d5`) | The integration branch was created from a local base that predates PR #19 on origin/main (the bridge, also 0.11.0), which edits many of the same files; found only at PR time (lapse l4). The branch diff was applied onto origin/main with a three-way apply; 12 files conflicted and were resolved by keeping both sides; five merge fallouts in tests were fixed; the bridge surface-parity test learned the check verb. Both suites and every gate pass on the combined tree, and one live worker run from it was accepted. Not yet approved by the operator. | `risky` |
| `t20` | senses was not measured: the gateway reported the role not feasible on the measuring machine. Reasoning was off in every run. The answer key was readable in the checkout and both models cited it on one task (#30). No record covers this. | `needs-follow-up` |
| `t3` | The task set with its answers sits inside the checkout the models examine (#30). No record covers this. | `needs-follow-up` |
| `t16` | Tests were written after the code and never seen to fail (lapse `l3`). No deviation record covers this. | `risky` |

## Evidence

- tests: `uv run pytest -n auto -q` at `3bb876d` — 1037 passed
- tests: `bash .pi/extensions/associate/tests/run.sh` at `3bb876d` — 918 tests, 915 pass, 0 fail, 3 skipped
- tests named in evidence records `e1`–`e30`: 107 tests, 325 cases, all passed in the two runs above (`devague evidence --list --plan associate-accuracy-method`)
- obligations: 30 (`o1`–`o30`); 21 fully asserted by tests (strength `execution`), 9 partly (strength `coverage`: `o4`, `o5`, `o9`, `o11`, `o14`, `o15`, `o22`, `o26`, `o29`); each partial record names what no test asserts
- live observations: `e31` (`o17`), `e32` (`o13`), `e33` (`o20`), from `docs/notes/accuracy-live-acceptance.md`; one run each
- behaviour deltas: `b1` (amends `c47`), `b2` (`d1`), `b3` (`d3`), `b4` (`d4`)
- lint: black, isort, flake8, bandit, markdownlint, `teken cli doctor . --strict` — clean on the PR head; CI on `69b7e77` passed, SonarCloud included
- commits: `a9182d7..3bb876d` (one squash commit on `main`)
- PRs / issues: #27 (merged 2026-11-18), #20 (open), follow-ups ordered in #33

## Delivery Claims

| Claim | Confidence | Evidence |
|-------|------------|----------|
| `c3` — accuracy is calculable by count: the number of each fact and each claim a run made, and how many of each were checked, passed and refused — operator, 2026-11-17 | `medium` (tests pass; Python-side tests never seen to fail, `l3`) | `tests/test_run_accuracy.py::test_the_pi_result_reports_the_python_counts_and_copies_unchecked_text` (run 2026-11-18) |
| `c7` — every tool call carries a purpose the model states before the call (the question it settles and what it expects to see); a call with no purpose is refused in the `tool_call` hook before it runs, and the harness copies the purpose into the walk entry | `high` (tests pass) | `.pi/extensions/associate/tests/toolcall.test.ts :: t7 criterion 1: '${name}' with a missing or empty purpose is refused in the hook before it runs` (run 2026-11-18) |
| `c8` — the walk entry is the harness-written record of an action: purpose, arguments as asked, arguments as sent, how it ended with a reason, and a pointer to the full saved result with a count of what the model was not shown | `high` (tests pass) | `.pi/extensions/associate/tests/tool-args.test.ts :: t8 criterion 2: read with limit and offset (run scope20-cortex-t2): the walk entry shows asked and used differ` (run 2026-11-18) |
| `c10` — every refusal and failure a model receives carries a reason and how to fix the request; a non-ok outcome without a reason is a harness bug | `low` (only partly asserted by tests) | `.pi/extensions/associate/tests/refusal-reasons.test.ts :: t8 criterion 4: no call to a refusal constructor can leave out the reason or the fix` (run 2026-11-18) |
| `c11` — a fact is a value, the walk entry it came from, and a quote of that entry's saved result word for word; the harness checks each quote with a deterministic matcher against the saved result, one fact at a time, refuses a quote that is not there and shows the nearest match, and marks a fact from a source it cannot read as unchecked | `high` (tests pass) | `.pi/extensions/associate/tests/finish-check.test.ts :: AC4: a session started without associate run leaves facts.json, check.json and report.json` (run 2026-11-18) |
| `c12` — the prose hand-back route drops walk ids that the walk never recorded, as the finish route already does, so an invented \[wN\] marker can no longer make a statement count as referenced | `high` (tests pass) | `.pi/extensions/associate/tests/statements.test.ts :: a final message citing a walk id the walk never issued is unreferenced` (run 2026-11-18) |
| `c13` — the model can run the quote check during the run through a tool that uses the same matcher the harness uses to grade the result afterwards | `high` (tests pass) | `.pi/extensions/associate/tests/matcher.test.ts :: vector: ${c.name}` (run 2026-11-18) |
| `c15` — every walk entry carries a source kind set by the harness from the tool that produced it (file read, tool or command output, web, memory, agent conclusion, harness measurement), every fact inherits the kind and the known limits (truncated, stale) of the entry it cites, and a closing conclusion backed only by an agent conclusion or memory is refused | `high` (tests pass) | `.pi/extensions/associate/tests/facts.test.ts :: handback vector: ${c.name}` (run 2026-11-18) |
| `c16` — finish becomes an enforcing check: a hand-back whose facts fail the quote check, or whose conclusion rests on something unread, is refused with what is wrong and how to fix it; the model answers again in the same session for a fixed number of rounds set in the contract; after that the run ends with a named failure reason and no result is reported as accepted | `high` (tests pass) | `.pi/extensions/associate/tests/finish-check.test.ts :: AC2: enforce refuses a failing hand-back with the fix, tools stay callable, finished stays false` (run 2026-11-18) |
| `c17` — a conclusion is recorded apart from observations and explanations: alternatives are listed with what each predicts and what would refute it, each ends supported, refuted or open with the numbered facts it rests on, an open one names the check that would decide it, and "cannot tell" is an accepted answer | `low` (only partly asserted by tests) | `.pi/extensions/associate/tests/facts.test.ts :: handback vector: ${c.name}` (run 2026-11-18) |
| `c19` — each run reports a count per kind next to its result: facts made, checked, passed, refused and unchecked; conclusions supported, refuted and open; statements with no fact; by source kind — written by the harness, never by the model; the harness also stores its own reviewer flags (an unbacked link, a conclusion resting on something unread) beside the result without changing it, in a file an outside grader can add to | `high` (tests pass) | `.pi/extensions/associate/tests/finish-check.test.ts :: AC4: a session started without associate run leaves facts.json, check.json and report.json` (run 2026-11-18) |
| `c21` — a ledger entry that claims a result cites the walk entry that measured it and the harness checks that the entry exists; the harness can append the measured outcome itself (issue #15) | `high` (tests pass) | `.pi/extensions/associate/tests/ledger.test.ts :: t14: a walk-id-shaped ref the walk never issued is refused with the fix, nothing spawned` (run 2026-11-18) |
| `c29` — every tool result the model is shown is stamped by the harness with its walk id, so a fact cites an id the model was given instead of one it counted | `high` (tests pass) | `.pi/extensions/associate/tests/stamp.test.ts :: t9 criterion 1/2: a ${tool} result reaches the model stamped with its own walk id` (run 2026-11-18) |
| `c31` — a fact names its source unambiguously across runs: a reference to an entry of a prior run loaded with --continue-from, or of a child run, is distinguishable from an entry of the current run and resolves to that run's saved result | `high` (tests pass) | `.pi/extensions/associate/tests/facts.test.ts :: a labelled reference never resolves to a current-run entry` (run 2026-11-18) |
| `c40` — the harness pin moves from pi 1.1.0 to pi 1.5.2 as part of this work (operator decision, 2026-11-17: upgrading to 1.5.2 is approved) | `high` (tests pass) | `tests/test_run.py::test_the_pinned_version_does_not_warn` (run 2026-11-18) |
| `c47` — no free text reaches the caller as a checked answer: the answer in the run result is rendered by the harness from the accepted facts and conclusions, and whatever else the model wrote (the finish summary, the final message) is delivered under an unchecked label with its sentence count in the report | `low` (only partly asserted by tests) | `.pi/extensions/associate/tests/finish-check.test.ts :: AC5: the cortex pyproject sentence in a summary appears only under the unchecked label` (run 2026-11-18) |
| `c48` — a statement that an action happened (a tool ran, a file changed, a test passed, a record was stored) is a fact whose cited entry must be a call of that tool that did not end in an error or refusal | `high` (tests pass) | `.pi/extensions/associate/tests/facts.test.ts :: t20 A2: 'Eidetic remember: Success' citing a recall entry is refused with a fix` (run 2026-11-18) |
| `c51` — the matcher refuses a quote shorter than a minimum length set in the contract, and when a fact value is a literal (a number, an identifier, a path) that literal must occur inside the quote | `high` (tests pass) | `.pi/extensions/associate/tests/matcher.test.ts :: vector: ${c.name}` (run 2026-11-18) |
| `c52` — the checks ship with a mode set in the contract, report or enforce, per model and overridable per run: in report mode nothing is refused and the report says what would have been; a model moves to enforce only after a recorded live run in report mode | `high` (tests pass) | `.pi/extensions/associate/tests/finish-check.test.ts :: AC3: report mode accepts the failing hand-back and the report lists each refusal it would have made` (run 2026-11-18) |
| `c53` — consecutive refusals for the same reason (a missing purpose, a failed hand-back) are capped by a number in the contract; at the cap the run ends with a named outcome instead of looping to its time limit | `low` (only partly asserted by tests) | `.pi/extensions/associate/tests/toolcall.test.ts :: t7 criterion 4: the same refusal repeated to the contract's refusal_cap ends the run with outcome 'refused'` (run 2026-11-18) |
| `c54` — the extension writes the facts, the check results and the counts itself in every session, so mesh sessions through pi-acp and spawned children have them; the Python re-check runs wherever associate run runs (headless and delegated runs), and the report says when it did not run | `medium` (tests pass; Python-side tests never seen to fail, `l3`) | `.pi/extensions/associate/tests/finish-check.test.ts :: AC4: a session started without associate run leaves facts.json, check.json and report.json` (run 2026-11-18) |
| `c56` — a run whose hand-back still fails the check after the allowed rounds exits 3, the first use of the reserved range, and still prints its result object, so a caller and `delegate_status` can read the named outcome | `medium` (tests pass; Python-side tests never seen to fail, `l3`) | `tests/test_run_accuracy.py::test_a_refused_handback_exits_3_and_still_prints_the_result` (run 2026-11-18) |
| `c58` — an export says which format it is: the checker, the counts and --continue-from accept an export written before this change and report its facts as not applicable instead of failing; the stub adapter writes the new shape | `low` (only partly asserted by tests) | `tests/test_accuracy_check.py::test_an_old_export_is_read_and_its_facts_are_not_applicable` (run 2026-11-18) |
| `c60` — a fact names its source by run label and walk id only, validated by pattern; the harness maps that to a saved file, and neither the matcher nor the check tool opens a path supplied by the model | `high` (tests pass) | `.pi/extensions/associate/tests/facts.test.ts :: a reference containing a path is refused before any saved result is looked up` (run 2026-11-18) |
| the method was measured live on worker and cortex: counts from the extension, the Python re-check and a hand count agreed in 12 of 12 runs | `medium` (one run per task; answer key readable, #30) | `docs/notes/accuracy-live-acceptance.md` · `e31` |
| the method works on senses, with reasoning on, on the mesh path, in spawned children or delegated runs, or with a real `ledger` binary | `unverified` | (no evidence — not claimed done) |
| the method makes associate's answers more often correct | `unverified` | (no evidence — not claimed; #32) |

Lapse ledger evidence:

| Lapse | Code | What |
|-------|------|------|
| `l1` | `assumption-for-measurement` | while writing the why-it-matters and success-signal claims in /think I treated the cortex pyproject sentence as a failure the specified method catches, without checking which part of the hand-back carried it; the challenge probe shows it sat in the finish summary and the final message, which the confirmed spec leaves unchecked |
| `l2` | `assumption-for-measurement` | merged t12 (`check_quote`) after running only three test files, not the full extension suite, and then told three task agents their starting branch had 0 failures; the stamp test for the new tool was failing from that merge until the t10 merge run exposed it |
| `l3` | `control-absent` | t16 task agent drafted associate/accuracy/check.py before writing its tests and never saw a test fail; every test passed on its first run, so the tests show agreement with the 10 shared vectors and the fixtures more than fault detection |
| `l4` | `assumption-for-measurement` | at gate 2 I told the operator the working branch was 145 commits ahead of main and proposed branching from it, comparing against the local main ref without fetching; the remote main had already squash-merged that work (#18) and a 21,000-line follow-up (#19, also version 0.11.0) that edits the same files, so the whole plan was built on a stale base and the version bump collides |
| `l5` | `assumption-for-measurement` | I reported PR #27 as 'all CI checks pass' in the handoff; on that commit (1f29031) the SonarCloud check and the pull-request test job were already failing: one new bug and 29 other open issues on new code, which the repo's CI treats as a failure |

## Remaining Work / Follow-up

- `t20` — measure senses, reasoning on, the mesh path, children and delegated runs — #33 "Not measured, still"
- `t3`, `t20` — move the answer key out of the examined checkout, then re-measure — #30
- nine obligations are only partly asserted by tests (`o4`, `o5`, `o9`, `o11`, `o14`, `o15`, `o22`, `o26`, `o29`) — add the missing assertions; the gaps are quoted in `e4`, `e5`, `e9`, `e11`, `e14`, `e15`, `e22`, `e26`, `e29`
- no evidence that answers improved — #32
- checker findings from live runs and from the PR review — #24
- the models do not reply with the rendered answer — #25; the bridge does not surface the new fields — #26
- no model is in enforce mode; recommendation is to keep report mode until #24 is settled
- decider score per fact — #31 (replay results in #29); per-run final report — #28
- sibling repositories — listed in #33
- issue #20 itself is still open
