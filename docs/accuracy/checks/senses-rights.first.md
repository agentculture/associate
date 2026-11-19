# First check: `senses-rights`

- Repository: github.com/agentculture/associate
- Pinned commit: `266dad376813baa8a92a2f34b457222ae7d9d481`
- Kind: read
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

In associate/contract/models.json, may the senses model change the checkout (may_mutate), and which registry models may it delegate a task to?

## What was run and what it printed

Each command ran in the associate checkout with `COMMIT=266dad376813baa8a92a2f34b457222ae7d9d481`.

```text
$ git show $COMMIT:associate/contract/models.json | grep -n -A15 '"senses": {' | grep -n -E 'may_mutate|may_delegate|may_spawn'
13:60-      "may_mutate": false,
14:61-      "may_spawn": [],
15:62-      "may_delegate": ["worker"]
```

## Finding

```text
senses has may_mutate false and may_delegate ["worker"]. Recorded answer right. Expected values widened to the colon, backtick and "is" forms and to "only (to) worker"; the saved cortex answer wrote `may_mutate: false` and `may_delegate: ["worker"]` and was marked wrong before. must_not_appear "may_mutate true" was dropped: a right answer may say that worker has may_mutate true.
```

## Recorded answer

```text
The senses entry has may_mutate false and may_delegate ["worker"], so it cannot change the checkout itself and may hand a task to worker through delegate_run.
```

## Answer check against the hand judgement

5 answers in docs/accuracy/answer-cases.json (3 judged right, 2 judged wrong); the answer check agrees with the hand judgement on 5 of 5. The recorded answer grades `matches`.
