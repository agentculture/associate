# wl-unterminated-ledger: second check

## What I was given

The question "append with file not ending in newline" about workledger-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

_store.py append_entry lines 274-283.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

It refuses and does not modify the file: with the file opened O_RDWR|O_APPEND|O_CREAT, if size>0 and the last byte (pread at size-1) is not b'\n', it raises CliError 'ledger `<path>` does not end with a newline (truncated write?)', remediation 'the ledger is append-only; repair the last line by hand'. Exit code 2 (EXIT_ENV_ERROR; the OSError wrapper does not catch CliError). Nothing is written, no repair/truncation. The new entry is lost (not appended).

## Confidence and doubts

high
