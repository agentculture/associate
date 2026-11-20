# Answer (rendered by the harness from checked items)

## Conclusions

- v1 [supported] support_score has exactly five option names — all, mostly, part, little, none — listed in the options object at associate/contract/accuracy.json:18-22. (rests on f1)
  - alternative a1: The five names are the answer keys rather than the option names, and passes is the display order.
    - predicts: options would be keyed 1-5 or similar, with passes holding the descriptive names.
    - refuted by: f1: options is an object whose keys are the names all/mostly/part/little/none and passes is a separate array [all, mostly].
- v2 [supported] Only all and mostly pass; the other three (part, little, none) are reported in their own words, per the passes array at accuracy.json:24. (rests on f2)
- v3 [supported] support_score.enabled is false for every registry model (worker, senses, cortex, super-vl) at accuracy.json:28-33. (rests on f3)
  - alternative a2: Some registry model has support_score.enabled true in this checkout.
    - predicts: at least one enabled entry would be true in accuracy.json.
    - refuted by: f3: all four registry models show false; the $comment also says false for every model until the operator switches it on.

## Facts

A fact marked "quote found" means its quote is in the saved result it cites; it does not mean the value is true.

The support mark is a second, separate check: how much of the value the quote, read on its own, shows, or "support not scored" when that check did not run. Neither mark means the value is true.

- f1: The five option names of support_score are: all, mostly, part, little, none — ""all": "the quote states or directly shows every claim the value makes", "mostly": "the quote shows the main claim of the value; only a minor detail of the value is not in the quote", "part": "the quote shows some of the value, and the value also makes a real claim the quote does not show", "little": "the quote is on the same subject but shows little of what the value claims", "none": "the quote is about something else, or a number or name in the value differs from the quote"" (w2, file; quote found in the saved result; quote supports the value)
- f2: The passing option names are all and mostly — ""passes": ["all", "mostly"]," (w2, file; quote found in the saved result; quote supports the value)
- f3: support_score.enabled per model: worker false, senses false, cortex false, super-vl false — ""enabled": { "worker": false, "senses": false, "cortex": false, "super-vl": false }" (w2, file; quote found in the saved result; quote supports the value)

## Unchecked: the model's own words, not checked by the harness

Finish summary (4 sentences):

> support_score in associate/contract/accuracy.json has five option names — all, mostly, part, little, none — of which all and mostly pass. enabled is false for every registry model: worker, senses, cortex and super-vl. All facts were verified with check_quote (support: all). Nothing was changed.

Final message (4 sentences):

> support_score in associate/contract/accuracy.json has five option names — all, mostly, part, little, none — of which all and mostly pass. enabled is false for every registry model: worker, senses, cortex and super-vl. All facts were verified with check_quote (support: all). Nothing was changed.
