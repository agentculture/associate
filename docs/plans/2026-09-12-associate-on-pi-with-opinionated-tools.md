# Build Plan — associate on Pi with opinionated tools

slug: `associate-on-pi-with-opinionated-tools` · status: `exported` · from frame: `associate-on-pi-with-opinionated-tools`

> associate ships as a Pi-based agent on Nemotron 3.5 Lightning: pi (pi.dev) drives the lobes associate lane with a project extension that registers opinionated read/find/summarize/web tools, a structurally restricted toolset (no edit/write into any checkout), and precision aids where the model is weak

## Tasks

### t1 — Track the Pi project config and package manifest: .pi/settings.json, package.json (pi key), .gitignore entries

- instruction: Commit .pi/settings.json with defaultTools set to an empty array (no built-ins; extension tools stay), skills pointing at .claude/skills (repo-relative), and extensions pointing at .pi/extensions/associate; add package.json at the repo root whose only purpose is the pi key declaring extensions and skills dirs (no scripts, no dependencies); git-ignore .pi/npm/, .pi/git/, `node_modules`/, and the export root .associate-runs/. Do not touch the Python package.
- covers: c10, h7, c45, h37
- acceptance:
  - .pi/settings.json is tracked, contains no '~' or '/home' path, sets defaultTools to \[\] and skills to .claude/skills
  - package.json exists with a pi key naming .pi/extensions/associate and .claude/skills, has no dependencies or scripts, and 'uv run pytest' still passes with dependencies = \[\] unchanged
  - .gitignore covers .pi/npm/, .pi/git/, `node_modules`/, and the export root; git ls-files shows none of them

### t4 — Test harness for the extension and CI job independent of the lane: node --test for the extension, fake OpenAI-compatible server for the Python side, tests.yml job

- instruction: Add an extension test runner using Node 22's built-in test runner with type stripping (document the exact node flags in package.json is forbidden — put them in a small script under .pi/extensions/associate/tests/run.sh); add tests/`fake_lane.py`, a minimal OpenAI-compatible chat/completions server that returns scripted `tool_calls`, used by pytest; extend .github/workflows/tests.yml with a Node 22 job that runs the extension tests and skips pi-dependent tests with a printed reason when pi is absent. No test may read an endpoint or bearer from the environment.
- depends on: t1
- covers: c40, h33
- acceptance:
  - the tests job passes on a runner with no route to the lane and no bearer set; pi-dependent tests skip with a reason when pi is absent
  - the fake server answers a chat completion with a scripted `tool_calls` structure and is used by at least one pytest
  - grep of tests/ and .pi/extensions/associate/tests/ finds no `ASSOCIATE_BASE_URL` or bearer read that a test depends on to pass

### t16 — Portable contract module: role.json, policy.json, task/walk/statements schemas, a small adapter base, and a plumbing-only stub

- instruction: Create associate/contract/ with role.json (capabilities and forbidden tokens copied from lobes/roles.py associate), policy.json (read denylist patterns, shell allowlist, per-tool budgets, result caps, fetch cap), and schemas/task.schema.json, schemas/walk.schema.json, schemas/statements.schema.json. No prompt file here — the runtime prompt is Pi-tailored and lives in AGENTS.md (t13). Create associate/harness/base.py with a deliberately small interface (start a session against a checkout with the contract dir, submit a task, collect walk and statements paths) and associate/harness/stub.py, an in-process adapter that replays scripted events so tests can exercise plumbing without pi; the stub's results are labeled plumbing-only. Pure Python, no dependency, no pi import.
- depends on: t1
- covers: c46, h38, c47, h39
- acceptance:
  - associate/contract/ holds role.json, prompt.md, policy.json, and the two schemas; a test validates a sample walk.jsonl and statements.json against the schemas
  - associate/harness/base.py defines the interface and stub.py satisfies it; a test drives the stub end to end without pi installed
  - role.json forbidden tokens equal lobes `ROLE_FORBIDDEN`\['associate'\] exactly (`final_decision`, `security_decision`, `code_authoring`, `repo_action`)

### t17 — Behavioral suite and 'associate bench --harness' evaluating the complete configuration, stub labeled plumbing-only

