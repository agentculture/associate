# The difference that will be called a change

Written before any stored run of the comparison (spec claim c36). Confirmed by
the operator on 2026-11-18. Changing this file after the first stored run of a
comparison makes that comparison's reading invalid.

## What is counted

- The unit is a run whose answer the answer check marked as matching.
- Counts are per arm and per model, out of 72 runs (24 tasks, 3 repeats).
- A contaminated run and a run that was not graded (a time limit, a failed
  launch) are reported in their own columns. Neither is counted as wrong.

## The rule

- **A change:** on one model, the two arms differ by 12 or more matching runs
  out of 72.
- **Fewer than 12:** reported as "no difference shown". It is never reported
  as "no difference".
- The table also reports, per model, how many tasks change their majority
  verdict (2 of 3 repeats) between the arms, in each direction.

## Why 12

With about half the runs matching, chance alone moves the gap between two arms
of 72 runs by about 6 runs. Twelve is twice that. The three repeats of one
task are not independent of each other, which argues for the wider margin.

## When the result may be read

Both conditions must hold; otherwise the table is reported as not readable and
the cause is fixed first.

1. At least 95% of the runs are graded.
2. A hand-graded sample of at least 48 graded runs agrees with the answer
   check on at least 95% of the runs that were hand graded.

## The pilot

A pilot of 16 runs comes first. It gives run times and the numbers for
choosing between the two readings of an answer (the model's answer text alone;
that text plus the values and conclusions the model wrote in its hand-back).
Its runs are not part of the comparison, and no difference is read from them.

## What this measures

This is an internal measurement on 24 tasks. It is not a benchmark score. A
matching run means the expected values were found in the answer text.
