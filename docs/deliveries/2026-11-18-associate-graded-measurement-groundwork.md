# Delivery Summary — associate graded measurement groundwork

plan: `associate-graded-measurement-groundwork` · run: `partial` · date: `2026-11-19`
baseline: `devague plan (associate-graded-measurement-groundwork)`

## Intent

> associate can show whether a harness change makes answers more often correct: one command runs 24 fixed tasks in three repositories against clones that do not hold the answers, evidence-cli grades every run right or wrong, and the results are stored per arm

After: one associate command runs every arm of a comparison on 24 tasks in three repositories, each against a clone without the answers; every run ends with a result object even when it times out; evidence-cli grades each run right or wrong from its export and the task's expected values; associate's own re-check is evidence-cli, imported; the results are stored and printed as one table per arm with correct answers, time, calls and runs that ended without a hand-back

## Planned Work

- `t1` — Import the re-check from evidence-cli and rewrite the dependency rule
- `t2` — A timed-out run returns a result, and reasoning can be set for one run
- `t3` — A quoted facts list in finish is handled, and a rejected hand-back is kept
- `t4` — Build the filtered clone a measured run examines
- `t5` — Give each measured run its own empty memory and ledger, and detect contaminated runs
- `t6` — Define the task file format with structured expected values and a checker for it
- `t7` — Extract the model's own answer text, the same way for every harness version
- `t8` — Write the 24 tasks: 8 each in associate and two sibling repositories
- `t9` — Build the runner: arms by tasks by repeats, resumable, with an older-harness arm
- `t10` — Build the comparison table and the hand-grading sample
- `t11` — Add the associate measure command
- `t12` — Run the comparison and record it

## Actual Delivery

| Plan task | Status | What actually landed |
|-----------|--------|----------------------|
| `t1` | delivered | `associate/accuracy/` imports the re-check from evidence-cli (floor 0.7.0); the dependency rule in `CLAUDE.md` and its tests name the first-party list. `check.py` stays as a re-export module (d3). |
| `t2` | delivered | A run killed at its limit prints a result naming the timeout (exit 4); `associate run --reasoning` sets reasoning for one run. After review it applies to every model that can run in that run, spawned children included. |
| `t3` | delivered | A `facts` field holding a JSON string is accepted or refused with a named cause; a timed-out run keeps a rejected hand-back, labelled, unless a later one was accepted. |
| `t4` | delivered | `associate/measure/clone.py`: a one-commit clone without `docs/accuracy`; it refuses to be made when `export-ignore` would leave tracked files out. Rewriting by `export-subst` is not detected. |
| `t5` | delivered | `isolation.py` and `contamination.py`: an empty memory store and ledger per run; a walk that shows the answer key, a link to the repository hosting (percent-encoded and proxied forms included) or a recalled record marks the run contaminated. |
| `t6` | delivered | `associate/measure/tasks.py`: tasks with expected values in the evidence-cli schema and a checker for the file. |
| `t7` | delivered | `associate/measure/answer.py`: the model's own answer text, without harness-written lines. A run graded on its final reply keeps only the last 2,000 characters (risk r7). |
| `t8` | delivered | `docs/accuracy/tasks.json`: 24 tasks, 8 each in associate, workledger-cli and coherence-cli, pinned, each answer checked twice. The second check was run by the main agent after the task (d2). |
| `t9` | delivered | `associate/measure/runner.py`: arms by tasks by repeats, resumable, an arm on an older harness commit, two labelled grade readings per run (d1), plan identity and own-path checks added in review. |
| `t10` | partial | `associate/measure/report.py`: the table, the hand-grading sample and the agreement figure, tested on fixture records. No sample of real runs was drawn and no agreement figure exists. |
| `t11` | delivered | `associate measure` with the sub-verbs run, status, report, sample, agreement and overview, with a detached background run and a 3,600 second default limit (d4). |
| `t12` | not delivered | The comparison was not run (d7). Two 16-run pilots were run and recorded in `docs/notes/measure-pilot.md`; no difference between arms is read from them. |

## Mid-work Decisions

