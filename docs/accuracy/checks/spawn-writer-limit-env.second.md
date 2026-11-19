# spawn-writer-limit-env: second check

## What I was given

The question "env var for writing children count" about associate at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

Read .pi/extensions/associate/tools/spawn.ts lines 40-46 and 271-295; grepped process.env / ASSOCIATE_ names in spawn.ts. (One broader recursive grep was blocked by the sandbox.)
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

There is none. The limit is fixed at one writing child per checkout at a time (per-checkout promise queue `withWriterLock`, spawn.ts lines 271-295); readers (may_mutate false) run in parallel. spawn.ts reads only ASSOCIATE_RUN_DEADLINE, ASSOCIATE_MODEL, ASSOCIATE_API_KEY, ASSOCIATE_SESSION_ID, ASSOCIATE_EXPORT_ROOT, ASSOCIATE_CONTRACT_DIR, ASSOCIATE_CHECKOUT_ROOT, ASSOCIATE_INJECT_PROMPT, ASSOCIATE_PI_TRUST, ASSOCIATE_CONTINUE_FROM (and sets ASSOCIATE_SPAWNED_BY); none sets a writer count. The question's premise (a configurable count) is false at this commit. Also not in policy.json.

## Confidence and doubts

medium
