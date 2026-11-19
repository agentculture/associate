# associate strict facts

> associate hands back strict facts: every claim in the answer rests on a basis a reader can check, and a count comes with the command that produced it

## Audience

- The operator and mesh peers who read an associate answer and act on it, and a reviewer who wants to run the basis of any claim in it again

## Before → After

- Before: In the 36 measured broad runs of the decider plan (worker, six repositories, 1,657 statements graded by model graders), 65 of the 71 statements graded false were in the model's unchecked text and 6 rested on a quote-found fact; 39 of the 71 were counts. The attribution to facts is by text matching, a heuristic
- After: Every fact in the rendered answer is shown with how to check it: the command, search or read of the call it cites, as the walk recorded it, and that call's result, so a reader can run it again
- After: The rendered answer is made only of items whose basis passed; an item that fails is dropped from the answer, the model is told which items were dropped and why and may answer again, and the model's unchecked text stays in the export and is not part of the answer

## Requirements

- The harness takes the command from the walk entry the fact cites (arguments as used), never from text the model retypes
  - honesty: a fact whose cited call ran a different command than the model describes renders the command from the walk; a node test covers it
- For a fact that states a number, the harness checks that the number is in the saved result of the cited call, and reports or refuses the fact when it is not, by the model's check mode
  - honesty: the '604 test files' fact from the measured colleague run, replayed from its stored export, is reported: 604 is in the cited result, but the cited command counts entries; the replay shows what the check can and cannot catch
- A fact the decider answers part, little or none fails its check: it is dropped and returned to the model with that answer and the fix (narrow the value to what the quote shows, or cite a source that shows the rest), within the existing retry rounds
  - honesty: in a live enforce-mode run, a fact answered part is returned once and the next finish either narrows the value or the run ends refused; the walk shows it
- The broad report states, per run, how many graded statements rest on a passed basis and how many of those were graded false, with the matching done by the harness from item ids and not by text similarity
  - honesty: for the stored t12 runs the harness attribution and my text-matching attribution are compared and the differences listed