- instruction: Add tests/behavioral/ with one case per category (local read/find, repo exploration, summarization, structured evidence extraction, tool-call reliability, forbidden mutation attempts, bounded completion and hand-back) expressed against the adapter interface and, where the category allows, against a fixture repo with known facts so support and coverage are checkable; add associate/cli/`_commands`/bench.py registering bench (with --json) that runs the cases against a named adapter and prints a table whose rows record the complete configuration — harness, model role and served model id as reported by the endpoint, pi version, extension version, provider and reasoning settings — plus per-category pass/fail and wall time; exit non-zero on any failure; a stub run is labeled plumbing-only in the table. Wire the four CLI sync points. The stub run is the CI path; the pi run is local.
- depends on: t16, t4
- covers: c48, h40
- acceptance:
  - 'associate bench --harness stub' passes in CI with no pi and no lane; 'associate bench --harness bogus' exits 1 listing adapters
  - the corpus contains no adapter-specific case; the same seven cases run for every adapter
  - the table names harness and model role per row; teken cli doctor --strict still passes with bench registered
  - the table row for a pi run records pi version, extension version, served model id, and reasoning setting; the stub row is labeled plumbing-only

### t2 — Extension core: loader, sentinel tool, finish/handback tool, write-guard hook, session-keyed scratch and export dirs

- instruction: Create .pi/extensions/associate/index.ts that dynamically imports every module under tools/ and calls its register(pi); register a sentinel tool '`associate_ready`' (returns the extension version and the contract version it loaded) and a 'finish' tool whose payload is the handback; load policy.json and the walk/statements schemas from the Python package's contract dir (path passed by the adapter via env `ASSOCIATE_CONTRACT_DIR`, falling back to the repo-relative associate/contract/) — never define policy values in TypeScript; register a `tool_call` hook that blocks any call whose resolved path lies outside the session scratch dir; resolve one scratch and one export dir per session under the export root, keyed by the ACP session id when present else a generated id (lib/session.ts). Pi provides typebox; import nothing else.
- depends on: t1, t16
- covers: c3, h2, c5, h4, c4, h3, c42, h35
- acceptance:
  - starting pi with the extension loaded lists `associate_ready` and finish and lists neither edit nor write (defaultTools \[\] plus no built-in override)
  - a tool call that targets a path outside the session scratch dir is blocked in the `tool_call` hook and the block is visible in the transcript; a unit test asserts both
  - two sessions started in parallel resolve two disjoint scratch/export dirs whose names carry their session ids
  - after a complete fixture run, git status --porcelain in the examined checkout is empty

### t3 — Containment library ported from colleague: confine, pattern-escape refusal, output budget with spill, denylist, schema validation, continuation cursors

- instruction: Port case by case into .pi/extensions/associate/lib/contain.ts: confine(root, rel) and refuse-pattern-escape from colleague/colleague/`search_tools.py`:90-105, the per-tool output budget with spill-to-disk from colleague/colleague/readpage.py, a read denylist driven by policy.json patterns plus paths matched by the checkout's .gitignore, a validateArgs(schema, args) helper that returns a structured error naming the offending field, and a continuation-cursor helper for chunked output. Budgets, caps, and patterns come from the loaded policy, never from literals. This task owns only lib/contain.ts and its tests.
- depends on: t1, t16
- covers: c29, h23, c21, h15
- acceptance:
  - confine refuses ../outside-root and absolute paths outside the root; a grep pattern containing ../ is refused; each refusal is a structured error object
  - a 5 MB input is bounded at the budget and the result carries a spill path and truncated=true; a continuation cursor re-enters at the right offset
  - a read of .env and of a file matched by a secret pattern is refused; validateArgs returns {error, field} for a malformed argument set and null for a valid one

### t5 — Bounded read tool with absolute line numbers, byte cap, continuation cursor, and denylist

- instruction: Add tools/read.ts registering a tool named read (overriding the built-in by name) that takes path plus optional start/end lines, stamps every returned line with its absolute file line number regardless of the requested window, applies the byte cap from lib/contain.ts, returns a continuation cursor and truncated marker, and refuses denylisted files.
- depends on: t2, t3
- covers: c24, h18
- acceptance:
  - reading a fixture from line 3400 returns lines prefixed 3400, 3401, ... never 1, 2
  - a file larger than the byte cap returns truncated=true plus a cursor; re-reading with the cursor returns the next chunk
  - a read of .env is refused with a structured error; a malformed argument set returns an error naming the field

