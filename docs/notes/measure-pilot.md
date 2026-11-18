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
