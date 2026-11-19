# read-budget: second check

## What I was given

The question "policy.json read limits and spill" about associate at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

Read associate/contract/policy.json lines 71-77; grep spill in .pi/extensions/associate/lib/contain.ts (lines 56, 416-494).
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

policy.json `budgets.read`: max_lines 1000, max_output_chars 25000, max_bytes 1048576 (1 MiB), spill_to_disk true. So yes, an over-limit read is configured to spill the untruncated output to disk (contain.ts boundOutput writes a spill file with mode 0o600, O_EXCL/NOFOLLOW; read.ts reports a spillPath/cursor) rather than just being dropped. I did not run it; this is from the config and the code.

## Confidence and doubts

high
