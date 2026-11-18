# pi 1.1.0 → 1.5.2 migration: breaking-change verdicts

Plan task **t1** (`docs/plans/2026-11-17-associate-accuracy-method.md`),
covering claim c40 and honesty condition h25. Every entry under a
**Breaking Changes** heading in the installed pi CHANGELOG
(`@earendil-works/pi-coding-agent` 1.5.2) between 1.1.0 (exclusive) and 1.5.2
(inclusive) is listed below, each checked against the extension source
(`.pi/extensions/associate/index.ts`, `lib/*.ts`, `tools/*.ts`) and the Python
launcher (`associate/harness/pi.py`). Three releases in that range have a
Breaking Changes section: 1.2.0, 1.5.0 and 1.5.1. 1.3.0, 1.4.0 and 1.5.2 have
none. The changelog lists no other release in the range.

"Measured" means a real `pi` 1.5.2 process was run. "Reasoned" means the
verdict rests on reading the source and pi's 1.5.2 changelog and
`docs/extensions.md` without a run that would show the difference.

## Breaking changes

### 1.2.0

1. **Configuration schemas published; the theme schema moved and themes are
   validated at startup.**
   Verdict: **harmless** (reasoned). `.pi/settings.json` holds `defaultTools`,
   `skills` and `extensions` only, with no `$schema`; the repo ships no theme.

2. **`before_agent_start` also fires for runs started by
   `pi.sendMessage(..., { triggerTurn: true })`, and its event is a union on
   `messageType`; a `"custom"` event carries no `prompt`.**
   Verdict: **harmless** (reasoned). Four handlers listen
   (`index.ts`, `lib/preflight.ts`, `lib/torch.ts`, `lib/prompt.ts`). The one
   that reads the prompt guards it (`if (typeof prompt === "string") task =
   prompt;`), and nothing in the extension calls `pi.sendMessage`,
   `pi.sendUserMessage` or `ctx.isIdle` (grep over the extension, tests
   excluded: no hit), so no custom-message run is ever started here.

3. **The session counts as busy while a run starts; `pi.sendUserMessage()`
   requires `deliverAs`.**
   Verdict: **harmless** (reasoned). Same grep: the extension uses none of
   these calls.

4. **`pi mcp list --json` reports `resources: true` instead of counts.**
   Verdict: **harmless** (reasoned). The launcher passes `--no-mcp` and nothing
   in the repo runs `pi mcp list`.

### 1.5.0

1. **Tool argument validation runs on `@earendil-works/pi-schema`; TypeBox
   features outside JSON Schema no longer apply; plain JSON Schema tools get
   the same coercion as TypeBox tools; validation messages changed.**
   Verdict: **affects, tolerated** (measured for the tools the live runs
   called; reasoned for the rest). The extension's schemas use only
   `Type.Object`, `Type.String`, `Type.Integer`, `Type.Number`, `Type.Array`
   and `Type.Optional`, or plain JSON Schema objects; grep finds no
   `Type.Refine`, `Type.BigInt`, `Type.Undefined` or `Format.Set`. No test or
   prompt depends on TypeBox's message wording (grep for `must have required`,
   `must be number`: no hit). Coercion now also applies to the tools declared
   with plain JSON Schema (`grep`, `find`, `ls`, `bash`, the web, memory,
   ledger, test, spawn and delegate tools): a numeric string is converted
   before the tool sees it. The tools validate their own arguments again
   (`lib/contain.ts` `validateArgs`), so a converted value still passes
   through that check.

   Two facts from the 1.5.2 documentation bear on the accuracy work, and were
   not true or not known at 1.1.0:

   - `docs/extensions.md` says "An unknown tool or invalid arguments skip
     `tool_call`". A call pi rejects for its arguments never reaches the
     extension's `tool_call` hook, so the guard cannot record or explain it;
     it surfaces only as `tool_execution_end` with an error result. A rule
     enforced in the hook must not also be a `required` schema property.
   - An argument a built-in schema does not declare is passed through: in live
     run `scope20-worker-t6` an extra `purpose` on `write` and on `edit`
     reached the walk and both calls succeeded.

