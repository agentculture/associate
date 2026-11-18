# wl-rotation-size: second check

## What I was given

The question "rotation/truncation size" about workledger-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

grep -rn -i 'rotat|truncat|max_size|st_size' workledger; _store.py docstring line 3-5.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

No size at which it rotates or truncates: there is no rotation or truncation. The store is append-only ('Nothing in this module (or the CLI) rewrites, truncates, or deletes existing lines'). The only st_size use is the newline-ending check in append_entry. Premise false.

## Confidence and doubts

high
