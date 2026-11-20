# The shared strict cases (`strict_vectors.json`)

`associate/contract/strict_vectors.json` holds named cases for the strict
hand-back check. The extension computes the expected result of every case by
running its own code. A second implementation (the strict re-check in
evidence-cli, 0.8.0 on) must give the same result on every case. The file is
held byte for byte the same in both repositories, like `matcher_vectors.json`.

This note is enough to write such a re-check without reading the TypeScript.
Where it names a TypeScript function, that is only where to look for more.

A passed fact means its evidence was copied or found where the fact says, and,
for a judged fact, what the decider answered. It never means the value is
true. No count here is accuracy.

## How the file is made

- `scripts/strict_vectors.ts` holds the inputs of every case.
- It runs `runStrict` (`.pi/extensions/associate/lib/strict.ts`) on each case.
  The decider is a fake that returns the answer the case stores.
- `node --experimental-strip-types scripts/strict_vectors.ts --write` rewrites
  the file. Without `--write` it says whether the file is current.
- The extension test `tests/strict-vectors.test.ts` rebuilds the file in memory
  and fails when it differs from the committed bytes.
- The file records what the extension does. When the rule changes, regenerate,
  review the changed expectations by hand, and copy the file to evidence-cli.
- The Python tests in this repository check that the file is well formed
  (`tests/test_strict_vectors.py`), that it equals the copy inside the
  installed evidence-cli byte for byte, and that evidence-cli's `strict_recheck`
  gives every case's expected result (`tests/test_strict_recheck.py`).
- The file has 64 cases. evidence-cli 0.8.0 holds the first 45. Until it takes
  the other 19, the two tests that compare the files are marked as expected
  failures; its `strict_recheck` is still run on all 64.

## Paths in the cases

Every case uses the checkout root `/srv/work/proj`, which is not a home
directory, and run worktrees in the matching `/srv/work/.worktrees.proj/<run>`
layout. One string in `command_relative_and_redacted` is a placeholder home
path (a made-up user under the Linux home root) on purpose: it shows that a home path outside the
checkout is printed as `~`. That string is the documented exception to the rule
against home-directory paths in tracked files, and `tests/test_strict_vectors.py`
checks that it is the only one.

## Top level

| Key | What it is |
|---|---|
| `$comment` | What the file is. Not data. |
| `version` | `1`. A change of shape bumps it. |
| `redaction` | `{replacement, patterns}`: the contract's redaction filter (`policy.json` `redaction`). Used on the command. |
| `cases` | The list of cases. |

`redaction.patterns` are regular expressions. A pattern that starts with
`(?i)` is case-insensitive: drop those four characters and set the flag. Every
pattern replaces all matches (a global replace) with `replacement`. Apply the
patterns in order, each to the output of the one before.

## One case

| Key | What it is |
|---|---|
| `name` | Unique in the file. |
| `note` | One sentence: what the case shows. |
| `input` | Everything the re-check reads. Nothing outside the case is read. |
| `expect` | What the extension produced. |

### `input`

| Key | What it is |
|---|---|
| `checkout_root` | The absolute path of the checkout the run examined. Used to print paths in the command. |
| `walk` | The current run's walk entries (see below). |
| `results` | The saved result texts, by file name (`results/wN.txt`). |
| `prior_runs` | Prior runs by label: `{label: {walk, results}}`. A source `label:wN` looks here. |
| `children` | Child runs: a list of `{label, walk, results}`. A source `label:wN` looks here too. |
| `finish` | The `finish` payload: `facts`, `verdicts`, `open_items`, as the model gave them. |
| `contract` | The settings that matter (see below). |
| `decider` | The decider's stored answer per judged fact id (see below). |
| `returned_before` | Fact ids returned to the model in an earlier round of the same prompt, sorted. For an export it is `strict.returned_before` of `check.json` (see The rounds record). |
| `rounds_left` | How many rounds may still send facts back. `0` means none. |

A walk entry has `id` (`wN`), `tool`, `args` (the arguments as asked, with
`purpose`), and may have `args_used` (the arguments as the tool used them),
`saved_result` (the file name of its saved result), `partial: true` (the saved
result was cut at the size cap), `error`, and `source_kind`. Other fields are
not read. Which text is the entry's saved result depends on the kind of fact
(see Which saved result is read).

`contract` holds:

| Key | What it is |
|---|---|
| `strict.keep_marked` | Support answers that return a fact once, then keep it with the mark. |
| `strict.drop` | Support answers that drop a fact. |
| `strict.mark_text` | The mark written beside a kept fact. |
| `strict.derived_decides_drops` | Whether a derived answer can drop a fact. Only the value `true` switches it on. `false` in every case but `derived_decides_drops_true` and `derived_passes_absent_fails_closed`. |
| `strict.derived_passes` | Derived answers that pass a fact when `derived_decides_drops` is true (`yes`, `mostly`). The key may be absent: then no answer passes. |
| `support_passes` | Support answers that pass a fact. |
| `min_quote_length` | The matcher's shortest quote, for old-shape facts. Any JSON value may stand here; one that is not a positive integer is a broken contract (step 0). |
| `retry_rounds` | Rounds a hand-back may be sent back. |
| `source_kinds` | The source kind of each tool in the case (`file`, `tool`, `web`, `memory`, `agent`, `harness`). |

`decider` maps a fact id to `{question, option}` (the decider answered:
`question` is `support` or `derived`) or to `{not_judged: reason}` (no answer,
for example `unreachable`). The re-check never calls the decider. It uses the
stored answer for each fact it would send. Every stored answer is used, and
every fact that is sent has one. A fact that cannot be sent (`no_evidence`,
`no_inputs`, step 9) has no stored answer: the re-check works out that reason
itself.

### `expect`

