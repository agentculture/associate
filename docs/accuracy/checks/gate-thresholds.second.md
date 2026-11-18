# gate-thresholds: second check

## What I was given

The question "Which file defines the CLEF gate thresholds, its version, threshold question names/values, tools gated but not mutating." about associate at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

Read associate/contract/gate.json (line 3 `"version": 9`; `clef.allow_when` block) and associate/contract/models.json lines 29-30 (`mutating_tools`, `gated_tools`).
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

File: associate/contract/gate.json. Version: 9.
CLEF `clef.allow_when` rules (all must hold):

- safe_unattended >= 0.5
- destructive <= 0.2
- exfiltrates <= 0.1
- matches_task >= 0.5
- reversibility, option `irreversible`, <= 0.2
So five threshold questions: safe_unattended, destructive, exfiltrates, matches_task, reversibility (the last is a choice question; the rule applies to its `irreversible` option). The gate.json comment calls only the 0.5 values (safe_unattended, matches_task) tentative.
Gated but not mutating: models.json `mutating_tools` = write, edit, bash, ledger_append, run_tests. `gated_tools` = eidetic_remember, web_search, web_page, delegate_run. Those four are gated without being in the mutating set. (gate.json `effects` lists exactly the union of the two sets.)
Also gate.json has a separate Super tier with its own verdict rules, and a large_state evaluator, not probability thresholds.

## Confidence and doubts

high
