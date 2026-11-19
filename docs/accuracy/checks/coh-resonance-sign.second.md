# coh-resonance-sign: second check

## What I was given

The question "resonance statistic and interference sign" about coherence-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

coherence/signal/resonance.py lines 1-20, 66-106.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

Pearson correlation (np.corrcoef) over the points where both fields are present (>=3 common points; constant fields excluded). Negative alignment is labelled 'interference' (specifically alignment < -0.1, NEUTRAL_BAND=0.1); > +0.1 is 'resonance'; |value| <= 0.1 is 'neutral'.

## Confidence and doubts

high
