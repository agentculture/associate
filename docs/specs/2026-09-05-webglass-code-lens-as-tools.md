# webglass + code-lens as tools

> webglass and code-lens become associate tools
> instruction: verify: `code-lens --version` and `webglass --version` exit 0 from a clean shell; associate .claude/skills/ holds code-lookup, repo-map, and webglass; CLAUDE.md Tooling prerequisites names both CLIs

## Audience

- the associate agent (resident, backend: colleague) and any operator driving it from a bash surface — it is the find/read and web-fetch work the harness was missing that these tools take on
  - instruction: verify: after the 3 new skills land, `uv run associate doctor` passes skills-present and every new SKILL.md frontmatter carries type: command with name equal to the directory name

## Before → After

- Before: associate has no find/read or web-fetch capability — no read verb, no summarize verb, no find verb, no web fetch (CLAUDE.md "Current state vs. target"); code-lens 0.10.0 and webglass 0.8.3 are installed on PATH on this machine but the repo documents neither, so a fresh session has no sanctioned way to reach them
  - instruction: verify historically: at the pre-change HEAD, `git show HEAD:CLAUDE.md | grep -ci "code-lens\|webglass"` is 0 and docs/skill-sources.md has no rows for either origin
- After: code-lens and webglass are first-class associate tools: .claude/skills/ holds code-lookup + repo-map (adapted from code-lens-cli, origin recorded) and a webglass skill (origin associate); CLAUDE.md Tooling prerequisites lists both CLIs with their floors; docs/skill-sources.md carries ledger rows with origin, adaptation notes, and last-synced dates
  - instruction: verify: `uv run associate doctor` and `steward doctor --scope self` pass; docs/skill-sources.md carries 3 new rows (code-lookup, repo-map, webglass) with origin, adaptation notes, and last-synced

## Requirements

- webglass and code-lens are usable as PATH CLIs for the associate agent: code-lens for find/read repo inspection (profile/classify/grep/recent/connections/graph), webglass for guarded web operations (search/page/action/session)
  - instruction: verify: run `code-lens profile .` and `webglass page open <url>` from the associate checkout via the new skills wrappers; both return structured output with exit 0
  - honesty: the PATH CLIs are invoked via bash from any working directory — the new wrappers never resolve the engine relative to the script location (the verbatim code-lens-cli wrappers failure mode)
- webglass search requires `WEBGLASS_BRAVE_API_KEY` and loopback/private-network targets are denied by default (webglass-cli README.md 'Status: M0-M2 shipped')
  - instruction: verify: with `WEBGLASS_BRAVE_API_KEY` unset, `webglass search <query>` exits non-zero with a clean error (no traceback); a loopback target is denied under the default policy profile
  - honesty: webglass search fails cleanly without `WEBGLASS_BRAVE_API_KEY` (no traceback) and loopback targets are denied by default (webglass-cli README, Status M0-M2 shipped) — the skill must document both
- the adapted code-lookup and repo-map copies must add `type: command` to their frontmatter: upstream frontmatter carries only name + description (code-lens-cli/.claude/skills/code-lookup/SKILL.md, repo-map/SKILL.md) and core.`skill_loader` silently skips any SKILL.md lacking type: (docs/skill-sources.md) — a present-but-skipped skill is exactly the failure the ledger rules against
  - honesty: after the copies land, every new SKILL.md carries type: command and name equal to the directory name (steward doctor skills-convention), and `uv run associate doctor` still passes skills-present
- the webglass skill must document that loopback and private-network targets are denied by default and name the explicit --policy-profile override pattern (webglass-cli README.md, Status M0-M2 shipped; docs/ci-recipe.md), so the agent reads a policy denial as policy — not as a tool failure
  - honesty: the landed webglass SKILL.md names the loopback/private-network default-deny and shows the --policy-profile override pattern with a pointer to webglass-cli docs/ci-recipe.md — verify by grep on the skill body

## Honesty conditions

