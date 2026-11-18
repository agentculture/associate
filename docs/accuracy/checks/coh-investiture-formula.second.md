# coh-investiture-formula: second check

## What I was given

The question "investiture_score formula" about coherence-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

coherence/investiture/score.py lines 23-41, 98-158.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

Multiplied: investiture_score = meaning_score *agency* future_constraint * affordance (product of the four, start 1.0, loop multiply). The values are meaning's own [0,1] outputs: meaning_score (as meaning_density), subdimensions['agency'] (agency_coupling), future_constraint, affordance. Left out: consequence and causality (the other two of the five subdimensions; the module says a richer formula may fold them in later). mode is always 'estimated'; persistence_signal, integration_signal, behavioral_effect are None.

## Confidence and doubts

high
