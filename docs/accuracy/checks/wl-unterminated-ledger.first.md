# First check: `wl-unterminated-ledger`

- Repository: github.com/agentculture/workledger-cli
- Pinned commit: `71ef513d20a99d74cb06f954b15fe56d2a999a20`
- Kind: review
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Review `ledger append` for the case where the existing ledger file does not end with a newline: what does it do with the file, and with which exit code does it end?

## What was run and what it printed

Each command ran in the workledger-cli checkout with `COMMIT=71ef513d20a99d74cb06f954b15fe56d2a999a20`.

```text
$ git show $COMMIT:workledger/cli/_commands/_store.py | grep -n -E 'os.pread|does not end with a newline|repair the last line|code=EXIT_ENV_ERROR'
183:        code=EXIT_ENV_ERROR,
219:            code=EXIT_ENV_ERROR,
242:                code=EXIT_ENV_ERROR,
277:            if size and os.pread(fd, 1, size - 1) != b"\n":
279:                    code=EXIT_ENV_ERROR,
280:                    message=f"ledger {path} does not end with a newline (truncated write?)",
281:                    remediation="the ledger is append-only; repair the last line by hand",
288:            code=EXIT_ENV_ERROR,
```

## Finding

```text
append_entry opens the file O_APPEND, reads the last byte with os.pread and, when it is not a newline, raises CliError (code EXIT_ENV_ERROR = 2) "does not end with a newline (truncated write?)" before _write_all; nothing is written or repaired. Recorded answer right.
```

## Recorded answer

```text
It refuses: append_entry reads the last byte with os.pread and, when it is not a newline, raises CliError "ledger <path> does not end with a newline (truncated write?)" with remediation to repair the last line by hand. Nothing is written and the file is not repaired; the code is EXIT_ENV_ERROR, exit code 2.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
