# Build Plan — webglass + code-lens as tools

slug: `webglass-code-lens-as-tools` · status: `exported` · from frame: `webglass-code-lens-as-tools`

> webglass and code-lens become associate tools

## Tasks

### t1 — Add .claude/skills/code-lookup adapted from code-lens-cli: PATH-based wrapper, type: command frontmatter, install-hint degradation

- instruction: adapt from ../code-lens-cli/.claude/skills/code-lookup; keep the upstream SKILL.md body; add `type: command` to the frontmatter; replace the relative project-root engine resolution (`PROJECT_ROOT` four levels up plus `uv run --directory`) with a PATH invocation of the installed `code-lens` binary guarded by a `command -v code-lens` check that degrades with the install hint; scripts must not reach outside the repo
- covers: c2, h2, c3, h3, c12, h10
- acceptance:
  - .claude/skills/code-lookup/SKILL.md frontmatter carries `name: code-lookup`, `type: command`, and a description, with `name` equal to the directory name
  - each wrapper under .claude/skills/code-lookup/scripts/ invokes `code-lens` from PATH and exits non-zero with an install hint naming `uv tool install code-lens-cli` when `code-lens` is absent, and exits 0 when present
  - no wrapper resolves the engine relative to the script location (no `uv run --directory <root> python -m code_lens`)

### t2 — Add .claude/skills/repo-map adapted from code-lens-cli: PATH-based wrapper, type: command frontmatter, install-hint degradation

- instruction: adapt from ../code-lens-cli/.claude/skills/repo-map; keep the upstream SKILL.md body; add `type: command` to the frontmatter; replace the relative project-root engine resolution (`PROJECT_ROOT` four levels up plus `uv run --directory`) with a PATH invocation of the installed `code-lens` binary guarded by a `command -v code-lens` check that degrades with the install hint; scripts must not reach outside the repo
- covers: c2, h2, c3, h3, c12, h10
- acceptance:
  - .claude/skills/repo-map/SKILL.md frontmatter carries `name: repo-map`, `type: command`, and a description, with `name` equal to the directory name
  - each wrapper under .claude/skills/repo-map/scripts/ invokes `code-lens` from PATH and exits non-zero with an install hint naming `uv tool install code-lens-cli` when `code-lens` is absent, and exits 0 when present
  - no wrapper resolves the engine relative to the script location (no `uv run --directory <root> python -m code_lens`)

### t3 — Add .claude/skills/webglass (origin associate): PATH-based wrapper, type: command frontmatter, policy plus key documentation, install-hint degradation

- instruction: locally authored (no upstream copy to cite, origin associate); follow the ask-colleague optional-external-CLI pattern (prefer the installed `webglass` on PATH, degrade with the complete install hint including the one-time chromium step); document the default-deny policy and the `--policy-profile` override so a policy denial reads as policy, not tool failure; do not claim a session-store path; scripts must not reach outside the repo
- covers: c1, h1, c2, h2, c6, h5, c14, h13, c12, h10
- acceptance:
  - .claude/skills/webglass/SKILL.md frontmatter carries `name: webglass`, `type: command`, and a description, with `name` equal to the directory name
  - the webglass SKILL.md documents search/page/action/session, names that `webglass search` requires `WEBGLASS_BRAVE_API_KEY` and fails cleanly (no traceback) without it, documents that loopback and private-network targets are denied by default, and shows the explicit `--policy-profile` override pattern with a pointer to webglass-cli docs/ci-recipe.md
  - each wrapper under .claude/skills/webglass/scripts/ invokes `webglass` from PATH and exits non-zero with an install hint naming `uv tool install webglass-cli` plus the one-time `playwright install --with-deps chromium` step when `webglass` is absent, and exits 0 when present
  - no wrapper resolves the engine relative to the script location; the SKILL.md does not claim a webglass session-store path (that location is an unverified parked unknown)

### t4 — Document code-lens and webglass in CLAUDE.md Tooling prerequisites as optional CLI prerequisites with floors and uv-tool origins

- instruction: add code-lens and webglass to the "Optional, only when the skill is actually invoked" block of the Tooling prerequisites section in CLAUDE.md, mirroring the existing colleague and eidetic entries (name the CLI, its floor version, the PyPI origin the uv tool receipt names, and that the wrapper degrades with an install hint); do not add a runtime dependency; keep `dependencies = []`
- covers: c1, h1, c8, h6, c10, h8
- acceptance:
  - the Tooling prerequisites section of CLAUDE.md lists `code-lens` (>=0.10.0, origin code-lens-cli) and `webglass` (>=0.8.3, origin webglass-cli) as optional prerequisites with their floor versions and `uv tool install` names, framed like the existing `colleague` and `eidetic` optional entries
  - markdown lint passes on CLAUDE.md and no runtime dependency is added to pyproject.toml (dependencies stays empty)

### t5 — Record code-lookup, repo-map, and webglass in the docs/skill-sources.md skill provenance ledger with origin, adaptation note, and last-synced date

- instruction: add the three ledger rows per the existing ledger table format; for code-lookup and repo-map record origin code-lens-cli plus the divergence note (PATH wrapper, not verbatim) plus today date as last-synced; for webglass record origin associate (no upstream copy) plus today date as last-synced; do not record any promote row (promote is deliberately not vendored)
- covers: c10, h8, c11, h9
- acceptance:
  - docs/skill-sources.md carries exactly three new rows: code-lookup (origin code-lens-cli), repo-map (origin code-lens-cli), and webglass (origin associate), each with origin, adaptation note, and last-synced date
  - the code-lookup and repo-map rows note the tracked divergence (wrappers prefer the installed CLI on PATH and degrade with an install hint instead of the upstream relative-path engine resolution); no promote row is added; markdown lint passes on docs/skill-sources.md

### t6 — Verify doctor, PATH degradation, non-vendored boundaries, and machine-agnostic artifacts for the three new tools

- instruction: run `uv run associate doctor` and `steward doctor --scope self`; test degradation by invoking each wrapper under a PATH lacking its CLI and under the real PATH; confirm promote was not vendored and culture.yaml is untouched; verify the exported spec and frame carry no absolute home paths; this task owns no source files and reads everything
- depends on: t1, t2, t3, t4, t5
- covers: c1, h1, c4, h4, c9, h7, c10, h8, c11, h9, c13, h14
- acceptance:
  - `uv run associate doctor` passes skills-present (the three new skills load) and `steward doctor --scope self` skills-convention and portability pass (every new SKILL.md frontmatter `name` equals its directory; no absolute home paths in tracked .md/.yaml/.toml/.json)
  - with each CLI shimmed out of PATH its wrapper exits non-zero with the install hint, and under the real PATH it exits 0; `grep -rl promote .claude/skills/ docs/skill-sources.md` returns nothing and `git diff culture.yaml` is empty (resident identity untouched); the three ledger rows are present in docs/skill-sources.md

## Risks

- [unknown_nonblocking] webglass session-store location is unverified (frame parked unknown v1): t3 must document the session subcommands generically and must not claim a store path; no plan task may depend on persistent sessions until the store location is observed (task t3)
