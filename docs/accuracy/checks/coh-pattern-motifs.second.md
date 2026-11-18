# coh-pattern-motifs: second check

## What I was given

The question "signal pattern motifs and module" about coherence-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

coherence/signal/pattern.py lines 89-94, 311-322; cli/_commands/signal.py line 258.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

Six motifs: increasing, decreasing, plateau, spike, reversal, stair_step (MOTIFS tuple in that order). Defined in coherence/signal/pattern.py (constants MOTIF_*; detectors registered in _MOTIF_DETECTORS); the CLI wiring is coherence/cli/_commands/signal.py. Independent per-field checks, not exclusive; needs >=3 points.

## Confidence and doubts

high
