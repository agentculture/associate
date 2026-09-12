# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.1] - 2026-09-12

### Changed

- Ledger adjudication after PR #6 merged: evidence e1–e15, behavioural deltas
  b1–b5, and lapses l33–l36 confirmed by the operator; the delivery summary's
  pending line updated. No code change.

## [0.9.0] - 2026-09-12

### Added

- **`CLAUDE.md` Tooling prerequisites** gains the exact Pi harness pins (`pi`
  0.84.2, `pi-acp` 0.0.33, Node >=22, and the extension's own contract
  version), the upgrade rule (bump a pin only after `associate bench` passes
  against the new version), and a reference table for the six `ASSOCIATE_*`
  environment variables (`BASE_URL`, `API_KEY`, `MODEL`, `CONTRACT_DIR`,
  `SESSION_ID`, `EXPORT_ROOT`).
- **`docs/skill-sources.md`** gains a "Ported guards — not vendored skills"
  section with two ledger rows for
  `.pi/extensions/associate/lib/contain.ts`'s `confine()` /
  `refusePatternEscape()` and `boundOutput()`, hand-ported from `colleague`'s
  `search_tools.py` / `readpage.py` / `truncation.py`, plus a drift note
  explaining that these ports have no scripted re-sync path and must be
  re-applied by hand when colleague's originals change.

### Changed

- **`README.md`** drops the "Status: scaffold, not yet a harness" framing and
  replaces it with the boundary the operator set: associate is an opinionated
  Pi extension plus a thin wrapper around a small portable contract (role and
  permission boundaries, task input/handback format, evidence artifacts,
  behavioral cases), while everything else — tool descriptions, prompt
  construction, context selection, compaction, reasoning/provider settings —
  stays tailored to Pi and the model; a second harness is added only after a
  measured benefit. Adds the three reader audiences (mesh resident, colleague
  or an operator driving it headlessly, a developer running `pi` directly)
  each with one invocation, the lane boundary (reads/finds/summarizes/verifies,
  never edits/writes/PRs), and the before state quoted at the pre-change HEAD
  (commit `2f24585`: `backend: colleague`, no tracked `.pi/`, README literally
  said "not yet a harness"). Adds `bench` to the CLI table and Quickstart.
