# wl-since-precision: second check

## What I was given

The question "--since sub-ms and naive" about workledger-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

_store.py parse_timestamp 88-103, normalize_since 106-122.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

Sub-millisecond bound: rounds UP to the next whole millisecond (microsecond remainder added as 1000-remainder), so no entry earlier than the bound is included; a bound already on a ms boundary is unchanged. Naive bound (no timezone): treated as UTC (tzinfo replaced with UTC). Trailing Z/z is accepted as UTC; other offsets are converted to UTC. Normalised to YYYY-MM-DDTHH:MM:SS.mmmZ and compared lexicographically with `timestamp >= since`. Invalid text: user error exit 1.

## Confidence and doubts

high
