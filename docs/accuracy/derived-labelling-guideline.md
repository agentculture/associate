# Labelling guideline: does the conclusion follow from the listed facts?

Each item has a `conclusion` and a list of `listed` facts (an id and a value each). Label whether the conclusion follows from the listed facts, taken together and read on their own.

Use only what the listed facts say. Do not use what you know about the software they describe, and do not look anything up. If the conclusion is true in the world but the listed facts do not show it, it does not follow.

Labels:

- `yes`: the conclusion follows from the listed facts. Nothing in it goes beyond them. Rewording, summarising and putting two listed facts together are fine.
- `partly`: the listed facts support part of the conclusion, and the conclusion also claims something they do not show. A specific name, number, file, cause or scope ("all", "only", "never") that no listed fact gives counts as a claim.
- `no`: the conclusion does not follow from the listed facts, is about something else, or contradicts them (a different number, the opposite statement).

Rules for common cases:

- A location in the conclusion (a file name or line number) that only says where something is, when a listed fact is plainly about that same thing, is not an extra claim.
- A conclusion that restates one listed fact and nothing more is `yes`.
- An answer word at the start ("Yes", "Question 3: YES") is part of the conclusion: judge it with the rest.
- If you cannot tell what the conclusion claims, label by what its words most plainly say and set `borderline` to true.

Set `borderline` to true when you could defend the neighbouring label. Give a `why` of at most 20 words.