| Key | What it is |
|---|---|
| `facts` | One record per fact, in the model's order (see below). |
| `graph.order` | Fact ids in check order. |
| `graph.refusals` | `{reason, fact, ids}` per graph refusal: `based_on_unknown` (the fact, the unknown ids) or `based_on_cycle` (`fact` null, the ids of the cycle in the model's order). |
| `verdicts`, `open_items` | One record per item: `{id, outcome, reason, strict_outcome, strict_reason}`. |
| `counts` | Facts per outcome: `pass`, `keep_marked`, `returned`, `dropped`, `not_judged`. |
| `drop_reasons` | Dropped items per reason, facts and items together. |
| `judge_counts` | `direct_passed`, `llm_judged`, `derived_judged`, `not_judged` (see Counts). |
| `report` | The `strict` object of `report.json` (see Counts). |

A fact record:

| Key | What it is |
|---|---|
| `id` | The fact id. |
| `kind_stated` | The kind the fact gave: `direct`, `llm` or `derived`. Absent, or any other string, reads as `direct`. |
| `kind_checked` | How it was checked: `direct` (copied or found, value word for word or none), `llm` (judged with the support question), `derived` (judged with the derived question). A fact that failed before it was classified keeps its stated kind. A fact dropped by a shape rule has null. |
| `worded` | `true` when the value is in the model's own words, `false` when it is word for word in the evidence or no value was given, `null` when the fact failed before it was classified or was dropped by a shape rule. |
| `status` | `passed`, `failed`, `unchecked`, `dropped`, `judged` or `not_judged` (see Outcomes). |
| `strict_outcome` | `pass`, `keep_marked`, `returned`, `dropped` or `not_judged`. |
| `drop_reason` | Why it is out of the answer, else null. |
| `dropped_by` | For a cascade drop, the root failed fact's id, else null. |
| `evidence` | What the harness copied for a resolved pointer: `{quote, command, command_from, result_file, lines, run}`. Null for an old-shape fact, for a pointer that did not resolve, and for a fact dropped by a shape rule. |
| `judge` | `{question, option, reason}` when the fact was sent to the decider, else null. |
| `sent` | `{question, value, evidence}`: what the decider would be asked, before the support client redacts and encodes it. Null when not sent. |

`evidence.lines` is the first and last line copied, in the pointer's own count.
`evidence.run` is the run label of the source, or null for the current run.
`evidence.command_from` is `args_used`, or `args` when the entry has no
`args_used`.

## The checks, in order

Each fact is checked on its own first. Then the shape rules, the graph, the
decider and the cascade follow. The first failure of a fact is its reason,
except where a later step says it replaces it.

### 0. A broken `min_quote_length`

`min_quote_length` is usable when it is a JSON number that is a whole number
of 1 or more. Anything else (absent, null, `0`, a negative number, a fraction,
a string, `true` or `false`, a list, an object) is a broken contract. In
Python, test the type: `True` is an `int` there and must not count as 1.

With a broken setting every fact fails as `quote_short` before its source is
looked up: a pointer fact too, and a fact with an unknown source too. Its
checker verdict is `refused`, `kind_checked` is its stated kind, `worded` is
null, nothing is copied and nothing is sent. The shape rules (step 6) still
run and replace the reason; a graph failure does not (the fact has already
failed). A verdict resting on such a fact is `basis_refused`
(`min_quote_length_zero`, `min_quote_length_true`).

### 1. The source

The source is an optional run label and a walk id: `^([A-Za-z0-9_-]+:)?w[1-9][0-9]*$`.

- A source holding `/` or `\` fails as `source_path`.
- Any other source that does not match fails as `source_malformed`.
- A label that names neither a prior run nor a child fails as `source_unknown`.
  A label that names both is not usable either and fails the same way.
- A walk id with no entry in that run fails as `source_unknown`.
- An action fact is a fact with `action` exactly `true` (any other value, such
  as the string `yes`, is not one). Strict changes nothing in its rule. After
  its source is found and before any pointer or quote is looked at, three
  things are checked, in this order. `tool` must be a string that is not empty
  (`action_tool_missing`). The cited entry's `tool` must equal it
  (`action_wrong_tool`). The entry must have no `error` key, and its saved
  result must not be a JSON object with `ok` equal to `false`
  (`action_failed`). The saved result read here is the one an old-shape fact
  reads (see Which saved result is read); a result that is absent or is not
  JSON does not fail the fact.
- An action fact that passes these goes on like any other fact: its pointer or
  quote, the number rule, direct or worded, the decider (`action_facts`).

These failures make the fact's checker verdict `refused`.

### Which saved result is read

The two shapes of fact read the saved result in two ways. This is how the
extension is built, and a second implementation must do the same.

- A pointer (`at`) reads the file the walk entry names in `saved_result`. The
  name must be a string of the form `results/wN.txt`
  (`^results/w[1-9][0-9]*\.txt$`) and `results` must hold a text under that
  name. The entry's own id is not compared with the name: an entry whose
  `saved_result` names another entry's file reads that file, and
  `evidence.result_file` is the name as the entry gives it. An entry without
  `saved_result`, a name of another form, or a name `results` does not hold,
  fails the fact as `no_saved_result`.
- An old-shape fact (a `quote`, no `at`), the action check and the
  `delegate_status` rule read `results/<the entry's own id>.txt`, whether or
  not the entry has `saved_result`. When `results` holds no such text the
  old-shape fact is `unchecked` (`no_saved_text`), also when its quote is too
  short.

In an export written by the extension an entry names its own file, so the two
agree. `saved_result_file_read` shows each way they can differ.

### 2. A pointer (`at`)

When `at` is an object, the pointer is resolved in the run the source names.

1. No saved result for the entry (see Which saved result is read):
   `no_saved_result`. This is checked before the shape of `at`.
2. `at` must have exactly one of `lines` and `search`. `lines` is two whole
   numbers with `1 <= first <= last`. `search` is a string that is not blank.
   Otherwise: `pointer_malformed`.
3. The saved text is split into lines on `\n`. A trailing `\n` does not make an
   empty last line. An empty text has no lines. `\r` stays in the line.
4. Lines are counted from 1 at the first line of the saved text. The
   `walk id: wN` line the model saw is not in the saved text and is not
   counted.
5. A read result is counted by the line numbers it shows. This applies when
   the tool is `read`, `read_file`, `read_page` or `readpage` and the first
   line of the saved text starts with a stamp: one or more ASCII digits and a
   tab (`^[0-9]+\t`). Only the first line decides. A read result whose first
   line has no stamp, and the result of any other tool, is counted by position
   even when its lines look stamped. In a stamped result:
   - `lines: [a, b]` takes the first line whose stamp digits, as text, equal
     `a` written as a decimal number, and the first line whose stamp equals
     `b` (so a stamp `007` is not line 7). Both must be found. The quote is
     every line from the one to the other by position, lines without a stamp
     between them included. `evidence.lines` is `[a, b]`.
   - A search looks at every line, stamped or not. `evidence.lines` is the
     found line's stamp as a number, twice, or its position counted from 1
     when that line has no stamp.
   (`read_shown_line_numbers`, `read_stamps_mixed_lines`.)
6. `search` takes the first line that contains the term (exact, case-sensitive
   substring). That one line is the evidence.
7. Missing lines:
   - Not found by search: `search_not_found`, or `result_cut` when the entry is
     `partial`.
   - Lines past the end: `pointer_out_of_range`, or `result_cut` when the entry
     is `partial`. For a stamped read result, a stamp that is not shown is out
     of range; on a `partial` entry it is `result_cut` when the last line has
     no stamp or the asked last line is above the last shown stamp, and
     `pointer_out_of_range` otherwise (`read_stamps_cut_result`).
8. On a `partial` entry, evidence that includes the last kept line is
   `result_cut` too: that line may itself have been cut.
9. The quote is the lines from first to last, byte for byte, joined with `\n`.
   Read stamps are kept.
10. The number rule (below) on the value and the quote: `number_absent`. It is
    applied only to a value that is a string and not blank.

A failure here makes the checker verdict `refused`. Its `drop_reason` is the
reason named above.

### 3. An old-shape fact (a `quote`, no `at`)

1. The quote is matched against the entry's saved text with the quote matcher
   and `min_quote_length`. The matcher is the one in `matcher_vectors.json`
   (see its `normalisation`). No literal is passed under strict.
2. No saved text: the fact is `unchecked` (`no_saved_text`).
3. A `partial` entry: `unchecked` (`partial_result`), unless the quote is too
   short (`quote_short`), which fails it.
4. A refusal (`quote_short`, `quote_absent`) fails the fact for any stated
   kind.
5. Then the number rule on the value and the quote as the model gave it:
   `number_absent`.

### 4. The number rule

A number token is a run of ASCII digits. It is written either with thousands
separators (one to three digits, then groups of a comma and exactly three
digits) or without. It may have one `.digits` decimal part. The regular
expression, tried left to right, first alternative first:

```text
\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?
```

`\d` means `[0-9]` only (in Python, use `re.ASCII`). Commas are removed before
tokens are compared as strings. Every token of the value must be a token of
the evidence. Signs, units and letters around a number do not matter (`w12`
holds `12`). `0.50` and `0.5` differ. A value with no number passes.

The rule reads only a value that is a string. A value that is a number, a
boolean, null, a list or an object is treated as no value in every step: the
number rule is not applied to it (a value `99` beside evidence without 99
passes), `worded` is false, and where a value is sent to the decider an empty
string is sent. The shape rule `value_missing` looks only at whether the key
is present, so it does not fail such a fact (`value_not_a_string`).

### 5. Direct or worded

When the evidence is had (a resolved pointer's quote, or an old-shape quote
that was found), the value is classified.

- The value is given when it is a string that is not blank after trimming.
  Trimming removes the ECMAScript whitespace and line terminators at both ends
  (`String.prototype.trim`). Python's `str.strip()` also removes `\x1c` to
  `\x1f` and `\x85`, which JavaScript keeps; strip the exact set.
- `worded` is false when no value is given. It is also false when the trimmed
  value is an exact substring of the evidence: case-sensitive, with no other
  normalisation. A value differing only in case, or in whitespace inside it, is
  worded.
- A fact stating `derived`: `kind_checked: derived`, to be judged with the
  derived question, whatever `worded` is.
- Otherwise, `worded: false`: `kind_checked: direct`, `status: passed`, never
  sent to the decider.
- Otherwise, `worded: true`: `kind_checked: llm`, to be judged with the support
  question, whatever kind it stated.

A fact that failed or was unchecked before this step has `worded: null`.

### 6. The shape rules

They run after the checks above. The first rule a fact breaks fails it, and its
reason replaces any earlier reason or status.

1. `kind` present and not `direct`, `llm` or `derived`: `kind_unknown`.
2. `at` present and not an object with exactly one key, `lines` (two integers,
   `1 <= first <= last`) or `search` (not blank): `pointer_malformed`.
3. Neither `at` nor `quote`: `pointer_missing`.
4. A direct fact with neither `value` nor `at`, or an llm or derived fact with
   no `value`: `value_missing`.
5. A derived fact without a non-empty `based_on` list: `based_on_missing`.

A fact dropped by a shape rule carries no classification: `kind_checked` and
`worded` are null and no `evidence` is recorded, whatever the earlier steps
found. `kind_stated` stays. A shape failure does not change the checker
verdict.

### 7. The graph

`based_on` names fact ids of the same hand-back. An id resolves to the first
fact with that id.

- An id naming no fact fails the fact as `based_on_unknown`.
- A cycle fails every fact in it as `based_on_cycle`. A cycle is a strongly
  connected group of two or more facts, or a fact naming itself.
- A graph failure does not replace an earlier failure of the same fact, and a
  shape failure replaces it.
- A graph failure does replace an unchecked result. A fact that was `unchecked`
  (`no_saved_text`, `partial_result`) and names an unknown id or sits in a
  cycle gets `status: failed` and the graph reason as `drop_reason`. Its
  checker verdict stays `unchecked`, so a verdict resting on it is
  `basis_dropped`, not `basis_refused` (`graph_failure_replaces_unchecked`).
  The same holds for a fact that had passed or was waiting for the decider.
- `graph.order` is a topological order of the groups. Each time, take the ready
  group whose first fact comes earliest in the model's order. A cycle's facts
  sit together in the model's order.

### 8. The cascade

Facts are visited in `graph.order`. A fact that is not itself failed is dropped
when one of its `based_on` facts failed or was dropped. Look at its `based_on`
facts in its own order and take the first that failed or was dropped. Its root
is that fact when it failed, or that fact's `dropped_by` when it was dropped.
The dropped fact gets `status: dropped`, `drop_reason: based_on_failed` and
`dropped_by` the root. The root is never an intermediate fact.

The cascade runs after the checks and the graph, again after the shape rules,
and twice with the decider (step 9: after the first answers, and at the end).

An unchecked fact (`no_saved_text`, `partial_result`) is not a failed fact in
the first two cascades and is one in the two cascades of step 9. So a fact
resting on an unchecked fact is dropped there, and `dropped_by` is the
unchecked fact's own id; through a chain it is still that id. The unchecked
fact itself keeps `status: unchecked`. Two things follow from the order. A
derived fact resting on an unchecked fact is never sent. A fact that is not
derived, is worded and rests on an unchecked fact is sent in the first step
and then dropped, and its `judge` keeps the answer
(`cascade_from_unchecked_fact`).

### 9. The decider

The decider is asked in two steps, in dependency order.

1. Every fact whose status is still `to_judge` after the shape rules and the
   cascade, and that does not state `derived`, is sent, in the model's order.
2. The outcome policy (step 10) is applied to those answers, and the cascade
   runs. A derived fact still waiting counts as standing in this cascade.
3. Every derived fact still `to_judge` that this cascade did not drop is sent,
   in the model's order.

A derived fact dropped in step 2 is never sent: its `judge` and `sent` are
null. Facts sent in the same step do not wait for each other. A non-derived
fact resting on another non-derived fact is sent with it; if the cascade then
drops it, its `judge` still shows its answer.

- The support question: `value` is the fact's value as given (not trimmed), or
  empty. For a fact with a resolved pointer, `evidence` is a first line made of
  `command:`, one space and the command, then a newline, then the copied
  quote (`command: ls tests` and `604` in the 604 cases). For an
  old-shape fact it is the quote alone. Sending the command is new and has not
  been measured on a labelled set.
- The derived question has five answers, like the support question: `yes`,
  `mostly`, `partly`, `little`, `no` (the criteria are in `accuracy.json`
  `strict.derived_question`). `derived_each_answer` walks through all five.
  `value` is the conclusion. `evidence` is one line per
  id in `based_on`, in that order. A listed fact with a value that is not blank
  is `id: value`. One without is `id: (no value given; its copied quote)
  quote`, using its copied quote or its own quote. One with neither is
  `id: (no value or quote available)`. When no listed fact has a value or a
  quote, nothing is sent.

Two facts cannot be sent at all. They get `status: not_judged`, outcome
`not_judged`, `judge: {question, option: null, reason}` and `sent: null`, and
the case stores no answer for them. This is decided before the stored answer
is looked at, so it holds during an outage too.

- `no_evidence`: a fact for the support question whose evidence (the copied
  quote, or the old-shape quote) is empty or only whitespace. The command line
  is not put in front of blank evidence. A worded fact pointing at a blank
  line is the way to get here.
- `no_inputs`: a derived fact for which no id in `based_on` gives a line with
  a value or a quote. A listed fact counts as having a value when its value is
  a string that is not blank, and as having a quote when its copied quote (or
  its own `quote`) is not blank.

Blank is tested with the same trimming as in step 5
(`not_sendable_no_evidence_no_inputs`).

### 10. Outcomes

After the last cascade, each fact gets one outcome.

| Case | `status` | `strict_outcome` | `drop_reason` |
|---|---|---|---|
| Dropped by the cascade | `dropped` | `dropped` | `based_on_failed` |
| Failed (source, pointer, number, matcher, shape, graph) | `failed` | `dropped` | its reason |
| Unchecked (no saved text, partial result) | `unchecked` | `dropped` | `no_saved_text` or `partial_result` |
| Passed as direct | `passed` | `pass` | null |
| Answered with a `drop` option | `judged` | `dropped` | `decider_drop` |
| Answered with a `keep_marked` option, not returned before, a round left | `judged` | `returned` | null |
| Answered with a `keep_marked` option, returned before or no round left | `judged` | `keep_marked` | null |
| Answered with a `support_passes` option | `judged` | `pass` | null |
| Support answer in none of the three lists | `judged` | `pass` | null |
| Derived answer, `derived_decides_drops` false | `judged` | `pass` | null |
| Derived answer, `derived_decides_drops` true, named in `derived_passes` | `judged` | `pass` | null |
| Derived answer, `derived_decides_drops` true, not named there or `derived_passes` absent | `judged` | `dropped` | `decider_drop` |
| No answer | `not_judged` | `not_judged` | null |

A round is left when `rounds_left > 0`. Lists are checked in this order:
`keep_marked`, then `drop`, then `support_passes`.

`returned_before` is read only for a support answer named in `keep_marked`. A
fact named there and answered with a pass or drop option passes or is dropped
like any other, and an id there that no fact has is ignored
(`returned_before_only_changes_part_and_little`).

`derived_decides_drops` is on only when it is exactly `true`. Then a derived
answer named in `derived_passes` passes the fact and every other answer drops
it; a derived fact is never returned and never kept with the mark. When
`derived_passes` is absent no answer passes, so every answered derived fact is
dropped: the setting fails closed. A fact dropped this way is a failed fact
for the last cascade. A derived fact resting on it was sent in the same step,
so it is dropped with `based_on_failed` and its `judge` keeps its answer
(`derived_decides_drops_true`, `derived_passes_absent_fails_closed`).

### 11. Verdicts and open items

The checker rules come first. For a verdict, the first that applies:

1. A `basis` id naming no fact: `unknown_fact`.
2. A basis fact whose checker verdict is `refused`: `basis_refused`. The
   checker verdict is `refused` for the failures of steps 1 to 3 (source,
   pointer, number, matcher). Shape, graph, decider and cascade failures do not
   change it.
3. `supported` or `refuted` with an empty basis: `no_basis`.
4. `supported` or `refuted` with `unread` items: `verdict_with_unread`.
5. `open` or `cannot_tell` without a `check`: `open_without_check`.
6. The closing verdict (the one with `closing: true`, else the last) that is
   `supported` or `refuted` with no first-hand basis fact:
   `closing_second_hand`. A fact is first-hand when its source kind is not
   `agent` or `memory`. A fact whose source did not resolve has no kind and is
   not first-hand. Strict changes nothing in this rule: the verdict is refused
   by the checker and so dropped (`closing_verdict_second_hand`).

   A fact citing a `delegate_status` entry that has a source kind has its own
   rule, whatever that kind is. Take the entry's saved text (see Which saved result
   is read). No text, or text that is not JSON: second-hand. Otherwise find,
   anywhere in the parsed value, every key `unchecked_final_reply`,
   `final_reply` or `answer` whose value is a string. For each, build the text
   `"key":"value"` as compact JSON writes it (no space after the colon,
   non-ASCII characters kept as they are). If the saved text does not hold
   that text exactly, the fact is second-hand. Otherwise replace every
   occurrence with `"key":""`. The fact is first-hand when the quote matcher
   still finds its quote in the text that is left: the copied quote with a
   minimum length of 1 for a pointer, the model's quote with
   `min_quote_length` for an old-shape fact. A pointer copies whole lines, so
   on a one-line result that holds the child's reply it is second-hand
   (`delegate_status_quote_in_harness_fields`,
   `delegate_status_pointer_reaches_child_words`).