### t6 — find, grep, and ls tools over Pi's vendored rg and fd with result caps

- instruction: Add tools/search.ts registering find, grep, and ls that spawn the rg and fd binaries Pi vendors under its agent bin dir with an argv list (no shell), confine every path through lib/contain.ts, cap results at 200 with a truncated marker, and validate arguments through validateArgs.
- depends on: t2, t3
- covers: c20
- acceptance:
  - grep and find return at most 200 results with truncated=true when more exist
  - a pattern containing ../ or an absolute path outside the root is refused with a structured error
  - no code path passes model text to a shell; the spawn uses an argv array

### t7 — Shell tool override: same-named bash tool that spawns an argv allowlist with no shell and refuses mutating commands

- instruction: Add tools/shell.ts registering a tool named bash (overriding the built-in) whose input is an argv array; match argv\[0\] and, for git, argv\[1\] against the read-only allowlist from policy.json; refuse anything else, and refuse any token that is a redirection, pipe, tee, sed -i, rm, or a mutating git subcommand; spawn directly with no shell. Log every invocation for the walk.
- depends on: t2, t3
- covers: c35, h27, h14, h28
- acceptance:
  - echo x > f, tee f, sed -i, git commit, git push, and rm are each refused with a structured error; git log, git diff, rg, fd, and code-lens profile succeed
  - the startup tool list shows exactly one tool named bash and it is the extension's; a unit test asserts the override
  - the spawn call receives an argv array and never a shell string

### t8 — code-lens and read-only webglass wrapper tools with install-hint degradation and typed fetch errors

- instruction: Add tools/codelens.ts and tools/web.ts. codelens wraps the code-lens PATH CLI (profile, classify, grep, recent, connections, graph). web registers only webglass search and webglass page open; action and session are not registered. Both degrade with a structured install-hint error when the CLI is absent from PATH, never resolve an engine relative to the repo, and return a typed error object for a policy denial, a non-2xx fetch, or a paywall, never page text. Cap fetches per run and record every URL for the walk. These wrappers reuse the skills the webglass-code-lens-as-tools plan lands; if that plan has not merged, state the dependency in the PR.
- depends on: t2, t3
- covers: c7, h5, c38, h31
- acceptance:
  - with code-lens shimmed out of PATH the tool returns a structured install-hint error; with it present code-lens profile returns structured output
  - the registered tool list contains `web_search` and `web_page` and no tool that can submit a form or hold a session
  - a loopback target denied by webglass policy and a 403 fetch each return a typed error object with kind and detail and no page text

### t9 — Walk recorder and run record: keyed tool events with hashes and timestamps, redaction filter, run metrics, default export

- instruction: Add lib/walk.ts hooking `tool_call` and `tool_result`: append one entry per tool event to walk.jsonl in the session export dir with monotonic ids w1..wN, ISO timestamps, the arguments, and for reads the returned content plus its sha256; pass every entry through a redaction filter for known secret shapes before write; on session end append a run record with `duration_ms`, `tool_calls`, outcome, and truncated; the export always happens with no flag. Each entry maps 1:1 to a Pi event; never synthesize one.
- depends on: t2
- covers: c23, h17, c30, h24, c36, h29
- acceptance:
  - after a fixture run walk.jsonl exists with monotonic ids, every read entry carries a sha256, and every entry has a timestamp
  - a fixture bearer token read during the run appears redacted in walk.jsonl
  - the final entry carries `duration_ms`, `tool_calls`, outcome, and truncated, and a script aggregates ten such records into a latency and failure table

### t10 — Statements artifact, citation verifier, not-fully-read marker, and continue-from loader

- instruction: Add lib/statements.ts and lib/torch.ts: capture the final assistant message as statements.md and statements.json where each paragraph or list item carries an evidence list of walk ids it references (parse \[wN\] markers the AGENTS.md prompt asks the model to emit); entries with an empty evidence list render with an UNSUPPORTED marker; verify every path:N citation against the walk's recorded read ranges and mark unverifiable ones; set the not-fully-read marker exactly when a tool truncated its input (from walk truncated flags, never from the model); implement continue-from that loads a prior walk as the first context of a new session.
- depends on: t9
- covers: c25, h19, c31, h25
- acceptance:
  - a statement with no \[wN\] reference renders with an UNSUPPORTED marker; one with references carries them in statements.json evidence
  - given one correct and one wrong path:N citation the verifier accepts the first and flags the second
  - the not-fully-read marker is present exactly when a walk entry has truncated=true; continue-from starts a session whose first context contains the prior walk contents
  - a citation that resolves into a recorded read range is marked ENCOUNTERED, never SUPPORTED; a statement with no reference is marked UNREFERENCED

