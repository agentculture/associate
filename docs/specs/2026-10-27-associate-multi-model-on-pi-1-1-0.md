# associate multi-model on Pi 1.1.0

> associate runs on Pi 1.1.0 with each fleet model aligned to its own tools — bolt (default, replacing Nemotron Lightning), senses (read-only) and cortex (qwen), with Nemotron 3.5 Super VL joining when it arrives — where cortex delegates to bolt/senses sub-agents, every mutating action passes a CLEF 27B decider safety check, the models recall and record through eidetic memory and the workledger ledger, and each model's fitness is measured on public tool-calling, vision and LiveCodeBench benchmarks rather than our own

## Audience

- the operator running associate on the mesh and headless, and the mesh peers (colleague and others) that hand associate read/summarize/find and now execution work
  - instruction: check the exported spec names both the operator and mesh peers

## Before → After

- Before: associate is bound to one model (Nemotron 3.5 Lightning via the lobes associate role) on pi 0.84.2, never changes anything, has no memory, ledger, decider or sub-agent tools, and is measured only by a 7-case in-house suite whose last live run passed 1/7
  - instruction: cite provider.ts:52, pi.py:57, guard.ts, delivery doc r26
- After: an operator picks bolt, senses or cortex for an associate run on Pi 1.1.0; each model gets its own tools and prompt, cortex delegates to bolt/senses sub-agents, every mutating action is safety-checked by CLEF (falling back to Super, then read-only), memory and ledger entries go through eidetic-cli and workledger-cli, and each model has published public-benchmark scores
  - instruction: a live run per model, plus the benchmark matrix in a committed results doc

## Why it matters

- the fleet already serves models with different strengths (vision on senses, execution on bolt, reasoning on cortex) but associate can use none of them, and its quality claims rest on our own tests instead of numbers comparable to the wider field

## Requirements

- associate is pi.dev (Pi) based
  - instruction: bump the pin to 1.1.0 (c23), run the extension tests on 1.1.0, then a live associate run and a culture start associate launch through pi-acp
  - honesty: both entry points run the installed pi 1.1.0: associate run (pi -p) and culture start associate (pi-acp -> pi --mode rpc); no other agent runtime is launched
- associate supports all existing models — senses, bolt, qwen (cortex) and the coming Nemotron 3.5 Super VL — each aligned to its own tools
  - instruction: add a models registry to associate/contract/ with entries for worker (bolt), senses, cortex and a pending super-vl; associate run gains --model selecting an entry
  - honesty: every model the contract registry lists is addressed by lobes role name through the gateway, and its tool set and prompt come from its own registry entry; Super VL is listed as pending, not as working
- CLEF 27B is supported through the decider models, and the models are instructed to use it
  - instruction: implement the safety gate (c32/c37) in the `tool_call` hook and name it in each model's prompt
  - honesty: the CLEF decider is called on the live path for mutating actions and every model's prompt names the safety check; a test with a fake decider shows a refusal blocks the call
- qwen (cortex) and Super are both instructed to use sub-agents of bolt / senses
  - instruction: add the spawn tool (c40) and the cortex prompt section; Super's lands with v5
  - honesty: cortex's prompt names the bolt/senses spawn tool and when to use it; Super's prompt does the same when Super lands (v5) — until then it is recorded as pending
- everything is benchmarked with known public benchmarks, not our own
  - instruction: adopt the public suites (c27) and delete tests/behavioral and the in-house checks (c28)
  - honesty: every number associate reports as a benchmark comes from a public suite's own scorer and published task set, with the suite version recorded; no in-house case is reported as a benchmark
- the models have tools for memory (eidetic) and evidence tracking (the ledger)
  - instruction: register eidetic tools (c20) and workledger tools (c39) in .pi/extensions/associate/tools/
  - honesty: eidetic remember/recall and workledger append/list are registered tools in the extension, each tested against a fake CLI on PATH
