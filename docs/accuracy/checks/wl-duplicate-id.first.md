# First check: `wl-duplicate-id`

- Repository: github.com/agentculture/workledger-cli
- Pinned commit: `71ef513d20a99d74cb06f954b15fe56d2a999a20`
- Kind: read
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

What does `ledger list` do when two lines of the ledger file carry the same id, and with which exit code does it end?

## What was run and what it printed

Each command ran in the workledger-cli checkout with `COMMIT=71ef513d20a99d74cb06f954b15fe56d2a999a20`.

```text
$ git show $COMMIT:workledger/cli/_commands/_store.py | grep -n -E 'duplicate id|is corrupt at line|code=EXIT_ENV_ERROR|Every line is validated'
183:        code=EXIT_ENV_ERROR,
184:        message=f"ledger {path} is corrupt at line {lineno}: {why}",
210:    Every line is validated (shape, timestamp format, unique id) even when the
219:            code=EXIT_ENV_ERROR,
237:                    raise _corrupt(path, lineno, f"duplicate id {entry['id']!r}")
242:                code=EXIT_ENV_ERROR,
279:                    code=EXIT_ENV_ERROR,
288:            code=EXIT_ENV_ERROR,
```

```text
$ git show $COMMIT:workledger/cli/_errors.py | grep -n 'EXIT_ENV_ERROR ='
23:EXIT_ENV_ERROR = 2
```

## Finding

```text
iter_entries raises _corrupt(path, lineno, "duplicate id ..."), a CliError with code EXIT_ENV_ERROR (2) and the message "ledger <path> is corrupt at line N: ..."; list consumes the stream before printing, so nothing is printed. Recorded answer right.
```

## Recorded answer

```text
It stops with an error and prints no entries: iter_entries raises CliError "ledger <path> is corrupt at line N: duplicate id '<id>'" with remediation "the ledger is append-only; inspect the file by hand". The code is EXIT_ENV_ERROR, exit code 2. Every line is validated even when a filter would drop it, so the duplicate is never silently skipped.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