- `d1` — t9: the runner stores two labelled readings of the grade for a current-harness run (the answer text alone; the answer text plus the values and conclusions the model wrote in its hand-back). The plan asked for one grade. — t7 found a recorded worker run whose expected values appear only in its conclusions and facts, so the answer text alone would mark it wrong (risk r4). The operator chooses one reading after the pilot.
- `d2` — t8: the second, independent check of each task's answer is done by a separate agent started by the main agent after t8, not inside t8; t8 also revises the expected values of the six converted tasks against the saved real answers of 2026-11-17. — A second check started by the first checker is not independent of it. t6 wrote small values as fixed phrases (for example '`max_lines` 1000') that a correct answer in another form would fail.
- `d3` — t1: associate/accuracy/check.py is kept as a re-export module and tests/`test_run.py` (not in t1's owned files) was edited; t6 edited tests/`test_accuracy_tasks.py` (not owned). — The harness adapters still import from associate.accuracy.check, and both tests enforced what the tasks changed (the empty dependency list; the old task file header).
- `d4` — t11: the associate measure verb can start the comparison as a detached background process that survives the terminal, with a status sub-verb that reads the stored records and a log file; the per-run timeout is a flag with a default of 3600 seconds (the plan's runs used 1500). No unlimited timeout: a hung run would stall every run behind it. — Operator, 2026-11-18: increase the timeout or drop it, and run in a background process, which associate should support. Half of six live runs timed out at 1500 seconds, and reasoning is now on in both arms.
- `d5` — The comparison runs on worker only: 2 arms (worker before PR 27, worker on main) by 24 tasks by 3 repeats, 144 runs, not 288. Cortex is not compared; its only runs are the 16 pilot runs, from which no difference is read. The difference rule (12 of 72 per model) is unchanged and applies to worker. — Operator, 2026-11-18: worker is faster; run the comparison after the code-review fixes on worker only.
- `d6` — The measurement of whether a mechanism changes answers moves to the decider-score spec as a few big asks (one broad explanation task per pinned repository, graded on checked facts stated and false statements). The 24 short tasks are kept as the checklist. — Operator, 2026-11-18: the short questions leave no room to show a change; confirmed measuring on a few big asks, folded into the decider-score plan.
- `d7` — The before/after comparison of the accuracy method (issue 32) is not run at all, on either model: deviation d5's 144 worker runs are dropped. This stream delivers the measurement tooling, the 24 checked tasks and two 16-run pilots only. — My reading of the operator's messages of 2026-11-18 ('if we skip this test and move to the decider first', then 'Confirmed' on the big-ask design); not stated outright.

## Drift From Plan

| Plan item | Reason for divergence | Classification |
|-----------|------------------------|-----------------|
| `t9` (`d1`) | t7 found a recorded worker run whose expected values appear only in its conclusions and facts, so the answer text alone would mark it wrong (risk r4). The operator chooses one reading after the pilot. | `acceptable` |
| `t8` (`d2`) | A second check started by the first checker is not independent of it. t6 wrote small values as fixed phrases (for example '`max_lines` 1000') that a correct answer in another form would fail. | `acceptable` |
| `t1` (`d3`) | The harness adapters still import from associate.accuracy.check, and both tests enforced what the tasks changed (the empty dependency list; the old task file header). | `acceptable` |
| `t11` (`d4`) | Operator, 2026-11-18: increase the timeout or drop it, and run in a background process, which associate should support. Half of six live runs timed out at 1500 seconds, and reasoning is now on in both arms. | `acceptable` |
| `t12` (`d5`) | Operator, 2026-11-18: worker is faster; run the comparison after the code-review fixes on worker only. | `needs-follow-up` |
| `t12` (`d6`) | Operator, 2026-11-18: the short questions leave no room to show a change; confirmed measuring on a few big asks, folded into the decider-score plan. | `needs-follow-up` |
| `t12` (`d7`) | Proposed from my reading of the operator's messages of 2026-11-18; the operator approved it on 2026-11-19. | `needs-follow-up` |

## Evidence

- tests: `uv run pytest -n auto -q` on merged `main` (`208935e`) — 1566 passed
- tests: `bash .pi/extensions/associate/tests/run.sh` on the same commit — 932 tests, 930 pass, 2 skipped, 0 fail
- lint: black, isort, flake8, bandit, markdownlint and `teken cli doctor . --strict` (26 of 26) — clean on the PR head before merge; SonarCloud 0 open issues
- live: two 16-run pilots (32 of 32 runs stored, none timed out, none contaminated), `docs/notes/measure-pilot.md`
- commits: `266dad3..208935e`
- PRs / issues: #35 (merged), #30, #22, #32; tracking issue #33
- weaker evidence, as filed: `e2` no live timeout was provoked; `e3` fixture exports only; `e7` no pilot run was contaminated, so that path never ran live; `e14` fixture records only

## Delivery Claims

| Claim | Confidence | Evidence |
|-------|------------|----------|
| `c2` — during a measured run the model cannot read the answer key by any tool (read, shell, grep, find); a test proves the key is absent from the checkout a measured run examines | `execution` | `tests/test_measure_clone.py` (run 2026-11-19) |
| `c3` — each measurement task carries structured expected values that a script can grade right or wrong without a model, and the grader scores the final answer, not only the fact quotes | `execution` | `tests/test_measure_tasks.py` (run 2026-11-19) |
| `c4` — a committed runner starts every arm of the comparison (tasks by harness version by mode by repeat) with fixed settings and stores each run's graded result, so no step is done by hand | `execution` | `tests/test_measure_runner.py` (run 2026-11-19) |
| `c5` — a run that hits its time limit still returns a result object naming the timeout, with whatever the export holds, and reasoning can be set for one run without editing the contract (issue #22) | `execution` | `tests/test_run.py::test_a_run_killed_at_its_time_limit_prints_a_timeout_result` (run 2026-11-19) |
| `c20` — a comparison of the commit before PR #27 against current main in report mode, on worker and cortex, yields a graded result for at least 95% of its 288 runs (24 tasks, 3 repeats, 2 arms, 2 models); grading the same exports a second time changes 0 grades; and 0 of the walks contain a read of the answer key | untested | not run (deviation d7, delta b1); obligation o15 is unmet |
| `c21` — evidence-cli provides two things associate uses: the export re-check (the matcher, the checker and the counts now in associate/accuracy, moved with their tests and still passing the shared vectors), and a grade command that takes an export directory and a task's expected values and returns right, wrong or cannot grade, with no model call | `execution` | `tests/test_accuracy_check_outputs.py` (run 2026-11-19) |
| `c22` — associate's dependency rule is rewritten in CLAUDE.md and in the tests that enforce it: no third-party runtime dependency; a first-party AgentCulture package with zero dependencies of its own may be imported with a version floor; evidence-cli is the first | `execution` | `tests/test_pi_config.py::test_python_package_dependencies_are_the_named_first_party_list` (run 2026-11-19) |
| `c23` — the task set grows to 24 tasks, 8 each in associate and two sibling repositories, each with a prompt, structured expected values and a pinned commit of the repository it is asked about; every answer is checked by hand and by a second, independent check before it is used | `execution` | `tests/test_measure_task_set.py` (run 2026-11-19) |
| `c24` — the runner can run an arm on an older harness commit, so the commit before PR #27 can be measured on the same tasks as current main | `execution` | `tests/test_measure_runner.py::test_the_real_pre_pr27_commit_runs_through_the_runner` (run 2026-11-19) |
| `c29` — every measured run starts with an empty memory store and an empty ledger file of its own, so nothing one run remembered can reach another | `execution` | `tests/test_measure_isolation.py` (run 2026-11-19) |
| `c30` — the runner marks a run contaminated, excludes it from the table and counts it, when its walk shows the answer key's path, a web search or page fetch that reaches this repository's hosting, or a recalled record; the measured clone has one commit and no history, and files that restate task answers are removed from it | `execution` | `tests/test_measure_contamination.py` (run 2026-11-19) |
| `c33` — before any table is read, a sample of at least 48 graded runs is graded by hand and the agreement with the grader is reported; below 95% agreement the grader or the expected values are fixed first | `unverified` | the commands are tested on fixture records (`tests/test_measure_report.py`, run 2026-11-19); no sample of 48 real runs was graded by hand and no agreement figure exists |
| `c35` — when evidence-cli is missing or older than the floor, associate run and associate check fail with a CliError that names the package and the install command, never a traceback | `execution` | `tests/test_accuracy_evidence.py::test_without_a_usable_evidence_cli_the_verb_exits_2_naming_the_install` (run 2026-11-19) |
| `c37` — The text given to the answer check is the model's own answer without any line the harness wrote, and expected values avoid bare small numbers. Found in the evidence-cli live test of 2026-11-18 (agentculture/evidence-cli docs/notes/2026-11-18-live-test.md, finding 2): the rendered answer.md holds harness lines such as '2 items were refused' and 'Finish summary (3 sentences)', and a deliberately wrong answer was reported as holding the expected 2 and 3 because of them. | `execution` | `tests/test_measure_answer.py` (run 2026-11-19) |
| `c38` — A finish call whose facts field is a string holding a JSON list is either accepted or refused with a fix that names the cause, and a run that times out after a rejected finish keeps that payload in its result, labelled as rejected. Found in the same live test (associate issue 22, comment of 2026-11-18): a worker run lost a complete, correct answer this way. | `execution` | `.pi/extensions/associate/tests/handback-rejected.test.ts` (run 2026-11-19) |

## Remaining Work / Follow-up

- Whether the accuracy method changed how often answers are right is still not measured (issue #32). — The decider-score plan measures the next mechanism on six broad tasks; nothing re-measures PR #27 itself. Operator decides whether #32 stays open.
- A run that ends without `finish` is graded on a final reply cut to its last 2,000 characters; one pilot grade changed because of it (risk r7), and `worker` on `main` ended without `finish` in 2 of 4 pilot-2 runs (risk r8). — Needs its own fix proposal.
- The hand-grading sample and agreement figure have never been produced from real runs. — First real use is the decider-score measurement.
- A symbolic link inside a run's directory that points outside it is no longer detected, after the path checks were changed for SonarCloud. — Follow-up issue.
- `export-subst` content rewriting in the filtered clone is not detected. — Follow-up issue.
- The lock race between a starting runner and `measure status` is narrowed to a 2 second retry, not removed. — Follow-up issue if it is seen.
- The widened expected values of `gate-thresholds` and `read-budget` accept some wrong answers. — Tighten when those tasks are next used.
