# wl-duplicate-id: second check

## What I was given

The question "list with duplicate id" about workledger-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

_store.py iter_entries lines 207-245, _corrupt 181-186; list.py cmd_list; _errors.py EXIT_ENV_ERROR=2.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

It treats the ledger as corrupt: iter_entries keeps a `seen` set and on a repeated id raises CliError `ledger <path> is corrupt at line N: duplicate id '<id>'` with remediation 'the ledger is append-only; inspect the file by hand'. Exit code 2 (EXIT_ENV_ERROR). Validation is done on every line even ones a filter would drop; the generator is lazy so entries before the bad line may have been read, but list builds its output list before printing, so nothing is printed and the error goes to stderr.

## Confidence and doubts

high