An open item is refused only without a `check` (`open_without_check`).

Then, per item:

- Refused by the checker: `strict_outcome: dropped`, `strict_reason` the
  checker's reason.
- A basis fact whose outcome is `dropped` or `returned`: `dropped`,
  `basis_dropped`.
- Else a basis fact whose outcome is `not_judged`: `not_judged`.
- Else `pass`.

## The command

One line built from the walk entry. Text the model wrote about the command is
never read.

1. Take `args_used` when it is an object (not a list, not null), else `args`
   when that is an object, else no arguments. `command_from` is `args_used` in
   the first case and `args` in the other two. Drop the `purpose` key at the
   top level only; a `purpose` key deeper inside stays.
2. Rewrite every string value in the arguments, at any depth (in lists and in
   objects), with the three steps below, in this order. An object key gets
   step 3 only: a path in a key is not made relative. Numbers, booleans and
   null are not touched.
   1. Paths under the checkout become relative. Trim trailing slashes from
      `checkout_root`. A root that does not start with `/`, or is `/` alone,
      makes no path relative. When it is a run worktree
      (`<parent>/.worktrees.<name>/<run>`), the base is `<parent>/<name>`.
      Otherwise the base is the root itself. The worktrees directory is
      `<parent of base>/.worktrees.<name of base>`. A match is the worktrees
      directory followed by `/` and one path segment (one or more characters
      that are not `/`, whitespace, a quote or a backtick), or else the base;
      the worktree form is tried first. It must be followed by `/`, or by the
      end or a character that is not an ASCII letter, a digit, `_`, `.` or
      `-`. A match without its `/` becomes `.`. A match with its `/` is
      removed, or becomes `.` when the end, whitespace, a quote (`"` or `'`)
      or a backtick follows. So `<root>/lib` prints `lib`, and `<root>` and
      `<root>/` print `.`. A match may start anywhere in a string, and every
      match in it is replaced: `--include=<root>/lib` prints `--include=lib`.
      A path that only shares the root's first characters
      (`/srv/work/project`) does not match. The worktrees directory with no
      segment after it stays as it is.
   2. Other home paths become `~`. A home path is `/`, then `home` or `Users`,
      then `/` and one segment with no `/`, whitespace or quote; or `/` then
      `root`. It must be followed by `/`, whitespace, a quote, a backtick or the
      end. Like a checkout match it may start anywhere in the string, also in
      the middle of a longer path, and every match is replaced. This step runs
      on the output of the step before, so a checkout under a home directory
      is already relative. (Written in words so this note names no home path
      itself; the regular expression is `HOME_PREFIX` in `lib/evidence.ts`.)
   3. The redaction filter (see Top level), on the output of the step before.
      A whole token may become the replacement text, which is then quoted
      like any other string (`"[REDACTED]"`).

   The tool name gets steps 2 and 3, not step 1.
