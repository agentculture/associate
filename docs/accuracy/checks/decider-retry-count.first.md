# First check: `decider-retry-count`

- Repository: github.com/agentculture/associate
- Pinned commit: `266dad376813baa8a92a2f34b457222ae7d9d481`
- Kind: not_found
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

What is the maximum number of retries, and the backoff between them, that the CLEF safety gate applies to a failed call to the decider?

## What was run and what it printed

Each command ran in the associate checkout with `COMMIT=266dad376813baa8a92a2f34b457222ae7d9d481`.

```text
$ git grep -n -i -E 'retry|retries|backoff|attempts' $COMMIT -- associate/contract/gate.json .pi/extensions/associate/lib/gate.ts; echo "exit $?"
exit 1
```

```text
$ git show $COMMIT:.pi/extensions/associate/lib/gate.ts | sed -n '17,20p'
 *      questions>}`. A well-formed answer is judged by `clef.allow_when`
 *      (every rule must hold); a 2xx with a malformed answer refuses at tier
 *      `clef` and is NOT retried on a laxer tier. Any non-2xx status, network
 *      error, missing key or timeout means CLEF is *unreachable*.
```

## Finding

```text
No retry, retries, backoff or attempts in gate.json or lib/gate.ts at the pin (git grep exits 1); gate.ts line 19 says a decider failure is "NOT retried on a laxer tier". The honest answer is that there is no retry. Recorded answer right. Group widened with "does not retry", "never retries", "zero retries", ...; both saved answers matched before and after.
```

## Recorded answer

```text
Not found. The gate has no retry or backoff setting: a case-insensitive search for retry, retries, backoff and attempts finds nothing in associate/contract/gate.json or in .pi/extensions/associate/lib/gate.ts. The one nearby hit is the comment at gate.ts line 19 saying a decider failure is "NOT retried on a laxer tier", which says there is no retry. When the decider is unreachable the gate falls through to the Super tier and then the read-only fallback (gate.json readonly_fallback), it does not retry.
```

## Answer check against the hand judgement

5 answers in docs/accuracy/answer-cases.json (3 judged right, 2 judged wrong); the answer check agrees with the hand judgement on 5 of 5. The recorded answer grades `matches`.
