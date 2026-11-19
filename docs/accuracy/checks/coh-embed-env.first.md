# First check: `coh-embed-env`

- Repository: github.com/agentculture/coherence-cli
- Pinned commit: `a52f7b5be81c636cedcf64535a07cfa878f9be3d`
- Kind: find
- Checker: the t8 agent (first check). Read only with `git show`, `git grep` and `git ls-tree` at the pinned commit, never the working tree of a sibling checkout.

## Prompt

Which environment variables configure the Meaning Gradient's embedding client, and what base URL does it use when none is set?

## What was run and what it printed

Each command ran in the coherence-cli checkout with `COMMIT=a52f7b5be81c636cedcf64535a07cfa878f9be3d`.

```text
$ git show $COMMIT:coherence/meaning/embed.py | grep -n -o -E 'os.environ.get\("COHERENCE_EMBED_[A-Z]+"|DEFAULT_EMBED_URL = "[^"]*"'
39:DEFAULT_EMBED_URL = "http://localhost:8002/v1"
50:os.environ.get("COHERENCE_EMBED_URL"
55:os.environ.get("COHERENCE_EMBED_MODEL"
65:os.environ.get("COHERENCE_EMBED_TIMEOUT"
```

## Finding

```text
embed.py reads COHERENCE_EMBED_URL (default http://localhost:8002/v1), COHERENCE_EMBED_MODEL and COHERENCE_EMBED_TIMEOUT at call time and posts to {url}/embeddings. Recorded answer right. The task does not ask for the default model id, so no checkpoint id is in the answer key.
```

## Recorded answer

```text
COHERENCE_EMBED_URL (base URL, default http://localhost:8002/v1), COHERENCE_EMBED_MODEL (model id) and COHERENCE_EMBED_TIMEOUT (request timeout in seconds, default 30). The client posts to {COHERENCE_EMBED_URL}/embeddings (coherence/meaning/embed.py).
```

## Answer check against the hand judgement

6 answers in docs/accuracy/answer-cases.json (3 judged right, 3 judged wrong); the answer check agrees with the hand judgement on 6 of 6. The recorded answer grades `matches`.