- the single hardcoded 'associate' provider becomes a per-model registry owned by the portable contract (associate/contract/), each entry naming lobes role, input modalities, reasoning mode, allowed tools and prompt file; Pi and the Python adapter both read it, neither hardcodes it
  - honesty: provider.ts and pi.py contain no model id, role name or endpoint literal; adding a model is a contract registry edit only
- reasoning mode is a per-model registry setting, not a global hook: the `nemotron_v3` `enable_thinking`=false injection is removed with the Lightning lane, and each model (bolt, senses, cortex) runs with the reasoning mode its entry declares
  - honesty: no request is sent with an `enable_thinking` override unless that model's registry entry asks for one
- the runtime prompt is selected per model (e.g. one prompt file per aligned model) so each model is told its own tools, its sub-agents and when to consult the decider
  - honesty: each registry model has its own prompt file, the acp backend-consistency invariant still passes (AGENTS.md present), and a test shows the prompt injected matches the active model
- each model gets an aligned tool set enforced by the tool surface (pi.setActiveTools / --tools), not by prompt instruction alone
  - honesty: a test starting the extension per model shows exactly that model's registered tool names active, and a call to a tool outside the set is refused
- image input is supported for the vision-capable models (senses, bolt/worker, cortex; Super VL when it arrives) and the contract stops claiming text-only for them
  - honesty: an image file read by senses, bolt or cortex reaches the model as an image block, and role.json no longer carries the `text_only` note for them
- eidetic tools shell out to eidetic-cli: recall is registered as a declared non-writer, bounded by top-k/depth and the per-tool output budget in policy.json; remember is available to every model (senses included, c35) and lands wherever eidetic-cli's own scope/visibility rules put it, under the agent's scope
  - honesty: the recall tool's output never exceeds the policy.json budget, and remember is invoked through eidetic-cli with the agent's scope — no file under .eidetic/ is written by associate code directly
- associate bench gains public-benchmark adapters selected per model alignment, and every result row keeps the existing config stamp (model role, served checkpoint, pi version, extension version, reasoning mode)
  - honesty: bench rows carry the existing config stamp fields plus suite name, suite version and model role; the bench verb still follows the four CLI invariants and teken cli doctor --strict passes
- the extension, harness and docs move from the pi 0.84.2 pin to the installed 1.1.0 and the pin is updated in CLAUDE.md Tooling prerequisites
  - honesty: the pin in CLAUDE.md, pi.py and index.ts reads 1.1.0, the extension's tests pass against pi 1.1.0, and a live associate run on 1.1.0 completes
- a pre-action safety gate in the extension's `tool_call` hook posts a fixed, versioned question set (kept in associate/contract/, not in TypeScript) to /v1/systemone for every mutating tool call and blocks the call when the decider's answer falls below a contract-set threshold; the gate's probabilities and verdict land in the walk
  - honesty: the question set and threshold are read from associate/contract/ (no literal in TypeScript), redaction runs before the post, and every gated call's walk entry carries the tier and verdict
- senses gets a read-only tool set — read, find/grep/ls, web search/page, eidetic recall, image reading — plus eidetic remember (memory, not repo); no file write, edit, or mutating shell, enforced by the per-model guard
  - instruction: senses' registry entry lists only read, find, grep, ls, `web_search`, `web_page`, `eidetic_recall`, `eidetic_remember`, image read and finish; guard keeps writers dropped for senses
  - honesty: with senses active, write/edit tools are absent and a mutating shell command is refused, while read, search, web, recall, remember and image read succeed
- the gate checks every call the per-model guard classifies as mutating — write/edit tools and any shell command outside the read-only allowlist in policy.json — and never checks pure reads; the Super fallback asks the same contract-held question set through chat with a structured (JSON) answer, and the walk records which tier answered (clef / super / readonly-fallback)
  - honesty: pure reads never trigger a decider call; with CLEF down the Super tier answers and is recorded; with both down a mutating call is refused and a read succeeds
