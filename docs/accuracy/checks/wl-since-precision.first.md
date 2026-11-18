# First check: `wl-since-precision`

- Repository: github.com/agentculture/workledger-cli
- Pinned commit: `71ef513d20a99d74cb06f954b15fe56d2a999a20`
- Kind: read
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

How does `ledger list --since` treat a bound written with sub-millisecond precision, and a bound written without a timezone?

## What was run and what it printed

Each command ran in the workledger-cli checkout with `COMMIT=71ef513d20a99d74cb06f954b15fe56d2a999a20`.

```text
$ git show $COMMIT:workledger/cli/_commands/_store.py | grep -n -E 'rounds \*up\*|microseconds=1000|naive value is treated as UTC|tzinfo=timezone.utc'
89:    """Parse ISO-8601; a trailing ``Z`` or a naive value is treated as UTC."""
102:        parsed = parsed.replace(tzinfo=timezone.utc)
109:    Sub-millisecond precision rounds *up*, so no entry earlier than the bound is included.
115:            utc += timedelta(microseconds=1000 - utc.microsecond % 1000)
```

## Finding

```text
normalize_since rounds sub-millisecond precision up to the next millisecond (so no earlier entry is included); parse_timestamp treats a trailing Z or a naive value as UTC. Recorded answer right. While writing the task the recorded answer ("rounds sub-millisecond precision up to the next millisecond") was itself marked wrong by the first draft of the expected values; the group gained "up to the next", "precision up", "microseconds up" and "upward".
```

## Recorded answer

```text
normalize_since parses it once and rounds sub-millisecond precision up to the next millisecond, so no entry earlier than the bound is included; a bound without a timezone (naive) is treated as UTC (parse_timestamp). The result is compared as a YYYY-MM-DDTHH:MM:SS.mmmZ string.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
