# wl-limit-order: second check

## What I was given

The question "list --limit semantics" about workledger-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

list.py lines 376-404, 412.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

Keeps the most recent N matching entries (the last N in file order), printed in append order i.e. oldest first among those N (help says 'Only the most recent N matching entries'). It does not hold every matching entry in memory: it uses `collections.deque(matches, maxlen=N)` over a streaming generator, so memory is bounded by N (the file is still read fully because every line is validated). Without --limit it does list(matches), i.e. all. N<1 is a user error (exit 1).

## Confidence and doubts

high
