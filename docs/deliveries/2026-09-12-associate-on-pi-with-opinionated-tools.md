# Delivery Summary — associate on Pi with opinionated tools

plan: `associate-on-pi-with-opinionated-tools` · run: `partial` · date: `2026-09-12`
baseline: `devague summary skeleton`

## Intent

> associate ships as a Pi-based agent on Nemotron 3.5 Lightning: pi (pi.dev) drives the lobes associate lane with a project extension that registers opinionated read/find/summarize/web tools, a structurally restricted toolset (no edit/write into any checkout), and precision aids where the model is weak

After: associate runs as pi on the lobes associate role: a tracked .pi/ project config plus extension registers the opinionated tools, edit/write are structurally absent, the endpoint is pure configuration, culture launches it through pi-acp as backend: acp, and AGENTS.md is the runtime prompt; the CLI keeps its afi contract and gains a verb that drives pi headlessly

## Planned Work

- `t1` — Track the Pi project config and package manifest: .pi/settings.json, package.json (pi key), .gitignore entries
- `t2` — Extension core: loader, sentinel tool, finish/handback tool, write-guard hook, session-keyed scratch and export dirs
- `t3` — Containment library ported from colleague: confine, pattern-escape refusal, output budget with spill, denylist, schema validation, continuation cursors
- `t4` — Test harness for the extension and CI job independent of the lane: node --test for the extension, fake OpenAI-compatible server for the Python side, tests.yml job
- `t5` — Bounded read tool with absolute line numbers, byte cap, continuation cursor, and denylist
- `t6` — find, grep, and ls tools over Pi's vendored rg and fd with result caps
- `t7` — Shell tool override: same-named bash tool that spawns an argv allowlist with no shell and refuses mutating commands
- `t8` — code-lens and read-only webglass wrapper tools with install-hint degradation and typed fetch errors
- `t9` — Walk recorder and run record: keyed tool events with hashes and timestamps, redaction filter, run metrics, default export
- `t10` — Statements artifact, citation verifier, not-fully-read marker, and continue-from loader
- `t11` — Provider from environment and reasoning-off on the wire
- `t12` — Python 'associate run' verb: fail-closed launcher over pi -p / --mode json with export paths and continue-from
- `t13` — Runtime prompt AGENTS.md and the mesh cutover: culture.yaml backend acp with pi-acp `acp_command`, AGENTS.colleague.md retained
- `t14` — Docs: CLAUDE.md exact harness pins, README contract-plus-adapters shape and boundary, ledger rows for ported colleague guards, version bump
- `t15` — Verification on the live lane and a real culture server: success signals, package install, git cleanliness, evidence in the PR body
- `t16` — Portable contract module: role.json, policy.json, task/walk/statements schemas, a small adapter base, and a plumbing-only stub
- `t17` — Behavioral suite and 'associate bench --harness' evaluating the complete configuration, stub labeled plumbing-only

## Actual Delivery

| Plan task | Status | What actually landed |
|-----------|--------|----------------------|
| `t1` | delivered | `.pi/settings.json`, root `package.json` (pi key), `.gitignore` entries; paths corrected to `.pi`-relative under d1 |
| `t2` | delivered | `index.ts` loader, `associate_ready` sentinel, `finish`, write-guard hook, session dirs; amended by d5, d7, d8, d9 |
| `t3` | delivered | `lib/contain.ts` ported from colleague (confine, pattern escape, budget + spill, denylist, validateArgs, cursors); `.gitignore` re-include (d2) |
| `t4` | delivered | Node test runner (`tests/run.sh`), `tests/fake_lane.py`, pi-skip helper, Node 22 CI job |
| `t5` | delivered | `tools/read.ts`: absolute line numbers, byte cap, prefix-only continuation, denylist |
| `t6` | delivered | `tools/search.ts`: `find`/`grep`/`ls` over vendored rg/fd, argv spawn, cap 200 |
| `t7` | delivered | `tools/shell.ts`: argv-only `bash` override, policy allowlist, `declareNonWriter` (d5) |
| `t8` | delivered | `tools/codelens.ts`, `tools/web.ts` (search + page only), install hints, typed fetch errors; the webglass/code-lens skills plan is still unmerged (r23) |
| `t9` | delivered | `lib/walk.ts`: streamed walk with ids, hashes, redaction, run record; `bench/walkstats.py` |
| `t10` | delivered | `lib/statements.ts`, `lib/torch.ts`: statements with evidence, ENCOUNTERED/UNVERIFIABLE citations, not-fully-read, continue-from |
| `t11` | delivered | `lib/provider.ts`: provider from `ASSOCIATE_*`, reasoning-off knob measured live |
| `t12` | delivered | `harness/pi.py`, `associate run`; readiness via preflight `ready.json` and explicit `-e` (d8) |
| `t13` | delivered | `AGENTS.md`, `culture.yaml` backend acp + `acp_command: [pi-acp]`, `AGENTS.colleague.md` retained; d9 prompt amendment |
| `t14` | delivered | CLAUDE.md pins and `ASSOCIATE_*` table, README boundary and audiences, ledger rows, version 0.9.0 |
| `t15` | partial | live checks run and filed as evidence e2–e13; c22 and c27 success signals not met (see Drift) |
| `t16` | delivered | `associate/contract/` (role, policy, three schemas, validator), `harness/base.py`, plumbing-only stub |
| `t17` | delivered | seven-case corpus, `associate bench --harness`, configuration row; forbidden-tool list corrected (l34) |

