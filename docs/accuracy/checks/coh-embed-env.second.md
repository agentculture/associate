# coh-embed-env: second check

## What I was given

The question "embedding env vars and default URL" about coherence-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

coherence/meaning/embed.py lines 10-12, 39-76.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

COHERENCE_EMBED_URL (base URL), COHERENCE_EMBED_MODEL (default Qwen/Qwen3-Embedding-0.6B) and COHERENCE_EMBED_TIMEOUT (seconds, default 30; invalid/non-finite/<=0 falls back to 30). Default base URL when none set: <http://localhost:8002/v1> (requests go to `<url>`/embeddings). Read at call time.

## Confidence and doubts

high