- the announcement holds only when both CLIs are reachable from the agent PATH and the repo skills document them — no hidden env vars, no checkout-relative engine fallback
- a verbatim copy of code-lens-cli repo-map/code-lookup wrappers into associate fails: `uv run --directory <associate-root> python -m code_lens` cannot resolve the `code_lens` module in associate dependencies=\[\] venv — verified in all six wrapper script bodies
- running colleague promote inside the associate repo would mint/overwrite the resident culture.yaml (associate is already a Culture agent, backend: colleague) — per promote SKILL.md step 1 and its --force flag
- the audience is the associate resident (culture.yaml backend: colleague) and the operator bash surface — the skills under .claude/skills load only for backends whose core.`skill_loader` requires frontmatter type: command, so the audience is never a library consumer of the associate package (dependencies=\[\])
- the before state is accurate as of today: CLAUDE.md Current-state-vs-target lists no read/summarize/find/web-fetch verbs, and neither CLAUDE.md nor docs/skill-sources.md names code-lens or webglass
- the after state holds only when all four surfaces exist: the 3 skill dirs (frontmatter type: command, name == directory name), the CLAUDE.md Tooling-prerequisites entry, and the ledger rows — and steward doctor skills-convention + portability still pass
- the success signals are checkable from a fresh session: the exit-code checks (2) run with the CLI present and with it shimmed out of PATH, and (1) uses a public URL or an explicit --policy-profile because webglass denies loopback targets by default
- the re-exported spec and the committed frame state carry zero absolute home paths — verify by grep -c /home/spark on docs/specs/2026-09-05-webglass-code-lens-as-tools.md and .devague/frames/webglass-code-lens-as-tools.json, both 0 after export
- the one-time chromium step is documented at webglass-cli README.md:70 and the uv tool receipts name the PyPI origins code-lens-cli and webglass-cli (probe P1, this pass)

## Success signals

- from a fresh session in the associate checkout: (1) `code-lens profile .` and `webglass page open <url>` both exit 0 with structured output; (2) all three new skills wrappers exit non-zero with an install hint when their CLI is absent from PATH and exit 0 when present; (3) docs/skill-sources.md contains a row for each of the 3 new skills with origin + last-synced
  - instruction: verify from a fresh shell in a clean clone: (1) `code-lens --version` + `webglass --version` exit 0; (2) each new wrapper exits non-zero with an install hint under a PATH that lacks its CLI and exits 0 under the real PATH; (3) the 3 ledger rows are present

## Scope / boundaries

- repo-map / code-lookup wrapper scripts from code-lens-cli are NOT vendored verbatim: each resolves the engine four levels above the script and runs `uv run --directory <that-root> python -m code_lens` (code-lens-cli/.claude/skills/repo-map/scripts/profile.sh, code-lookup/scripts/\*.sh); copied into associate they would target associate's venv where dependencies=\[\] and no `code_lens` module exists
  - instruction: verify: diff -ru ../code-lens-cli/.claude/skills/repo-map .claude/skills/repo-map shows only the wrapper divergence; bash .claude/skills/repo-map/scripts/profile.sh . exits 0 through the installed code-lens, not through uv run in the associate venv
- colleague's promote skill is NOT vendored: promote.sh drives 'colleague promote', which mints/overwrites a colleague instance's culture.yaml identity (--force overwrites a differing existing culture.yaml per colleague/.claude/skills/promote/SKILL.md), while associate is already a resident Culture agent with its own culture.yaml (backend: colleague)
  - instruction: verify: grep -rl promote .claude/skills/ docs/skill-sources.md returns nothing and git diff culture.yaml is empty — the resident identity was never touched
- exported specs and committed .devague frame state stay machine-agnostic — no absolute home paths: the steward doctor portability invariant scans tracked .md/.yaml/.toml/.json (CLAUDE.md steward-doctor invariants), and scope entries s4/s5 originally carried them (amended this pass)

## Assumptions

- both CLIs are invoked from PATH via the agent's bash surface — no new runtime dependency lands in associate (dependencies=\[\] stays); webglass's Playwright/headless-Chromium runtime stays in webglass's own uv tool env (webglass-cli 0.8.3) and code-lens in its own (code-lens-cli 0.10.0)
- the fresh-machine install path is `uv tool install code-lens-cli` and `uv tool install webglass-cli` (PyPI origins per the uv tool receipts, probe P1) plus a one-time `playwright install --with-deps chromium` for webglass (webglass-cli README.md:70) — the wrapper install hints must name the complete path, not just the uv tool install step

## Scope exploration

- `s1` — `associate/.claude/skills/ + docs/skill-sources.md`: inventory holds 19 vendored skills covering the devague chain, mesh ops, and CI — zero repo-introspection or web-fetch tools; CLAUDE.md 'Current state vs. target' confirms the missing read/summarize/find/web-fetch harness; the ledger has no rows for code-lens-cli or webglass-cli origins and its re-sync paths assume ../guildmaster or ../devague sources
  - seeds: `c2`
- `s2` — `colleague/.claude/skills/ (20 skills)`: promote is the only delta vs associate's 19; promote.sh forwards to 'colleague promote' which mints culture.yaml (suffix + backend + model) and --force overwrites a differing existing culture.yaml — a colleague-instance lifecycle verb that would collide with associate's existing resident identity
  - seeds: `c4`
