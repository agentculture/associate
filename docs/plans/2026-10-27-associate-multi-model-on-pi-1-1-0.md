# Build Plan — associate multi-model on Pi 1.1.0

slug: `associate-multi-model-on-pi-1-1-0` · status: `exported` · from frame: `associate-multi-model-on-pi-1-1-0`

> associate runs on Pi 1.1.0 with each fleet model aligned to its own tools — bolt (default, replacing Nemotron Lightning), senses (read-only) and cortex (qwen), with Nemotron 3.5 Super VL joining when it arrives — where cortex delegates to bolt/senses sub-agents, every mutating action passes a CLEF 27B decider safety check, the models recall and record through eidetic memory and the workledger ledger, and each model's fitness is measured on public tool-calling, vision and LiveCodeBench benchmarks rather than our own

## Tasks

### t1 — verify which model the mesh resident actually runs, and make culture.yaml's model reach it

- instruction: trace `culture_core` (config.py:536 onward) for where an ACP session's model is sent; pi-acp only calls setModel when the client requests a modelId (pi-acp dist/index.js:2800-2814). Read-only investigation first; if culture never sends it, propose the smallest associate-side fix (e.g. pi-acp/pi flags or a repo-local .pi setting) — no change to culture (c18)
- covers: h3
- acceptance:
  - a docs/notes file records, with file:line citations, how the resident's model is resolved today
  - after the fix, a culture start associate session reports model worker in its first pi event, verified live

### t2 — migrate the extension and harness from pi 0.84.2 to 1.1.0

- instruction: walk every Breaking Changes entry in the pi CHANGELOG between 0.84.2 and 1.1.0 (0.86.0 TranscriptContext + transcript-backed `before_agent_start`/tool changes, 0.87.0 shouldStopAfterTurn removal, 1.0.3 azure rename, JSON-only ToolCall.arguments, `user_bash` fail-closed); fix what bites; update the pin in associate/harness/pi.py, the 'Measured against' comment in index.ts, and CLAUDE.md Tooling prerequisites
- covers: c2, c23, h18, c56, h37
- acceptance:
  - bash .pi/extensions/associate/tests/run.sh passes on pi 1.1.0
  - uv run pytest -n auto passes; pi.py warns on any version other than 1.1.0
  - the PR body lists each breaking change with a verdict (harmless / fixed in file:line)

### t3 — workledger-cli: add append-only ledger verbs and land them by PR in that repo

- instruction: work in ../workledger-cli on its own branch; follow that repo's CLAUDE.md (agent-first CLI invariants, version bump, cicd PR). Verbs: append one entry (JSON in, --json out), list entries (filters, --json); append-only — no edit/delete verb
- covers: c39, h23
- acceptance:
  - workledger append and workledger list exist with --json, follow the four CLI invariants, and pass that repo's teken cli doctor --strict
  - a test proves an appended entry cannot be modified or removed through the CLI
  - the workledger-cli PR is merged and released before t13 starts

### t4 — contract: a per-model registry and the per-model policy

- instruction: add associate/contract/models.json (+ schema, + validate.py checks): entries worker (bolt, default), senses, cortex, super-vl (status pending). Fields: lobes role, input modalities, reasoning mode, allowed tool names, prompt file, `may_mutate`, `may_spawn` (list of models). Move the Lightning `text_only` note out of role.json. Extend policy.json's shell section with the eidetic and workledger argv shapes. Data only — no TypeScript in this task
- depends on: t2
- covers: c3, h4, c10
- acceptance:
  - validate.py rejects a models.json entry with an unknown field or a tool name not in the extension's registered set
  - senses has `may_mutate` false; worker and cortex true; only cortex has `may_spawn` \[worker, senses\]; super-vl is marked pending
  - role.json no longer claims `text_only`

### t5 — contract: the safety-gate question set and the walk schema fields

- instruction: add associate/contract/gate.json: versioned prebuilt CLEF questions (noul/choice), the decider domain, the CLEF threshold, the Super-tier rule and threshold, and the redaction keys. Extend schemas/walk.schema.json with a gate entry (tier clef|super|readonly, question-set version, probabilities or verdict, allow/refuse) and a child-walk link entry
- depends on: t2, t4
- covers: c32, h19
- acceptance:
  - gate.json validates against a schema checked by validate.py
  - a walk line with a gate entry and one with a child link both validate; one missing tier is rejected

### t6 — extension: providers from the registry, per-model reasoning

- instruction: lib/contract.ts loads models.json and gate.json; lib/provider.ts registers one provider entry per registry model (base URL/key from `ASSOCIATE_`\* env, model = lobes role), selected by `ASSOCIATE_MODEL`; delete the `nemotron_v3` `enable_thinking` hook and apply a model's reasoning setting only if its entry declares one
- depends on: t4, t5
- covers: h9, c11, h10
- acceptance:
  - provider.ts and contract.ts contain no model id, role name or endpoint literal (a test greps for them)
  - a provider test shows no `enable_thinking` override is sent for a model whose entry declares none

