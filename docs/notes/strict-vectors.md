# The shared strict cases (`strict_vectors.json`)

`associate/contract/strict_vectors.json` holds named cases for the strict
hand-back check. The extension computes the expected result of every case by
running its own code. A second implementation (the strict re-check planned for
evidence-cli) must give the same result on every case. The file is held byte
for byte the same in both repositories, like `matcher_vectors.json`.

This note is enough to write that re-check without reading the TypeScript.
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
- The Python tests in this repository only check that the file is well formed
  (`tests/test_strict_vectors.py`).

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
| `returned_before` | Fact ids returned in an earlier round of this task. |
| `rounds_left` | How many rounds may still send facts back. `0` means none. |

A walk entry has `id` (`wN`), `tool`, `args` (the arguments as asked, with
`purpose`), and may have `args_used` (the arguments as the tool used them),
`saved_result` (the file name of its saved result), `partial: true` (the saved
result was cut at the size cap), `error`, and `source_kind`. Other fields are
not read. An entry without `saved_result`, or whose file is missing from
`results`, has no saved result.

`contract` holds:

| Key | What it is |
|---|---|
| `strict.keep_marked` | Support answers that return a fact once, then keep it with the mark. |
| `strict.drop` | Support answers that drop a fact. |
| `strict.mark_text` | The mark written beside a kept fact. |
| `strict.derived_decides_drops` | Whether a derived answer can drop a fact. `false` in every case. |
| `strict.derived_passes` | Derived answers that would pass a fact if `derived_decides_drops` were true (`yes`, `mostly`). |
| `support_passes` | Support answers that pass a fact. |
| `min_quote_length` | The matcher's shortest quote, for old-shape facts. |
| `retry_rounds` | Rounds a hand-back may be sent back. |
| `source_kinds` | The source kind of each tool in the case (`file`, `tool`, `web`, `memory`, `agent`, `harness`). |

`decider` maps a fact id to `{question, option}` (the decider answered:
`question` is `support` or `derived`) or to `{not_judged: reason}` (no answer,
for example `unreachable`). The re-check never calls the decider. It uses the
stored answer for each fact it would send. Every stored answer is used, and
every judged fact has one.

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

### 1. The source

The source is an optional run label and a walk id: `^([A-Za-z0-9_-]+:)?w[1-9][0-9]*$`.

- A source holding `/` or `\` fails as `source_path`.
- Any other source that does not match fails as `source_malformed`.
- A label that names neither a prior run nor a child fails as `source_unknown`.
  A label that names both is not usable either and fails the same way.
- A walk id with no entry in that run fails as `source_unknown`.
- An action fact (`action: true`) must name its `tool`
  (`action_tool_missing`), cite an entry of that tool (`action_wrong_tool`),
  and that entry must have no `error` and a saved result that is not a JSON
  object with `ok: false` (`action_failed`). No case has an action fact.

These failures make the fact's checker verdict `refused`.

### 2. A pointer (`at`)

When `at` is an object, the pointer is resolved in the run the source names.

1. No saved result for the entry: `no_saved_result`.
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
   line starts with digits and a tab. Then `lines: [a, b]` names the lines
   stamped `a` and `b`, and a search reports the stamp of the line it found.
6. `search` takes the first line that contains the term (exact, case-sensitive
   substring). That one line is the evidence.
7. Missing lines:
   - Not found by search: `search_not_found`, or `result_cut` when the entry is
     `partial`.
   - Lines past the end: `pointer_out_of_range`, or `result_cut` when the entry
     is `partial`. For a stamped read result, a stamp that is not shown is out
     of range; on a `partial` entry it is `result_cut` when the last line has
     no stamp or the asked last line is above the last shown stamp.
8. On a `partial` entry, evidence that includes the last kept line is
   `result_cut` too: that line may itself have been cut.
9. The quote is the lines from first to last, byte for byte, joined with `\n`.
   Read stamps are kept.
10. The number rule (below) on the value and the quote: `number_absent`.

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
and a last time after the decider.

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
| Derived answer, `derived_decides_drops` true: named in `derived_passes` / other | `judged` | `pass` / `dropped` (`decider_drop`) | |
| No answer | `not_judged` | `not_judged` | null |

A round is left when `rounds_left > 0`. Lists are checked in this order:
`keep_marked`, then `drop`, then `support_passes`.

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
   `agent` or `memory`. (A `delegate_status` result has its own rule in
   `lib/facts.ts`; no case uses it.)

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

1. Take `args_used` when it is an object, else `args`. Drop the `purpose` key.
2. Rewrite every string, and every object key, in the arguments:
   1. Paths under the checkout become relative. Trim trailing slashes from
      `checkout_root`. When it is a run worktree
      (`<parent>/.worktrees.<name>/<run>`), the base is `<parent>/<name>`.
      Otherwise the base is the root itself. The worktrees directory is
      `<parent of base>/.worktrees.<name of base>`. A match is the base, or
      the worktrees directory followed by `/` and one path segment. It must
      be followed by `/`, or by the end or a character that is not a letter,
      digit, `_`, `.` or `-`. A match without its `/` becomes `.`. A match
      with its `/` is removed, or becomes `.` when the end, whitespace or a
      quote follows. So `<root>/lib` prints `lib`, and `<root>` prints `.`.
   2. Other home paths become `~`: `/home/<user>`, `/Users/<user>` or `/root`,
      followed by `/`, whitespace, a quote, a backtick or the end.
   3. The redaction filter.

   The tool name is redacted too.
3. Print by tool:
   - `bash` with an `argv` list of strings: each token, joined by spaces.
     When `cwd` is a string that is not blank, put `cd`, a space, the cwd
     token and ` && ` in front: `cd . && grep -rn lib`.
   - A read tool with a string `path`: `<tool> <path>`. When `start_line` or
     `end_line` is a number, add a space and `lines <start>-<end>`, with `1`
     for a missing start and `end` for a missing end.
   - Any other tool: `<tool> key=value ...` in the recorded key order, or the
     tool name alone when no argument is left.
4. A token: a string matching `^[A-Za-z0-9_@%+=:,./~-]+$` prints as it is.
   Any other string prints as a JSON string. A number, a boolean or null prints
   as JSON. An object or a list prints as compact JSON in its key order.

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
- The command: `command_relative_and_redacted`.

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