### t11 — Provider from environment and reasoning-off on the wire

- instruction: Add lib/provider.ts: at load, register a provider named associate via pi.registerProvider from `ASSOCIATE_BASE_URL`, `ASSOCIATE_API_KEY`, and `ASSOCIATE_MODEL` (default model id associate, default base URL the lobes gateway <http://localhost:8001/v1>) — no endpoint constant beyond that documented default; register a `before_provider_request` hook that disables reasoning for this provider (the concrete knob is unverified — try `chat_template_kwargs` `enable_thinking` false and `reasoning_effort` none; record which works against the fake server and the live lane). Never read ~/.pi/agent/models.json.
- depends on: t2
- covers: c14, h8, c28, h22
- acceptance:
  - with the three env vars set the provider resolves and pi --list-models shows it; with them unset the extension registers nothing and prints a hint naming the variables
  - git grep for the Orin host, port, or any bearer in tracked files returns nothing
  - a request captured against the fake server carries the reasoning-off field the hook injects; the live-lane check is recorded by the verification task

### t12 — Python 'associate run' verb: fail-closed launcher over pi -p / --mode json with export paths and continue-from

- instruction: Add associate/harness/pi.py implementing the adapter interface over 'pi --mode json --no-session' with `ASSOCIATE_CONTRACT_DIR` set, checking the startup tool list for `associate_ready` and raising a typed error naming the missing extension if absent; add associate/cli/`_commands`/run.py registering run (with --json, --harness defaulting to pi, --continue-from) that selects the adapter, exits 2 with remediation when the adapter fails closed, exits 1 listing adapters on an unknown --harness, passes the session export dir, and prints walk and statements paths on stdout; wire the four sync points (cli/`__init__.py`, explain/catalog.py, learn.py `_TEXT` and `_as_json_payload`). Subprocess only; no new dependency; no import of any pi package.
- depends on: t4, t9, t10, t16
- covers: c34, h26
- acceptance:
  - in a checkout where the extension does not load, associate run exits 2 with an error naming the missing extension and serves nothing; with it loaded the command prints both artifact paths
  - uv run teken cli doctor . --strict passes; explain associate run and learn mention the verb; pyproject dependencies stays \[\]
  - a pytest using tests/`fake_lane.py` drives associate run end to end and asserts walk.jsonl and statements.md exist
  - 'associate run --harness bogus' exits 1 listing available adapters; the pi adapter lives in associate/harness/pi.py and imports no pi package

### t13 — Runtime prompt AGENTS.md and the mesh cutover: culture.yaml backend acp with pi-acp `acp_command`, AGENTS.colleague.md retained

- instruction: Write AGENTS.md as the Pi runtime prompt for the associate lane (the lobes bound, the tool list, the \[wN\] evidence-marker convention for statements, handback via finish); set culture.yaml backend: acp with `acp_command` launching pi-acp; keep AGENTS.colleague.md in place this commit; make it one commit that git revert restores cleanly. Confirm with the installed pi that with AGENTS.md present CLAUDE.md is not injected.
- depends on: t2
- covers: c9, h6, c41, h34
- acceptance:
  - AGENTS.md exists and carries the lane prompt; uv run associate doctor and steward doctor backend-consistency pass with backend: acp
  - a captured pi system prompt contains AGENTS.md content and not CLAUDE.md content
  - git revert of the cutover commit restores backend: colleague and both doctors pass; AGENTS.colleague.md is still present after the cutover commit

### t14 — Docs: CLAUDE.md exact harness pins, README contract-plus-adapters shape and boundary, ledger rows for ported colleague guards, version bump

- instruction: CLAUDE.md Tooling prerequisites: exact pins pi 0.84.2 and pi-acp 0.0.33 as tested, Node >=22, the `ASSOCIATE_`\* variables, and the upgrade rule (bump the pin only after the bench passes); README: replace the not-yet-a-harness status with the boundary the operator set — associate is an opinionated Pi extension plus wrapper with a small portable contract (role and permission boundaries, task input and handback format, evidence artifacts, behavioral cases), everything else tailored to Pi and the model, a second harness only on measured benefit — the three audiences and their invocation paths, the lane boundary (reads, finds, summarizes, verifies; never edits, writes, or PRs) and the before state at the pre-change HEAD; docs/skill-sources.md: rows for lib/contain.ts ported from colleague `search_tools.py` and readpage.py with the drift note; bump the version. Docs only; no code.
- depends on: t3
- covers: c39, h32, c16, h10, c17, h11, c19, h13
- acceptance:
  - CLAUDE.md names the four floors and the `ASSOCIATE_`\* variables; markdownlint passes
  - README names the three audiences each with one invocation that works from a clean clone, states the boundary, and no longer says not yet a harness
  - docs/skill-sources.md carries the ported-guard rows with origin colleague and the note on what happens when colleague's version changes; pyproject version differs from main

### t15 — Verification on the live lane and a real culture server: success signals, package install, git cleanliness, evidence in the PR body

- instruction: Owns no source files. From a clean clone with `ASSOCIATE_`\* set: run 'associate bench --harness pi' and record its table; run the three c22 checks; run the issue #3 prompt three times and record wall time, the encounter-check rate, a reviewer's factual-support tally over a 10-statement sample against the source, the coverage checklist against issue #3's reference list, and the receiving-coder outcome (give cortex only the walk and statements and record whether it completes the follow-on change without re-reading files the walk contains); confirm reasoning-off on the wire from a captured live request; pi install the repo at the current tag in an unrelated directory and assert the associate tool list with no edit or write; culture start associate on a local server and answer one channel message through pi-acp, comparing pi-acp Limitations against the ACP features culture's runner uses; assert git status is clean in the examined checkout after every run. File one evidence record per obligation from these results. Record every number and transcript path in the PR body.
- depends on: t11, t12, t13, t14, t5, t6, t7, t8, t17
- covers: c1, h1, c18, h12, c22, h16, c27, h21, c26, h20, c15, h9, c45
- acceptance:
  - the PR body records: 0 write-capable tools and 10/10 blocked writes; the find-and-summarize wall time under 60 s; one mesh message answered; three issue #3 runs each under 5 min with an artifact path, 100% encounter-check rate, at least 90% factual support on the 10-statement sample, the coverage checklist, and the receiving-coder outcome
  - a captured live request shows reasoning disabled; pi install at the tag yields the associate tool list without edit or write; git status --porcelain is empty after each run
  - the receiving-coder re-run (cortex given only the walk and statements) is recorded as measured, whether or not it completed the follow-on change

## Risks

- [follow_up] t8's wrappers reuse the skills of the webglass-code-lens-as-tools plan (t1-t3 there), which is exported but not implemented; if it has not merged first, t8 must land the PATH wrappers itself and say so (task t8)
- [unknown_nonblocking] the reasoning-off knob on the wire is unverified (frame v6): `chat_template_kwargs` or `reasoning_effort` may or may not be honored by the served lane (task t11)
- [unknown_nonblocking] pi-acp's handling of session/`request_permission` and other ACP features culture's runner uses is unread (frame v7); the mesh path may need an adapter tweak upstream (task t15)
- [unknown_nonblocking] Node 22 type stripping for the extension tests needs Node 22.6+ flags or Node 23+; the CI runner version must be pinned accordingly (task t4)
- [unknown_nonblocking] t15 needs a bearer for the lobes gateway and a reachable Orin; without them the live numbers cannot be recorded and the PR stays draft (task t15)
- [unknown_nonblocking] both t5 and t7 override built-in tool names (read, bash); Pi warns in interactive mode — acceptable, but the sentinel check in t12 must not treat the warning as failure (task t12)
- [unknown_blocking] issue #5's colleague adapter: in or out of this milestone is pending the user's answer (frame question); if in, a t18 colleague adapter task is needed and the bench must run both configurations before t15 closes
- [follow_up] Qwen Code adapter is the deferred next harness (q6); the adapter interface in t16 must not assume pi-specific event shapes so that adapter can plug in without changing the contract or the bench (task t16)
- [unknown_nonblocking] the factual-support tally in t15 is a reviewer judgement against source lines; the bench (t17) may automate it only for fixture cases with known facts — never claim an automated support score on the issue #3 corpus (task t15)