3. Print by tool:
   - `bash` with an `argv` list in which every item is a string: each token,
     joined by spaces. When `cwd` is a string that is not blank, put `cd`, a
     space, the cwd token and ` && ` in front: `cd . && grep -rn lib`. Other
     arguments of the call are not printed. A `bash` entry whose `argv` is
     missing, is not a list or holds anything but strings is printed like any
     other tool.
   - A read tool (`read`, `read_file`, `read_page`, `readpage`) with a string
     `path`: `<tool> <path>`. When `start_line` or `end_line` is a number, add
     a space and `lines <start>-<end>`, with `1` for a missing start and `end`
     for a missing end. Other arguments are not printed. A read entry whose
     `path` is not a string is printed like any other tool.
   - Any other tool: `<tool> key=value ...` in the recorded key order, joined
     by spaces, the key as it is and the value as a token, or the tool name
     alone when no argument is left.
4. A token: a string matching `^[A-Za-z0-9_@%+=:,./~-]+$` prints as it is.
   Any other string, the empty string included, prints as a JSON string. A
   number, a boolean or null prints as JSON. An object or a list prints as
   compact JSON in its key order. JSON here is what JavaScript's
   `JSON.stringify` writes: no space after `,` or `:`, and characters outside
   ASCII kept as they are (in Python, `ensure_ascii=False` and
   `separators=(",", ":")`). Quoting is not shell quoting: `it's` prints as
   `"it's"`.

