# coh-trust-anchors: second check

## What I was given

The question "file holding trust axis anchors" about coherence-cli at its pinned commit; I did not see the first check or any expected answer.

## Commands and what they showed

git ls-files | grep -i 'anchor|trust'; coherence/meaning/axis.py lines 35-42 DIMENSIONS; grep -i trust over coherence/*.py.
(Read-only grep/cat/sed/python-json over the clone; no repository code was run.)

## Answer

No such file: the Meaning Gradient has no trust axis. Anchor files in coherence/meaning/anchors/ are `<dim>`.high.txt/.low.txt for exactly: meaning, consequence, agency, causality, affordance, future_constraint (axis.py DIMENSIONS). 'trust' appears only in README/docs prose (trust as the question the quality domain answers, docs/domains.md line 24), not as a Meaning Gradient axis. If a trust-like axis was meant, the nearest are agency/consequence, but I would say not in repository.

## Confidence and doubts

high