- the write guard becomes per-model: senses keeps today's block (writers dropped, writes outside scratch refused), while bolt and cortex may write and edit in the checkout, each mutating call first passing the safety gate (c32/c37)
  - instruction: guard.ts/index.ts read the active model's entry from the contract registry; test: a senses write is refused, a bolt write with a fake decider answering safe executes, a bolt write with the decider answering unsafe is refused
  - honesty: the guard tests cover all three models: senses write refused, bolt/cortex write executes only after a safe gate verdict
- workledger-cli gains the ledger verbs associate needs (append an entry, list entries, --json, append-only) by PR in that repo, and associate registers workledger tools that shell out to it with the same contract-held argv rules as the other CLIs
  - instruction: PR in workledger-cli first; then a tools/ledger.ts in associate; test with a fake workledger on PATH
  - honesty: the workledger PR is merged before associate's ledger tools land, and associate's tools call only verbs that exist in the released workledger-cli
- cortex's prompt instructs it to hand perception and read-heavy sub-tasks to senses sub-agents and bounded execution sub-tasks to bolt sub-agents, through a spawn tool limited to those two models; a child inherits the per-model guard of the model it runs
  - instruction: test the spawn tool refuses any model other than bolt/senses and that a senses child cannot write
  - honesty: the spawn tool refuses any model other than bolt or senses, a child runs under its own model's guard, and the child walk path is recorded in the parent walk
- the repo's identity docs describe the multi-model associate: CLAUDE.md (runtime lane, current state, tooling pins), AGENTS.md, culture.yaml model: worker, README — and the stale 'no pi adapter registered' lines (CLAUDE.md:50, :457) are corrected
  - instruction: uv run associate doctor and steward doctor both pass; grep for Lightning/Nemotron-3.5-Lightning returns only CHANGELOG history
  - honesty: associate doctor and steward doctor pass, and CLAUDE.md no longer says no pi adapter is registered or that Lightning is the lane

## Honesty conditions

- a live run of each of bolt, senses and cortex on pi 1.1.0 exists, and the 8-row benchmark matrix is committed — the announcement is not made on the stub or a fake lane
- the diff of this work touches no file in lobes-cli or colleague; the only sibling repo changed is workledger-cli (c33)
- pyproject dependencies = \[\] and no package.json dependencies after the change; the tests CI job passes with no lane, decider, Super, network or benchmark dataset
- results come from the upstream suite's own scorer and published task set, unmodified, with the release/version recorded per row — no re-weighted or hand-picked subset reported as the benchmark
- the spec's reader list matches who actually invokes associate today: the operator (associate run, culture start) and mesh peers over IRC
- each before-state fact is cited to a file or doc in this repo (provider.ts:52, pi.py:57, guard.ts, the 2026-09-12 delivery doc r26)
- the fleet's model strengths are cited to lobes roles.py responsibilities, not asserted
- each after-state clause maps to a requirement with its own honesty condition (c10-c14, c20, c32, c38-c40)
- the results doc has exactly the 8 rows named, each with suite, version, scorer and config stamp; a missing row blocks the success claim
- the counts come from recorded walks, and the fault-injected run actually points the decider and Super at unreachable endpoints
- the parent and both child walk files exist and the parent walk references both by path

## Success signals

- the benchmark matrix is complete: 8 recorded public-benchmark rows — tool calling for bolt, senses and cortex (3), vision for bolt, senses and cortex (3), LiveCodeBench for bolt and cortex (2) — each with suite name and version, upstream scorer, and the config stamp
  - instruction: a committed results doc under docs/ lists all 8 rows; missing rows are listed as missing, never omitted
- live safety behaviour: 100% of senses mutating attempts refused; 0 bolt/cortex mutating calls execute without a recorded gate verdict; with CLEF and Super both unreachable, 0 mutating calls execute and read-only calls still succeed
  - instruction: record the counts from live runs and a fault-injected run (decider endpoint pointed at a dead port) in the delivery doc
