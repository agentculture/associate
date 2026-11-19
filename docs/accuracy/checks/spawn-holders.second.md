# spawn-holders: second check

## What I was given

The question "models listing spawn_subagent" about associate at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

python json over associate/contract/models.json models[*].tools; lines 65-94.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

spawn_subagent is in the tools list of: cortex (status active, may_spawn ["worker","senses"]) and super-vl (status pending, may_spawn ["worker","senses"]). worker and senses do not list it (their may_spawn is []). Note super-vl is pending/not usable.

## Confidence and doubts

high
