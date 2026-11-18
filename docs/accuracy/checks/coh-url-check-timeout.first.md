# First check: `coh-url-check-timeout`

- Repository: github.com/agentculture/coherence-cli
- Pinned commit: `a52f7b5be81c636cedcf64535a07cfa878f9be3d`
- Kind: not_found
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

What timeout does coherence-cli's quality domain use when it checks that a cited source URL resolves?

## What was run and what it printed

Each command ran in the coherence-cli checkout with `COMMIT=a52f7b5be81c636cedcf64535a07cfa878f9be3d`.

```text
$ git grep -n -i -E 'timeout|import httpx|urllib|import requests|socket' $COMMIT -- coherence/quality; echo "exit $?"
exit 1
```

```text
$ git show $COMMIT:coherence/quality/heuristics.py | grep -n -E 'no network|cannot check that it resolves'
4:``re`` + ``datetime``, no embeddings, no numpy/httpx, and no network. It never
85:        "heuristic cannot check that it resolves or that the source exists."
```

## Finding

```text
coherence/quality has no timeout and no HTTP client (git grep exits 1); the heuristics docstring says no network, and a source marker only raises source_liveness_unverified. The one timeout in the package (COHERENCE_EMBED_TIMEOUT) belongs to meaning's embed client. Honest answer: not there. Recorded answer right.
```

## Recorded answer

```text
None: the quality domain never checks that a source resolves. Its heuristics are offline text rules with no network access; a found source marker only raises the diagnostic source_liveness_unverified ("the heuristic cannot check that it resolves"). The only timeout in the package, COHERENCE_EMBED_TIMEOUT, belongs to the meaning domain's embedding client.
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
