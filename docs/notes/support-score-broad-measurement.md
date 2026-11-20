# The support check on six broad tasks

Measured on 2026-11-19 for plan task t12
(`docs/plans/2026-11-19-associate-decider-fact-score.md`). The question: does
showing a model the decider's answer about each of its quote-found facts change
what the model hands back?

**Result: no difference shown**, on either count, under the committed rule
(`docs/accuracy/broad-difference-threshold.md`) and under both gradings below.

None of the numbers here is accuracy, and none is a benchmark score. They are
counts on 36 runs of one model on six tasks.

## What was run

- Six broad explanation tasks, one per repository, from
  `docs/accuracy/broad-tasks.json`: culture, culture-rules, colleague,
  associate, coherence-cli and workledger-cli, each at a pinned commit.
- Two arms, `check-off` and `check-on` (`--support-score off|on`), three runs
  per repository per arm: 36 runs.
- `worker` only, reasoning on, report mode, the finish reminder on in both
  arms, harness commit `ef6d1b4`, pi 1.5.2, 3,600 seconds per run.
- The runs went one at a time. All 36 were stored, none failed to launch, and
  every one ended with an accepted `finish`. One run in each arm was reminded
  once.
- Run time: `check-off` 286 to 773 seconds (middle value 516); `check-on` 356
  to 987 seconds (middle value 549).

The support check is the five-option question of plan deviation d4: for each
fact whose quote was found, the decider picks how much of the value the quote
shows (`all`, `mostly`, `part`, `little`, `none`), and `all` or `mostly` passes.
In report mode the answer is shown to the model by `check_quote` and written to
the export; nothing is refused or removed.

## How it was graded

Each run's answer was split into statements: 1,657 in all. They were written
to a sheet in shuffled order under ids that hide the arm. The key was opened
only after grading.

The plan asked for hand-grading. The operator chose model graders instead
(plan deviation d5). **No person graded any statement.**

- **Claude grading.** Two graders, one on Opus and one on Sonnet, each graded
  every statement of a repository against a checkout at the pinned commit.
  They gave the same verdict to 1,606 of 1,657 statements. A third grader, on
  Opus, then decided 121 statements: the 51 the two differed on, every other
  statement marked false, and 35 that state a count.
- **Gemini grading.** One outside grader (Antigravity on a Gemini model)
  graded all 1,657 statements with the rules the third Claude grader had.

A statement marked false carries the file and line that contradict it; the
sheet check looked up every one at the pinned commit.

| Verdict | Claude grading | Gemini grading |
|---|---|---|
| true | 1,283 | 1,212 |
| false | 71 | 150 |
| not checkable | 303 | 295 |

Gemini marked false every statement the Claude grading has as false, and 79
more. The operator chose the Gemini grading as the main reading, with the
Claude grading beside it.

The two differ mostly on how strict to be:

- a list given as complete that leaves members out (a model copied
  `culture channel {list, read, message, who}` from a stale docstring; the
  code registers six more verbs);
- a claim copied from the repository's own documentation that the code
  contradicts ("no mocks", where the document says "no mocks for the server"
  and 24 test files use mocks);
- a count that matches only when directories are counted as files ("604 test
  files", where 604 is the number of entries in `tests/` and 595 are test
  files). The third Claude grader and Gemini were given one rule for these.

The cited lines of 43 of the 97 differences (culture and culture-rules) were
read by the session that ran the measurement, and Gemini's reasons held. The
other 54 were not read.

Both gradings of every statement are in
`docs/accuracy/broad-graded-statements.json`.

## The rule's verdict

An arm must be better in at least 5 of 6 repositories, where "better in a
repository" needs all three of its runs to beat all three of the other arm's.

| Count | Claude grading | Gemini grading |
|---|---|---|
| Checklist facts marked as stated | no difference shown (off better in 1, on in 0) | the same; this count does not use the grading |
| Statements counted false | no difference shown (off better in 3, on in 1) | no difference shown (off better in 2, on in 0) |

## Middle value of each arm's three runs

For reading beside the rule. No verdict is drawn from these.

| Repository | Facts stated, off | Facts stated, on | False, off (Gemini) | False, on (Gemini) | False, off (Claude) | False, on (Claude) |
|---|---|---|---|---|---|---|
| associate | 9 of 12 | 10 of 12 | 2 | 5 | 2 | 2 |
| coherence-cli | 7 of 12 | 9 of 12 | 2 | 4 | 0 | 2 |
| colleague | 9 of 11 | 8 of 11 | 4 | 4 | 3 | 4 |
| culture | 8 of 12 | 8 of 12 | 6 | 9 | 2 | 1 |
| culture-rules | 6 of 12 | 7 of 12 | 0 | 4 | 0 | 2 |
| workledger-cli | 11 of 12 | 10 of 12 | 2 | 0 | 2 | 0 |

The facts count is a first marking by word match against the checklist. It was
not read by hand.

## Every run

