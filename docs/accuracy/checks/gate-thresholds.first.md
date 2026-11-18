# First check: `gate-thresholds`

- Repository: github.com/agentculture/associate
- Pinned commit: `266dad376813baa8a92a2f34b457222ae7d9d481`
- Kind: find
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Which file defines the CLEF safety gate's thresholds, what is that file's version, what are the names of the threshold questions and their threshold values, and which tools are gated without being in the mutating set?

## What was run and what it printed

Each command ran in the associate checkout with `COMMIT=266dad376813baa8a92a2f34b457222ae7d9d481`.

```text
$ git show $COMMIT:associate/contract/gate.json | grep -n -E '"version"|allow_when|"question": "(safe_unattended|destructive|exfiltrates|matches_task|reversibility)", "op"|"option"'
3:  "version": 9,
66:    "allow_when": [
67:      {"question": "safe_unattended", "op": ">=", "value": 0.5},
68:      {"question": "destructive", "op": "<=", "value": 0.2},
69:      {"question": "exfiltrates", "op": "<=", "value": 0.1},
70:      {"question": "matches_task", "op": ">=", "value": 0.5},
71:      {"question": "reversibility", "option": "irreversible", "op": "<=", "value": 0.2}
80:    "allow_when": {
89:    "$comment": "Deviations d16 and d19 (version 7). A state over decider.max_input_tokens is never cut and never sent to CLEF: the FULL state (the same fields CLEF would get, uncut) is judged by a large-context registry model, asked the same questions through the Super mechanism (super.answer_shape, judged by super.allow_when). The evaluator is the first `evaluators` key that is active in models.json, registered with pi, and not the acting model. When none is and `self_fallback` is true (d19), the acting model judges its own call from a fresh, history-free request (the gate prompt and the state, no transcript) and the walk line says self_evaluated. No evaluator, an unreachable one, or a prompt over `max_input_tokens` refuses; a malformed or unsafe answer refuses. Deviation d20 (version 8): the evaluator gets its own `timeout_ms` instead of the Super tier's 120 s, because large states took 37-213 s live (3 of 7 probes over 120 s). `max_input_tokens` must leave the provider's registered context window (lib/provider.ts) room for the answer; the extension refuses to load otherwise. Measured live once, one pair, not a rate: cortex judged a 40 KB write on this path (docs/notes/gate-calibration.md).",
```

```text
$ git show $COMMIT:associate/contract/models.json | grep -n -E '"(mutating|gated)_tools"'
29:  "mutating_tools": ["write", "edit", "bash", "ledger_append", "run_tests"],
30:  "gated_tools": ["eidetic_remember", "web_search", "web_page", "delegate_run"],
```

## Finding

```text
gate.json is version 9; clef.allow_when holds safe_unattended >= 0.5, destructive <= 0.2, exfiltrates <= 0.1, matches_task >= 0.5 and reversibility option irreversible <= 0.2. models.json gated_tools are eidetic_remember, web_search, web_page, delegate_run; none of them is in mutating_tools (write, edit, bash, ledger_append, run_tests). The recorded answer is right. Expected values changed in t8: the per-rule phrases ("safe_unattended >= 0.5") were replaced by the five question names as identifiers plus one group per operator and value (">= 0.5" / "≥ 0.5" / ...), because two of three saved correct answers wrote the rule as a table row or as "reversibility (irreversible option) <= 0.2" and were marked wrong. Known limit, accepted: the check no longer ties a value to its question, so an answer that gives matches_task a wrong value while every other value is right is still marked right (safe_unattended supplies the ">= 0.5"). A value with an extra digit ("<= 0.25") also contains "<= 0.2".
```

## Recorded answer

```text
associate/contract/gate.json, version 9. The clef.allow_when rules are safe_unattended >= 0.5, destructive <= 0.2, exfiltrates <= 0.1, matches_task >= 0.5, and reversibility option irreversible <= 0.2. The gated tools that are not in the mutating set are eidetic_remember, web_search, web_page and delegate_run (associate/contract/models.json gated_tools; mutating_tools is write, edit, bash, ledger_append, run_tests).
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (4 judged right, 2 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
