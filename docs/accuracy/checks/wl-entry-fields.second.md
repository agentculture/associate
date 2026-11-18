# wl-entry-fields: second check

## What I was given

The question "top-level fields of stored entry" about workledger-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

_store.py append_entry lines 268-292 and validate_input lines 161-177.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

7 fields: id (uuid4 hex), timestamp (UTC ms, e.g. ...Z), agent, action, summary, refs (list of strings, default []), data (object, default {}). Written in that order (id, timestamp, then agent, action, summary, refs, data). id and timestamp are generated and cannot be supplied.

## Confidence and doubts

high
