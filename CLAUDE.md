# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**associate** is a *non-coding agent harness* — a fast, reliable worker for
**read, summarize, and find** work across local files and the web. It exists to
take non-coding tool work off [`colleague`](https://github.com/agentculture/colleague)
so colleague can spend its budget on coding and thinking. The design is modelled
on the Pi harness and merged from colleague's base tools.

It is a sibling in the AgentCulture mesh alongside
[`colleague`](https://github.com/agentculture/colleague) (the diverse-backend
delegate), [`guildmaster`](https://github.com/agentculture/guildmaster) (the
skills supplier), [`steward`](https://github.com/agentculture/steward)
(resident-agent alignment), [`devague`](https://github.com/agentculture/devague)
(idea→spec→plan→delivery), and [`culture`](https://github.com/agentculture/culture)
(the IRC mesh itself). See the workspace-level `CLAUDE.md` one directory above
for the cross-project overview.

Sibling paths in this file (`../devague/`, `../guildmaster/`) **assume the
workspace layout** where siblings are checked out in the same parent directory.
In a standalone clone, read the same files on GitHub or clone the sibling beside
this repo first. Each path names a project, not a guaranteed location.

## Current state vs. target

**Read this before believing the description.** This repo was scaffolded from
`culture-agent-template` (`guild create`) and carries the template's full
baseline — the agent-first CLI, the vendored skill kit, CI, PyPI publishing, and
an inherited `CHANGELOG.md` whose pre-`0.8.0` entries are *template* history with
the names substituted, not things that happened here.

What exists today:

- the agent-first CLI (`whoami` / `learn` / `explain` / `overview` / `doctor` /
  `cli overview`) — introspection only, no domain verbs;
- the mesh identity (`culture.yaml` + `AGENTS.colleague.md`);
- 19 vendored skills under `.claude/skills/`;
- a green build/lint/publish baseline.

What does **not** exist yet: **the harness itself.** There is no read verb, no
summarize verb, no find verb, no web fetch, no file-reading tool loop. Nothing
in this repo currently takes work off colleague. Treat "Project shape" below as
the ground you build on, not as a description of a working harness.

**One known inconsistency in the inherited scaffold** — don't "fix" it by
guessing which side is right; ask. The `remember` skill's `SKILL.md` frontmatter
says records default to the home-dir store (`$HOME/.eidetic/memory`) at
**private** visibility; its `scripts/remember.sh` actually defaults to **public**
(in-repo). The script is authoritative — see [Memory discipline](#memory-discipline--recall-before-remember-after).

## The runtime lane: `associate` is a first-class lobes role

This is not an aspiration — it is wired and serving today, and it is the reason
this repo exists.

`associate` is the **tenth Colleague-facing role** in
[`lobes`](https://github.com/agentculture/lobes-cli) (`lobes/roles.py`), backed
by `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` — a Mamba-2/MoE/attention
hybrid, ~3B active of 30B total. lobes defines it as **`worker` MINUS
`repo_action`**: it may execute, draft, inspect, and call tools, then hands the
result **back** rather than enacting it. Its forbidden set is
`final_decision`, `security_decision`, `code_authoring`, `repo_action`. That is
this repo's remit stated in someone else's registry — read `lobes/roles.py`
before you widen this agent's scope.

The topology, as measured on 2026-09-05:

```text
associate (backend: colleague)
  └─ colleague default base_url  http://localhost:8001/v1
       └─ lobes gateway (this box, the DGX Spark)
            ASSOCIATE_FEASIBLE=false        # not hosted here
            ASSOCIATE_PEER_PROXY=true       # forward, don't 404
            ASSOCIATE_PEER_ORIGIN=http://<orin-host>:8000   # the tailnet peer
              └─ Jetson AGX Orin 64GB (sm_87, zero swap), shape `orin-associate`
                   associate: feasible=true ready=true loaded=true
                   nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4
```

So `culture.yaml` names the **role** (`model: associate`), never a checkpoint id.
The gateway resolves the role to whichever box hosts it; the lane can move or
re-checkpoint without touching this repo. Addressing a capability by role instead
of hardcoding an endpoint is lobes' stated purpose.

**Known deployment defect (in the fleet, not in this repo):** the Orin advertises
that lane on its `/v1/models` under the checkpoint id, while the Spark's
`ASSOCIATE_SERVED_NAME=associate`. `probe_peer_ready` compares exactly those two
strings, so the readiness probe fails and the Spark reports the role
`ready=false, loaded=false` and omits it from its own `/v1/models` — even though
the data plane proxies it correctly and `model=associate` returns real
completions. Effect: **the lane works when addressed explicitly but is invisible
to model discovery.** Any client that lists models before choosing one will not
see it. Don't work around this in repo code; it is fixed in the deployment env.

## Identity: this file is not the runtime prompt

`culture.yaml` declares `backend: colleague`, so the **resident agent's** runtime
prompt is [`AGENTS.colleague.md`](AGENTS.colleague.md), not this file. This
`CLAUDE.md` is the prompt for **Claude Code sessions working on the repo** — the
two audiences are different and both are real.

That split is what the `backend-consistency` invariant checks: the declared
backend must agree with the prompt file on disk (`claude` → `CLAUDE.md`,
`colleague` → `AGENTS.colleague.md`, `acp` → `AGENTS.md`, `gemini` →
`GEMINI.md`). If you ever change `backend:`, the matching prompt file must exist
or both `associate doctor` and `steward doctor` fail. Verify with:

```bash
uv run associate whoami      # nick / version / backend / model
uv run associate doctor      # prompt-file-present + skills-present
```

## Project shape (afi-cli pattern, no `src/`)

```text
associate/                  # Python package (top level — no src/ wrapper)
├── __init__.py             # __version__ via importlib.metadata("associate")
├── __main__.py             # python -m associate
├── cli/
│   ├── __init__.py         # argparse main() + _build_parser() + _dispatch()
│   ├── _errors.py          # CliError + EXIT_SUCCESS/USER_ERROR/ENV_ERROR
│   ├── _output.py          # emit_result / emit_error / emit_diagnostic
│   └── _commands/          # one module per verb, each exposing register(sub)
└── explain/
    ├── __init__.py         # resolve(path) / known_paths()
    └── catalog.py          # ENTRIES: dict[tuple[str, ...], str] of markdown
tests/                      # pytest — test_cli.py, test_cli_introspection.py
.claude/skills/<name>/      # SKILL.md + scripts/ per skill (cite-don't-import)
docs/skill-sources.md       # skill provenance ledger — authoritative
culture.yaml                # agent suffix + backend + model
sonar-project.properties    # SonarCloud key agentculture_associate
```

### The CLI contract (four invariants, all load-bearing)

These are enforced by tests *and* by the `teken cli doctor --strict` rubric gate
in CI. Breaking one fails the build, usually with a message that doesn't point at
the cause — so know them before you add a verb.

1. **Results to stdout, diagnostics and errors to stderr. Never mixed.**
   `_output.py` is the only module that writes to either stream. Every command
   takes `--json`; in JSON mode results are a JSON object on stdout and errors
   are `{code, message, remediation}` on stderr.

2. **Every failure raises `CliError`; no traceback ever reaches stderr.**
   `_dispatch()` catches `CliError`, and wraps *any* other exception into one
   pointing at the issue tracker. A handler returns `None` (→ exit 0) or an
   `int` exit code. Exit-code policy: `0` success, `1` user-input error, `2`
   environment/setup error, `3+` reserved.

3. **Argparse errors route through the same contract.** `_CliArgumentParser`
   overrides `.error()` to emit `error:` / `hint:` and exit `1` — not argparse's
   default exit `2`. Subparsers are built with `parser_class=_CliArgumentParser`
   so this propagates; **a noun group that adds its own subparsers must pass
   `parser_class=type(p)` too** (see `_commands/cli.py`). Because parse-time
   errors happen before `args.json` exists, `main()` pre-scans raw argv for
   `--json` into the class-level `_json_hint`.

4. **Descriptive verbs never hard-fail on a bad target.** `overview` accepts and
   ignores an optional positional `target` so `overview <bogus-path>` still exits
   0. The rubric checks this explicitly (`overview_graceful_on_bad_path`).

### Adding a verb — the four places that must stay in sync

The rubric gate cross-checks the CLI against its own documentation, so a new verb
is never a one-file change:

1. `associate/cli/_commands/<verb>.py` — a `register(sub)` function plus the
   handler; add `--json`; raise `CliError` on failure.
2. `associate/cli/__init__.py` — import inside `_build_parser()` (imports are
   function-local to keep startup cheap) and call `register(sub)`.
3. `associate/explain/catalog.py` — an `ENTRIES` entry keyed by the command-path
   tuple. **The root key is `("associate",)` and the empty tuple**; the rubric's
   `explain_self` check literally runs `associate explain associate`, so if the
   console-script name ever diverges from the catalog root key, CI fails.
4. `associate/cli/_commands/learn.py` — both `_TEXT` and `_as_json_payload()`.
   The rubric requires `learn` to be ≥200 chars and to mention purpose, the
   command map, exit codes, `--json`, and `explain`.

**Adding a *noun* (a verb group) additionally requires an `overview` sub-verb
under it** — the rubric's `overview_cli_noun_exists` check. `_commands/cli.py`
exists purely to satisfy this and is the pattern to copy.

## Build, test, lint, publish

- **Dev install:** `uv sync`
- **Run from source:** `uv run associate --version` / `uv run python -m associate ...`
- **Tests:** `uv run pytest -n auto -v`
- **Single test:** `uv run pytest tests/test_cli.py::test_whoami_json -v`
- **Coverage** (what CI and Sonar consume):
  `uv run pytest -n auto --cov=associate --cov-report=xml:coverage.xml --cov-report=term`
  — `fail_under = 60`, and `relative_files = true` is load-bearing: absolute or
  `.venv` paths in `coverage.xml` fail to map to `sonar.sources=associate` and
  SonarCloud reports empty coverage.
- **Lint (all four must pass):**
  `uv run black --check associate tests`, `uv run isort --check-only associate tests`,
  `uv run flake8 associate tests`, `uv run bandit -c pyproject.toml -r associate`
- **Markdown:** `markdownlint-cli2 "**/*.md" "#node_modules" "#.local" "#.claude/skills" "#.teken"`
  — config is the repo-local `.markdownlint-cli2.yaml`; never depend on a
  per-user home-directory config. **Vendored skills are excluded on purpose** —
  do not reformat them.
- **Rubric gate:** `uv run teken cli doctor . --strict` — the agent-first CLI
  check described above. Run it before opening a PR; it is a required CI job.
- **Version bump — required on every PR, no exceptions:**
  `python3 .claude/skills/version-bump/scripts/bump.py {patch|minor|major}`
  (or `/version-bump`). The `version-check` CI job fails the run when
  `pyproject.toml`'s version matches `main` — including for docs-only and
  CI-only changes. This is an AgentCulture rule, not a suggestion.
- **Publish:** push to `main` triggers `publish.yml` → `uv build` → PyPI via
  Trusted Publishing (no API tokens). PRs publish `<version>.dev<run_number>` to
  TestPyPI. Fork PRs skip publishing (no OIDC context), and the SonarCloud step
  is guarded by `if: env.SONAR_TOKEN != ''` so token-less forks stay green.

## Finishing a branch: default to a PR

When work on a branch is complete and tests pass, **push the branch and open a
Pull Request** via the `cicd` skill (`workflow.sh open` / `devex pr open`) — do
not pause on an interactive "what next?" menu. This is the integration point for
the whole `branch → implement → bump version → PR` workflow, and it overrides the
Superpowers `finishing-a-development-branch` skill's default pause.
Merge-locally / keep-as-is / discard remain available only when the user asks.

`cicd` adds two extensions over `devex pr`: `status` (SonarCloud quality gate +
hotspots + unresolved-thread tally) and `await` (blocks, then exits non-zero on a
Sonar `ERROR` or unresolved threads).

## Skills convention (cite, don't import)

Skills are **copied** into `.claude/skills/<name>/` — associate owns its copy;
nothing is symlinked or installed as a cross-repo dependency. Each skill ships a
`SKILL.md` (frontmatter `name` **must equal the directory name**, and `type:
command` is load-bearing — `core.skill_loader` silently skips a `SKILL.md`
without it) and, where there is automation to run, `scripts/<entry-point>.sh`.
Scripts must not reach outside this repo.

**Vendored means vendored.** A finding a reviewer raises against a vendored
script — bot or human — is fixed **upstream and pulled back in on the next
sync**, never patched here. A local patch is exactly the drift the ledger exists
to prevent: the next re-sync silently reverts it, and meanwhile `diff -r` against
the origin stops being a meaningful check. The two deliberate, *documented*
exceptions (the `agex` → `devex` rename and the eidetic visibility override) are
recorded in [`docs/skill-sources.md`](docs/skill-sources.md) — **that ledger is
the authority on every skill's upstream, origin, and last sync.** Read it before
re-syncing anything.

Per-machine paths live in `.claude/skills.local.yaml` (git-ignored); the
committed `.claude/skills.local.yaml.example` documents every key. Skills read
the local file, falling back to the example.

### The devague chain (8 skills, origin `devague`)

`scope` → `think` → `challenge` → `spec-to-plan` → `assign-to-workforce` →
`deviate` → `validate-delivery` → `summarize-delivery` is one workflow, not eight
independent tools: idea → spec → plan → parallel implementation → accounted-for
delivery. These are vendored **directly from `../devague/`**, never from
guildmaster's re-broadcast (guildmaster's copies carry added `scripts/` wrappers
the originals don't have). Five of them are method-only `SKILL.md`s with no
scripts at all — that is correct, not an omission.

Three human gates run the chain: **the spec**, **the implementation split plan**,
and **the final PR**. Everything else is the agent's, and all of it is written
down. `devague` itself is deterministic — it never calls an LLM, runs a test, or
orchestrates agents; the fan-out lives in `assign-to-workforce`, and the tests run
agent-side with `validate-delivery` recording the result.

### Where worktrees live: `../.worktrees.associate/` (mandatory)

Every worktree you create — `assign-to-workforce` fan-out lanes, scratch
checkouts — goes under **one repo-owned root beside the repo directory**.
Resolve it, never hardcode it:

```bash
repo_root=$(git rev-parse --show-toplevel)
wt_root="$(dirname "$repo_root")/.worktrees.$(basename "$repo_root")"
git worktree add "$wt_root/agent-<task-id>" -b <scoped-prefix>/<task-id>
```

Two locations are **forbidden**: a shared `../worktrees/` (this workspace holds
~200 sibling projects, so that directory belongs to nobody, and task ids restart
at `t1` in every repo — two concurrent fan-outs collide on the same path), and
anything *inside* the repo (`git add -A` sweeps N checkouts into the PR and `git
clean -fdx` destroys live agent work).

Scope the branch prefix to the work; a plain `agent/*` collides with leftovers
from earlier fan-outs and fails `git worktree add -b`. Tear a lane down with
`git worktree remove "$wt_root/agent-<task-id>"` — `git worktree prune` only
clears metadata and leaves the directory. Never `rm -rf` the root itself; a
concurrent fan-out may be running inside it.

**The vendored `assign-to-workforce` SKILL.md uses the shared `../worktrees/`
path and plain `agent/<task-id>` branches in its fan-out example.** It is cited
verbatim and must not be edited — both are overridden by this section when you
follow it.

### Tooling prerequisites

On PATH in the standard AgentCulture dev setup:

- **`devex`** (>=0.21) — `cicd` delegates the PR lifecycle to `devex pr`.
- **`agtag`** (>=0.1) — `communicate` issue I/O wraps `agtag issue`.
- **`devague`** (>=0.24) — the 8-skill chain drives this CLI.

Optional, only when the skill is actually invoked (each degrades with a clear
install hint rather than blocking a clone):

- **`colleague`** — for `ask-colleague`; also needs a reachable backend (a local
  vLLM by default, overridable via `--engine` / `--model` / `--base-url` or
  `COLLEAGUE_*`).
- **`eidetic`** (>=0.10.0) — for `remember` / `recall`; the version floor is what
  routes public records in-repo instead of to `$HOME`.

## `steward doctor` invariants (build to pass these)

- **portability** — no absolute user-home paths in tracked files, and no
  per-user home-directory dotfile config references in committed
  `.md`/`.yaml`/`.toml`/`.json` outside documented carve-outs. Commit a
  repo-local config or document a portable lookup instead.
- **skills-convention** — every `.claude/skills/<name>/SKILL.md` has matching
  frontmatter `name`.
- **prompt-file-present** — a repo declaring an agent in `culture.yaml` has a
  recognized system-prompt file.
- **backend-consistency** — the declared `backend` agrees with the prompt file on
  disk.

Check with `steward doctor --scope self <path-to-associate>` from a steward
checkout. The first two checks are also covered locally by `associate doctor`.

## Conventions and workflow

### Memory discipline — recall before, remember after

This repo's memory is **in-repo and public**: a plain `/remember` resolves to
`<repo-root>/.eidetic/memory` — committed, and shared with the team and mesh
peers, so memory travels with the repo rather than a private home-dir store.
Both the `claude` and `colleague` backends resolve the same `associate` scope, so
they read each other's records.

- **`/recall` before you start** a non-trivial task — prior decisions, gotchas,
  "have we done this before?" — so you build on what's known instead of
  re-deriving it. Do this by habit, not only when asked.
- **`/remember` when something worth keeping surfaces** — a non-obvious decision
  and its rationale, a constraint, a fix and *why*, a gotcha that cost time.
  Capture it as it happens, not at the end when it has faded.

Pass `--visibility private` to route a record to `$HOME/.eidetic/memory` instead
(never committed); `/recall` reads both stores and merges. Don't store what the
repo already records — code structure, git history, or anything already in this
file or `CHANGELOG.md`. Store what you'd otherwise have to re-derive.

Note the drift flagged above: the wrapper script's public default is what runs;
the `SKILL.md` frontmatter still describes eidetic's upstream private default.

### Renaming this template's identifiers

If associate is ever forked into a new agent, the name is hard-coded in ~100
places. List them before touching anything:

```bash
git grep -n 'associate' -- ':!CHANGELOG.md' ':!.claude/skills'
```

The load-bearing sites are `pyproject.toml` (`[project].name`,
`[project.scripts]`, `[tool.hatch...]`, `[tool.coverage]`, `[tool.isort]`), the
package directory, `tests/`, `sonar-project.properties`, both workflow files
(they filter on `associate/**` paths), `culture.yaml`, and the **explain catalog
root key** — see invariant 3 under "Adding a verb".

## What not to invent

- **Don't add a runtime dependency.** `dependencies = []` is deliberate: the
  harness must install and start fast. `culture.yaml` is parsed by hand in
  `_commands/whoami.py` specifically to avoid a YAML dependency. If you think you
  need a dep, that is a conversation, not a commit.
- **Don't edit a vendored skill** to fix a bug in it. Fix it upstream.
- **Don't skip the version bump** because the change is "just docs".
- **Don't describe the harness as working** in docs, commits, or PR bodies until
  a read/summarize/find verb actually ships.
