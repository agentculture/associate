# pi 0.84.2 → 1.1.0 migration: breaking-change verdicts

Plan task **t2** (`docs/plans/2026-10-27-associate-multi-model-on-pi-1-1-0.md`),
covering claims c23 / c56 and honesty conditions h18 / h37. Every entry under a
**Breaking Changes** heading in the installed pi CHANGELOG
(`@earendil-works/pi-coding-agent` 1.1.0) between 0.84.2 (exclusive) and 1.1.0
(inclusive) is listed below, each checked against the extension source
(`.pi/extensions/associate/index.ts`, `lib/*.ts`, `tools/*.ts`) and the Python
launcher (`associate/harness/pi.py`). Only four releases in that range have a
Breaking Changes section: 0.84.3, 0.86.0, 0.87.0 and 1.0.3. 0.85.x, 0.86.1,
0.87.1, 0.99.x, 1.0.0–1.0.2, 1.0.4 and 1.1.0 have none.

"Measured" means a real `pi` 1.1.0 process was run; "reasoned" means the
verdict rests on reading the source and pi's 1.1.0 type declarations
(`dist/core/extensions/types.d.ts`) without a run that would show the
difference.

## Breaking changes

### 0.84.3

1. **`GoogleThinkingLevel` renamed to `GoogleApiThinkingLevel`.**
   Verdict: **harmless** (reasoned). The extension imports only
   `type ExtensionAPI` from pi; no file in the repo names either type.

### 0.86.0

