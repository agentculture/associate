# The 16-run pilot of `associate measure`

A pilot of the graded comparison, run on 2026-11-18 before the 288-run
comparison. Its purpose was to show that the path works end to end and to
measure run times. **No difference between the arms is read from it**: the
rule in `docs/accuracy/difference-threshold.md` says pilot runs are not part of
the comparison, and 16 runs on four tasks could not show one.

## Settings

- Four arms: `worker` and `cortex`, each on the harness before PR #27
  (`a9182d7`) and on `main` (`266dad3`).
- Four of the 24 tasks in `docs/accuracy/tasks.json`: `read-budget`,
  `wl-entry-fields`, `coh-investiture-formula`, `coh-url-check-timeout`.
- One repeat, reasoning on in every arm, 3,600 seconds per run, report mode.
- Both harness commits ran on pi 1.5.2. The older commit pins pi 1.1.0 and
  warns about the mismatch; it ran in 8 of 8 runs.
- The `ledger` binary was not installed, so every `ledger_append` call failed.

## Result

All 16 runs were stored. None failed to launch, none timed out, and no walk
read the answer key.

| Arm | Runs | Answer marked as matching | No answer | Mean time |
|---|---|---|---|---|
| worker, before PR #27 | 4 | 4 | 0 | 119 s |
| worker, main | 4 | 4 | 0 | 184 s |
| cortex, before PR #27 | 4 | 4 | 0 | 122 s |
| cortex, main | 4 | 3 | 1 | 177 s |

Time per run, in seconds:

| Task | worker before | worker main | cortex before | cortex main |
|---|---|---|---|---|
| `read-budget` | 73 | 104 | 41 | 136 |
| `wl-entry-fields` | 156 | 239 | 111 | 175 |
| `coh-investiture-formula` | 176 | 210 | 146 | 209 |
| `coh-url-check-timeout` | 72 | 181 | 188 | 188 |

The 16 runs took about 40 minutes in total. At that rate 288 runs take about
12 hours; the four tasks may be easier than the other 20.

## What was checked by hand

All 15 answers were read against the second checker's answers in
`docs/accuracy/checks/`. The reader agreed with every mark. One answer marked
as matching carries a wrong side detail: `worker` on `main` said the `agent`
field of a ledger entry is generated, when the caller supplies it. The question
asked for the count and names of the fields, which it gave correctly.

Grading the 16 stored runs a second time changed no grade.

## The two grade readings

Each run is graded twice: on the model's answer text alone, and on the answer
text plus the values it handed back. The two readings gave the same grade on
every run that has both. The operator chose the answer text alone as the
reading the table is read on, because both arms have it; the second reading is
reported beside it.

## What the pilot exposed

- **A run that ended with no answer.** In `wl-entry-fields`, `cortex` on
  `main` finished its reads, then called `ledger_append` twice and
  `eidetic_remember` once. The gate refused all three (scores 0.207, 0.229 and
  0.205) and the run ended `refused` with no `finish`. It is graded "cannot
  tell", not wrong.
- **The older arm keeps only the last 2,000 characters of its answer.** One of
  the 8 older-arm answers was at that cap and starts mid-sentence. A long
  answer with its key values at the start would be marked as not matching on
  that arm only. The comparison reports how many answers were at the cap.
- **The quote-found counts on `main`** were 4 of 4, 8 of 8, 3 of 4, 4 of 5,
  12 of 14, 4 of 4 and 4 of 4. That count says a quote was found in the saved
  result it cites; it does not say the value is true.

Each item above is one run, not a rate.

## Second pilot, with the `ledger` binary installed

The operator installed workledger-cli 0.8.0 and asked for the pilot to be
repeated. Same 16 runs and settings, run later on 2026-11-18. No difference
between the arms is read from it either.

All 16 runs were stored. None failed to launch, none timed out, and no walk
read the answer key.

| Arm | Runs | Answer marked as matching | Marked as not matching | Mean time |
|---|---|---|---|---|
| worker, before PR #27 | 4 | 4 | 0 | 398 s |
| worker, main | 4 | 4 | 0 | 237 s |
| cortex, before PR #27 | 4 | 2 | 2 | 68 s |
| cortex, main | 4 | 4 | 0 | 267 s |

Time per run, in seconds:

| Task | worker before | worker main | cortex before | cortex main |
|---|---|---|---|---|
| `read-budget` | 61 | 174 | 34 | 99 |
| `wl-entry-fields` | 52 | 227 | 54 | 287 |
| `coh-investiture-formula` | 162 | 240 | 108 | 473 |
| `coh-url-check-timeout` | 1,318 | 306 | 75 | 207 |

The run time adds up to about 65 minutes, against 40 in the first pilot. One
run took 1,318 seconds: `worker` before PR #27 on `coh-url-check-timeout`
answered that no such timeout exists, then tried to add the check to the
repository; the gate refused the edit.

### The two answers marked as not matching, read by hand

- **`wl-entry-fields`, `cortex` before PR #27.** The answer says "6 top-level
  fields" and then lists seven names. The count is wrong; the mark is right.
- **`coh-investiture-formula`, `cortex` before PR #27.** The stored answer is
  exactly 2,000 characters and starts mid-sentence. What remains names the
  values used and the two left out, correctly, but the sentence saying the
  score is a product was cut off. The mark is an effect of the 2,000-character
  cap, not of the answer. The run's `statements.json` holds that sentence.

The other 14 answers were read by hand and the reader agreed with their marks.

### What the second pilot showed

- **The cap changed a grade.** Three of the 16 stored answers were exactly
  2,000 characters: the one above, and two from `worker` on `main` that ended
  without calling `finish`. The cap applies to any run graded on its final
  reply, on either harness; a run on `main` that calls `finish` is graded on
  `answer.md`, which has no cap.
- **Ending without `finish`.** `worker` on `main` did so in 2 of 4 runs. Both
  answers were still marked as matching, from the final reply.
- **The ledger tools ran.** Of 14 `ledger_append` calls, 11 wrote an entry,
  the gate refused two (scores 0.210 and 0.221 against a limit of 0.2), and
  one was refused for having no `purpose`. All three `ledger_list` calls
  returned what was there. Entries went to the run's own ledger file. No run
  lost its answer to a refusal.
- **A workledger task can be answered from the tool.** On `wl-entry-fields`,
  `worker` before PR #27 and `cortex` on `main` each appended an entry and
  read its fields from the tool's output. The installed tool is workledger-cli
  0.8.0; the task is pinned to an earlier commit. The operator decided to
  leave the tools available and to report, beside the comparison table, how
  many runs called a ledger tool on a workledger-cli task.
- **The two grade readings** gave the same grade on every run that has both.

Each item is one or two runs, not a rate.
