# wl-ledger-location: second check

## What I was given

The question "default ledger location, env override" about workledger-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

workledger/cli/_commands/_store.py lines 22-23, 45-55.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

Default: `.workledger/ledger.jsonl` under the git toplevel of the cwd (nearest ancestor with a .git dir or file), or under the cwd when not inside a repo. Override: environment variable WORKLEDGER_PATH (used as the full file path). tests/test_ledger.py lines 151-154, 355-384 agree.

## Confidence and doubts

high
