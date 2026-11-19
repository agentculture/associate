# senses-rights: second check

## What I was given

The question "senses may_mutate and delegation" about associate at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

associate/contract/models.json lines 49-62 (senses entry); parsed with python json.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

senses: `may_mutate: false` (line 60), so it may not change the checkout. `may_delegate: ["worker"]` (line 62): it may delegate only to worker. (Its `may_spawn` is [].) All other models have `may_delegate: []`.

## Confidence and doubts

high
