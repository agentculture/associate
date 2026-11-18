# coh-url-check-timeout: second check

## What I was given

The question "URL resolve timeout in quality domain" about coherence-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

grep for timeout/httpx/urllib/requests/http in coherence/quality/*.py and coherence/cli/_commands/quality.py; read heuristics.py docstring lines 3-8, 83-86.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

None: the quality domain never checks that a cited URL resolves. heuristics.py is 'no numpy/httpx, and no network', never performs I/O; a present URL only yields the diagnostic `source_liveness_unverified` ('cannot check that it resolves'). No timeout exists in coherence/quality. The only timeout in the repo I found is COHERENCE_EMBED_TIMEOUT (default 30 s) in coherence/meaning/embed.py, which is the embeddings request, not a URL check. Premise false.

## Confidence and doubts

high