`command_details`, `command_run_worktree_root` and `command_root_not_absolute`
show each of these beside `command_relative_and_redacted`.

## The rounds record

`check.json` of a strict hand-back has a top-level `strict` object. Four of
its keys say where the hand-back stood in its rounds:

| Key | What it is |
|---|---|
| `retry_rounds` | Rounds the contract allows a hand-back to be sent back. |
| `rounds_used` | Rounds sent back so far, this one included when `round_open` is true. |
| `round_open` | `true` when this hand-back was sent back to the model. |
| `returned_before` | The fact ids returned to the model in earlier rounds of the same prompt, as a sorted list (plain string order). The ids this round returns are not in it; they are in `returned`. |

`returned_before` is the set the check was given, written before the round's
own returns are added. It is the case input of the same name. With it a reader
can tell the two ways a fact ends as `keep_marked`: its id is in
`returned_before` (it was returned once and came back with a `keep_marked`
answer), or it is not (no round was left). A new prompt empties the set. An
export written before the key existed has no `returned_before`; a reader must
load it and treat the set as not recorded. The Python side copies the key as
it is (`associate check`, the `strict` object of a run result) and does not
check it.

## Counts

- `counts`: facts per outcome.
- `drop_reasons`: every dropped fact, verdict and open item, per reason.
- `judge_counts` is taken from the final records, after the last cascade.
  `direct_passed`: facts with `status: passed` and outcome `pass` (a fact that
  ends dropped is never counted). `llm_judged`: facts the decider answered
  with the support question, whatever happened next. `derived_judged`: the
  same for the derived question. `not_judged`: facts with outcome
  `not_judged`.
