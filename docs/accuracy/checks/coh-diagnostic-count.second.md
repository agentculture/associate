# coh-diagnostic-count: second check

## What I was given

The question "DIAGNOSTIC_MESSAGES count" about coherence-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

coherence/quality/heuristics.py lines 68-99.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

7 codes in DIAGNOSTIC_MESSAGES: no_dateable_statements, age_not_derivable, publication_date_unverified, source_liveness_unverified, no_source_attribution, quote_accuracy_unverified, no_verbatim_signal. (Other modules, e.g. meaning/signal, have their own diagnostic codes; this answer is the quality heuristics catalog.)

## Confidence and doubts

high
