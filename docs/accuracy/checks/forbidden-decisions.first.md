# First check: `forbidden-decisions`

- Repository: github.com/agentculture/associate
- Pinned commit: `266dad376813baa8a92a2f34b457222ae7d9d481`
- Kind: find
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Which decisions does the harness-wide role contract forbid every registry model from taking, and in which file?

## What was run and what it printed

Each command ran in the associate checkout with `COMMIT=266dad376813baa8a92a2f34b457222ae7d9d481`.

```text
$ git show $COMMIT:associate/contract/role.json | grep -n -A3 '"forbidden"'
15:  "forbidden": [
16-    "final_decision",
17-    "security_decision"
18-  ],
```

## Finding

```text
role.json forbidden: final_decision, security_decision. Recorded answer right. The file item became a group (associate/contract/role.json, contract/role.json, role.json) so a short path is accepted; both saved answers matched before and after.
```

## Recorded answer

```text
associate/contract/role.json lists forbidden: final_decision and security_decision.
```

## Answer check against the hand judgement

5 answers in docs/accuracy/answer-cases.json (3 judged right, 2 judged wrong); the answer check agrees with the hand judgement on 5 of 5. The recorded answer grades `matches`.