- `report`: `direct_passed` (outcome `pass`, no answer from the decider),
  `llm_judged` (outcome `pass` on a support answer), `derived` (outcome `pass`
  on a derived answer), `kept_with_mark`, `returned`, `not_judged`, `dropped`
  (`total` and `by_reason`, facts only), `by_stated_kind` (per stated kind:
  `stated`, and `checked_as_direct`, the facts of that kind passed as direct),
  `worded` (facts with `worded: true`) and `judged` (facts the decider
  answered).

## The cases

The names say what each case shows. Every case has a `note`.

- Pointers and the rule: `lines_pointer_no_value`,
  `search_pointer_value_copied`, `value_ends_trimmed_is_direct`,
  `value_case_differs_is_worded`, `value_inner_whitespace_differs_is_worded`,
  `stated_llm_value_copied_is_direct`, `worded_all_pass`,
  `worded_mostly_pass`.
- The 604 case: `604_part_first_time_returned`,
  `604_part_returned_before_kept_marked`, `604_part_no_round_left_kept_marked`,
  `604_little_first_time_returned`, `604_none_dropped`,
  `604_bare_number_is_direct`.
- Numbers and pointers that fail: `number_absent`,
  `number_thousands_separator`, `pointer_out_of_range`, `search_not_found`,
  `result_cut`, `read_shown_line_numbers`, `no_saved_result`.