1. **Provider stream inputs changed from `Context` to `TranscriptContext`**;
   custom providers must read the system prompt and tools from
   `context.messages` via `getCurrentSystemPrompt()` / `getCurrentTools()`.
   Verdict: **harmless** (measured). `lib/provider.ts` registers a
   configuration-only provider (`api: "openai-completions"`, no custom
   `streamSimple`/stream function), so pi's own adapter does the conversion;
   the one provider hook, `before_provider_request`, edits the serialized
   payload. On 1.1.0 the first request body carries the system prompt as a
   leading `system` message and the declared tools; reasoning is now per model
   (`tests/test_provider_wire.py::test_transcript_backed_prompt_and_tool_changes_reach_the_first_request`,
   (`::test_reasoning_off_reaches_the_wire_for_that_model_only`).
2. **`ToolCall.arguments` and `ToolResultMessage.details` restricted to
   JSON-compatible values**; `ToolResultMessage` became a conditional type and
   `JsonValue` arrays readonly.
   Verdict: **harmless** (measured for the core tools, reasoned for the rest).
   The restriction is type-level; pi loads the extension with types stripped,
   and no runtime check was found in pi's `dist`. The extension never builds a
   `ToolCall` or `ToolResultMessage`; it reads `event.input` / `event.details`
   and never writes them. A new test asserts that the `details` of
   `associate_ready`, `read` and `finish` contain only JSON values
   (`.pi/extensions/associate/tests/extension.test.ts:378`). The other tool
   modules' `details` are not covered by that test.
3. **`user_bash` fails closed**: a handler error or an invalid defined result
   aborts the command.
   Verdict: **harmless** (reasoned). The extension registers no `user_bash`
   handler (`user_bash` is the interactive `!command` path, not a model tool
   call). The model-facing shell is the extension's own argv-only `bash`
   override.

The 0.86.0 **Added** entry the plan also names, **transcript-backed
`before_agent_start` prompt and tool changes**, is not listed under Breaking
Changes, but it changes how two extension hooks take effect:

- Verdict: **harmless** (measured). `lib/prompt.ts` and `lib/torch.ts` return
  `{ message }` from `before_agent_start`; that field is still part of
  `BeforeAgentStartEventResult` in 1.1.0. On a real run the checkout's
  `AGENTS.md` injection reaches the first request exactly once. `index.ts`'s
  `dropWriters` calls `pi.setActiveTools()` from `session_start` and from
  `before_agent_start`. A helper extension that re-enables `write`/`edit` in
  an earlier `before_agent_start` handler shows both gone at `agent_start`
  and absent from the first request's declared tools
  (`tests/test_provider_wire.py:288`; a mutation that drops the
  `before_agent_start` registration fails it). `lib/torch.ts`'s continue-from
  message has the same shape but has no wire test of its own.

### 0.87.0

1. **`shouldStopAfterTurn` agent option removed** (use `finishTurn`).
   Verdict: **harmless** (reasoned). It is an `AgentSession`/agent-core
   option that neither the extension nor the subprocess-only launcher sets.
   `finish` does not stop the loop (deviation d9 removed `terminate: true`);
   later tool calls are blocked by the `tool_call` hook.
2. **`ContextEditEntry` added to the `SessionEntry` union.**
   Verdict: **harmless** (reasoned). Nothing in the extension switches over
   session entries.
3. **`SessionManager` made canonical for `AgentSession` provider context**
   (assigning `session.agent.state.messages` no longer rewrites history).
   Verdict: **harmless** (reasoned). SDK-only; associate drives pi as a
   process and never holds an `AgentSession`.
4. **`TurnEndEvent` expanded, `AgentBeforeSettleEvent` added to
   `ExtensionEvent`, and `ExtensionRunner.emit()` no longer accepts
   `turn_end`.**
   Verdict: **harmless** (reasoned). The extension has no `turn_end` or
   `agent_before_settle` handler, does no exhaustive switch over events, and
   hosts no `ExtensionRunner`. The test `FakePi` is the repo's own stand-in
   and does not emulate it.
5. **Runs requested from `agent_settled` handlers are deferred** until all
   settled handlers finish.
   Verdict: **harmless** (reasoned). The extension registers no
   `agent_settled` handler.

### 1.0.3

1. **Azure provider renamed** from `azure-openai-responses` to `azure`.
   Verdict: **harmless** (reasoned). The lane's provider is the extension's own
   `associate` provider (`api: "openai-completions"`), and nothing in the repo
   refers to an Azure provider.

## Beyond the Breaking Changes headings

These changes in the same range were not filed as breaking, but they touch the
tool set this lane must keep free of writers.

- **0.84.3: optional built-in `powershell` tool.** Verdict: **fixed in
  `.pi/extensions/associate/lib/guard.ts:41`** (measured). On 1.1.0 (Linux)
  `getAllTools()` lists `powershell` as a configured built-in. Before the fix,
  `pi --tools +powershell` (the 1.1.0 `+name` syntax) put this unrestricted
  shell on the wire next to the associate tools, because `dropWriters` did not
  count it as a writer. It is now in `BUILTIN_WRITER_TOOLS`, so it is dropped
  from the active set and blocked by the guard
  (`.pi/extensions/associate/tests/guard.test.ts:108`,
  `tests/test_provider_wire.py:343`; that test fails with `guard.ts` at the
  pre-fix revision).
- **0.99.0: built-in `codemode`, `tool_search` and MCP support.** Verdict:
  **harmless today; open risk recorded**. `codemode` and `tool_search` are
  configured but inactive (measured in the run's `ready.json`). pi's docs say
  nested `ctx.executeTool()` calls go through the `tool_call` handlers, so the
  guard also sees calls made from codemode scripts (from the docs, not
  measured). MCP tools are a new path the guard does not classify: an
  operator-configured MCP server with `direct` exposure would put its tools in
  the active set, and `isWriterTool` does not treat `mcp__*` names as
  writers. No MCP server is configured on this box (pi's user-level
  `mcp.json` in its agent directory and `.pi/mcp.json` are absent), and the
  launcher does not pass `--no-mcp` (t12 later added it).
  That is a scope decision for the plan, not something this migration changes.
- **Ordering edge (measured, not version-attributed):** a writer re-enabled
  by another extension at `agent_start`, which fires after this extension's
  `before_agent_start`, is not declared in the first request, but it stays
  active for later requests. The `tool_call` write guard is the remaining
  defense on that path. 0.84.2 is no longer installed, so whether this
  behaviour differs from 0.84.2 was not measured.

## The pin

- `associate/harness/pi.py:104`: `PINNED_PI_VERSION = "1.1.0"`. Any other
  version warns on stderr naming 1.1.0 and still runs
  (`tests/test_run.py:593`, `:599` (parametrized over 0.84.2, 0.99.0, 1.0.4,
  1.1.1 and 2.0.0), and `:617` (the pin itself does not warn)).
- `CLAUDE.md` Tooling prerequisites, `README.md`, the `index.ts` "Measured
  against" comment, and the `associate run` explain entry now name 1.1.0.
  Historical records (CHANGELOG, specs, plans, deliveries) are unchanged.

CLAUDE.md's upgrade rule says a pin is bumped only after `associate bench`
passes on the new version. That has **not** been met on the associate lane:
the local gateway requires a bearer token that was not in this environment,
so no live associate-lane run was made (h18's "a live associate run on 1.1.0
completes" is still open). The bump follows the confirmed plan, and the
evidence actually gathered on 1.1.0 is:

- both test suites pass (see below);
- the real-pi wire tests above pass;
- `associate bench --harness pi` was run against pi's **default** provider
  (`bolt/worker`, because no `ASSOCIATE_API_KEY` was set), **not** the associate
  lane. All 7 cases ran end to end on 1.1.0: preflight, `ready.json`, task
  turn, and `walk.jsonl`/statements artifacts. All 7 failed their checks
  (0/7). At least part of that is a bench-check artifact rather than a 1.1.0
  defect. The `local-read-find` walk records a successful `read` of
  `src/constants.py`, but the model passed the absolute path, and
  `associate/bench/checks.py:251` compares `args.path` to the relative path by
  exact string. The remaining failures (no `[wN]` evidence on statements,
  `not_fully_read`, forbidden-mutation outcome `ok` rather than `refused`) match
  the failure classes recorded for the 0.84.2 live run. These numbers say
  nothing about the associate model.

## The one skipped extension test

`pi-integration.test.ts` › "a real pi run blocks a write into the checkout"
skips with "the model never attempted a write". The skip comes from deviation
d7, not from 1.1.0. `dropWriters` removes the `write` that `--tools` re-enabled,
so the model is never offered it: on 1.1.0 the leading system message's
`toolsAdded` names only `associate_ready` and `finish`. It should not be
expected to run. Its comment now says so.