### t7 — python harness: associate run --model, provider args from the registry

- instruction: pi.py builds --provider/--model from models.json and sets `ASSOCIATE_MODEL` for the extension; run.py gains --model (default worker); update explain/catalog.py and learn.py so teken cli doctor --strict stays green
- depends on: t2, t4
- covers: c3
- acceptance:
  - uv run associate run --model senses passes the senses entry to pi (test with a fake pi)
  - an unknown --model exits 1 with a CliError naming the registry's models
  - uv run teken cli doctor . --strict passes

### t8 — eidetic tools: recall and pinned remember

- instruction: new tools/eidetic.ts shelling out via `_procs.ts`: `eidetic_recall` (declared non-writer, top-k/depth bounded, output capped at the policy budget) and `eidetic_remember` (always passes --scope associate and an explicit destination — never relies on cwd; records from web or untrusted-repo reads carry a provenance tag or are refused)
- depends on: t4
- covers: c20, h16, c53, h35
- acceptance:
  - with a fake eidetic on PATH: recall output never exceeds the budget; remember always receives --scope associate and an explicit destination
  - a remember issued while the session root is another repo writes nothing under that repo
  - a remember whose source is a `web_page` result is tagged untrusted (or refused) per gate.json/models.json policy

### t9 — drop the in-house behavioral suite

- instruction: delete tests/behavioral/, associate/bench/corpus.py, checks.py, replay.py and their tests; keep runner/config/table/walkstats and the stub harness only where the public-suite runner (t18) reuses them
- depends on: t2
- covers: c6
- acceptance:
  - no in-house case or check remains; uv run pytest and teken cli doctor --strict still pass

### t10 — extension: the safety gate library

- instruction: new lib/gate.ts: build the gate state from task, action, arguments and model id only (never tool results); redact per gate.json; ask CLEF at POST /v1/systemone with X-Lobes-Model `decider:<domain>` from gate.json; on unreachable ask Super through ctx.modelRegistry.stream with the same questions and a JSON answer; when both are unreachable allow only non-mutating calls; return a walk-ready gate entry. Pure library + tests; index.ts wiring is t12
- depends on: t6
- covers: c37, h21, c54, h36
- acceptance:
  - with a fake decider: an unsafe answer refuses, a safe answer allows, the entry carries tier clef
  - with the decider down and a fake Super: tier super is recorded; with both down a mutating call is refused and a read is allowed
  - a gate request built after a `web_page` result contains none of the page text

### t11 — extension: per-model prompts

- instruction: add one prompt file per registry model (bolt, senses, cortex, super-vl pending) next to the extension; lib/prompt.ts injects the active model's file. Each prompt names its own tools, the CLEF safety check, eidetic and workledger; cortex's names the spawn tool and when to hand perception/read-heavy work to senses and bounded execution to bolt. AGENTS.md stays the acp prompt file
- depends on: t6
- covers: c12, h11, c5, h6
- acceptance:
  - a test per model shows the injected prompt is that model's file
  - the cortex prompt names the spawn tool and both child models; the super-vl prompt is marked pending
  - associate doctor's backend-consistency check still passes

### t12 — extension: per-model tool sets, per-model guard, gate wiring

- instruction: index.ts: setActiveTools to the active model's allowed tools; guard.ts: senses keeps writers dropped and writes refused, worker/cortex may write; the `tool_call` hook runs lib/gate.ts on every mutating call and appends its entry to the walk
- depends on: t6, t10
- covers: c13, h12, c35, h20, c38, h22, c32, c4, h5
- acceptance:
  - per model, exactly its registered tools are active; a call outside the set is refused
  - senses write refused; bolt/cortex write executes only after a safe gate verdict (fake decider)
  - pure reads never call the decider

### t13 — extension: workledger tools

- instruction: new tools/ledger.ts: `workledger_append` and `workledger_list` shelling out via `_procs.ts` to verbs that exist in the released workledger-cli (t3)
- depends on: t3, t4
- covers: c7, h8
- acceptance:
  - with a fake workledger on PATH, append and list pass their argv and parse --json
  - the tools call no verb that does not exist in the released workledger-cli

### t14 — extension: image input for vision models

- instruction: tools/read.ts returns an image block for image files when the active model's entry declares image input, and refuses with a typed error otherwise
- depends on: t6
- covers: c14, h13
- acceptance:
  - for senses, worker and cortex an image file reaches the model as an image block; for a text-only entry it is refused

### t15 — python harness: worktree per mutating run, then merge to main

- instruction: new associate/harness/worktree.py: a run whose model may mutate creates a worktree under the repo-owned root (`dirname(repo)/.worktrees.<name>/`) on a scoped branch, runs pi there, and merges to main when the run finishes clean; removing the worktree before merge discards it. run.py calls it. Leave explain/catalog.py and learn.py text to t19 (t18 edits them in the same wave)
- depends on: t7
- covers: c51, h33
- acceptance:
  - a mutating run's writes exist only in its worktree until merge; removing it leaves main and the operator checkout unchanged
  - a clean run's branch is merged to main; a failed run is not merged

