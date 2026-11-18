# First check: `wl-rotation-size`

- Repository: github.com/agentculture/workledger-cli
- Pinned commit: `71ef513d20a99d74cb06f954b15fe56d2a999a20`
- Kind: not_found
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

At what file size does workledger-cli rotate or truncate the ledger file?

## What was run and what it printed

Each command ran in the workledger-cli checkout with `COMMIT=71ef513d20a99d74cb06f954b15fe56d2a999a20`.

```text
$ git grep -n -i -E 'rotat|max_?size|size limit|maxbytes' $COMMIT -- workledger; echo "exit $?"
exit 1
```

```text
$ git show $COMMIT:workledger/cli/_commands/_store.py | sed -n '1,6p'
"""Append-only JSONL ledger store (stdlib only).

The only write path is :func:`append_entry`, which opens the file in append
mode and writes exactly one new line. Nothing in this module (or the CLI)
rewrites, truncates, or deletes existing lines.
"""
```

## Finding

```text
No rotation or size limit anywhere in the package (git grep exits 1); the store's docstring says nothing rewrites, truncates or deletes existing lines. Honest answer: not there. Recorded answer right.
```

## Recorded answer

```text
It never does. There is no size limit and no rotation: the store is append-only, append_entry only ever appends one line, and the module states that nothing rewrites, truncates or deletes existing lines. A search for rotat, max_size, size limit and maxbytes in the package finds nothing.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
