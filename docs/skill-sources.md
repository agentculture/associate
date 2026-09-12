# Skill upstream sources

associate vendors its `.claude/skills/` from **guildmaster** — the
AgentCulture **skills supplier** after the steward → guildmaster cutover
(guildmaster 0.5.0, 2026-05-24). `steward` retains the **alignment** role
(`steward doctor`, the sibling-pattern baseline); only the skills-supplier role
moved. This file tracks provenance so re-syncs stay deterministic.

Eight skills — `scope`, `think`, `challenge`, `spec-to-plan`,
`assign-to-workforce`, `deviate`, `validate-delivery`, and `summarize-delivery`
— originate in [`agentculture/devague`](https://github.com/agentculture/devague).
They are not eight independent tools but **one workflow chain**: idea → scope →
spec → challenged spec → plan → parallel implementation → validated,
accounted-for delivery. All eight are vendored **directly from devague**, never
from guildmaster's re-broadcast, because guildmaster's copies of the script-less
ones carry an added `scripts/*.sh` wrapper the devague originals do not have —
citing guildmaster's copy would pull in content this repo never asked for. This
is a tracked local divergence, parallel to `ask-colleague`'s below (see
[below](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)).

One skill, `ask-colleague` (formerly `outsource`), originates in
[`agentculture/colleague`](https://github.com/agentculture/colleague) — the
renamed `convertible`. guildmaster's re-broadcast still carries the old
`outsource` name, so `ask-colleague` is vendored **directly from colleague** as a
tracked local divergence (see [below](#local-divergence--outsource--ask-colleague-2026-06-06)).

Every vendored `SKILL.md` carries `type: command`. associate
declares a culture agent (`culture.yaml`, `backend: colleague`), and
`core.skill_loader` silently skips any `SKILL.md` lacking `type:` — so the field
is load-bearing, even where guildmaster's upstream copy omits it.

| Skill | Upstream | Origin | Notes | Last synced |
|-------|----------|--------|-------|-------------|
| `cicd` | `../guildmaster/.claude/skills/cicd/` | guildmaster | CI/CD lane layered on `devex pr`: the 5 thin scripts (`workflow.sh`, `pr-status.sh`, `pr-reply.sh`, `_resolve-nick.sh`, `portability-lint.sh`) delegate lint/open/read/reply/delta to `devex` and add the `status` / `await` SonarCloud-gating extensions. Consumer-identifying prose (`guildmaster` → `associate`) adapted in the description + heading; upstream history (`Renamed from pr-review in steward 0.7.0; rebased on devex in 0.12.0`) and env-var literals (`STEWARD_*`) kept verbatim. The PR signature resolves at runtime from `culture.yaml` via `_resolve-nick.sh` (→ `associate`). Requires `devex` on PATH. | 2026-05-26 (guildmaster 0.6.0) |
| `communicate` | `../guildmaster/.claude/skills/communicate/` | guildmaster | Cross-repo + mesh communication. Consumer-identifying prose adapted in the description (incl. the `- associate (Claude)` signature line). **No hard-coded signature literal in the scripts** — `post-issue.sh` is `agtag`-backed and resolves the signing nick from `culture.yaml`; requires `agtag` (>=0.1) on PATH. The supplier `scripts/templates/` (`skill-update-brief.md`, `skill-new-brief.md`) are kept verbatim — inert for a consumer (they cite guildmaster as upstream). Renamed from `coordinate` in steward 0.8.0; absorbed `gh-issues` in 0.9.1. | 2026-05-26 (guildmaster 0.6.0) |
| `version-bump` | `../guildmaster/.claude/skills/version-bump/` | guildmaster | Pure-Python, CWD-aware (`scripts/bump.py`). Verbatim except added `type: command`. | 2026-05-26 (guildmaster 0.6.0) |
| `agent-config` | `../guildmaster/.claude/skills/agent-config/` | guildmaster (origin steward) | Shows a Culture agent's full config; run `scripts/show.sh` directly (no `guild` binary required). `scripts/show.sh` + `data/backend-fingerprints.yaml` verbatim. Verbatim except added `type: command`. | 2026-05-26 (guildmaster 0.6.0) |
| `doc-test-alignment` | `../guildmaster/.claude/skills/doc-test-alignment/` | guildmaster | **STUB** — `scripts/check.sh` exits not-yet-implemented; the contract lives in SKILL.md. Verbatim except added `type: command`. | 2026-05-26 (guildmaster 0.6.0) |
| `pypi-maintainer` | `../guildmaster/.claude/skills/pypi-maintainer/` | guildmaster | Switch a package install between PyPI / TestPyPI / local editable (`scripts/switch-source.sh`). Verbatim except added `type: command`. | 2026-05-26 (guildmaster 0.6.0) |
| `run-tests` | `../guildmaster/.claude/skills/run-tests/` | guildmaster | pytest + xdist + coverage (`scripts/test.sh`). Verbatim except added `type: command`. | 2026-05-26 (guildmaster 0.6.0) |
| `sonarclaude` | `../guildmaster/.claude/skills/sonarclaude/` | guildmaster | SonarCloud API queries (`scripts/sonar.sh`). Verbatim except added `type: command`. | 2026-05-26 (guildmaster 0.6.0) |
| `scope` | `../devague/.claude/skills/scope/` | **devague** (vendored directly — guildmaster's re-broadcast is not cited; see [local divergence](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)) | Leg 1 — idea→scope. Surveys the surfaces an idea touches (code, docs, skills, CI, sibling repos) before framing, seeding the Announcement Frame with boundary/non-goal/assumption claims that cite what was actually explored. Method-only, no `scripts/`. Verbatim. | 2026-09-05 (devague 0.24.1) |
| `think` | `../devague/.claude/skills/think/` | **devague** (vendored directly — guildmaster's re-broadcast is not cited; see [local divergence](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)) | Leg 2 — idea→spec, working backwards from the announcement. Captures and classifies claims, interrogates them with honesty conditions, parks open vagueness, exports only once the frame converges. Carries `scripts/think.sh`. Verbatim. | 2026-09-05 (devague 0.24.1) |
| `challenge` | `../devague/.claude/skills/challenge/` | **devague** (vendored directly — guildmaster's re-broadcast is not cited; see [local divergence](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)) | Leg 3 — risk-scaled blind-spot pass over a converged, exported frame, between `/think` and `/spec-to-plan`. Routes every finding back through the deterministic moves as proposed-only content the human adjudicates; on a clean pass records examined lenses and residual uncertainty, never a claim of no unknown unknowns. Method-only, no `scripts/`. Verbatim. | 2026-09-05 (devague 0.24.1) |
| `spec-to-plan` | `../devague/.claude/skills/spec-to-plan/` | **devague** (vendored directly — guildmaster's re-broadcast is not cited; see [local divergence](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)) | Leg 4 — spec→plan, working forwards. Tasks with acceptance criteria covering every coverage target, an honest dependency order, unknowns parked as first-class risks. Carries `scripts/spec-to-plan.sh`. Verbatim. | 2026-09-05 (devague 0.24.1) |
| `assign-to-workforce` | `../devague/.claude/skills/assign-to-workforce/` | **devague** (vendored directly — guildmaster's re-broadcast is not cited; see [local divergence](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)) | Leg 5 — plan→parallel implementation. Fans a plan's dependency waves out to agents in isolated worktrees with TDD-gated merges. Carries `scripts/assign-to-workforce.sh`. Verbatim **except** the `agex` → `devex` re-application (2 occurrences; see the divergence section below). | 2026-09-05 (devague 0.24.1) |
| `deviate` | `../devague/.claude/skills/deviate/` | **devague** (vendored directly — guildmaster's re-broadcast is not cited; see [local divergence](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)) | Leg 6 — stops an in-flight fan-out the moment execution must diverge from the confirmed plan, gets explicit human approval, and records the divergence as a first-class append-only record before resuming. Method-only, no `scripts/`. Verbatim. | 2026-09-05 (devague 0.24.1) |
| `validate-delivery` | `../devague/.claude/skills/validate-delivery/` | **devague** (vendored directly — guildmaster's re-broadcast is not cited; see [local divergence](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)) | Leg 7 — runs the confirmed plan's behavioral tests agent-side after the waves merge and before `/summarize-delivery`, filing evidence and behavioral deltas as record-only entries. Never runs tests inside the CLI (devague#20); never suppresses a failing or partial outcome. Method-only, no `scripts/`. **New in this sync.** Verbatim. | 2026-09-05 (devague 0.24.1) |
| `summarize-delivery` | `../devague/.claude/skills/summarize-delivery/` | **devague** (vendored directly — guildmaster's re-broadcast is not cited; see [local divergence](#local-divergence--the-eight-devague-chain-skills-vendored-directly-from-devague-2026-09-05)) | Leg 8 — closes the loop with a planned-versus-actual accountability artifact: mid-work decisions, plan drift, evidence-backed delivery claims, remaining work. Runs on complete, partial, AND failed runs, reporting failure faithfully. Method-only, no `scripts/`. Verbatim. | 2026-09-05 (devague 0.24.1) |
| `ask-colleague` | `../colleague/.claude/skills/ask-colleague/` | **colleague** (renamed from convertible; vendored directly — guildmaster re-broadcast pending) | The first-party front door to the `colleague` CLI: hand a scoped task to a *different* engine/mind via `explore` / `review` / `write`, run the spec→plan→workforce arc via `plan`, pick a cut or timed-out run back up via `resume` (`--detach` to background it), pilot a live work item with `monitor` / `guide` / `stop`, grade a finished work item via `feedback` (the ROI loop), and reap stale/corrupt `colleague/*` branches a crashed run left behind via `clean`. Thinking effort is per-seat (`--effort`, `--seat-effort S=R`, `--role`). Every verb takes `--json` (result JSON on stdout, diagnostics on stderr). `explore`/`review` run isolated in a throwaway `git worktree`; `write` **previews by default** (throwaway worktree, no side effects) and refuses a dirty tree only when applying (`--apply` / `--pr`). Vendored **byte-verbatim** as of the 1.63.0 sync — the Provenance paragraph is consumer-neutral upstream, so the localization noted for earlier syncs no longer applies; verify with `diff -r ../colleague/.claude/skills/ask-colleague .claude/skills/ask-colleague`. Already carries `type: command`. Optional runtime dep: **`colleague`** on PATH. | 2026-08-24 (colleague 1.63.0, direct) |

## Ported guards — not vendored skills, tracked here anyway

The table above is `.claude/skills/`. The two rows below are a different
kind of borrowing: `.pi/extensions/associate/lib/contain.ts`, the containment
library every registered Pi tool goes through before it touches a path, spends
output budget, or trusts an argument set, ports two functions **case by
case** from `colleague`'s tool implementation (decision c33 of
`docs/specs/2026-09-12-associate-on-pi-with-opinionated-tools.md` — colleague's
base tools are ported one at a time, origin recorded, not bulk-vendored). This
is source-level porting into a TypeScript module, not a `SKILL.md` +
`scripts/` skill, so it does not fit the table's columns — but the same
"know your provenance, know what re-sync means" discipline applies, so it is
recorded here rather than nowhere.

| Ported into | Upstream | Origin | Notes | Last synced |
|-------------|----------|--------|-------|-------------|
| `.pi/extensions/associate/lib/contain.ts` `confine()` / `refusePatternEscape()` | `colleague/colleague/search_tools.py:90-101` (`confine`, mirroring `ToolExecutor._safe_path` at `colleague/tools.py:844-849`) and `:105-118` (`_refuse_pattern_escape`) | **colleague** (ported by hand, not vendored — see the drift note below) | Confines every read/find/grep path to the session root and refuses a pattern containing a parent-path escape (`../`). Ported logic, not a byte-copy: errors are returned as structured, retryable values instead of colleague's thrown `ToolError` (a Pi tool has to hand the model something correctable), and the budget/cap values come from the caller's parsed `policy.json` rather than a literal or an env var. | 2026-09-12 (colleague at the commit read for spec `associate-on-pi-with-opinionated-tools`) |
| `.pi/extensions/associate/lib/contain.ts` `boundOutput()` | `colleague/colleague/readpage.py` (`bound_output`), delegating to `colleague/colleague/truncation.py:189-255` (`truncate_output`), `:128-172` (`_head_and_tail`), `:175-186` (`_bounded_preview`), and `:258-301` (`_create_spill_file`, the `O_EXCL` / `O_NOFOLLOW` symlink-plant fix, finding #441-5/A) | **colleague** (ported by hand, not vendored — see the drift note below) | Bounds tool output at a per-call budget with spill-to-disk past the cap. Deliberately **not** ported: colleague's 500 MB per-session spill cap (`truncation.MAX_SESSION_SPILL_BYTES`) — there is no `policy.json` key for it yet, so add one before wanting the cap. Colleague reads its budgets from `COLLEAGUE_MAX_OUTPUT_CHARS` / `COLLEAGUE_TOOL_SPILL` env vars; here they are parameters from the caller's parsed policy — this module never reads `policy.json` itself. | 2026-09-12 (colleague at the commit read for spec `associate-on-pi-with-opinionated-tools`) |

**Drift note — what happens when colleague's version changes:** these are
**hand-ported**, not cited/vendored — there is no `diff -r` against a checked
out `../colleague` that stays meaningful, because the target language and
error-handling convention differ by design (see each row's Notes). So a
colleague change to `search_tools.py`, `readpage.py`, or `truncation.py` does
**not** auto-propagate here and does **not** get silently reverted by a
re-sync script the way a vendored skill would. Concretely: if colleague fixes
a bug or tightens a guard in one of the cited functions (a new symlink attack,
a widened denylist, a corrected off-by-one in `_head_and_tail`), someone has to
notice, re-read the upstream fix, and **re-port it into `contain.ts` by hand**
— there is no automated or scripted re-sync path for this pair the way there
is for `.claude/skills/`. Check `git log` on the cited colleague files
periodically, or when a colleague release note mentions `search_tools.py` /
`readpage.py` / `truncation.py`, and update the "Last synced" cell above after
each manual re-port.

## Re-sync procedure

```bash
# Diff against upstream before pulling (example: cicd / communicate):
for s in cicd communicate; do
  diff -ru ../guildmaster/.claude/skills/$s .claude/skills/$s
done

# Pull a skill fresh (remove first so dropped scripts don't linger):
rm -rf .claude/skills/<skill>
cp -R ../guildmaster/.claude/skills/<skill> .claude/skills/

# Re-apply the identifier-only adaptations in SKILL.md:
#   - consumer-identifying prose: `guildmaster` → `associate` (NOT
#     where it cites guildmaster/steward/devague as the upstream/origin).
#   - add `type: command` to the frontmatter if guildmaster's copy omits it
#     (load-bearing for the culture/claude backend's core.skill_loader).
# No script bodies are edited (cite-don't-import). The communicate signature
# resolves from culture.yaml via agtag — no literal to patch.
```

If a re-sync would lose a associate adaptation, lift the change
upstream into guildmaster first (per guildmaster's `docs/skill-sources.md`) and
re-vendor.

### Local divergence — `agex` → `devex` rename (2026-05-30)

The PR-lifecycle CLI was renamed `agex` → `devex` (same tool, new name). The
vendored `cicd` (`SKILL.md`, `workflow.sh`, `pr-status.sh`),
`assign-to-workforce`, and `communicate` (`skill-new-brief.md` template) copies
were **patched in place** for this rename rather than re-vendored — a deliberate
exception to cite-don't-import, made so the `cicd` scripts invoke the real
`devex pr` binary now. The matching canonical rename is tracked upstream for
guildmaster in [agentculture/guildmaster#48](https://github.com/agentculture/guildmaster/issues/48),
so the next clean re-sync from guildmaster reconciles without losing this
change. (Re-sync once guildmaster's renamed copies are broadcast.)

The same in-place patch also bumped the documented `devex` version floor from
`>=0.1` to `>=0.21` in the vendored `cicd` `SKILL.md` + `workflow.sh` (to match
this doc's tooling-prerequisites and the `await`-era feature set) — likewise
flagged for guildmaster on #48.

### Local divergence — outsource → ask-colleague (2026-06-06)

`convertible` was renamed **`colleague`**, and its skill `outsource` →
**`ask-colleague`** (colleague#148; the `wheels` verb also became `backends`, and
`drive` → `work`). `ask-colleague` adds a fourth verb, `feedback` (the ROI loop),
and `write` now **previews by default** (a throwaway worktree, no side effects)
instead of committing to a branch unless you pass `--apply` / `--pr`.

guildmaster has **not** re-broadcast the rename yet — its kit still ships the old
`outsource`. So this template's `outsource/` was removed and `ask-colleague/`
vendored **directly from the sibling `colleague` checkout**
(`../colleague/.claude/skills/ask-colleague/`), not from guildmaster. This is a
tracked exception to "cite guildmaster's copy", parallel to the `agex` → `devex`
divergence above. Re-sync path until guildmaster catches up:

```bash
# Pull ask-colleague fresh from colleague (the origin):
rm -rf .claude/skills/ask-colleague
cp -R ../colleague/.claude/skills/ask-colleague .claude/skills/
# Byte-verbatim as of 1.63.0 — nothing to re-apply. Upstream rewrote the
# SKILL.md Provenance paragraph to be consumer-neutral, retiring the one
# consumer-identifying clause earlier syncs had to patch back in
# (`which colleague vendors from guildmaster` →
#  `which associate vendors from guildmaster`).
# Confirm the copy is clean:
diff -r ../colleague/.claude/skills/ask-colleague .claude/skills/ask-colleague
# (already carries `type: command`; no script bodies edited.)
```

**Vendored means vendored.** Findings a reviewer raises against
`scripts/ask-colleague.sh` — bot or human — are fixed **upstream in
`agentculture/colleague` and pulled back in on the next sync**, never patched
here. A local patch is exactly the drift this ledger exists to prevent: the
next re-sync silently reverts it, and in the meantime `diff -r` against the
origin stops being a meaningful check.

Once guildmaster re-broadcasts `ask-colleague`, switch the upstream column back
to `../guildmaster/.claude/skills/ask-colleague/` and re-sync from there.

### Local divergence — the eight devague-chain skills vendored directly from devague (2026-09-05)

All eight chain skills — `scope`, `think`, `challenge`, `spec-to-plan`,
`assign-to-workforce`, `deviate`, `validate-delivery`, `summarize-delivery` —
are vendored **directly from the sibling `devague` checkout**
(`../devague/.claude/skills/<skill>/`), not from guildmaster. This supersedes
the earlier split where `think` / `spec-to-plan` / `assign-to-workforce` cited
guildmaster's re-broadcast and only four cited devague.

Two reasons to cite the origin for all eight:

1. **guildmaster's copies carry an added `scripts/*.sh` wrapper** for the
   script-less skills (guildmaster `292feac`, "vendor scripts/ wrappers for
   script-less devague skills") that the devague originals do not have. Five of
   the eight (`scope`, `challenge`, `deviate`, `validate-delivery`,
   `summarize-delivery`) are method-only `SKILL.md`s with no entry-point script
   of their own — that is correct, not an omission. Citing guildmaster's copy
   would silently pull in content this repo never asked for.
2. **They are one chain, so they must be synced as one unit.** Splitting them
   across two upstreams meant three legs could lag the other five by a
   re-broadcast cycle, leaving the chain internally inconsistent — the failure
   this sync corrects.

`validate-delivery` (leg 7) was **added** in this sync; it had no row before.

**One adaptation is re-applied on every sync** — `assign-to-workforce`'s
`agex` → `devex` rename, 2 occurrences (`SKILL.md` line ~284 and
`scripts/assign-to-workforce.sh` line ~109, both the phrase `agex pr open`).
The PR-lifecycle CLI was renamed `agex` → `devex` (same tool, new name) and the
vendored `cicd` scripts invoke the real `devex pr` binary, so a stale `agex`
reference would send a reader to a command that no longer exists. This is a
deliberate exception to cite-don't-import, tracked upstream for guildmaster in
[agentculture/guildmaster#48](https://github.com/agentculture/guildmaster/issues/48);
devague's originals still say `agex`. Re-apply it after every re-sync.

Re-sync path:

```bash
set -euo pipefail
CHAIN="scope think challenge spec-to-plan assign-to-workforce deviate validate-delivery summarize-delivery"
SRC=../devague/.claude/skills

# Diff against the origin before pulling, to see what actually changed:
for s in $CHAIN; do diff -ru "$SRC/$s" ".claude/skills/$s" || true; done

# VERIFY EVERY SOURCE BEFORE TOUCHING ANYTHING. In a standalone clone there is
# no ../devague, and a delete-then-copy loop would strip all eight vendored
# skills and copy nothing back.
for s in $CHAIN; do
  [ -d "$SRC/$s" ] || { echo "missing source: $SRC/$s — aborting, nothing changed" >&2; exit 1; }
done

# Stage every skill first; swap only once all eight copies have succeeded, so
# an interrupted or failed copy never leaves the kit half-replaced.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
for s in $CHAIN; do cp -R "$SRC/$s" "$stage/$s"; done
for s in $CHAIN; do
  rm -rf ".claude/skills/$s"
  cp -R "$stage/$s" ".claude/skills/$s"
done

# Re-apply the one adaptation:
sed -i 's/`agex pr open`/`devex pr open`/g' \
  .claude/skills/assign-to-workforce/SKILL.md \
  .claude/skills/assign-to-workforce/scripts/assign-to-workforce.sh

# Verify: all eight carry `type: command`, and frontmatter name == directory name.
for s in $CHAIN; do grep -q '^type: command' .claude/skills/$s/SKILL.md || echo "MISSING type: $s"; done
```

No consumer-identifying prose needs adapting — each `SKILL.md`'s Provenance
section already speaks generically of downstream repos, and names guildmaster
only as the *broadcaster*, which stays true.

## Tooling prerequisites

- **`devex`** (>=0.21) on PATH — `cicd` delegates the PR lifecycle to `devex pr`.
- **`agtag`** (>=0.1) on PATH — `communicate` issue I/O wraps `agtag issue`.
- **`devague`** (>=0.24) on PATH — the eight chain skills drive this CLI
  (`devague frame` / `plan` / `deviate` / `evidence` / `delta` / `summary`).
  Install with `uv tool install devague`.

All three ship on PATH in the standard AgentCulture dev setup (installed per the
devex / agtag / devague READMEs).

- **`eidetic`** (>=0.10.0) on PATH — *optional*; only `remember` / `recall` need
  it. The version floor is what routes public records to `<repo-root>/.eidetic/memory`
  instead of `$HOME` — on an older CLI public records still work but land in the
  home-dir store. **Note a stale description:** `remember`'s `SKILL.md`
  frontmatter still describes eidetic's upstream *private* default; the wrapper
  script's recipe override defaults to `--visibility public`. The script is
  authoritative.
- **`colleague`** on PATH — *optional*; only the `ask-colleague` skill needs it,
  and only when invoked (`uv tool install colleague`). The wrapper exits
  with a clear install hint if it is absent, so the skill degrades gracefully
  rather than blocking a clone that never uses it. `ask-colleague` also needs a
  reachable backend — a local vLLM by default, overridable via `--engine` /
  `--model` / `--base-url` or `COLLEAGUE_*` env (the legacy `CONVERTIBLE_*` names
  still work as a deprecated fallback).
