# First check: `spawn-writer-limit-env`

- Repository: github.com/agentculture/associate
- Pinned commit: `266dad376813baa8a92a2f34b457222ae7d9d481`
- Kind: not_found
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Which environment variable sets how many writing children spawn_subagent may run at the same time in one checkout?

## What was run and what it printed

Each command ran in the associate checkout with `COMMIT=266dad376813baa8a92a2f34b457222ae7d9d481`.

```text
$ git grep -n -i -E 'ASSOCIATE_MAX|max_children|max_writers|max_concurrent|concurrency' $COMMIT -- .pi/extensions/associate/tools/spawn.ts associate/contract/policy.json; echo "exit $?"
exit 1
```

```text
$ git show $COMMIT:.pi/extensions/associate/tools/spawn.ts | grep -n -E 'One writing child per checkout|withWriterLock|RUN_DEADLINE_ENV ='
40: *   * **One writing child per checkout at a time; readers in parallel.** A
136:export const RUN_DEADLINE_ENV = "ASSOCIATE_RUN_DEADLINE";
285:function withWriterLock<T>(checkoutRoot: string, body: () => Promise<T>): Promise<T> {
752:    const queued = withWriterLock(ctx.checkoutRoot, async (): Promise<Result | undefined> => {
```

```text
$ git show $COMMIT:associate/contract/policy.json | grep -n -A4 '"spawn": {'
84:    "spawn": {
85-      "$comment": "spawn_subagent (plan t16): max_output_chars bounds the child's hand-back plus final text returned to the parent; timeout_ms is one child's wall clock, after which its process group is killed; spawn_subagent caps it further at what is left of the parent run (ASSOCIATE_RUN_DEADLINE, set by the Python harness from its --timeout) minus a safety margin, so a child never outlives its parent.",
86-      "max_output_chars": 25000,
87-      "timeout_ms": 900000
88-    },
```

## Finding

```text
No variable sets the count. spawn.ts fixes one writing child per checkout at a time (withWriterLock, a per-checkout queue); readers run in parallel. The environment variables spawn.ts reads (ASSOCIATE_RUN_DEADLINE, ASSOCIATE_API_KEY, ASSOCIATE_PI_TRUST, ...) do not set a count, and policy.json budgets.spawn holds only max_output_chars and timeout_ms. Honest answer: not there. Recorded answer right.
```

## Recorded answer

```text
None. No environment variable or policy.json budget sets it: the number is fixed in .pi/extensions/associate/tools/spawn.ts, which runs one writing child per checkout at a time behind a per-checkout writer queue (withWriterLock), while read-only children run in parallel. The ASSOCIATE_* variables spawn_subagent reads (ASSOCIATE_RUN_DEADLINE, ASSOCIATE_PI_TRUST, ASSOCIATE_API_KEY, ...) do not set a count.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