- **`CLAUDE.md`** "Current state vs. target" now lists the harness pieces that
  have landed in this plan so far (the portable contract, the Pi extension
  core, the containment library, `associate bench --harness stub`) separately
  from what is still landing (the `pi` harness adapter, the `run` CLI verb,
  the provider registration, the mesh cutover to `backend: acp`) and states
  plainly that the harness does not work end to end until a later task (t15)
  measures a live `pi` adapter run. "What not to invent" gets a matching
  entry, plus a reminder that policy values belong in `associate/contract/`,
  never hardcoded in the Pi extension. Build/test/lint gains an
  `associate bench` entry, and Skills convention documents the `.gitignore`
  re-include needed for `.pi/extensions/*/lib/` (the Python-project template's
  bare `lib/` rule would otherwise swallow the extension's TypeScript source).

This is a docs-only change: no code, no tests, no CLI verb added or modified.

### Fixed

## [0.8.0] - 2026-09-05

### Added

- **`validate-delivery` skill** vendored from `devague` (cite-don't-import) —
  leg 7 of the devague chain, the missing step between `assign-to-workforce`
  and `summarize-delivery`. It runs the confirmed plan's behavioral tests
  agent-side after the waves merge and files what was found — evidence for what
  passed, behavioral deltas for what the run added, amended, or removed — as
  first-class, record-only entries via the `devague` CLI. Tests never run inside
  the CLI (devague#20), and a failing or partial outcome is never suppressed.
  Without it, `summarize-delivery` had to make delivery claims with no filed
  evidence behind them.

### Changed

- **`culture.yaml` now names the lobes ROLE, not a checkpoint** —
  `model: associate` replaces the inherited `sakamakismile/Qwen3.6-27B-Text-NVFP4-MTP`.
  That pin was never a decision made for this agent: it is the
  `culture-agent-template` default carried by ~50 sibling repos in the workspace,
  and it names the *cortex* checkpoint, not anything this agent runs.

  `associate` is a first-class lobes role — the tenth Colleague-facing lobe,
  backed by `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4`, defined in
  `lobes/roles.py` as `worker` MINUS `repo_action`. The `colleague` backend
  defaults to the local lobes gateway (`http://localhost:8001/v1`), which
  resolves the role to whichever box hosts it — today a Jetson AGX Orin 64GB
  running the `orin-associate` shape, reached over the tailnet via
  `ASSOCIATE_PEER_ORIGIN` + `ASSOCIATE_PEER_PROXY`. Naming the role rather than
  the checkpoint means the lane can move boxes or re-checkpoint without touching
  this repo, which is lobes' stated purpose.

  Verified live 2026-09-05: `model=associate` through the gateway returns
  completions served by the Lightning checkpoint, and the Orin reports the role
  `feasible=true ready=true loaded=true`.

  This resolves the model/description inconsistency recorded earlier in this
  entry's `CLAUDE.md` rewrite — `pyproject.toml`'s "initially backed by NVIDIA
  Nemotron 3.5 Lightning" was correct all along; `culture.yaml` was the wrong
  half. `CLAUDE.md` gains a "runtime lane" section with the measured topology
  and the role's forbidden-responsibility set (`final_decision`,
  `security_decision`, `code_authoring`, `repo_action`) as the authority on this
  agent's scope; `README.md` leads with the role framing.

  **Recorded, not worked around — a fleet-side defect this repo must not
  compensate for:** the Orin advertises the lane on its `/v1/models` under the
  checkpoint id while the gateway's `ASSOCIATE_SERVED_NAME=associate`.
  `probe_peer_ready` compares exactly those two strings, so the readiness probe
  fails: the gateway reports the role `ready=false, loaded=false` and omits it
  from its own `/v1/models`, even though the data plane proxies it correctly.
  The lane works when addressed explicitly but is invisible to model discovery.
  The fix belongs in the deployment env, not in repo code.

- **`AGENTS.colleague.md` rewritten to match the `associate` role's authority
  bounds** (Qodo PR #2, finding 2). Binding `culture.yaml` to the `associate`
  role introduced a contradiction the old resident prompt did not have: the
  role forbids `repo_action` and `code_authoring`, while the prompt directed
  the resident to use the colleague tool-loop's `write_file`, `edit_file`, and
  `run_command` — so it could enact repository changes despite the role's
  hand-back-only definition. The prompt now states the permitted set
  (read, list, inspect, run already-authorized commands, bulk transform, draft)
  and the forbidden set (`repo_action`, `code_authoring`, `final_decision`,
  `security_decision`) explicitly, and says plainly that having a tool is not
  authorization to use it: drafts belong in the `finish` payload, not in
  someone's tree. Handing back "here is the change and why I did not apply it"
  is recorded as a complete answer, not a failure.

- **The `docs/skill-sources.md` re-sync procedure is now fail-safe** (Qodo PR
  #2, finding 5). The documented loop deleted each vendored skill before
  confirming its source existed and had no fail-fast, so in the
  standalone-clone case this file explicitly supports — no `../devague` — it
  stripped all eight chain skills and copied nothing back. It now runs under
  `set -euo pipefail`, verifies every source directory before touching the
  repo, and stages all eight copies into a temp dir, swapping only once every
  copy has succeeded.

- **`CLAUDE.md` re-initialized from the `/init` seed into a full runtime
  prompt.** The scaffold's bootstrap placeholder is replaced with the repo's
  actual conventions: a current-state-vs-target section that says plainly that
  the harness itself (read / summarize / find verbs) is not built yet; the
  four load-bearing CLI contract invariants (stdout/stderr split, `CliError`
  with no leaked traceback, argparse errors routed through the same contract,
  descriptive verbs that don't hard-fail on a bad target); the four places that
  must stay in sync when adding a verb (handler, parser registration, explain
  catalog, `learn` text) and why the rubric gate fails otherwise; build / test /
  lint / publish commands including single-test and coverage invocations; the
  skills convention and the `../.worktrees.associate/` worktree rule; and the
  `steward doctor` invariants.

  Two inconsistencies inherited from the template scaffold are recorded rather
  than silently "fixed": `pyproject.toml` describes the harness as backed by
  NVIDIA Nemotron 3.5 Lightning while `culture.yaml` pins the template's default
  `sakamakismile/Qwen3.6-27B-Text-NVFP4-MTP`, and the `remember` skill's
  `SKILL.md` frontmatter describes a private home-dir memory default that its
  own wrapper script overrides to public/in-repo.

  The seed also claimed this repo satisfies `prompt-file-present` via a
  `CLAUDE.md` + `backend: claude`. It does not: `culture.yaml` declares
  `backend: colleague`, so `AGENTS.colleague.md` is the resident agent's runtime
  prompt and `CLAUDE.md` is the prompt for Claude Code sessions working on the
  repo. `associate doctor` confirms the invariant passes via the former.

- **`README.md` rewritten** on the `devague` README model — reader-facing rather
  than template-facing. Leads with a "Status: scaffold, not yet a harness"
  section instead of describing unbuilt functionality, adds a mermaid diagram of
  the eight-skill devague chain and its three human gates, and tables the CLI
  verbs, the eleven day-to-day skills, and the optional per-skill tooling. The
  "Make it your own" template instructions move to `CLAUDE.md`, where the
  identifier-rename procedure belongs.

- **All eight devague-chain skills re-vendored from `devague` 0.24.1** —
  `scope`, `think`, `challenge`, `spec-to-plan`, `assign-to-workforce`,
  `deviate`, `validate-delivery`, `summarize-delivery`. Previously `think`,
  `spec-to-plan`, and `assign-to-workforce` cited guildmaster's re-broadcast
  while the rest cited devague directly; the chain is one workflow and syncing
  it from two upstreams let three legs lag the other five by a re-broadcast
  cycle. All eight now cite the origin. The one documented adaptation —
  `assign-to-workforce`'s `agex` → `devex` rename, 2 occurrences — is re-applied
  after the copy, and the re-sync script in `docs/skill-sources.md` re-applies
  it automatically.

- **`docs/skill-sources.md` ledger updated** — the eight chain rows rewritten in
  flow order with per-leg descriptions and a `2026-09-05 (devague 0.24.1)` sync
  stamp, the four-skill divergence section replaced by an eight-skill one
  explaining both reasons to cite the origin, and `devague` (>=0.24) added to
  the tooling prerequisites alongside an `eidetic` (>=0.10.0) entry that records
  the stale-description drift in `remember`.

## [0.7.0] - 2026-08-24

### Added

- **`resume <task-id|last> [--detach]` verb** in `ask-colleague` — pick a cut / timed-out / SIGTERM'd run back up from its persisted artifact, continuing on the original `colleague/<id>` work branch.
- **Per-seat thinking effort** in `ask-colleague` — `--effort` (acting seat), `--seat-effort S=R` (any seat), `--role NAME` (colleague#416). Rule of thumb: `--effort off` for small well-specified briefs, default for ordinary work, `xhigh` for open-ended judgement.
- **Review diff front-loading** — `ask-colleague review` embeds a filtered, bounded diff directly in the prompt instead of relying on the colleague run to fetch it.

### Changed

- **`ask-colleague` re-vendored byte-verbatim from `agentculture/colleague` @ 1.63.0** (cite-don't-import) — all five files (`SKILL.md`, `scripts/ask-colleague.sh`, `prompts/{explore,review,write}.md`). Every repo scaffolded from this template (`guild create` instantiates it) shipped the Qwen3.6-era wrapper until now.
- **Default colleague model is `unsloth/Qwen3.8-27B-NVFP4`** (was the Qwen3.6 pin). The lobes gateway on `:8001` no longer serves 3.6, so the previous default only worked via colleague's auto-refresh warning path.
- **`docs/skill-sources.md` ledger row** for `ask-colleague` updated to the 1.63.0 sync (was `2026-06-12 (colleague 1.7.0, direct)`) and its verb list extended with `plan` / `resume` / the pilot verbs.

## [0.6.1] - 2026-07-20

### Added

- **Worktree location convention** in `CLAUDE.md` — every worktree you create
  by hand (workforce fan-out lanes, scratch checkouts) lives in
  `../.worktrees.associate/<name>/`, one
  repo-named directory beside the checkout, replacing a shared `../worktrees/`
  folder. This workspace holds many sibling projects, so a generic shared
  folder accumulates orphaned trees from several repos at once with nothing
  indicating ownership — a stale-tree sweep can't tell a live lane from junk.
  Matches the convention already documented in sibling repo `reachy-mini-cli`.
  Adds branch-prefix guidance (scope the prefix to the work; plain `agent/*`
  collides with leftovers from earlier fan-outs and fails `git worktree add
  -b`), and notes that the vendored `assign-to-workforce` skill uses both the
  shared path *and* `agent/<task-id>` branches in its fan-out example — it is
  cited verbatim and must not be edited, so both are overridden when following
  it. Teardown guidance names `git worktree remove <path>` as the verb that
  actually deletes a worktree; `git worktree prune` only clears metadata for
  directories that are already gone. Tool-managed throwaways are explicitly
  out of scope: `ask-colleague`'s read-only verbs create a detached worktree
  under `${TMPDIR:-/tmp}` and reap it on an EXIT trap, so they never persist
  to need an owner.

## [0.6.0] - 2026-07-18

### Added

- **Four devague-origin skills re-vendored into `.claude/skills/`**
  (cite-don't-import), synced to the fixed devague source
  (devague#74/#75/#76):
  - `challenge` — a risk-scaled blind-spot discovery pass that runs between
    `/think` and `/spec-to-plan`, routing findings back through the existing
    deterministic moves as human-adjudicated proposals.
  - `scope` — the idea→scope leg that surveys the surfaces an idea touches
    before framing, seeding the Announcement Frame with provenance-backed
    boundary/non-goal/assumption claims.
  - `deviate` — stops an in-flight `assign-to-workforce` run when execution
    must diverge from the confirmed plan and records the divergence as a
    first-class, append-only deviation record.
  - `summarize-delivery` — closes the loop after an `assign-to-workforce`
    run with a planned-vs-actual accountability artifact.

  These four originate in `devague` and are re-broadcast via guildmaster; see
  `docs/skill-sources.md` for provenance.

## [0.5.0] - 2026-06-24

### Added

- **Memory-discipline "Conventions and workflow" section in `CLAUDE.md`** — a
  per-task *recall-before / remember-after* convention (scope localized to this
  repo's nick) so the vendored `remember` / `recall` skills are actually used,
  not just present: `/recall` before non-trivial work to build on prior
  decisions instead of re-deriving them, and `/remember` when a non-obvious
  decision, constraint, fix-and-why, or hard-won gotcha surfaces. The section
  documents this repo's memory as **in-repo and public** — records resolve to
  `<repo-root>/.eidetic/memory` (committed, team- and mesh-shared). Inserted
  idempotently (skipped if already present), slotted under an existing
  "Conventions and workflow" heading when one exists, else appended.

### Changed

- **Refreshed the `remember` + `recall` wrappers from eidetic-cli 0.10.0**
  (cite-don't-import) — picks up eidetic's **project-local store default**: the
  files backend now resolves per record by visibility — PUBLIC records inside a
  git repo go to `<repo-root>/.eidetic/memory` (committed, team-shared), PRIVATE
  records (or any record outside a repo) go to `$HOME/.eidetic/memory` (never
  committed), an explicit `EIDETIC_DATA_DIR` still wins, and recall reads both
  stores and merges. Also carries the 0.9.3 hardening (interactive-stdin guard,
  `help` as a search term, SIGPIPE-safe suffix parsing). **Recipe policy
  override (the wrappers here are NOT byte-verbatim):** the injected default
  visibility is flipped from eidetic's `private` to **`public`**, so a plain
  `/remember` lands the note in `./.eidetic/memory` in this repo, kept as part
  of the repo — pass `--visibility private` to route a record to `$HOME`
  instead. `remember` drives `eidetic remember` (idempotent upsert of one JSON
  record or an NDJSON batch on stdin); `recall` drives `eidetic recall` with
  four search modes (exact / approximate / keyword / hybrid). Each `SKILL.md` is
  localized only in the illustrative `--scope <nick>` examples (Provenance keeps
  "First-party to eidetic-cli"). Runtime dep: the `eidetic` CLI on PATH (else a
  local eidetic-cli checkout with `uv`) — **`eidetic >= 0.10.0`** for the
  in-repo routing; on an older CLI the public records still work but are stored
  in `$HOME/.eidetic/memory` instead of in-repo. Propagated by rollout-cli's
  `eidetic-memory` recipe.

## [0.4.0] - 2026-06-23

### Added

- **Vendored the `remember` + `recall` memory skills from eidetic-cli**
  (cite-don't-import) — the write/read halves of eidetic's shared
  `$HOME/.eidetic/memory` surface, so this agent (Claude and its colleague
  backend) can persist facts across sessions and recall them later, sharing
  one store.
  `remember` drives `eidetic remember` (idempotent upsert of one JSON record or
  an NDJSON batch on stdin, dedup by id + content hash); `recall` drives
  `eidetic recall` with four search modes — exact / approximate / keyword /
  hybrid — each hit carrying text, full provenance metadata, a relevance score,
  and a freshness signal. The `.sh` wrappers are byte-verbatim from eidetic-cli
  (their first-party origin); each `SKILL.md` is localized only in the
  illustrative `--scope <nick>` examples (Provenance keeps "First-party to
  eidetic-cli"). Both default to this agent's PRIVATE scope, reading the suffix
  from `culture.yaml`. Runtime dep: the `eidetic` CLI on PATH (else a local
  eidetic-cli checkout with `uv`). Propagated by rollout-cli's `eidetic-memory`
  recipe.

## [0.3.4] - 2026-06-20

### Fixed

- Identity docs and self-description strings still claimed `backend: claude`
  (prompt file `CLAUDE.md`), but this template was promoted to a colleague
  resident in #14/#15: `culture.yaml` declares `backend: colleague` (Qwen) with
  `AGENTS.colleague.md` as the resident prompt. Corrected the stale claim in
  `CLAUDE.md` (Identity section), `README.md`, `docs/skill-sources.md`, and the
  two CLI description strings (`overview` artifacts and `explain doctor`). The
  `doctor` backend→prompt-file mapping and the tests were already on
  `colleague`; this aligns the prose and self-description with them.

## [0.3.3] - 2026-06-20

### Fixed

- pyproject.toml: correct the `license` field and PyPI classifier from MIT to
  Apache-2.0 to match the `LICENSE` file. The README License section was already
  corrected in 0.3.2, but the package metadata was missed; the built wheel now
  reports `License-Expression: Apache-2.0`.

## [0.3.2] - 2026-06-18

### Added

- ask-colleague skill: `monitor`/`guide`/`stop` pilot verbs plus a `--watch`
  flag to dispatch, watch the live feed of, send mid-flight guidance to, and
  cooperatively stop a running colleague flight (re-vendored from colleague).

### Changed

- README: correct the License section from MIT to Apache 2.0 to match the
  `LICENSE` file.

## [0.3.1] - 2026-06-13

### Changed

- CLAUDE.md: add a convention to reach for the `ask-colleague` skill reflexively
  for explore/review/write/grade — read-only `review`/`explore` are always safe;
  side-effecting `write` needs the user's go-ahead.

## [0.3.0] - 2026-06-13

### Added

- AGENTS.colleague.md resident prompt file (backend colleague <-> AGENTS.colleague.md)

### Changed

- Promote agent identity to a colleague resident: culture.yaml backend
  claude -> colleague with a pinned model. The `doctor` backend-consistency
  map gains `colleague` -> AGENTS.colleague.md.

## [0.2.1] - 2026-06-12

### Changed

- **Re-vendored the `ask-colleague` skill from colleague (now 1.7.0, up from the
  0.39.2 sync)** — the wrapper had drifted multiple releases behind origin. Picks
  up the `clean` verb (reap stale/corrupt `colleague/*` branches + orphaned
  `.colleague/` artifacts a crashed run left behind), the `--json` flag on every
  verb (result JSON on stdout, diagnostics/digest on stderr), the
  `_colleague_via_uv` local-dev resolution that honors `--repo`, and the
  tri-state (0/1/2) exit-code contract. `scripts/ask-colleague.sh` + `prompts/`
  are byte-identical to the origin; `SKILL.md` diverges only in the one
  consumer-identifying Provenance clause (`associate vendors from
  guildmaster`). `docs/skill-sources.md` sync row updated to
  `2026-06-12 (colleague 1.7.0, direct)`. Refs: colleague#183, #186.

## [0.2.0] - 2026-06-06

### Added

- **`ask-colleague` skill** (`.claude/skills/ask-colleague/`) — the first-party front door to the `colleague` CLI (the renamed `convertible`). On top of `explore` / `review` / `write` it adds a `feedback` verb (grade a finished work item — the ROI loop), and `write` now **previews by default** in a throwaway worktree (no side effects) unless `--apply` / `--pr` is given. Reach for it reflexively — `review` for a diverse second opinion on a committed diff before opening a PR, `explore` for a fresh read of an unfamiliar area.

### Changed

- **Replaced the `outsource` skill with `ask-colleague`.** `outsource` was renamed to `ask-colleague` upstream ([colleague#148](https://github.com/agentculture/colleague/pull/148)). Because guildmaster has not re-broadcast the rename yet (its kit still ships the old `outsource`), `ask-colleague` is vendored **directly from the sibling `colleague` checkout** rather than from guildmaster — a tracked local divergence recorded in `docs/skill-sources.md`, parallel to the `agex` → `devex` one. Vendored verbatim except one consumer-identifying clause in the Provenance paragraph.
- **Ledger + CLAUDE.md + `.gitignore`:** point `docs/skill-sources.md` and the CLAUDE.md Skills section at `colleague` / `ask-colleague`, swap the *optional* runtime prerequisite `convertible` → `colleague` (env prefix `CONVERTIBLE_*` → `COLLEAGUE_*`, with the legacy names kept as a deprecated fallback), and gitignore the `.colleague/` run-artifact dir the skill writes (plus the stale `.agex/`).

## [0.1.4] - 2026-05-31

### Added

- **Vendor the `outsource` skill** (`.claude/skills/outsource/`) from
  guildmaster's canonical copy (origin
  [`agentculture/convertible`](https://github.com/agentculture/convertible),
  re-broadcast via guildmaster — guildmaster
  [#51](https://github.com/agentculture/guildmaster/pull/51)). Every agent
  cloned from this template now inherits the ability to hand a scoped task to a
  *different* engine/mind: `explore` (read-only investigation), `review` (a
  diverse second opinion on the committed diff), and `write` (delegate a small
  implementation). `explore`/`review` run isolated in a throwaway `git worktree`;
  `write` refuses a dirty tree. Fulfils
  [#8](https://github.com/agentculture/associate/issues/8).
- **Ledger + CLAUDE.md:** record `outsource` in `docs/skill-sources.md`
  (origin = convertible, re-broadcast via guildmaster; vendored verbatim — it
  already carries `type: command`) and document its *optional* runtime
  dependency on the `convertible` CLI (the skill exits with an install hint if
  absent, so a clone that never uses it is unaffected).

### Changed

### Fixed

## [0.1.3] - 2026-05-31

### Changed

- Expanded the clone-and-rename instructions in `CLAUDE.md`: added `README.md` to
  the rename targets and a portable `git grep` discovery command so a cloner can
  find every occurrence of the template name (hard-coded in ~100 places across the
  package, including the CLI command files and `_ISSUES_URL` in
  `associate/cli/__init__.py`) rather than renaming by hand.
- Synced `README.md`'s "Make it your own" checklist with `CLAUDE.md`: it now lists
  `README.md` itself as a rename target and points to `CLAUDE.md`'s discovery
  command as the authoritative procedure, so the two onboarding checklists no
  longer drift.

## [0.1.2] - 2026-05-30

### Changed

- Renamed the PR-lifecycle CLI references `agex` / `agex-cli` to `devex` (same
  tool, new name) across `CLAUDE.md`, `docs/skill-sources.md`, `.gitignore`, and
  the vendored `cicd`, `assign-to-workforce`, and `communicate` skills — the
  `cicd` scripts now invoke `devex pr`.
- Logged the vendored-skill in-place patch as a local divergence in
  `docs/skill-sources.md`; the matching canonical rename is tracked upstream for
  guildmaster in
  [agentculture/guildmaster#48](https://github.com/agentculture/guildmaster/issues/48)
  so a future re-sync reconciles cleanly.
- Aligned the documented `devex` version floor to `>=0.21` across the vendored
  `cicd` `SKILL.md` and `workflow.sh` install hint (were `>=0.1`), matching
  `docs/skill-sources.md` and the `await`-era feature set; flagged upstream on
  guildmaster#48.

### Fixed

- SonarCloud now reports code coverage — added `relative_files = true` to
  `[tool.coverage.run]` so `coverage.xml` emits repo-relative paths that map to
  `sonar.sources=associate` (absolute / `.venv` paths were dropped
  as unmappable). Mirrors the sibling `convertible` setup.

## [0.1.1] - 2026-05-26

### Changed

- **CI gates on the SonarCloud quality gate**
  ([issue #3](https://github.com/agentculture/associate/issues/3)) —
  added `sonar.qualitygate.wait=true` to `sonar-project.properties` so a failing
  gate fails the `test` job when `SONAR_TOKEN` is set. Token-less repos and fork
  PRs remain green (the scan step is guarded by `if: env.SONAR_TOKEN != ''`).

## [0.1.0] - 2026-05-26

### Added

- **Onboarded into the AgentCulture mesh** ([issue #1](https://github.com/agentculture/associate/issues/1)).
- **Agent-first CLI** cited from teken's (`afi-cli`) `python-cli` reference
  (`teken cli cite`) — verbs `whoami`, `learn`, `explain`, `overview`, `doctor`,
  and the `cli` noun group. Runtime is self-contained (`dependencies = []`);
  `teken>=0.8` is a dev dependency only. Passes the seven-bundle agent-first
  rubric (`teken cli doctor . --strict`). `doctor` checks the agent-identity
  invariants (prompt-file-present, backend-consistency, skills-present).
- **Mesh identity**: `culture.yaml` (`suffix: associate`,
  `backend: claude`) and the matching `CLAUDE.md` prompt file.
- **Canonical guildmaster skill kit** (11 skills) vendored under
  `.claude/skills/` (cite-don't-import): `agent-config`, `assign-to-workforce`,
  `cicd`, `communicate`, `doc-test-alignment`, `pypi-maintainer`, `run-tests`,
  `sonarclaude`, `spec-to-plan`, `think`, `version-bump`. Every `SKILL.md`
  carries `type: command` (load-bearing for the culture/claude backend);
  `cicd` / `communicate` consumer-identifying prose adapted, all script bodies
  verbatim. Provenance in `docs/skill-sources.md`. Three skills (`think`,
  `spec-to-plan`, `assign-to-workforce`) originate in `devague`, re-broadcast
  via guildmaster.
- **Build + deploy baseline**: `pyproject.toml` (hatchling), `tests/` (pytest,
  xdist, coverage), `.github/workflows/{tests,publish}.yml` (CI rubric/lint gate,
  PyPI Trusted Publishing), `.flake8`, `.markdownlint-cli2.yaml`,
  `sonar-project.properties`, and `.claude/skills.local.yaml.example`.

### Changed

### Fixed
