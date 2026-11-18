# First check: `spawn-holders`

- Repository: github.com/agentculture/associate
- Pinned commit: `266dad376813baa8a92a2f34b457222ae7d9d481`
- Kind: find
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

In associate/contract/models.json, which registry models list spawn_subagent among their tools, what is the status of each, and which models may each of them spawn?

## What was run and what it printed

Each command ran in the associate checkout with `COMMIT=266dad376813baa8a92a2f34b457222ae7d9d481`.

```text
$ git show $COMMIT:associate/contract/models.json | grep -n -E '"(worker|senses|cortex|super-vl)": \{|"status"|spawn_subagent|"may_spawn"'
22:    "spawn_subagent",
32:    "worker": {
33:      "status": "active",
45:      "may_spawn": [],
48:    "senses": {
49:      "status": "active",
61:      "may_spawn": [],
64:    "cortex": {
65:      "status": "active",
73:        "ledger_list", "run_tests", "spawn_subagent", "check_quote", "associate_ready", "finish"
77:      "may_spawn": ["worker", "senses"],
80:    "super-vl": {
81:      "status": "pending",
89:        "ledger_list", "run_tests", "spawn_subagent", "check_quote", "associate_ready", "finish"
93:      "may_spawn": ["worker", "senses"],
```

## Finding

```text
spawn_subagent appears three times: in tool_names, in cortex's tools and in super-vl's tools. cortex is status active, super-vl is status pending; both have may_spawn ["worker", "senses"]. worker and senses do not hold it. Recorded answer right.
```

## Recorded answer

```text
Two entries list spawn_subagent: cortex (status active) and super-vl (status pending, not usable yet). Both have may_spawn ["worker", "senses"]: each may spawn worker and senses. worker and senses do not hold spawn_subagent.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