- `s3` — `webglass-cli (0.8.3, sibling checkout ../webglass-cli)`: its .claude/skills/ contributes nothing new (18 skills, a subset of associate's 19); the value is the webglass CLI: search/page/action/session over headless Chromium, loopback denied by default, search gated on `WEBGLASS_BRAVE_API_KEY` (README.md); already installed via uv tool and on PATH, 'webglass --help' smoke-tested
  - seeds: `c6`
- `s4` — `code-lens-cli (0.10.0, sibling checkout ../code-lens-cli)`: code-lens CLI installed via uv tool, on PATH; `code-lens profile <associate-checkout>` smoke-tested and returned a mechanical-facts profile; repo-map/code-lookup skills are one-line wrappers whose `PROJECT_ROOT` resolves four levels above the script then `uv run --directory` there — a verbatim copy into associate would run against associate dependencies=\[\] venv and fail
  - seeds: `c3`
- `s5` — `agent PATH surface (code-lens 0.10.0 + webglass 0.8.3, both uv tool installs)`: both binaries resolve from the PATH surface (uv tool installs, PyPI origins code-lens-cli and webglass-cli per the uv tool receipts) and exit 0; no repo edit is needed for the agent to call them — they are available as bash tools now
  - seeds: `c5`
- `s6` — `associate skill-kit conventions (cite-don't-import, docs/skill-sources.md, CLAUDE.md Tooling prerequisites)`: the kit already has an established pattern for optional external CLIs: colleague is the optional prerequisite of the ask-colleague skill and 'the wrapper exits with a clear install hint if it is absent, so the skill degrades gracefully rather than blocking a clone' (docs/skill-sources.md Tooling prerequisites); a code-lens/webglass skill would follow that same pattern, but whether a skill is warranted at all vs a bare prerequisites note is the user's call
  - seeds: `q1` (question, resolved)
- `s7` — `challenge pass / security lens: webglass search key-gating (c6/h5)`: counter-evidence probe deliberately NOT run: `WEBGLASS_BRAVE_API_KEY` is set in this environment, so a no-key search would consume real API budget; the clean-failure behavior rests on webglass-cli README.md (Status M0-M2 shipped) rather than an observed run
- `s8` — `challenge pass / concurrency + reversibility lenses: skill wrappers, CLAUDE.md, docs/skill-sources.md`: clean pass: wrappers invoke stateless one-shot CLIs (code-lens is read-only AST analysis; webglass sessions live in its own store), nothing in the change shares mutable state across agents, and the change is additive files + docs — git-revertible with no migration; no finding
- `s9` — `challenge pass / operations lens: scope surface labels s3/s4`: surface labels originally carried absolute home paths and `scope --amend` preserves the surface by contract (same id/surface/seeds); the labels were hand-edited in .devague/frames/webglass-code-lens-as-tools.json to sibling-checkout-relative origins and the frame re-exported — the acknowledged hygiene path from the think skill (no retitle/edit move exists)

## Decisions

- land repo-level skills for code-lens and webglass in associate: code-lookup + repo-map adapted from code-lens-cli (origin code-lens-cli, tracked divergence — wrappers prefer the installed code-lens CLI on PATH and degrade with an install hint instead of the upstream relative-path engine resolution), a locally authored webglass skill (origin associate — no upstream copy to cite), a Tooling-prerequisites entry in CLAUDE.md, and ledger rows in docs/skill-sources.md — the agent gets both tools by design, not by ad-hoc install
  - instruction: verify: ls .claude/skills/code-lookup .claude/skills/repo-map .claude/skills/webglass; grep -l "code-lens" CLAUDE.md docs/skill-sources.md; with the CLI absent from PATH each wrapper exits non-zero with an install hint, with it present each exits 0

## Hard questions

- Beyond the PATH tools, do we also land repo-level skills (.claude/skills) documenting code-lens/webglass use — adapted wrappers that prefer the installed CLI and degrade with an install hint, per the ask-colleague optional-prereq precedent — or is a CLAUDE.md Tooling-prerequisites note plus a ledger entry enough? (resolved: yes — land repo-level skills; the agent gets both tools by design: code-lookup + repo-map adapted from code-lens-cli (wrappers prefer the installed code-lens CLI, degrade with an install hint), a locally authored webglass skill, CLAUDE.md Tooling-prerequisites entry, and ledger rows in docs/skill-sources.md)

## Open parks

- [unknown_nonblocking] webglass session-store location and its interaction with repo working trees is unverified by this pass (lightweight depth; `webglass session --help` shows create/list/show/close/clean over "this store" but not where it writes) — the webglass skill must name the store location before any plan task depends on persistent sessions