- Each fact states its kind of check: 'direct' (the cited call's result shows it: a quote or a number), 'llm' (a judgement the decider or a model must make, named as such in the answer), or 'derived' (it follows from other facts)
  - honesty: a node test and a live run each show a hand-back with the three kinds, rendered with the kind named on each item
- A fact may name the facts it is based on (a `based_on` list of fact ids); the harness checks the ids exist, refuses a cycle, checks facts in dependency order, and when a fact fails it flags and drops every fact based on it, naming the failed fact as the reason
  - honesty: a replay in which fact f1 fails and f2, f3 name f1 in `based_on` drops all three, and the message to the model names f1 as the reason for f2 and f3; a cycle f1->f2->f1 is refused with the fix
- A fact whose check is 'llm' is sent to the decider with the value and the cited result; the answer shows the decider's option beside it, and it is never counted with the facts a direct check passed
  - honesty: report.json counts direct-passed, llm-judged and derived facts separately, and the wording test finds none of them called accuracy
- The strict behaviour is on for worker and cortex by default in the contract, with a per-run switch to turn it off for comparison arms
  - honesty: one recorded live run each on worker and cortex with the default contract shows dropped items in the walk and in the message the model received

## Honesty conditions

- in a recorded live worker run and a recorded live cortex run with the default contract, every item in the answer section of answer.md has a check kind, a cited call and a passed check, and no item appears there that check.json lists as failed
- a reader who was not part of the run takes three items from a recorded answer, runs the printed command or read in the pinned checkout, and gets the printed result for all three
- the numbers are recomputed from the stored t12 results after grading is settled with an outside model's verdicts, and the spec is corrected if they change
- a live worker run on a broad task hands back at least one count fact, and answer.md shows its command and result exactly as walk.jsonl and results/wN.txt hold them
- in a live run, no sentence of the model's summary or final message appears in the answer section of answer.md, and the export still holds both
- the comparison is graded blind by graders that include at least one outside model or a person, since all three graders so far are Claude models
- the wording test over docs finds no use of accuracy or score for these counts, and git diff shows no change under lobes-cli, colleague or gate.json
- a node test shows that checking a hand-back starts no process and makes no tool call: it reads the walk and the saved results only

## Success signals

- On the six broad tasks, 3 runs per arm, statements in the rendered answer graded false are 0 for counts whose command is shown, and the strict arm has fewer statements graded false than the present arm in at least 5 of 6 repositories under the committed broad rule

## Scope / boundaries

- No change to lobes-cli or colleague; gate.json stays version 9; the quote-found count and the new counts are never called accuracy
- The harness does not run a model-chosen command a second time in this work; re-running is left to the reader or a later spec

## Non-goals

- Judging whether a source document is itself right: a quote from a stale docstring (the 'ten tools' case) still passes a quote check

## Assumptions

- A model that must attach a command to each count will still state the counts it stated before, and will not move them into the summary; the measured runs show models already put about five in six statements into free text
- Switching the strict behaviour on before a recorded live run departs from the repo rule in CLAUDE.md (no enforce without a recorded report-mode run); the rule is updated in this work and the first live runs are recorded before the PR is marked ready

## Scope exploration

- `s1` — `associate/contract/schemas/facts.schema.json`: a fact requires id, value, source, quote; source is a walk id pattern; additionalProperties false, so a new field is a schema change
  - seeds: `c6`
- `s2` — `.pi/extensions/associate/lib/walk.ts and tools/shell.ts`: the walk entry already stores `args_used` (walk.ts:195) and shell.ts sets details.`args_used` (shell.ts:615); every result is saved as results/wN.txt, so the command and its output exist for any cited call
  - seeds: `c8`
- `s3` — `.pi/extensions/associate/lib/render.ts`: renderAnswer (render.ts:174) writes accepted items and then the model's summary and final message under `UNCHECKED_HEADING` (render.ts:33); strict answers change what this renders
  - seeds: `c7`
- `s4` — `.pi/extensions/associate/lib/facts.ts and lib/matcher.ts`: checkHandback (facts.ts:408) is where a number-in-result check would sit beside the quote matcher (matcher.ts:98); literalOf (facts.ts:366) already extracts a literal from a value
  - seeds: `c9`
- `s5` — `associate/contract/accuracy.json`: mode is report for every model, `retry_rounds` 2; `source_kinds` maps bash, grep, find, ls to 'tool' and read to 'file'; new checks need entries under checks with a `motivating_failure`
  - seeds: `c10`, `c13`
- `s6` — `associate/measure/answer.py`: `broad_answer` (answer.py:286) builds the graded text from accepted items plus the unchecked section; statements carry no item id today, so basis has to be attributed by text
  - seeds: `c11`
- `s7` — `the 36 t12 runs and the graded sheet (scratchpad, not committed)`: source of the before-state numbers; graded by two Claude graders and a third for 121 statements; no person and no outside model graded them
  - seeds: `c5`

## Decisions

- Operator, 2026-11-19: the aim is not just to improve performance, but to clean false claims and improve claim basis so they are of better quality; a source or a 'how to check' on each fact makes all facts strict (issue 39)
- Operator, 2026-11-19: for a count, the claim carries the command itself, not only more careful wording (his example: not just '604 entries in tests/' but also the bash command)
- Operator, 2026-11-19: all claims carry how to check them, not only counts
- Operator, 2026-11-19: some claims need an LLM to check; the fact says so ('Some require an LLM, so we write that')
- Operator, 2026-11-19: some claims are based on other claims; facts get fields for that, so the check can iterate and, if one breaks, the facts based on it are flagged
- Operator, 2026-11-19: the strict behaviour is switched on
- Operator, 2026-11-19: what fails is dropped, and the agent is told what was dropped and why
- Operator, 2026-11-19 ('Confirmed all', on the proposal put to him): a derived fact is also judged by the decider, which is asked whether the conclusion follows from the facts it lists
- Operator, 2026-11-19 ('Confirmed all', on the proposal put to him): the two retry rounds stay; after the last round the answer goes out with the failing items dropped and the run is not refused
- Operator, 2026-11-19 ('Confirmed all', on the proposal put to him): senses is left out of 'switched on' until it has one recorded run with the accuracy method