### 1.5.1

1. **Custom `GrepOperations.readFile` callbacks are no longer called for
   context lines.**
   Verdict: **harmless** (reasoned). The extension registers its own `grep`
   (`tools/search.ts`) and imports only `type ExtensionAPI` from pi.

2. **OpenAI-compatible models no longer send `"tools": []` when all tools are
   disabled in a session that has used tools.**
   Verdict: **harmless** (reasoned). The extension always leaves the active
   model's registry tools enabled (`pi.setActiveTools`), so the tools list is
   never empty on the wire. The lanes are vLLM-served through the lobes
   gateway, which is the case this change fixes.

## Changes outside a Breaking Changes heading that touch the harness

These are not marked breaking upstream. They are listed because they change
what the launcher or the extension observes.

- **1.2.0, print mode:** "Fixed print mode (`-p`) exiting 0 without a warning
  when the final response was cut off at the model's output token limit; it
  now prints the partial text, writes a warning to stderr, and exits 1".
  The launcher treats a non-zero exit of the task run as a failed run
  (`pi exited N on the task run, so nothing is served`, exit 2). A reply cut at
  the output limit therefore now fails the run instead of being served as a
  truncated answer. Not measured: no run in this work hit the output limit.
- **1.3.0, `--model`:** provider choice by credentials when several providers
  offer a match. The launcher always passes `--provider` with `--model`, so
  the ambiguity does not arise (reasoned).
- **1.5.1, built-in `grep`, `find`, `ls`, `read`, `edit` fixes.** The
  extension overrides `read`, `grep`, `find`, `ls` and `bash` with its own
  tools, so only the `edit` and `write` built-ins are affected; the `edit`
  line-ending fix changes no interface (reasoned).
- **1.5.1, RPC mode shutdown fixes.** These touch the mesh path through
  `pi-acp`, which was not exercised here.

## What the 1.5.2 documentation allows that the accuracy plan relies on

Quoted from `docs/extensions.md` in the 1.5.2 install; documentation only, not
yet exercised by this extension:

- "`event.input` is mutable. Mutate it in place to patch tool arguments before
  execution." and "No re-validation is performed after your mutation".
- "`tool_result` (can modify the result)"; handlers "can return partial
  patches (`content`, `details`, `structuredContent`, `isError`, or `usage`)".

## Evidence

- `bash .pi/extensions/associate/tests/run.sh` with pi 1.5.2 installed, on the
  integration branch before this change: 622 pass, 0 fail, 3 skipped. The
  skips come from `tests/pi-integration.test.ts`, whose tests start a real pi
  and skip with a printed reason when the run does not exercise the path. One
  reason was read ("the model never attempted a write, so the guard was not
  exercised end to end"); the other two were not read.
- `uv run pytest -n auto -q`: 364 passed before this change.
- Live runs on pi 1.5.2, 2026-11-17, each one run and not a rate. Worker:
  `scope20-worker-t1`, `scope20-worker-t2`, `scope20-worker-t4`,
  `scope20-worker-t5`, `scope20-worker-t6` handed back; `scope20-worker-t3`
  ended at its time limit. Cortex: `scope20-cortex-t1` and `scope20-cortex-t5`
  handed back; `scope20-cortex-t2`, `-t3` and `-t4` ended at their time limit.
  Every one of them printed the launcher's version warning, because the pin
  was still 1.1.0. The walks are in the operator's scratch directory and are
  not committed.

## Not checked

- **`pi-acp` 0.0.33 against pi 1.5.2.** Not checked. The mesh resident on the
  survey machine already runs pi 1.5.2 under pi-acp, but no session through it
  was observed for this note.
- **`senses` on 1.5.2.** No live `senses` run was made.
- **The `--mode json` event shapes.** The changelog lists no change to them in
  this range; no 1.1.0 install was available to diff against.
- **A reply cut at the output limit** (the print-mode change above).