- Sources: `prior_source_present`, `prior_source_absent`,
  `child_source_present`, `child_source_absent`, `unknown_source`.
- Old-shape facts: `old_shape_found_direct`, `old_shape_found_worded_judged`,
  `old_shape_not_found`, `old_shape_number_absent`.
- Shape: `shape_unknown_kind`, `shape_no_at_no_quote`,
  `shape_lines_and_search`, `shape_llm_without_value`,
  `shape_derived_without_based_on`.
- The graph: `based_on_unknown_id`, `based_on_cycle`,
  `cascade_chain_names_root`, `derived_each_answer`,
  `derived_on_decider_dropped_fact`, `direct_on_decider_dropped_fact`,
  `derived_with_failed_pointer`.
- The decider and items: `decider_outage_not_judged`,
  `verdicts_on_dropped_facts`.
- The command: `command_relative_and_redacted`, `command_details`,
  `command_run_worktree_root`, `command_root_not_absolute`.
- A fact that could not be checked: `cascade_from_unchecked_fact`,
  `graph_failure_replaces_unchecked`, `saved_result_file_read`.
- Facts that cannot be sent: `not_sendable_no_evidence_no_inputs`.
- A broken contract: `min_quote_length_zero`, `min_quote_length_true`.
- A value that is not a string: `value_not_a_string`.
- Line stamps: `read_stamps_mixed_lines`, `read_stamps_cut_result`.
- Action facts and first-hand: `action_facts`, `closing_verdict_second_hand`,
  `delegate_status_quote_in_harness_fields`,
  `delegate_status_pointer_reaches_child_words`.
- Derived answers that decide: `derived_decides_drops_true`,
  `derived_passes_absent_fails_closed`.
- Earlier rounds: `returned_before_only_changes_part_and_little`.

## Defined behaviour that may surprise

These are part of the rule. A second implementation must do the same.

- A labelled source whose run is not loaded (no prior run or child with that
  label) fails as `source_unknown`, from the source check in step 1. The
  pointer resolver's `labelled_unread` is never reached in the strict flow
  (`prior_source_absent`, `child_source_absent`).
- A source that holds `/` or `\` fails as `source_path`, not
  `source_malformed` (`unknown_source`, fact f2).
- A fact with neither `at` nor `quote` is first refused by the matcher as
  `quote_short` (an empty quote); the shape rule then replaces that reason
  with `pointer_missing` (`shape_no_at_no_quote`). The checker verdict stays
  `refused`, so a verdict resting on it is `basis_refused`.