## Mid-work Decisions

- `d1` — `.pi/settings.json` paths are `.pi`-relative (Pi docs settings.md:268); criterion amended.
- `d2` — scoped `.gitignore` re-include for `.pi/extensions/*/lib/` (the Python `lib/` rule swallowed extension source).
- `d3`, `d4`, `d6` — shared structural tests that encoded an empty `tools/` were relaxed to shape checks by the first tool modules.
- `d5` — `ctx.declareNonWriter` built so the argv shell named `bash` passes the write guard.
- `d6` (also) — webglass `--policy-profile` not exposed to the model; six-verb `code_lens` enum kept with a typed `unsupported_command` for verbs code-lens 0.10.0 lacks.
- `d7` — the extension deactivates writers on `session_start`; measured: a globally installed package left `edit`/`write` active in an unrelated directory.
- `d8` — readiness proven by a model-free preflight writing `ready.json`; launcher passes `-e` explicitly; measured: a task prompt made the model skip the sentinel, and fixture checkouts loaded no extension.
- `d9` — `finish` no longer terminates the loop; later tool calls are blocked; AGENTS.md says the final message restates the summary; bench checks delivery. Measured on the mesh: the hand-back never reached IRC.
- Operator decisions: Pi is the runtime (c32); colleague tools ported case by case (c33); no colleague adapter, Qwen Code deferred (c49); commit to Pi with a small portable contract (c50).

## Drift

| Plan item | Divergence | Reason | Classification |
|-----------|------------|--------|----------------|
| `t1` | settings paths differ from the confirmed literal | Pi resolution rule unchecked at planning | acceptable (d1) |
| `t2`/`t12` | readiness and extension loading redesigned (d7, d8) | both assumptions failed on the first live task and first foreign checkout | acceptable (d7 risky at filing, resolved by measurement) |
| `t2`/`t13`/`t17` | finish semantics changed (d9) | mesh relays chat text, harness delivered via finish | acceptable |
| `t8` | wrappers landed without the webglass/code-lens skills plan | that plan is exported but unmerged | needs-follow-up (r23) |
| `t15` | c22 (3) and c27 not met; c22 (1)/(2) see evidence | model behaviour and lane speed, not harness defects; the timeout is the only hard bound by the operator's choice (no cap; progress detection is the follow-up) | needs-follow-up (r29, r26) |
| `t9` | preflight writes a run record into the task walk; killed runs report `ok` | d8 side effect | needs-follow-up (r27) |

## Delivery Claims

| Claim | Confidence | Evidence |
|-------|------------|----------|
| The extension loads and registers the associate tools with no writer active, on the lane and from a global install | high | e3, e6; `pi-integration.test.ts`; 230 extension tests |
| A headless run persists walk, statements and a run record by default and prints their paths | high | e5, e13, e11; `tests/test_run.py` |
| The launcher fails closed without the sentinel | high | e2 (o18); `tests/test_run.py` |
| No write reaches a checkout: 21 refusals, 0 writes, git clean (c22 part 1) | high | e14, e15; the probe looped to its timeout with no `finish` |
| Reasoning is off on the wire | high | e4 (sensitivity: 2 thinking blocks vs 0) |
| Citations prove encounter, never support; fabrications are flagged | high | e9; run 3's four fabricated modules all UNVERIFIABLE |
| culture launches the agent through pi-acp and relays its text to IRC | medium | e7, e12; caveats r30 (narration relayed, 5-min ACP timeout, competing prompt) |
| The issue #3 success signal (c27) | not met | r29: 520–723 s, support 50–89 %, coverage complementary |
| The behavioral bench on the live configuration | measured, 1/7 | r26 |
| Global package install from a pinned git tag | unverified | only the local-path install form was measured (e3); no tag pushed |
| Identical behaviour under `--mode rpc` / ACP as under `-p` (h1) | low | l13; ACP path exercised only via culture (e12) |

Approved lapses that cap confidence: l4 (invented policy budgets), l5/l29 (adapter shaped from the brief, then measured), l7 (byte cap on multibyte input), l13 (rpc/ACP parity), l26 (lane crash during t10's check, later attributed to an infrastructure update), l29–l31 (t12 proven on a fake pi first), l32 (a mis-targeted run), l34 (bench forbidden list).

## Remaining Work

- A hard tool-call cap (d10) was declined by the operator: it would stop the agent earlier, not make it better. Follow-up instead: progress and goal detection over the walk so runs get more time and end on the goal (v11, r33). r30: the mesh turn must end inside culture's ACP timeout and AGENTS.md should pre-empt culture's irc-skill prompt (culture-side text, cross-repo).
- r27: preflight run record and killed-run outcome in the walk; r32: repeat `finish` as a no-op; r31: extract `wN` tokens from prose evidence strings.
- r26: bench findings (read via shell vs read tool; evidence markers on short tasks; case expectations); extension version column.
- r23: the webglass/code-lens skills plan and its ledger rows; r13: ship the corpus as package data; r18/r28: redaction pattern dialect and over-redaction of identifiers.
- v9: colleague adopting the contract-plus-adapters design (issue on agentculture/colleague).
- Adjudicated by the operator after the squash merge (#6): evidence e1–e15, deltas b1–b5, lapses l33–l36 all confirmed.
