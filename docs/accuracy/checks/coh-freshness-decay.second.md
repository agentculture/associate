# coh-freshness-decay: second check

## What I was given

The question "freshness decay and no-date code" about coherence-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

coherence/quality/heuristics.py lines 51-56, 307-344.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

Exponential half-life decay: score = 0.5 ** (age_days / 365.0) (_HALF_LIFE_DAYS = 365), 1.0 for age <= 0; so 0.5 at one year, 0.25 at two. Applies only when a parseable calendar date (ISO YYYY-MM-DD or 'Month YYYY' -> first of month) and a reference_date exist (confidence 0.9, code publication_date_unverified). A marker without derivable age (version or relative phrase, or no reference date) -> 0.5 baseline, code age_not_derivable. A text with no date marker at all: score 0.0, confidence 0.2, diagnostic code `no_dateable_statements`.

## Confidence and doubts

high
