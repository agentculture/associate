# The difference that will be called a change, broad tasks

**DRAFT. Not confirmed by the operator.** `associate measure run --broad`
refuses a real run while this file is a draft. To confirm it: replace the
wording below as needed, set `status` to `confirmed` in the parameters, remove
every occurrence of the word DRAFT from this file, and commit it. Changing
this file after the first stored run of a comparison makes that comparison's
reading invalid.

## Parameters

The report reads these four values and nothing else from this file.

```json
{"status": "draft", "repositories": 6, "repositories_required": 5, "runs_per_arm": 3}
```

## What is counted

- The unit is one run of one broad task (one repository) on one arm.
- Two counts are kept per run, each on its own:
  - checklist facts marked as stated, out of that repository's checklist. This
    is a first marking by the answer check; every marking is read by hand.
  - statements counted false by hand. Each one is recorded with the file and
    line that contradicts it, and the person counting does not see which arm a
    run came from until every run is graded.
- Counts are never added up over runs or repositories and never turned into a
  percentage.

## The rule (DRAFT wording)

- Per repository, the two arms' three runs are compared on each count.
- **A change:** in at least 5 of 6 repositories, every run of one arm is at
  least as good as every run of the other on that count, and strictly better
  in at least one.
- **Anything else:** reported as "no difference shown". It is never reported
  as "no difference".
- More checklist facts marked as stated is better. Fewer statements counted
  false is better. The rule is applied to each count separately.

## When the rule is not applied

The report says "not applicable" and gives the reason when the stored runs are
not the ones this rule was written for: not exactly two arms, not six
repositories with runs, or fewer than three usable runs of an arm in a
repository. A run that failed to launch or read the answer key is not a usable
run.

## What this measures

This is an internal measurement on six repositories. It is not a benchmark
score. A fact marked as stated means its words were found in the answer text.