- at least 1 live cortex run delegates to both a bolt and a senses sub-agent, with each child walk linked from the parent walk
  - instruction: attach the parent walk.jsonl path and the two child walk paths to the evidence record

## Scope / boundaries

- lobes roles.py, colleague's tool loop and the gateway are consumed as they are — no role is added or changed in lobes by this work; models are addressed by lobes role name through the gateway and endpoints stay configuration, not code
- pyproject dependencies stay \[\] and the extension adds no npm dependency; CI never needs a live lane, decider, sub-agent model or benchmark download — those paths use fakes or skip with a reason

## Assumptions

- 'bolt' is not a lobes role: it is the user-level Pi provider 'bolt' pointing at lobes role 'worker' (nvidia/Qwen3.6-35B-A3B-NVFP4, image+video, tool parser `qwen3_coder`) on the local gateway; associate addresses it as role 'worker'
- CLEF 27B is a decider, not a chat model: it answers only POST /v1/systemone (header X-Lobes-Model: `decider:<domain>`, default general) with calibrated probabilities over caller-defined options, never text or `tool_calls` — so associate uses it as the pre-action safety gate (c31/c32), not as a model: entry

## Scope exploration

- `s1` — `lobes-cli/lobes/roles.py + catalog.py; user-level Pi models.json (outside repo)`: no role named bolt in roles.py:113-146 or anywhere in lobes-cli/colleague/associate; Pi models.json provider 'bolt' -> model 'worker' at the local gateway, input \[text,image\], and it is the Pi default provider; lobes catalog.py:1136 still marks worker 'configured' (no live boot)
  - seeds: `c9`
- `s2` — `.pi/extensions/associate/lib/provider.ts; associate/harness/pi.py; associate/contract/role.json`: provider.ts:52 hardcodes `ASSOCIATE_PROVIDER_ID`='associate' and emits one model entry (input text only, 131072 ctx); pi.py `_provider_arguments` (:671-687) hardcodes --provider associate; run.py has no --model/--role flag; role.json and policy.json have no model dimension
  - seeds: `c10`
- `s3` — `.pi/extensions/associate/lib/provider.ts before_provider_request`: provider.ts:234-248 injects `chat_template_kwargs`.`enable_thinking`=false via applyReasoningOff for the one provider — tuned for `nemotron_v3`; lobes compose gives cortex the `qwen3_coder_thinking` parser (templates/fleet/docker-compose.yml:255-256)
  - seeds: `c11`
- `s4` — `AGENTS.md; .pi/extensions/associate/lib/prompt.ts`: AGENTS.md is hard single-role ('You run the lobes associate role', fixed toolset 'That is the whole set'); prompt.ts:56-67 reads only `<checkout>/AGENTS.md`; culture backend-consistency maps acp -> AGENTS.md, so per-model files must not break that invariant
  - seeds: `c12`
- `s5` — `.pi/extensions/associate/index.ts; lib/runtime.ts`: tools are global per process (runtime.ts:388-405 loads every tools/\*.ts); index.ts:252-258 already calls pi.setActiveTools to drop writers, so a per-model filter is a new hook on an existing mechanism; role.json notes say capabilities are 'made true by the tool surface and policy.json, not by prompt instruction'
  - seeds: `c13`
- `s6` — `associate/contract/role.json; .pi/extensions/associate/tools/read.ts`: role.json notes.`text_only` says no `image_understanding` is claimed; no image/vision tool exists in tools/ or lib/; Pi 1.1.0 built-in read returns image blocks but associate overrides read with its own tools/read.ts (image handling unverified); lobes gives cortex, senses, worker image+video
  - seeds: `c14`
