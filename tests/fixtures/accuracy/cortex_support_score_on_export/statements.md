# associate statements

Artifact B of this run: what the model said, cross-checked against the walk.

- A statement carries the walk ids it referenced; one with none is marked
  `[UNREFERENCED]`.
- A citation marked `ENCOUNTERED` means the walk records that those lines were
  returned to the model. It does **not** mean they agree with the statement.
- `NOT FULLY READ` is set by the tool that truncated, never by the model.

## Statements

- [REFERENCED w2, w5] The five option names of support_score are all, mostly, part, little, none.
- [REFERENCED w2, w4] The options that pass are all and mostly.
- [REFERENCED w2, w6] support_score.enabled is false for worker, senses, cortex and super-vl.
- [REFERENCED w7] Nothing in the checkout was changed; the task was read-only and every check_quote passed with support 'all'.
- [UNREFERENCED] support_score in associate/contract/accuracy.json has five option names — all, mostly, part, little, none — of which all and mostly pass. enabled is false for every registry model: worker, senses, cortex and super-vl. All facts were verified with check_quote (support: all). Nothing was changed.

## Citations

- associate/contract/accuracy.json:17 — ENCOUNTERED (w2)
- associate/contract/accuracy.json:24 — ENCOUNTERED (w2)
- associate/contract/accuracy.json:28 — ENCOUNTERED (w2)

## Completeness

No tool reported truncating its input during this run.
