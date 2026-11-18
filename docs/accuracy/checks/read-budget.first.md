# First check: `read-budget`

- Repository: github.com/agentculture/associate
- Pinned commit: `266dad376813baa8a92a2f34b457222ae7d9d481`
- Kind: read
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

What limits does associate/contract/policy.json set on one read of a file (maximum lines, maximum output characters, maximum bytes), and does an over-limit read spill to disk?

## What was run and what it printed

Each command ran in the associate checkout with `COMMIT=266dad376813baa8a92a2f34b457222ae7d9d481`.

```text
$ git show $COMMIT:associate/contract/policy.json | grep -n -A5 '"read": {'
4:  "read": {
5-    "confine_to_session_root": true,
6-    "refuse_parent_path_segments": true,
7-    "respect_gitignore": true,
8-    "line_numbers": "absolute",
9-    "denylist": [
--
72:    "read": {
73-      "max_lines": 1000,
74-      "max_output_chars": 25000,
75-      "max_bytes": 1048576,
76-      "spill_to_disk": true
77-    },
```

## Finding

```text
budgets.read: max_lines 1000, max_output_chars 25000, max_bytes 1048576, spill_to_disk true. Recorded answer right. Expected values changed in t8: the three limits are number items (all are 100 or more) with their digit-grouped forms (1,000 / 25,000 / 1,048,576, and "1 MiB"), and spilling is a group of forms ("spill_to_disk true", "spills", "does spill", ...) with "not spill", "never spill" and spill_to_disk false forms forbidden. The saved cortex answer ("1000 lines, 25,000 output characters, and 1,048,576 bytes ... spill_to_disk enabled") is right and was marked wrong before. Known limit: the numbers are not tied to their key names, so an answer that swaps two limits is still marked right.
```

## Recorded answer

```text
budgets.read sets max_lines 1000, max_output_chars 25000, max_bytes 1048576, and spill_to_disk true.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (4 judged right, 2 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