- `s7` — `Pi 1.1.0 package: README.md:19, examples/extensions/subagent/index.ts`: Pi core 'skips features like sub-agents' (README:19) but ships a first-party subagent example: spawns pi per agent with --model (index.ts:303) and --tools (index.ts:307), single/parallel(max 8, 4 concurrent)/chain modes, agents as markdown with name/description/tools/model frontmatter; colleague already precedents child agents on cortex (colleague CLAUDE.md:155-159)
  - seeds: `c15`
- `s8` — `lobes-cli docs/decider.md, roles.py:126-127/222/274, catalog.py:1408; assess skill (user-level skills dir)`: decider role is path-routed to /v1/systemone and excluded from chat member lanes (roles.py:274); default checkpoint culture-dev/clef-27b-GPTQ-W4A16-g64 on the Orin (orin-decider shape, DECLARED/UNVALIDATED per lobes #108); question types choice/noul/score, text-only, 16384-token window; the assess skill is the existing client pattern
  - seeds: `c16`
- `s9` — `docs/specs/2026-09-12-associate-on-pi-with-opinionated-tools.md:132; associate/contract/role.json`: spec line 132: the tool surface honors lobes roles.py exactly, forbidden `final_decision`, `security_decision`, `code_authoring`, `repo_action`
  - seeds: `c17` (rejected)
- `s10` — `docs/specs/2026-09-12-...:142 and :204; culture.yaml`: spec non-goal line 142 says lobes' role registry and colleague's tool loop are not modified; :204 endpoint is configuration; culture.yaml comments: model: is a lobes ROLE name, never a checkpoint id; lobes roles.py:101-111 says adding a role is effectively irreversible
  - seeds: `c18`
- `s11` — `pyproject.toml; docs/specs/2026-09-12-...:93,:136-137`: spec: dependencies = \[\] deliberate (CLAUDE.md 'What not to invent'); spec line 137 'CI never needs the lane or Node 22'; tests/`fake_lane.py` is the existing fake
  - seeds: `c19`
- `s12` — `eidetic-cli 0.13.0 (eidetic recall --help); .claude/skills/recall`: recall supports --json, modes exact/approximate/keyword/hybrid, --top-k/--depth/--max-nodes; it is a side-effecting read (bumps `last_recall` and `recall_count`); no eidetic tool exists in .pi/extensions/associate/tools/; eidetic is not on policy.json shell.allowlist
  - seeds: `c20`
- `s13` — `.pi/extensions/associate/lib/guard.ts; .claude/skills/remember/scripts/remember.sh`: guard.ts blocks a writer tool with no path or a path outside scratchDir ('associate role is forbidden `repo_action`'); remember.sh defaults --visibility public, which resolves to `<repo-root>/.eidetic/memory` (committed) — the SKILL.md private-default text is stale (CLAUDE.md flags it)
  - seeds: `q1` (question, resolved)
- `s14` — `devague 0.24.2 evidence --help; git log 39f939b; workledger-cli`: devague evidence files obligation-linked records (type, strength, basis, outcome, run commit) and mutates .devague/; --confirm/--reject are user-only; evidence --list and summary are read-only; workledger-cli is still a cloned template with only introspection verbs and no ledger verbs; colleague's .colleague/ledger is an unrelated task ledger
  - seeds: `c21` (rejected)
- `s15` — `associate/contract/policy.json`: shell.allowlist is argv-only rg/fd/ls/cat/head/tail/wc/git read verbs/code-lens/webglass — neither eidetic nor devague is allowed; export policy is `outside_examined_checkout`, `git_ignored`, `session_scoped`
  - seeds: `q2` (question, resolved)
- `s16` — `associate/bench/*; associate/cli/_commands/bench.py; tests/behavioral/cases`: bench is fully in-house: 7 synthetic fixture cases (read-find, repo exploration, summarization, evidence extraction, tool-call reliability, forbidden mutation, bounded hand-back) with deterministic checks over walk.jsonl/statements.json; config.py stamps each row; results go only to stdout (no history store); no --model flag
  - seeds: `c22`
- `s17` — `lobes-cli, colleague (grep bfcl/tau-bench/gaia/mmmu/lm-eval/inspect_ai/ruler/longbench/hotpot/swe-bench/mmlu/humaneval/gsm8k)`: no public benchmark harness anywhere in the fleet; lobes 'benchmark' is throughput/latency (benchmark.py:1-30) and an in-house cat soft-score; delivery doc measured the live config at 1/7 on the in-house suite (r26)
  - seeds: `c22`
- `s18` — `CLAUDE.md upgrade rule (Tooling prerequisites)`: rule: bump a pin only after associate bench passes against the new version; that gate is today the in-house suite, which this idea retires as the benchmark
  - seeds: `q4` (question, resolved)
- `s19` — `associate/harness/pi.py:57; .pi/extensions/associate/index.ts:109; installed pi --version`: installed pi is 1.1.0; pi.py pins 'exactly at the tested 0.84.2' and warns on mismatch; index.ts says 'Measured against pi 0.84.2'; pi.py:13 notes 0.84.2 has no --list-tools (1.1.0 may); the extension has not been run on 1.1.0
  - seeds: `c23`
- `s20` — `lobes-cli/lobes/roles.py:325-572`: responsibilities differ sharply: cortex forbids nothing and holds `final_authority`; worker may act on the repo; senses forbids `final_decision`/`repo_action`/`security_decision`; associate forbids `code_authoring`+`repo_action` too; decider is /v1/systemone only
  - seeds: `q6` (question, resolved)
- `s21` — `CLAUDE.md 'The runtime lane'; associate/contract/role.json; .pi/extensions/associate/lib/guard.ts; AGENTS.md`: the repo's whole identity is 'worker MINUS `repo_action`' — role.json forbidden set, guard.ts (blocks writers outside scratch), dropWriters in index.ts:252-258, AGENTS.md and CLAUDE.md all encode it; decision c24 turns this into a per-model guard where only senses keeps the block
  - seeds: `q7` (question, resolved), `q8` (question, resolved)
- `s22` — `workledger-cli README CLI table; which workledger`: README pitch is append-only ledger entries proving what agents did, but no ledger verb is implemented; binary not on PATH (only uv run workledger-cli)
  - seeds: `q9` (question, resolved)
- `s23` — `associate/bench/{corpus,checks,replay}.py; tests/behavioral; CLAUDE.md bench + upgrade-rule lines`: dropping the suite removes corpus/checks/replay, the 7 cases, the stub-harness bench path, and rewrites CLAUDE.md's bench docs and the 'bump only after bench passes' upgrade rule (now superseded by c29)
  - seeds: `c28`
- `s24` — `culture.yaml; CLAUDE.md 'The runtime lane'; associate/contract/role.json; provider.ts reasoning-off`: culture.yaml model: associate and the CLAUDE.md runtime-lane section describe the Lightning lane on the Orin (role associate); role.json is sourced from lobes `ROLE_RESPONSIBILITIES`\['associate'\]; provider.ts reasoning-off is `nemotron_v3`-specific — all re-point to worker (bolt) or go
  - seeds: `c30`
- `s25` — `.pi/extensions/associate/index.ts tool_call handler (:214-231); lobes docs/decider.md; assess skill`: the `tool_call` hook already intercepts every call for the write guard, so it is the natural seam; decider questions are typed choice/noul/score, text-only, 16384-token window, ~1-2s per call, deterministic; the assess skill warns state is mesh-forwarded, so redaction must run before the post
  - seeds: `c32`
- `s26` — `../embodiment CLAUDE.md; embodiment/tools.py:303-324; embodiment/daemon/app.py:3457; docs/deliveries/2026-10-23-gwen-is-pocketchat-transcripts-as-knowledge.md:63; docs/plans/next-cycle-candidates.md:153`: Gwen's speaker is the senses role and the daemon binds a live tool registry to it (remember, forget, `search_library`, `read_passage`, `read_item`, `fetch_source`, `search_conversations`, `list_todos`, `set_todo_done`) via seam(messages, tools=...); measured: direct senses probe 2/2 tool calls (2026-10-24), and senses (Gemma-4-12B) 2.85s `tool_calls`=1 finish=`tool_calls`; live vision records in docs/live-test-results/senses-vision.md
  - seeds: `c34`, `c35`

## Decisions

- upgrade the Pi pin to 1.1.0
- sub-agents are spawned the way Pi's first-party examples/extensions/subagent does it — a child pi process per sub-agent with its own --model and --tools — and every child loads the associate extension so the write guard, walk and hand-back still apply, with the child walk linked into the parent walk
- only senses is not allowed to change things; every other model (bolt/worker, cortex/qwen, Super VL) may change the repo
- memory goes through eidetic-cli (eidetic remember / recall), not a bespoke store
- the ledger is workledger-cli
- public benchmarks cover three areas: tool calling, vision, and LiveCodeBench
- drop the in-house behavioral suite (tests/behavioral cases 01-07 and their checks)
- the Pi 1.1.0 upgrade has no bench gate: get it working on 1.1.0, then benchmark
- Nemotron 3.5 Lightning is out; bolt (lobes role worker) replaces it as associate's default model
- action safety is checked by CLEF with prebuilt questions: before an action, the harness asks the decider a fixed question set to make sure the action is safe
- build the needed ledger verbs in workledger-cli and land them there by PR
- senses uses tools — the embodiment repo is the evidence; it is not parked
- safety-gate fallback chain: CLEF decider first; when CLEF is unreachable, ask Super; when Super is also unreachable, allow read-only actions only
- the benchmark suites are BFCL (tool calling), MMMU (vision) and LiveCodeBench, and the bench must accept more public suites in future — adding a suite is a data/config addition, not a rewrite

## Hard questions

- does each model run under associate's contract (worker minus `repo_action`), or under its own lobes role's responsibilities? cortex has no forbidden set in lobes and worker may act on the repo — 'aligned to their tools' could mean either (resolved: user: only senses is forbidden to change; the other models may change — the write guard becomes per-model (c24))
- where may a model's eidetic remember write? Its public default lands in `<checkout>/.eidetic/memory` — exactly what guard.ts blocks and `repo_action` forbids. Options: (a) private store only, (b) `EIDETIC_DATA_DIR` pointed at the session export dir and promoted by the operator, (c) the model proposes records via finish and the harness/operator runs remember (resolved: user: via eidetic-cli (c25) — remember and recall shell out to the eidetic CLI and its own destination rules)
- which public benchmarks per model? (e.g. BFCL for tool calling, a long-context retrieval suite for read/find, MMMU-style for the vision models, an agentic suite like tau-bench/GAIA for cortex/Super delegation) — and do we adopt an existing runner or write adapters? (resolved: user: tool calling, vision, LiveCodeBench (c27))
- what happens to the in-house suite? Cases 06 (forbidden mutation) and 07 (bounded hand-back) and the citation checks have no public equivalent — drop them, or keep them as a safety gate that is not reported as a benchmark? (resolved: user: drop it (c28))
- the upgrade rule says bump only after bench passes on the new version: is the 1.1.0 bump gated on the existing in-house bench (now), or on the new public-benchmark run (later)? (resolved: user: nothing gates the bump — get it working, then benchmark (c29))
- the Nemotron 3.5 Lightning lane (lobes role 'associate', forbidden `repo_action` + `code_authoring` in lobes roles.py:554-559) is not in your model list — does it stay as a model here, and if so is it allowed to change like the others or does it keep lobes' restriction? (resolved: user: Lightning is out, bolt replaces it (c30))
- with repo changes allowed for all but senses, do `final_decision` and `security_decision` stay forbidden for every model (claim c17), or only where lobes forbids them (cortex holds `final_authority` in lobes roles.py:326-353)? (resolved: user: CLEF with prebuilt questions makes sure actions are safe (c31))
- workledger-cli today has only introspection verbs (whoami/learn/explain/overview/doctor/cli overview) and no ledger verbs, and its binary is not on PATH — does this work include building workledger's append/list verbs in the workledger-cli repo, or wait for them to land there first? (resolved: user: yes — add what is needed in workledger-cli and PR it (c33))
- which concrete suites: is tool calling BFCL (v3/v4) and vision MMMU (or MMMU-Pro / another)? LiveCodeBench is a code-generation benchmark — which models run it (all that may change code, i.e. not senses)? (resolved: user: tool calling is BFCL, vision is MMMU; LiveCodeBench as named)
- risk: LiveCodeBench grades by executing generated code and the suites download datasets — both need a sandbox and network, which the CI boundary (c19) keeps out of CI; benchmark runs are operator-side only
- risk: dropping the suite also drops associate bench's only end-to-end refusal check (case 06); senses' no-change rule then rests on the guard unit tests (guard.test.ts) — a guard regression would not show up in any benchmark
- when the decider is unreachable (lobes returns 503 `backend_unavailable` or 404 `role_infeasible`) — fail closed (block the action) or fail open? And which tool calls are 'actions': writes and edits only, or every shell command too? (resolved: user: CLEF -> Super -> read-only (c36))
- risk: the orin-decider shape is DECLARED/UNVALIDATED per lobes #108 and the decider never co-resides with a heavy lobe on the Orin — gate latency and availability are unmeasured
- risk: until Super VL arrives (v5), the chain is effectively CLEF -> read-only: any CLEF outage makes bolt and cortex read-only
- risk: Super answering a safety question by chat is a generator judging, not a calibrated scorer — its answers are not comparable to CLEF's probabilities, so the threshold for the Super tier needs its own definition

## Open parks

- [unknown_nonblocking] lobes catalog.py:1136 marks worker (bolt) 'configured', no live boot, yet the user-level Pi config defaults to it — whether the bolt lane is actually served today is unverified
- [unknown_nonblocking] embodiment's progress doc names senses as Gemma 4 26B A4B (docs/plans/2026-09-21-realtime-embodiment-app-progress.md:173) while lobes profiles/builtin/spark.toml:69 and next-cycle-candidates.md:153 name gemma-4-12B — which checkpoint serves senses on which box is unverified; associate addresses the role, so it only matters for benchmark row stamps
- [follow_up] CLAUDE.md:50 and :457 still say no pi adapter is registered, but associate/harness/pi.py is registered (harness/`__init__.py`:38-40) — stale doc
- [follow_up] Nemotron 3.5 Super VL joins once lobes serves it — the models config, prompt and sub-agent wiring for Super land in a follow-up

## Resolved vagueness

- [unknown_blocking] Nemotron 3.5 Super VL is not in lobes' catalog, roles or shapes — lobes spec 2026-10-17-vllm-0-31-0-fleet.md:81 defers it to its own frame; a standalone endpoint exists only in the user-level Pi models.json (nvidia/nemotron-3.5-super-vl-120b-a12b, a separate local port, reasoning on). Its lobes role name, host and tool parser are unknown, and the no-lobes-change boundary means associate cannot address it by role until lobes adds it — resolved: user: Super VL waits for the model to arrive (lobes to serve it); out of this work's scope until then
- [unknown_blocking] senses (gemma-4-12B) advertises tools:true but has no `tool_use` responsibility in lobes (docs/colleague-stack.md:214,541-559) — what a 'senses-aligned tool set' is (perception-only? image read + describe?) is undecided — resolved: user: senses uses tools, per ../embodiment (Gwen runs senses with a live tool registry; measured tool calls) — read-only tool set plus memory (c35)
