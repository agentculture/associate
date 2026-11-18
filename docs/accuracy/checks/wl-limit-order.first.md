# First check: `wl-limit-order`

- Repository: github.com/agentculture/workledger-cli
- Pinned commit: `71ef513d20a99d74cb06f954b15fe56d2a999a20`
- Kind: review
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Review `ledger list --limit N`: which N of the matching entries does it keep, in what order does it print them, and does it hold every matching entry in memory to do so?

## What was run and what it printed

Each command ran in the workledger-cli checkout with `COMMIT=71ef513d20a99d74cb06f954b15fe56d2a999a20`.

```text
$ git show $COMMIT:workledger/cli/_commands/list.py | grep -n -E 'deque|Most recent N|oldest first|--limit'
6:from collections import deque
22:            message="--limit must be >= 1",
35:    # Most recent N only, still in append order; deque keeps memory bounded by N.
36:    entries = list(deque(matches, maxlen=args.limit) if args.limit is not None else matches)
50:    p = sub.add_parser("list", help="List ledger entries (oldest first).")
54:    p.add_argument("--limit", type=int, help="Only the most recent N matching entries.")
```

## Finding

```text
matches is a generator; with --limit it goes through deque(matches, maxlen=N), keeping the last (most recent) N in append order, memory bounded by N; output is oldest first (help: "List ledger entries (oldest first)."). Without --limit every match is listed. Recorded answer right.
```

## Recorded answer

```text
It keeps the most recent N matching entries (the last N in the file) and prints them oldest first, in append order. It does not hold every match: the matches stream into deque(matches, maxlen=N), so memory is bounded by N (workledger/cli/_commands/list.py).
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