### t16 — extension: the cortex spawn tool

- instruction: new tools/spawn.ts modelled on pi's examples/extensions/subagent: only cortex has it (models.json `may_spawn`); children are bolt or senses only, launched as pi with this extension and `ASSOCIATE_MODEL` set, so each runs under its own model's guard; at most one writing child per checkout at a time (or a worktree each); senses children run in parallel; record each child walk path in the parent walk
- depends on: t12, t11
- covers: c40, h24, c52, h34
- acceptance:
  - spawning any model other than worker or senses is refused
  - a senses child cannot write; two writing bolt children never write the same tree concurrently
  - the parent walk references every child walk by path

### t17 — walkstats: gate-tier and read-only fallback rates

- instruction: extend associate/bench/walkstats.py to read the new gate entries: share of mutating calls by tier and count of read-only fallbacks
- depends on: t5
- covers: c57, h38
- acceptance:
  - over fixture walks, walkstats reports per-tier shares and the read-only fallback count

### t18 — public benchmark runner: BFCL, MMMU, LiveCodeBench, extensible

- instruction: `associate bench --suite <name> --model <registry-model>`: suites are data entries (name, version, upstream runner command, scorer, which models), so adding a public suite is a data addition (c49). Adapters call the suite's own upstream runner/scorer against the gateway; rows keep the existing config stamp plus suite name and version. No dataset or model is touched in CI. Do not edit associate/bench/walkstats.py (t17 owns it in the same wave)
- depends on: t9, t7, t4
- covers: c22, h17, h7
- acceptance:
  - bench --suite lists BFCL, MMMU and LiveCodeBench from data, and a test adds a fourth suite by data alone
  - with a fake upstream runner, a row carries suite, version, scorer and the config stamp
  - the tests CI job needs no network, dataset or model

### t19 — docs and identity: the multi-model associate

- instruction: rewrite CLAUDE.md (current state, runtime lane, tooling pins, `ASSOCIATE_`\* vars), AGENTS.md, README, culture.yaml (model: worker); fix the stale 'no pi adapter registered' lines; cite before-state and model-strength facts to files; version bump + CHANGELOG. Do not describe anything as working that t20/t21 have not measured
- depends on: t1, t11, t12, t13, t14, t15, t16, t17, t18, t8
- covers: c41, h25, c42, h26, c43, h27, c44, h28, c18, h14, c19, h15
- acceptance:
  - associate doctor and steward doctor pass; markdownlint and teken cli doctor --strict pass
  - grep for the Lightning checkpoint finds it only in CHANGELOG history
  - git diff main touches no file in lobes-cli or colleague; pyproject dependencies is \[\] and package.json has no dependencies

### t20 — live acceptance runs on pi 1.1.0

- instruction: operator-side, not CI: one live run each for worker, senses, cortex; a culture start associate session through pi-acp; a fault-injected run with the decider and Super pointed at dead ports; a cortex run that spawns both a bolt and a senses child. Record walks and counts in a delivery evidence doc
- depends on: t19
- covers: c1, h2, c45, h29, c47, h31, c48, h32
- acceptance:
  - each of worker, senses and cortex has a recorded live walk on pi 1.1.0
  - counts recorded: 100% senses mutating attempts refused; 0 bolt/cortex mutating calls without a gate verdict; 0 mutating calls in the fault-injected run while reads succeed
  - a cortex parent walk references one bolt and one senses child walk that exist

### t21 — run the public benchmark matrix

- instruction: operator-side: BFCL for worker, senses, cortex; MMMU for worker, senses, cortex; LiveCodeBench for worker and cortex. Commit a results doc under docs/ with the 8 rows; a row that could not run is listed as missing with why, never omitted
- depends on: t18, t20
- covers: c46, h30, c6
- acceptance:
  - the results doc has exactly the 8 named rows, each with suite, version, upstream scorer and config stamp

## Risks

- [unknown_nonblocking] the bolt lane (lobes worker) is marked 'configured, no live boot' in the lobes catalog (v3) — t20/t21 cannot run until the operator confirms it is served (task t20)
- [unknown_nonblocking] the Orin must be switched to the orin-decider shape to serve CLEF (user decision v7) — a lobes deployment outside this repo; t20's gate counts need it live (task t20)
- [unknown_nonblocking] LiveCodeBench executes generated code and every suite downloads datasets — t21 needs an operator-side sandbox and network; none of it may enter CI (task t21)
- [unknown_nonblocking] q17 + q21: any mesh peer can trigger any command, and the CLEF gate is the only control (q22, accepted) — t12 and t16 are the security-critical tasks; review them as such (task t12)
- [unknown_nonblocking] senses' checkpoint differs between embodiment (Gemma 4 26B A4B) and lobes profiles (12B) (v6) — t21's row stamps must record the served checkpoint, not assume one (task t21)
- [follow_up] Super VL is deferred (v5): its registry entry and prompt land as pending in t4/t11, and its spawn duty in c5/h6 is pending until lobes serves it (task t11)
