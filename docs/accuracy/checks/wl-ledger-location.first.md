# First check: `wl-ledger-location`

- Repository: github.com/agentculture/workledger-cli
- Pinned commit: `71ef513d20a99d74cb06f954b15fe56d2a999a20`
- Kind: find
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Where does workledger-cli write its ledger file when no override is set, and which environment variable overrides that location?

## What was run and what it printed

Each command ran in the workledger-cli checkout with `COMMIT=71ef513d20a99d74cb06f954b15fe56d2a999a20`.

```text
$ git show $COMMIT:workledger/cli/_commands/_store.py | grep -n -E 'ENV_PATH =|DEFAULT_PATH =|_git_toplevel\(cwd\)|def _git_toplevel'
22:ENV_PATH = "WORKLEDGER_PATH"
23:DEFAULT_PATH = Path(".workledger") / "ledger.jsonl"
37:def _git_toplevel(start: Path) -> Path | None:
55:    return (_git_toplevel(cwd) or cwd) / DEFAULT_PATH
```

## Finding

```text
WORKLEDGER_PATH overrides; otherwise .workledger/ledger.jsonl under the git toplevel of the cwd (nearest ancestor holding .git), or the cwd outside a repository. Recorded answer right.
```

## Recorded answer

```text
WORKLEDGER_PATH overrides it. Otherwise the ledger is .workledger/ledger.jsonl under the git toplevel of the current directory (the nearest ancestor holding .git), or under the current directory itself outside a repository (workledger/cli/_commands/_store.py, ledger_path).
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
