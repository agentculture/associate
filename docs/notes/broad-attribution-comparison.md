# Broad runs: attribution by structure and the earlier text matching

This compares two ways of saying where a graded statement of the 36 stored broad runs
(2026-11-19) came from. Every cell is a count of statements as true / false / not
checkable. None is a score and none is accuracy.

## What was done

The stored runs are not strict exports, so there is no item id on a statement. The
structure they do have is the rendered `answer.md`: accepted facts, conclusions and
open items under the harness's label, then the model's finish summary and final
message under the unchecked label. `scripts/broad_attribution_comparison.py` rebuilds
each run's statements from that structure, with the same splitting the grading sheet
used, and attributes a graded statement to its item (or to the summary or the final
message) only when the rebuilt statements are the graded statements, text for text
and in order. 36 of 36 runs were attributed that way.

## Totals by structural source

Grading by claude (true / false / not checkable):

| Structural source | Statements |
|---|---|
| an accepted fact | 205 / 6 / 3 |
| an accepted conclusion | 28 / 2 / 4 |
| an accepted open item | 1 / 0 / 23 |
| the finish summary | 401 / 26 / 99 |
| the final message | 640 / 34 / 173 |
| a sentence of the summary and of the final message run together | 8 / 3 / 1 |
| no structural source | 0 / 0 / 0 |

Grading by gemini (true / false / not checkable):

| Structural source | Statements |
|---|---|
| an accepted fact | 197 / 13 / 4 |
| an accepted conclusion | 28 / 2 / 4 |
| an accepted open item | 1 / 1 / 22 |
| the finish summary | 377 / 53 / 96 |
| the final message | 601 / 78 / 168 |
| a sentence of the summary and of the final message run together | 8 / 3 / 1 |
| no structural source | 0 / 0 / 0 |

## Beside the earlier attribution

The earlier attribution is not stored per statement. Its totals are written in the
table "Where the false statements are" of the support-score broad measurement
note: statements resting on a fact whose quote was found, on a fact whose quote was
refused, and on the model's unchecked text. They are copied into the script and
put next to the structural totals. This was not rebuilt from the old text matching.

| Grading | Row | Structure | Earlier (written) | Difference |
|---|---|---|---|---|
| claude | answer items vs found + refused facts | 234 / 8 / 30 | 261 / 6 / 7 | -27 / 2 / 23 |
| claude | summary and final message vs unchecked text | 1049 / 63 / 273 | 1022 / 65 / 296 | 27 / -2 / -23 |
| gemini | answer items vs found + refused facts | 226 / 16 / 30 | 247 / 17 / 10 | -21 / -1 / 20 |
| gemini | summary and final message vs unchecked text | 986 / 134 / 265 | 965 / 133 / 285 | 21 / 1 / -20 |

By claude's grading, structure puts 272 statements in the answer's items and the earlier totals put 274 on facts; 24 of the structural ones are open items, 23 of them graded not checkable.
By gemini's grading, structure puts 272 statements in the answer's items and the earlier totals put 274 on facts; 24 of the structural ones are open items, 22 of them graded not checkable.

## What could not be compared

- The earlier table's rows are defined by how a statement was matched to a fact, and
  that matching was not stored, so a difference in the verdict mix between the two
  tables cannot be traced to a cause here. The structural totals cover 1657 statements and the written totals add up to 1657.
- No statement can be listed as attributed differently, because the earlier
  attribution of a single statement was not kept. Only the totals above exist.
- By structure no statement rests on a fact whose quote was refused: the harness does
  not render a refused fact, so such a statement can only be in the model's own text.
  The earlier "refused" row therefore has no structural counterpart and is compared
  with the other two rows combined, as the table above does.
- A statement of the model's own text that repeats an accepted fact is, by structure,
  unchecked text. The comparison says nothing about whether it repeats one.
- The summary and the final message are separate sources by structure; the earlier
  table has one unchecked row, so they are compared together.