| Repository | Arm | Run | Facts stated | Statements | False (Gemini) | False (Claude) |
|---|---|---|---|---|---|---|
| associate | off | 1 | 8 of 12 | 17 | 2 | 2 |
| associate | off | 2 | 10 of 12 | 53 | 6 | 2 |
| associate | off | 3 | 9 of 12 | 14 | 2 | 2 |
| associate | on | 1 | 9 of 12 | 71 | 5 | 3 |
| associate | on | 2 | 10 of 12 | 34 | 8 | 2 |
| associate | on | 3 | 11 of 12 | 54 | 4 | 2 |
| coherence-cli | off | 1 | 7 of 12 | 36 | 0 | 0 |
| coherence-cli | off | 2 | 6 of 12 | 18 | 2 | 0 |
| coherence-cli | off | 3 | 9 of 12 | 55 | 2 | 0 |
| coherence-cli | on | 1 | 6 of 12 | 21 | 4 | 2 |
| coherence-cli | on | 2 | 9 of 12 | 50 | 2 | 2 |
| coherence-cli | on | 3 | 10 of 12 | 66 | 4 | 0 |
| colleague | off | 1 | 9 of 11 | 29 | 3 | 3 |
| colleague | off | 2 | 9 of 11 | 46 | 4 | 2 |
| colleague | off | 3 | 8 of 11 | 20 | 4 | 4 |
| colleague | on | 1 | 6 of 11 | 13 | 4 | 4 |
| colleague | on | 2 | 8 of 11 | 165 | 17 | 11 |
| colleague | on | 3 | 8 of 11 | 54 | 4 | 3 |
| culture | off | 1 | 8 of 12 | 41 | 4 | 2 |
| culture | off | 2 | 5 of 12 | 25 | 6 | 4 |
| culture | off | 3 | 10 of 12 | 62 | 11 | 2 |
| culture | on | 1 | 7 of 12 | 32 | 5 | 0 |
| culture | on | 2 | 8 of 12 | 55 | 9 | 2 |
| culture | on | 3 | 8 of 12 | 47 | 9 | 1 |
| culture-rules | off | 1 | 9 of 12 | 28 | 3 | 0 |
| culture-rules | off | 2 | 6 of 12 | 11 | 0 | 0 |
| culture-rules | off | 3 | 5 of 12 | 18 | 0 | 0 |
| culture-rules | on | 1 | 11 of 12 | 122 | 8 | 2 |
| culture-rules | on | 2 | 6 of 12 | 31 | 4 | 4 |
| culture-rules | on | 3 | 7 of 12 | 7 | 0 | 0 |
| workledger-cli | off | 1 | 12 of 12 | 73 | 10 | 6 |
| workledger-cli | off | 2 | 11 of 12 | 126 | 2 | 2 |
| workledger-cli | off | 3 | 7 of 12 | 20 | 0 | 0 |
| workledger-cli | on | 1 | 10 of 12 | 62 | 2 | 2 |
| workledger-cli | on | 2 | 8 of 12 | 22 | 0 | 0 |
| workledger-cli | on | 3 | 11 of 12 | 59 | 0 | 0 |

The number of statements in an answer runs from 7 to 165. Run-to-run spread
inside an arm is as large as any difference between the arms.

## What the decider answered

In the 18 `check-on` runs the decider scored 98 facts: `part` 39, `all` 35,
`little` 14, `mostly` 10, `none` 0. So 45 passed and 53 did not. Three runs had
no fact with a found quote, so nothing was scored in them.

A pass does not make a fact true. Matching each graded statement to the fact
it restates (by text similarity, a heuristic of the measuring session, not
part of the harness), on the Gemini grading:

| Decider's answer | Statements graded true | Graded false |
|---|---|---|
| `all` or `mostly` | 54 | 5 |
| `part` or `little` | 63 | 6 |

## Where the false statements are

The same matching, over both arms:

| What the statement rests on | True | False | Not checkable |
|---|---|---|---|
| A fact whose quote was found (Gemini) | 228 | 16 | 8 |
| A fact whose quote was refused (Gemini) | 19 | 1 | 2 |
| The model's unchecked text (Gemini) | 965 | 133 | 285 |
| A fact whose quote was found (Claude) | 239 | 6 | 7 |
| A fact whose quote was refused (Claude) | 22 | 0 | 0 |
| The model's unchecked text (Claude) | 1,022 | 65 | 296 |

On either grading, about nine in ten false statements are in the summary and
final message, which no check reads. About five in six statements of an answer
are in that text.

## Limits

- One model (`worker`), six tasks, three runs per arm, one day.
- No person graded. Every grader is a model; three of the four are Claude
  models.
- The count of false statements depends on the grading standard: 71 or 150 on
  the same statements.
- The facts-stated count is a word match and was not read by hand.
- Two attributions here (statement to fact, statement to decider answer) are
  text matching done after the fact.
- Five Claude graders left their working scripts, with verdicts in them, in a
  directory other graders could read. Each script was written in the same
  second as that grader's own output. No sign was found that a grader used
  another's verdicts, and that cannot be proved.
- A Codex grader was tried and did not run: its sandbox does not start on the
  measuring machine.
- In report mode the check removes nothing, so this measures only whether
  seeing the answer changes what a model writes.
- The `check-on` answers were longer (965 statements against 692). The rule
  does not adjust for length.

## What follows

The switch stays off for every model (`support_score.enabled`).

The measurement points at the unchecked text and at claims without a stated
way to check them. Issue #39 takes that up, with its own
spec: every fact carries how to check it, with the command behind a count, and
an answer is built only from items that passed.
