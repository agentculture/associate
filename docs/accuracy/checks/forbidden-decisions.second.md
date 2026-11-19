# forbidden-decisions: second check

## What I was given

The question "decisions the role contract forbids" about associate at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

Read associate/contract/role.json `forbidden` array.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

File associate/contract/role.json, key `forbidden`: ["final_decision", "security_decision"]. Harness-wide, shared by every registry model (deviation d13).

## Confidence and doubts

high
