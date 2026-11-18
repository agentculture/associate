# The accuracy checks and the failure behind each

Every check the accuracy method runs on a hand-back is listed in
`associate/contract/accuracy.json` (`checks`), each with the recorded failure
that motivated it. This note is that list in readable form (issue #20, spec
claim c20). A check whose reason no longer holds can be removed; a new check
needs a recorded failure first. The contract test
`tests/test_accuracy_contract.py` fails when a check has no
`motivating_failure`.

`strength` is `refuse` (in enforce mode the hand-back is refused with the fix)
or `flag` (recorded in the report only). In report mode nothing is refused:
the report lists what would have been.

A passed fact means its quote was found in the saved result of the entry it
cites. It does not mean the value is true.

## `unknown_source` (refuse)

A worker cited w19 (an ls of the lib directory) for a claim about walk.ts: it counted its calls, was wrong, and the harness recorded the statement as referenced (live run scope20-worker-t2).

Checker reasons that map to it: `source_malformed`, `source_unknown`.

## `quote_not_in_result` (refuse)

A cited line only had to fall inside a read range, so a sentence that quoted example markers from AGENTS.md was recorded as referenced on w3 and w7 (live run scope20-worker-t2).

Checker reasons that map to it: `quote_absent`.

## `quote_too_short` (refuse)

A one-word quote matches almost any saved result, so a fact could pass without being tied to the entry it cites.

Checker reasons that map to it: `quote_short`.

## `ambiguous_run_label` (flag)

Walk ids restart at w1 in every run, so a continued run's citations of the prior run's ids resolved against the wrong entries and all were recorded as referenced (live run scope20-worker-t5).

Checker reasons that map to it: `ambiguous_reference`.

## `closing_conclusion_unread` (refuse)

A worker closed with 'Nothing was concluded without reading' while its run was marked not_fully_read (live run scope20-worker-t2).

Checker reasons that map to it: `verdict_with_unread`.

## `literal_outside_quote` (refuse)

A fact with value 'version 10' and quote '"version": 9' passes a quote match alone (docs/specs/2026-11-17-associate-accuracy-method.md, scope entry s38).

Checker reasons that map to it: `literal_not_in_quote`.

## `source_is_path` (refuse)

Prior-run and child-run results live outside the session root, and nothing stopped the model naming a location instead of an entry (docs/specs/2026-11-17-associate-accuracy-method.md, scope entry s44).

Checker reasons that map to it: `source_path`.

## `action_without_call` (refuse)

A senses run reported 'Eidetic remember: Success' with no eidetic_remember call in its walk (docs/notes/t20-live-acceptance.md:53, t20 run A2).

Checker reasons that map to it: `action_failed`, `action_tool_missing`, `action_wrong_tool`.

## `conclusion_without_fact` (refuse)

cortex carried 'a content-identical copy of the same table also sits in pyproject.toml' in its finish summary with no fact behind it, from a file it never read (live run scope20-cortex-t1).

Checker reasons that map to it: `basis_refused`, `no_basis`, `unknown_fact`.

## `open_item_undecided` (refuse)

A worker review marked a finding 'CANNOT TELL' with no check that would decide it, carried only in the argument of a failed ledger call (live run scope20-worker-t3).

Checker reasons that map to it: `open_without_check`.

## `closing_conclusion_second_hand` (refuse)

A spawn_subagent hand-back or a delegate_status final_reply is the child model's own account, not something the harness measured (tools/delegate.ts, cited in docs/specs/2026-11-17-associate-accuracy-method.md scope entry s13).

Checker reasons that map to it: `closing_second_hand`.
