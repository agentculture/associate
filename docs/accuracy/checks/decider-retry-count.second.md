# decider-retry-count: second check

## What I was given

The question "gate decider retries/backoff" about associate at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

Read .pi/extensions/associate/lib/gate.ts header comment (lines 10-20) and grepped gate.ts and associate/contract/*.json for retry/backoff/attempt.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

None found: there is no retry and no backoff. The gate makes a single POST to the decider (/v1/systemone); gate.ts says any non-2xx status, network error, missing key or timeout means CLEF is *unreachable*, which moves to the next tier (Super, then read-only fallback) - that is tier fallback, not retry. A 2xx malformed answer refuses at tier clef 'and is NOT retried on a laxer tier'. So max retries = 0, backoff = none. (The only 'retry' hits are accuracy.json retry_rounds = 2, which is the hand-back check, unrelated to the decider.) A per-call timeout exists (abort timer in gate.ts ~line 792) but no retry.

## Confidence and doubts

medium
