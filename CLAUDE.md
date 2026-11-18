# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**associate** is a *multi-model agent harness* on [Pi](https://pi.dev): it runs
one of the fleet's models — chosen per run from a registry — on one task, with
that model's own tool set, prompt and permissions, and hands back what it saw,
what it did, and where. It began as a read/summarize/find worker that takes
non-coding tool work off [`colleague`](https://github.com/agentculture/colleague);
models the registry allows to change things now also write and edit, each
mutating call behind a CLEF safety gate and inside a per-run git worktree.

It is a sibling in the AgentCulture mesh alongside
[`colleague`](https://github.com/agentculture/colleague) (the diverse-backend
delegate), [`guildmaster`](https://github.com/agentculture/guildmaster) (the
skills supplier), [`steward`](https://github.com/agentculture/steward)
(resident-agent alignment), [`devague`](https://github.com/agentculture/devague)
(idea→spec→plan→delivery), and [`culture`](https://github.com/agentculture/culture)
(the IRC mesh itself). See the workspace-level `CLAUDE.md` one directory above
for the cross-project overview.

It serves two audiences: **the operator**, who runs it headless
(`associate run`) or as the mesh resident (`culture start associate`), and **mesh
peers** (colleague and others) that hand it read/summarize/find and, now,
execution work over IRC.

Sibling paths in this file (`../devague/`, `../guildmaster/`, `../lobes-cli/`)
**assume the workspace layout** where siblings are checked out in the same
parent directory. In a standalone clone, read the same files on GitHub or clone
the sibling beside this repo first. Each path names a project, not a guaranteed
location.

## Current state vs. target

**Read this before believing the description.** This repo was scaffolded from
`culture-agent-template` (`guild create`); `CHANGELOG.md` entries before `0.8.0`
are *template* history with the names substituted, not things that happened
here. Three devague plans have run since:
`docs/plans/2026-09-12-associate-on-pi-with-opinionated-tools.md` (the Pi
harness, 0.9.x), `docs/plans/2026-10-27-associate-multi-model-on-pi-1-1-0.md`
(the multi-model work, 0.10.0) and
`docs/plans/2026-11-17-associate-accuracy-method.md` (the accuracy method,
issue #20, 0.12.0).

**Before the multi-model plan** (commit `5f023e7`, 0.9.1 — check each with
`git show 5f023e7:<path>`): associate was bound to one model — the lobes
`associate` role, Nemotron 3.5 Lightning — through a single hardcoded provider
(`.pi/extensions/associate/lib/provider.ts:52`, `ASSOCIATE_PROVIDER_ID =
"associate"`, default model id `associate` at `:58`); it ran on pi 0.84.2
(`associate/harness/pi.py:57`); it never changed anything (every write outside
scratch refused as `repo_action`, `lib/guard.ts:166`); it had no memory, ledger,
decider or sub-agent tools; and its only quality measure was a 7-case in-house
suite whose last live run passed 1/7
(`docs/deliveries/2026-09-12-associate-on-pi-with-opinionated-tools.md:89`,
follow-up r26).

**What exists now** (all in-repo, covered by unit tests and the extension's
`node --test` suite against fakes; see "Measured vs. not measured" for what has
run live):

- **Pi 1.5.2.** The extension and harness moved from the 0.84.2 pin to 1.1.0
  and then to 1.5.2; every breaking change in between has a verdict in
  `docs/notes/pi-1.1.0-migration.md` and `docs/notes/pi-1.5.2-migration.md`.
- **A model registry** in the portable contract,
  `associate/contract/models.json`: `worker` (Pi label "bolt", the default),
  `senses`, `cortex`, and `super-vl` (status `pending`, no lobes role yet —
  not usable). Each entry names its lobes role, input modalities, reasoning
  mode, exact tool set, prompt file (`.pi/extensions/associate/prompts/`),
  `may_mutate`, and `may_spawn`. The provider (`lib/provider.ts`) and the Python
  adapter (`associate/harness/pi.py`) both read it; neither hardcodes a model.
  `associate run --model <key>` picks an entry.
- **Per-model tool surface and guard.** A model is offered only its registry
  tools (`pi.setActiveTools`), and `lib/guard.ts` refuses anything else.
  `senses` (`may_mutate: false`) never gets `write`/`edit`/`bash`/
  `ledger_append`/`run_tests`; `worker` and `cortex` may write and edit in the
  run checkout.
- **The CLEF safety gate** (`lib/gate.ts`, question set and thresholds in
  `associate/contract/gate.json`, version 9). Every mutating call
  (`models.json` `mutating_tools`) and every gated call (`gated_tools`:
  `eidetic_remember`, `web_search`, `web_page`, `delegate_run`) is scored by the lobes decider
  (`POST /v1/systemone`); below threshold it is refused. Tiers: CLEF, then
  Super (a chat model answering the same questions as JSON — counted as
  unreachable while `super-vl` is pending), then a read-only fallback that
  refuses every mutating call. The verdict lands in the walk. The thresholds
  (`safe_unattended` and `matches_task` ≥ 0.5) are **tentative**, set from one
  task's probes (`docs/notes/gate-calibration.md`, deviations d8–d11); issue #13
  is the CLEF benchmark that replaces them, and #14–#17 are the follow-ups.
- **Worktree per mutating run** (`associate/harness/worktree.py`): a
  `may_mutate` model runs in `../.worktrees.<repo>/run-<session>` on branch
  `associate-run/<session>`; only a clean run is committed and merged to `main`
  locally (never pushed); anything else is kept and reported.
  `--untrusted-checkout` (deviation d5) ignores the examined checkout's own
  `.pi` settings, extensions and MCP config.
- **Operator test commands** (deviation d12): `--test-command` names commands
  the harness runs after the model (`associate/harness/testcmds.py`); a worktree
  run merges only when all exit 0. The same commands are offered to writing
  models as the gated `run_tests` tool (`tools/tests.ts`).
- **Tools beyond the base set:** `eidetic_recall` / `eidetic_remember`
  (`tools/eidetic.ts`, shelling out to eidetic-cli with a pinned destination
  outside the checkout); `ledger_append` / `ledger_list` (`tools/ledger.ts`,
  over workledger-cli 0.8.0's `ledger append|list`); `spawn_subagent`
  (`tools/spawn.ts`, cortex only, children `worker` or `senses`, one writing
  child per checkout at a time, child walk paths recorded in the parent walk; a
  child is marked `ASSOCIATE_SPAWNED_BY` and holds no tool that starts another
  run — not `spawn_subagent`, not `delegate_run` / `delegate_status`);
  image blocks from `read` for models whose entry lists `image` input.
- **Delegation from the read-only resident** (deviation d18, `tools/delegate.ts`):
  senses holds `delegate_run` and `delegate_status`, allowed targets from
  `models.json` `may_delegate` (senses: `worker`; every other model `[]`).
  `delegate_run` starts `associate run --model <target> --checkout <session
  checkout> --json` **detached** and returns a run id at once (culture's turn
  timeout is 600 s; live worker runs took up to ~25 min); `delegate_status`
  reads the run's `--json` result (outcome, merge, merge_reason, worktree,
  tests, final_reply) or reports it running, failed or lost. The run is the
  in-tree CLI — `<tree>/.venv/bin/python` (else `python3` on PATH) `-m
  associate`, cwd and `PYTHONPATH` set to the tree that holds the extension
  (`lib/paths.ts` `associateRoot`), `ASSOCIATE_EXTENSION_PATH` to this
  extension — never the PATH `associate` and never `uv`, so the tree's
  `uv.lock` is untouched. It passes every operator test command from
  `ASSOCIATE_TEST_COMMANDS` as `--test-command` (and refuses to start with
  none configured), `--untrusted-checkout` unless `ASSOCIATE_PI_TRUST` is
  `approve`, and `--timeout` from `policy.json` `budgets.delegate.timeout_ms`.
  One delegated run per checkout at a time, across processes: the run holds a
  kernel `flock` for its whole life (`--checkout-lock`,
  `associate/harness/checkoutlock.py`, a lock file keyed by the checkout's real
  path under `ASSOCIATE_RUNS_DIR`), and `delegate_run` asks whether it is held
  before starting anything. It refuses a checkout outside git, and it refuses
  in a session `spawn_subagent` started (a child is never a spawner).
  Its export root is `<session root>/delegated`, its session id the run id, its
  stdout/stderr beside it; a `child` line in the session walk names its walk.
  `delegate_run` is in `gated_tools` (CLEF-gated for every model, effect line in
  `gate.json` version 9), not in `mutating_tools`; `delegate_status` is a read,
  and its result taints later memory records `untrusted:child`.
- **The bridge** (0.11.0; page `docs/operations/bridge.md`). *Bridge* here means one
  app with a CLI, an HTTP API and an MCP server over the same verbs, plus a
  read-only web UI (see [Web UI](#web-ui-web)). Another service starts a detached
  `associate run` on a checkout and reads the result:
  - `associate/runs/` holds the verbs: `service.py` (`start`, `show`,
    `list_runs`, and `VERBS`, the one table every surface reads), `state.py`
    (state layout, atomic JSON, the `flock` checkout lock), `supervisor.py` (the
    detached process that runs `python -m associate run --json
    --untrusted-checkout` and writes `result.json`) and `mcp_tools.py`;
  - `associate/server/` is the HTTP API (`app.py`: `POST /runs` admin,
    `GET /runs/{run_id}` and `GET /runs` viewer, public `GET /health`;
    `serve.py`: a loopback listener on `127.0.0.1:8794` that trusts Cloudflare
    Access, and an optional LAN listener, port `8795`, service tokens only;
    `tokenstore.py`: the token file); `create_app` mounts the built UI from
    `associate/web_dist` when the package holds one;
  - `associate/bridge/` is the app-agnostic framework (auth, route policy,
    Access JWTs, service tokens, MCP server), cited from qodo-cli, which cited
    it from culture-rules; it names no app. This repo owns its copy (cite, don't
    import); each file's header names the source and commit. `origin.py` is
    original here: before authentication, every method but GET/HEAD/OPTIONS
    needs a JSON body (415) and is refused 403 when `Sec-Fetch-Site` is
    `cross-site` or `Origin` is foreign, so a page cannot ride an Access cookie
    into a start;
  - the CLI verbs are `runs start|show|list`, `serve`, `tokens
    issue|list|revoke` and `mcp`. `serve` needs the `server` extra and `mcp` the
    `mcp` extra; the base package stays dependency-free;
  - `tests/test_surface_parity.py` fails when a runs verb is missing from the
    CLI, the MCP tools or the HTTP routes. A new verb goes in `VERBS` and needs
    no edit there. It runs against the API-only app and the app serving a UI;
    the UI's routes (the SPA fallback `static.install` adds) and the no-UI root
    404 are classified explicitly, not exempted by loosening the check;
  - a run **merges into the checkout's local `main`** when it is clean and its
    tests pass, and never pushes, so the checkout is a dedicated clone;
    `ASSOCIATE_RUNS_ROOTS` empty refuses every start over HTTP and MCP;
  - `ok` is true only when the exit code is 0, the outcome is `ok`, the tests
    passed and `merge` is `merged` or `nothing_to_merge`. A read-only model
    (`senses`) makes no merge, so its run is never `ok`;
  - **built and unit-tested only**: every test run uses the stand-in child
    `tests/runs_fake_child.py`; no real run has been started through the
    bridge. Known gaps are listed in `docs/operations/bridge.md`.
- **The run result** names the model and lobes role that ran, the isolation and
  merge outcome, the test results, and how the task turn ended (final reply,
  stop reason, lane error).
- **Public benchmarks as data** (`associate/bench/suites.json`: BFCL, MMMU,
  LiveCodeBench), run by `associate bench --suite <name> --model <key>` through
  each suite's own upstream runner and scorer. The in-house behavioral suite was
  dropped (plan task t9). Every suite entry is `verified: false`.
- `walkstats` (`associate/bench/walkstats.py`) reports gate-tier shares and
  read-only fallback counts over a set of walks.
- **The accuracy method** (issue #20; settings in
  `associate/contract/accuracy.json`, checks and the failure behind each in
  `docs/notes/accuracy-checks.md`):
  - **A purpose on every call.** Every tool call except `finish` and
    `associate_ready` must carry a `purpose` argument; the `tool_call` hook
    refuses one without it (`lib/guard.ts`), with the fix in the refusal. The
    purpose is recorded in the walk and stripped from what the safety gate is
    sent, so `gate.json` is unchanged.
  - **The walk entry is the action record** (`lib/walk.ts`, walk format 2,
    first line a format marker): purpose, arguments as asked and as used,
    source kind (from the contract table), and the name of a saved result file
    (`results/wN.txt` in the export, written by `lib/results.ts`). Every tool
    result the model sees starts with a `walk id: wN` line. A call pi rejects
    before the hook is recorded from `tool_execution_end`.
  - **Facts are checked.** `finish` accepts facts (value, source, quote),
    alternatives, verdicts and open items (`facts.schema.json`).
    `lib/facts.ts` checks each quote against the saved result of the entry it
    cites with a deterministic matcher (`lib/matcher.ts`), refuses a fact that
    an action happened unless it cites a successful call of that tool, and
    refuses a closing conclusion that rests only on an agent's report or a
    memory record. The model can run the same matcher with the `check_quote`
    tool. A source is `wN`, or labelled `prior:wN` (a `--continue-from` run) or
    `cN:wN` (a child); labels are looked up, never opened.
  - **Report and enforce modes.** `accuracy.json` `mode` is per model and is
    `report` for every model: nothing is refused and `report.json` lists what
    would have been. In `enforce` a failing hand-back is refused with each fix
    and the model may answer again for `retry_rounds`; after the last round
    the run ends `refused`. `associate run --check-mode` (the
    `ASSOCIATE_CHECK_MODE` variable) overrides the mode for one run.
  - **What a run leaves and returns.** The export gains `facts.json`,
    `check.json`, `report.json` and `answer.md` (the answer rendered by the
    harness from accepted items; the model's own summary and final message are
    kept under an unchecked label and counted). `associate run --json` carries
    the rendered answer, the counts from a Python re-check
    (`associate/accuracy/`), and `handback_outcome`; a hand-back refused after
    the allowed rounds exits 3 with the result still printed.
    `associate check <export-dir>` prints the same counts for any export.
  - **A passed fact means its quote was found** in the saved result it cites.
    It does not mean the value is true. Never call that count accuracy.

### Measured vs. not measured

**Measured live:** worker (bolt) runs on this repo, under the gate, each
reviewed and fixed before merge — `live-bolt-fix-f2c` drafted the bug-F2 fix
(commit `ceb5a7e`; it hit its timeout, and one defect the suite found was fixed
in `1669af3`), and `live-bolt-tests-gaps2` wrote three `run_tests` tests, ran
them with `run_tests`, and was kept out of `main` by the harness test check
(commit `50c7630`, fixed in review). Plan task t20 then recorded single live
runs on pi 1.1.0 (`docs/notes/t20-live-acceptance.md`):

- a walk each for `worker`, `senses` and `cortex`;
- every worker and cortex mutating call carried a gate verdict;
- a fault-injected run, with the decider unreachable, fell back to read-only
  while reads still ran;
- a cortex run linked one `senses` and one `worker` child walk;
- the `culture start associate` resident starts through pi-acp.

It runs as a systemd user unit that passes only the gateway key, with
`ASSOCIATE_MODEL=senses` (no checkout writes). Together with the probe bench
in `docs/notes/gate-calibration.md`, that is the whole of the live evidence.
Each item is one run, not a rate.

**The accuracy method, measured live** (2026-11-17/18, pi 1.5.2, reasoning off
for both models, report mode; `docs/notes/accuracy-live-acceptance.md`): six
tasks each on `worker` and `cortex` handed back, with the extension's counts,
the Python re-check and a hand count agreeing in 12 of 12 runs and none of the
42 passed facts failing a separate re-check. `worker` had 7 of 26 facts pass,
`cortex` 35 of 40. One enforce-mode worker run was refused twice and accepted
on its third `finish`; another ended with no `finish`. A continued cortex run
reviewed a real change and cited the earlier run with a `prior:` label. Each
is one run.

**Not measured yet. Do not describe any of it as working:**

- the resident's first reply on the mesh: it paused under the 23:00–08:00
  sleep schedule before answering;
- a writing model on the mesh: mesh sessions get no run worktree;
- delegation from the resident (d18): `delegate_run` / `delegate_status` are
  built and unit-tested against a fake launcher only; no delegated run has been
  started live. While the resident's checkout is on a branch whose base is not
  on `main`, the harness keeps (does not merge) every delegated run — see
  `associate/harness/worktree.py`;
- **any** benchmark score: no row of the 8-row matrix has run (t21);
- the accuracy method on `senses` (the gateway reported the role not feasible
  on the measuring machine), with reasoning on, on the mesh path, in spawned
  children or delegated runs, with a real `ledger` binary, or in enforce mode
  beyond two worker runs; the recording of calls pi rejects before the hook is
  tested against a fake pi only.

Say "built and unit-tested", never "works", for these. Live findings that
remain open: worker sometimes ends without `finish` (seen again in an
enforce-mode run); neither model replied with exactly the rendered answer in
any measured run, so its final message is always counted as unchecked text;
and the action rule refuses a true report that a call failed. The senses
statement that claimed an action it never took is now a replay test
(`tests/fixtures/accuracy/`), rebuilt from the note; it has not been
re-measured live.

**One known inconsistency in the inherited scaffold** — don't "fix" it by
guessing which side is right; ask. The `remember` skill's `SKILL.md` frontmatter
says records default to the home-dir store (`$HOME/.eidetic/memory`) at
**private** visibility; its `scripts/remember.sh` actually defaults to **public**
(in-repo). The script is authoritative — see [Memory discipline](#memory-discipline--recall-before-remember-after).
(This concerns the Claude Code skill only; the extension's `eidetic_remember`
tool always pins its own destination.)

**The bound is split in two (deviation d13).** `associate/contract/role.json`
is the harness-wide bound every model shares: none may take a
`final_decision` or a `security_decision`. What each model may change is
owned by `models.json` (`may_mutate`, tools, `may_spawn`). `worker` and
`cortex` hold `repo_action` and `code_authoring`; `senses` does not.
`AGENTS.md` states the same per-model bound to the model.

## The runtime lanes: models addressed by lobes role

associate no longer has a lane of its own. Every registry model is a **lobes
role** served by the local lobes gateway
([`lobes`](https://github.com/agentculture/lobes-cli), default
`http://localhost:8001/v1`), and associate addresses it by role name, never by a
checkpoint id. The gateway resolves a role to whichever box and checkpoint
currently serve it, so a lane can move or re-checkpoint without touching this
repo. That is lobes' stated purpose, and it is why no checkpoint id appears in
`models.json`, `culture.yaml`, or this file.

| Registry key | lobes role | What lobes says the role is for (`../lobes-cli/lobes/roles.py`, `ROLE_RESPONSIBILITIES` at `:325`, read 2026-10-27) | associate grants |
|---|---|---|---|
| `worker` (bolt) | `worker` | the fast doer: `execution`, `tool_use`, `repo_inspection`, `run_authorized_commands`, `repo_action`, `image_understanding` | writes behind the gate; no spawn |
| `senses` | `senses` | intake: `intake`, `normalize_input`, `classify_intent`, `prepare_context_packet`; served on the `multimodal` backend (role hint at `:153`) — no `image_understanding` token | read-only; memory writes behind the gate |
| `cortex` | `cortex` | `reasoning`, `planning`, `tool_use`, `code_repo_actions`, `image_understanding` | writes behind the gate; spawns `worker` / `senses` |
| `super-vl` | — (pending) | not yet a lobes role | not usable |

The decider (CLEF) is the lobes `decider` role (`typed_decision`,
`guardrail_check`), reached at `/v1/systemone`, not a chat model and not a
registry entry. "bolt" is not a lobes role: it is the Pi provider label for the
`worker` role.

What serves a role is measured, not assumed. On 2026-10-27, every reply in a
live pi run on the `worker` role reported `responseModel`
`nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB` in pi's JSON event stream (24
of 24 assistant messages). That is an observation of the gateway on that
date, not a pin. Re-read `responseModel` rather than trusting this line, and
never copy a checkpoint id into the contract. The other roles' serving
checkpoints have not been read from a live run.

The earlier lane — the lobes `associate` role, Nemotron 3.5 Lightning on the
Jetson AGX Orin, `worker` MINUS `repo_action` — is **out** (spec claim c30);
`worker` replaces it as the default. The lobes `associate` role itself is
untouched (this work changes no file in lobes-cli or colleague; spec boundary
c18). Its history is in `CHANGELOG.md` (0.8.0–0.9.1).

## Identity: this file is not the runtime prompt

`culture.yaml` declares `backend: acp` with `acp_command: ["pi-acp"]`, so the
**resident agent's** runtime prompt is [`AGENTS.md`](AGENTS.md), followed by the
active model's prompt from `.pi/extensions/associate/prompts/`. This `CLAUDE.md`
is the prompt for **Claude Code sessions working on the repo** — the two
audiences are different and both are real. `AGENTS.colleague.md` is retained
until the ACP path is verified live (t20), so the cutover stays one revert.

`culture.yaml`'s `model: worker` is the registry key of the default model. It
does **not** by itself select the resident's model: pi-acp ignores the ACP
`session/new` model and culture never sends `session/set_model`; the extension
pins the session to the registry model on `session_start` when
`ASSOCIATE_API_KEY` is set (`docs/notes/resident-model-resolution.md`). Whether
that holds on a live `culture start associate` is part of t20.

The `backend-consistency` invariant checks that the declared backend agrees with
the prompt file on disk (`claude` → `CLAUDE.md`, `colleague` →
`AGENTS.colleague.md`, `acp` → `AGENTS.md`, `gemini` → `GEMINI.md`). If you ever
change `backend:`, the matching prompt file must exist or both
`associate doctor` and `steward doctor` fail. Verify with:

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
├── explain/
│   ├── __init__.py         # resolve(path) / known_paths()
│   └── catalog.py          # ENTRIES: dict[tuple[str, ...], str] of markdown
├── contract/               # the portable contract: models.json, gate.json,
│                           #   role.json, policy.json, schemas/, validate.py
├── harness/                # adapters (pi.py, stub.py), worktree.py, testcmds.py,
│                           #   checkoutlock.py
├── runs/                   # the bridge's verbs: service, state, supervisor, mcp_tools
├── server/                 # the bridge's HTTP API: app, serve, tokenstore (server extra)
├── bridge/                 # cited framework: auth, policy, Access, tokens, MCP server,
│                           #   static UI serving, origin check
├── accuracy/               # the Python re-check: matcher.py, check.py, counts.py
└── bench/                  # public suites (suites.json, public.py), walkstats
web/                        # the web UI (Vite + React + TS); built into the wheel as
                            #   associate/web_dist by hatch_build.py (never committed)
.pi/extensions/associate/   # the Pi extension (TypeScript, no npm deps)
├── index.ts                # loader: registry model, tool surface, guard, gate
├── lib/                    # provider, guard, gate, walk, session, contain,
│                           #   results, matcher, facts, handback, render, …
├── tools/                  # read, search, shell, web, codelens, eidetic,
│                           #   ledger, tests (run_tests), spawn, delegate,
│                           #   check (check_quote)
├── prompts/                # one prompt per registry model
└── tests/                  # node --test suite (run.sh)
tests/                      # pytest — CLI, contract, run, worktree, gate, …
.claude/skills/<name>/      # SKILL.md + scripts/ per skill (cite-don't-import)
docs/skill-sources.md       # skill provenance ledger — authoritative
docs/notes/                 # pi migrations, gate calibration, resident model,
                            #   accuracy checks and live acceptance
docs/accuracy/tasks.json    # the fixed measurement tasks, hand-checked answers
docs/operations/            # the bridge: operators, agents and integrators
culture.yaml                # agent suffix + backend + model (a registry key)
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
   environment/setup error, `3` a hand-back refused after the allowed rounds
   (`associate run` only, result still printed), `4+` reserved.

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

## Web UI (`web/`)

A Vite + React + TypeScript app with two read-only screens, Runs (`/runs`) and one
run (`/runs/<id>`), whose toolchain, design tokens (`web/src/culture-design/`,
checked by `npm run check`) and conventions are cited from qodo-cli's `web/`
(which cited culture-rules'); every cited file carries a provenance header with the
source path and commit. The confirmed artboards ("associate: Runs" and "associate:
One run" on the shared design canvas) are the visual source of truth; the UI shows
only fields the API returns (`list_runs`, `show`) and invents none. Commands, from
`web/`: `npm ci`, `npm run typecheck`, `npm test`, `npm run check` (the design
tokens), `npm run build`. The browser calls the same-origin `/api` prefix, which
`associate serve` strips (`associate/bridge/static.py`); in dev `npm run dev`
proxies it to `ASSOCIATE_API_URL` (default `http://127.0.0.1:8794`). This app has
no pinned OpenAPI file: the client's routes live in `web/src/api/routes.json`, and
`tests/test_web_contract.py` binds them to `VERBS` and the fixtures
(`web/src/fixtures/runs.json`) to the real `list_runs`/`show` fields.

`hatch_build.py` packages an existing `web/dist` as `associate/web_dist`
(git-ignored build output) and never runs Node, so a wheel built without Node is
API-only. Release order: `npm ci && npm run build` in `web/`, then `uv build` with
`ASSOCIATE_REQUIRE_WEB=1` (a missing build then fails the build);
`ASSOCIATE_SKIP_WEB=1` leaves the UI out on purpose. `.github/workflows/publish.yml`
does exactly this, and the `web` job in `tests.yml` runs install, typecheck,
vitest, the tokens check and the build. `web/package.json` is the UI's own
manifest; the root `package.json` stays the Pi manifest with no dependencies.

## Build, test, lint, publish

- **Dev install:** `uv sync` (add `--extra server --extra mcp` for the bridge's
  HTTP API and MCP server; their tests skip without them)
- **Run from source:** `uv run associate --version` / `uv run python -m associate ...`
- **Tests:** `uv run pytest -n auto -v`
- **Single test:** `uv run pytest tests/test_cli.py::test_whoami_json -v`
- **Extension tests:** `bash .pi/extensions/associate/tests/run.sh` — Node's
  built-in test runner over `.pi/extensions/associate/tests/*.test.ts` (Node
  >=22; skips with a reason below that). A required CI job.
- **Plumbing check:** `uv run associate run --harness stub` — the run verb
  against the stub adapter; labelled `plumbing_only`, never a claim about a
  model.
- **Re-check an export:** `uv run associate check <export-dir>` — the calls
  with their purposes, each fact with its source kind, and the counts,
  recomputed from the saved files. Reads only; works on old exports.
- **Public benchmarks (operator-side, never CI):**
  `uv run associate bench` lists the suites in `associate/bench/suites.json`;
  `uv run associate bench --suite bfcl --model worker` launches the upstream
  runner and scorer through the gateway. They need the upstream tool installed,
  network, and a lane key. No suite has been run yet (t21).
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

**A `.gitignore` subtlety for the Pi extension's TypeScript source:** the
Python-project `.gitignore` template ignores a bare `lib/` (setuptools build
output), which would silently swallow `.pi/extensions/*/lib/` — the directory
the Pi extension's actual TypeScript source (`contain.ts`, `contract.ts`,
`session.ts`, `runtime.ts`, …) lives in. `.gitignore` re-includes that tree
explicitly (`!.pi/extensions/*/lib/` and `!.pi/extensions/*/lib/**`, plus a
belt-and-suspenders `!.pi/extensions/associate/lib/` line) — the directory
itself has to be un-excluded before git will look inside it. If a future
extension adds another `lib/` under `.pi/extensions/<name>/`, extend the
existing glob rather than adding a parallel one-off exception.

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

#### The Pi harness pins (exact pins, not floors-and-up)

What a Pi-driven associate run depends on, pinned exactly because they are the
versions the extension's tests and the worker live runs used:

- **`pi`** (`@earendil-works/pi-coding-agent`) — **1.5.2**. Migrated from
  0.84.2 through 1.1.0; every breaking change in between has a verdict in
  `docs/notes/pi-1.1.0-migration.md` and `docs/notes/pi-1.5.2-migration.md`.
  The pin lives in `associate/harness/pi.py`.
- **`pi-acp`** — **0.0.33**. Bridges ACP JSON-RPC over stdio to
  `pi --mode rpc`; MVP-grade and Zed-centred per its own README. It has not
  been checked against pi 1.5.2, and the mesh path through it is not measured.
- **Node** — **>=22** (pi-acp's floor, and the extension test runner's).
- **the portable contract** (`associate/contract/`) — `models.json` version 1,
  `gate.json` version 9 (d18 added the `delegate_run` effect),
  `accuracy.json` version 1, walk format 2. A
  contract-version bump is a compatibility event, not a patch note; a `gate.json` bump changes what CLEF is asked, so record why
  (`docs/notes/gate-calibration.md`). 0.12.0 changed the contract without a
  version bump of `models.json`: the tool name `check_quote` was added to
  `tool_names` and to every model, and the walk schema gained fields (old
  exports still load).
- **CLIs the tools shell out to** — `eidetic` (eidetic-cli) for
  `eidetic_recall` / `eidetic_remember`, and `ledger` from **workledger-cli
  0.8.0** (the release that ships `ledger append` / `ledger list`) for the
  ledger tools. Each tool degrades with an install hint when its CLI is absent.

**Upgrade rule:** bump a pin only after the extension tests pass and a live run
has been measured against the new version — never bump ahead of a measured run.
`pi update` is never run by the harness itself; the launcher checks the
installed version against the pin and warns (naming the tested version) rather
than silently working with whatever is on PATH.

The extension declares no npm dependency beyond what Pi itself provides
(`typebox`, via `pi`), and no `node_modules/` directory is ever tracked — see
the `.gitignore` re-include note under "Skills convention" above for the one
place that rule gets subtle.

#### `ASSOCIATE_*` environment variables

These are the whole external interface to the lanes, the gate, and the session
plumbing — no committed file names a host, port, or bearer beyond the documented
gateway default. Every row is read by the code named in it; "set by
`associate run`" means the launcher sets (or clears) it per run and an operator
value is not inherited.

| Variable | Default | Read by | Purpose |
|----------|---------|---------|---------|
| `ASSOCIATE_BASE_URL` | `endpoint.default_base_url` in `models.json` (the local lobes gateway) | `lib/provider.ts`, `lib/gate.ts`, `associate/bench/public.py`, `associate/harness/pi.py` (bench's served-model probe) | OpenAI-compatible base URL for the model lanes, the CLEF decider (`/v1/systemone`) and Super, and the benchmark runners. |
| `ASSOCIATE_API_KEY` | — | `lib/provider.ts`, `lib/gate.ts`, `tools/spawn.ts`, bench | Bearer for that endpoint. Unset: no `associate` provider is registered (pi's own default model applies, and `associate run` says so), and CLEF counts as unreachable, so the gate falls back to read-only. Never committed, never logged, never needed by a test. |
| `ASSOCIATE_MODEL` | `default` in `models.json` (`worker`) | `lib/provider.ts`, `lib/prompt.ts`, `associate/harness/pi.py`; set by `associate run --model` and by `spawn_subagent` for a child | The **registry key** of the active model. The wire `model` is that entry's `lobes_role`, never a checkpoint id. An unknown or `pending` key registers no provider and prints one error line. |
| `ASSOCIATE_CONTRACT_DIR` | repo-relative `associate/contract/` | `lib/contract.ts`; set by `associate run` | Where the extension loads `models.json`, `gate.json`, `role.json`, `policy.json` and the schemas. |
| `ASSOCIATE_SESSION_ID` | `PI_ACP_SESSION_ID` / `ACP_SESSION_ID`, else generated | `lib/session.ts`; set by `associate run` and per child by `spawn_subagent` | Keys the scratch and export directories, so concurrent runs never share one. |
| `ASSOCIATE_EXPORT_ROOT` | `.associate-runs` beside the checkout | `lib/session.ts`; set by `associate run` | Where the session directory (`<root>/<session id>/export`, holding `walk.jsonl` and the statements) is created — always outside the examined checkout. |
| `ASSOCIATE_CHECKOUT_ROOT` | the process cwd | `lib/runtime.ts`; set by `spawn_subagent` for a child | The checkout a session examines and confines tools to. |
| `ASSOCIATE_CONTINUE_FROM` | — | `lib/torch.ts`; set by `associate run --continue-from` | A prior run's export directory, loaded as this session's first context. |
| `ASSOCIATE_INJECT_PROMPT` | — | `lib/prompt.ts`; set to `1` by `associate run` | With pi's ancestor context-file discovery off, inject associate's own `AGENTS.md` as the runtime prompt plus the active model's prompt — both from associate's install (`prompts/<model>.md`), never from the checkout — and nothing above it. The examined checkout's `AGENTS.md` (when it is not associate's own install) is injected only when `ASSOCIATE_PI_TRUST` is `approve`, labelled as repository context, between the two (deviation d17). Unset for the mesh resident (pi-acp), whose pi loads context files itself. |
| `ASSOCIATE_EXTENSION_PATH` | the `.pi/extensions/associate/index.ts` above the installed package | `associate/harness/pi.py`; set by `delegate_run` for a delegated run | The extension entry point `associate run` passes pi with `-e`. |
| `ASSOCIATE_ISOLATION` | absent (read as `in-place`) | `index.ts` → `lib/gate.ts`; set by `associate run` | Where the run's checkout writes land, `worktree` or `in-place`; told to CLEF as the `isolation` state line (deviation d8). |
| `ASSOCIATE_TEST_COMMANDS` | absent | `tools/tests.ts`, `tools/delegate.ts`; set by `associate run --test-command` | The operator's test commands as a JSON array of argv lists, for the `run_tests` tool. The harness runs the same commands itself after the model (deviation d12). For the mesh resident the operator sets it in the unit's environment: `delegate_run` passes each one to the delegated run as `--test-command` and refuses to start any run while it names none (d18). |
| `ASSOCIATE_PI_TRUST` | absent (read as untrusted) | `lib/trust.ts`, read by `tools/spawn.ts`, `tools/delegate.ts` and `lib/prompt.ts`; set by `associate run` | `approve` or `untrusted`, from how the parent pi was launched (deviation d5); only the exact value `approve` is trust. It gives a child `--approve` and a delegated run no `--untrusted-checkout` (neither is ever more trusting than its parent) and lets the examined checkout's `AGENTS.md` be injected as repository context (d17); anything else skips that file. |
| `ASSOCIATE_RUN_DEADLINE` | absent (no cap beyond `budgets.spawn.timeout_ms`) | `tools/spawn.ts`; set by `associate run` from `--timeout`, never inherited | The parent run's deadline as absolute epoch milliseconds. Each child's wall clock is the contract's `timeout_ms` capped at what is left of the run minus a safety margin, measured after any wait for the writer lock; a spawn with too little time left is refused (`run_deadline`) rather than started to be killed. |
| `ASSOCIATE_SPAWNED_BY` | absent | `lib/toolset.ts`; set by `spawn_subagent` for a child, removed by `associate run` from the pi it starts | The parent's session id, marking a spawned child. In a marked session `spawn_subagent`, `delegate_run` and `delegate_status` are not in the model's tool set and refuse by themselves: a child is never a spawner. |
| `ASSOCIATE_DELEGATED_RUN` | absent | `associate/harness/pi.py`; set by `delegate_run` on the delegated `associate run` process, removed from the pi that run starts | The delegated run's id. A run timeout kills every descendant of pi except a process started with this variable: a delegated run outlives the session that started it. |
| `ASSOCIATE_RUNS_DIR` | `$XDG_STATE_HOME/associate/runs`, else `$HOME/.local/state/associate/runs` | `associate/harness/checkoutlock.py` | The state directory holding `locks/<sha256 of the checkout's real path>.lock`, the one-run-per-checkout lock `associate run --checkout-lock` holds (a kernel `flock`). Must be outside every checkout. |
| `ASSOCIATE_EIDETIC_DIR` | `$HOME/.eidetic/memory` | `tools/eidetic.ts` | The eidetic store the memory tools pin (`EIDETIC_DATA_DIR`); must be absolute and outside the examined checkout. |
| `ASSOCIATE_LEDGER_PATH` | `$HOME/.workledger/associate.jsonl` | `tools/ledger.ts` | The workledger file the ledger tools pin (`WORKLEDGER_PATH`); must be absolute and outside the examined checkout. |
| `ASSOCIATE_CHECK_MODE` | absent (the model's `mode` in `accuracy.json`) | `lib/handback.ts`; set by `associate run --check-mode`, never inherited | `report` or `enforce` for this run's hand-back check; any other value is ignored with one stderr line. |
| `ASSOCIATE_RUNS_DIR` | `$XDG_STATE_HOME/associate/runs` (else `~/.local/state/associate/runs`) | `associate/runs/service.py` | The state directory of `associate runs` (one directory per run id, plus the per-checkout lock files); refused inside a checkout. Never inherited by a run. |
| `ASSOCIATE_RUNS_ROOTS` | empty | `associate/runs/service.py` | The `os.pathsep`-separated directories a `runs start` checkout must be in (by real path). Empty: the HTTP API refuses every start; the local CLI is not restricted. Never inherited by a run. |
| `ASSOCIATE_SERVER_TOKENS` | `$XDG_STATE_HOME/associate/service_tokens.json` | `associate/server/tokenstore.py` (`default_token_path`, `open_tokens`) | The file-backed service-token store (`associate/bridge/filetokens.py`; hashes only) that `associate tokens` writes and `associate serve` reads. Never inherited by a run. |
| `ASSOCIATE_HOST`, `ASSOCIATE_PORT` | `127.0.0.1`, `8794` | `associate/server/serve.py` (`plan_listeners`) | `associate serve`'s loopback listener (always on; must be a loopback address). Flags `--host`/`--port` win. |
| `ASSOCIATE_LAN_HOST`, `ASSOCIATE_LAN_PORT` | unset (no LAN listener), `8795` | `associate/server/serve.py` | `associate serve`'s optional LAN listener (service tokens only). Flags `--lan-host`/`--lan-port` win; it cannot share the loopback address. |
| `ASSOCIATE_ACCESS_LISTEN`, `ASSOCIATE_ACCESS_TEAM_DOMAIN`, `ASSOCIATE_ACCESS_AUD` | unset | `associate/bridge/access.py` (`AccessListenerConfig.from_env`) | Cloudflare Access on the loopback listener: all three or none (a partial set is refused, exit 1); `ASSOCIATE_ACCESS_LISTEN` is a loopback `host:port`. |
| `ASSOCIATE_ADMINS`, `ASSOCIATE_EDITORS` | empty | `associate/server/serve.py` (`names`) | Comma-separated identities Access lets through as admin or editor; any other Access person is a viewer. |
| `ASSOCIATE_REQUIRE_WEB`, `ASSOCIATE_SKIP_WEB` | unset | `hatch_build.py` | At build time: `1` fails a build with no `web/dist`, or leaves the UI out of the wheel on purpose. |
| `ASSOCIATE_API_URL` | `http://127.0.0.1:8794` | `web/vite.config.ts` | The API the UI's dev server (`npm run dev`) proxies `/api` to. |
| `ASSOCIATE_DESIGN_SOURCE_REPO` | unset | `web/scripts/check-tokens.mjs` | A culture-rules checkout; when set, the tokens check also compares `tokens.css` with it at the pinned commit. |
| `ASSOCIATE_BENCH_SUITES` | `associate/bench/suites.json` | `associate/bench/public.py` | An alternative suites file for `associate bench`. |
| `ASSOCIATE_PROVIDER`, `ASSOCIATE_REASONING_EFFORT`, `ASSOCIATE_REASONING` | — | `associate/bench/config.py` | Only labels in a bench row's configuration stamp (provider falls back to `ASSOCIATE_BASE_URL`); they change nothing on the wire. Reasoning is per model in `models.json`. |

`ASSOCIATE_TEST_PI_PROVIDER` / `ASSOCIATE_TEST_PI_MODEL` appear only in the
extension's integration tests, and `ASSOCIATE_PROVIDER_ID` is a constant in
`lib/provider.ts`, not an environment variable.

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
Claude Code sessions and any other backend using these skills resolve the same
`associate` scope, so they read each other's records. (The extension's
`eidetic_remember` tool is separate: it pins its own destination, see
`ASSOCIATE_EIDETIC_DIR`.)

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
  harness must install and start fast. The same holds for the root `package.json`: it is
  a Pi project manifest with no `dependencies` and no `scripts` (the web UI's npm
  packages live in `web/package.json` and never reach the Python package). `culture.yaml` is parsed by hand in
  `_commands/whoami.py` specifically to avoid a YAML dependency. If you think you
  need a dep, that is a conversation, not a commit.
- **Don't edit a vendored skill** to fix a bug in it. Fix it upstream.
- **Don't skip the version bump** because the change is "just docs".
- **Don't describe a model, the mesh path, the gate's fallbacks, delegation, or
  the bridge as working** in docs, commits, or PR bodies until a live run measures it
  (t20) — and don't quote a benchmark number until t21 commits one. The worker
  live runs listed under "Measured vs. not measured" are the only live evidence;
  say exactly what exists and what doesn't; don't round up.
- **Don't call the quote-checked count accuracy, and don't set a model to
  `enforce`** in `accuracy.json` without a recorded live run in report mode
  (`docs/notes/accuracy-live-acceptance.md`). The settings there
  (`retry_rounds`, `refusal_cap`, `min_quote_length`) are first values, not
  measured ones. A new check needs a recorded failure in its
  `motivating_failure`.
- **Don't treat the 0.5 gate thresholds as calibrated.** They are tentative
  (deviation d9); change them only with new measurements recorded in
  `docs/notes/gate-calibration.md`, or from the issue #13 benchmark.
- **Don't name a checkpoint id** in `models.json`, `culture.yaml`, prompts or
  docs. Address a model by lobes role; the gateway owns the checkpoint.
- **Don't change lobes-cli or colleague from here.** Both are consumed as they
  are (spec boundary c18); a needed change there is an issue on that repo.
- **Don't hand-roll a harness pin, an endpoint constant, a model entry, or a
  policy value** the contract already owns. The Pi extension reads
  `models.json`, `gate.json`, `policy.json` and the schemas from
  `associate/contract/` (via `$ASSOCIATE_CONTRACT_DIR` or the repo-relative
  fallback); it must not define its own copy in TypeScript, and the harness
  version pins belong in CLAUDE.md's Tooling prerequisites, not scattered as
  literals.
