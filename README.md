# associate

associate is a **multi-model agent harness** on [Pi](https://pi.dev) (pinned
1.1.0). It runs one of the fleet's models on one task — reading, finding,
summarizing, and, for the models allowed to, changing the checkout — and hands
back what it saw, what it did, and where, with every statement tied to the
recorded tool calls it rests on.

It serves the operator (headless `associate run`, or the mesh resident via
`culture start associate`) and mesh peers such as
[`colleague`](https://github.com/agentculture/colleague) that hand it work over
IRC.

## Models

Models come from a registry in the portable contract,
[`associate/contract/models.json`](associate/contract/models.json). Each is
addressed by its [lobes](https://github.com/agentculture/lobes-cli) **role**
through the local lobes gateway — never by a checkpoint id — and gets its own
tool set, prompt (`.pi/extensions/associate/prompts/`) and permissions:

| Key | lobes role | May change the checkout | Notes |
|-----|------------|-------------------------|-------|
| `worker` (default; Pi label "bolt") | `worker` | yes, behind the safety gate | the bounded executor |
| `senses` | `senses` | no | read, search, web, memory |
| `cortex` | `cortex` | yes, behind the safety gate | may spawn `worker` / `senses` sub-agents |
| `super-vl` | — | — | **pending**: no lobes role yet, not usable |

The role descriptions are lobes' own (`lobes/roles.py`); see
[`CLAUDE.md`](CLAUDE.md)'s "The runtime lanes" for the citations. The earlier
single lane (the lobes `associate` role on Nemotron 3.5 Lightning, never
changing anything) is retired; `worker` replaces it.

## How a run is kept safe

- **Tool surface per model.** A model is offered only its registry tools, and
  a guard refuses anything else; `senses` has no writer at all.
- **CLEF safety gate.** Every mutating call — and every memory write and web
  call — is scored by the lobes decider (CLEF) against a versioned question set
  in [`associate/contract/gate.json`](associate/contract/gate.json); below
  threshold it is refused. With CLEF unreachable the gate tries Super (pending
  today, so it counts as unreachable), then refuses every mutating call while
  reads continue. The thresholds are **tentative**, set from one task's probes
  ([`docs/notes/gate-calibration.md`](docs/notes/gate-calibration.md)); issue
  #13 is the benchmark meant to replace them.
- **A worktree per mutating run.** A model that may change things runs in its
  own git worktree beside the repo; only a clean run whose operator test
  commands (`--test-command`) all pass is merged to `main`, locally. Nothing is
  ever pushed.
- **Fail closed at launch.** `associate run` refuses to serve (exit `2`) unless
  a preflight proves the extension loaded — and, for a model that may not
  change things, that no writer tool is active.

Writing models also get `run_tests` (the operator's test commands, gated),
eidetic memory (`eidetic_recall` / `eidetic_remember`) and a workledger ledger
(`ledger_append` / `ledger_list`); `cortex` gets `spawn_subagent`.

## What is measured, and what is not

**Measured live:** worker (bolt) runs on this repository, under the gate, that
drafted the fix for bug F2, and that wrote three tests and ran them with
`run_tests`. Each was reviewed, and fixed where needed, before merge (see
`git log` for "drafted by associate worker" / "drafted by bolt"). Everything
else is covered by unit tests and the extension's test suite against fakes.

**Not measured yet:** a recorded live run of `senses` and `cortex` (and a
recorded acceptance walk of `worker`) on pi 1.1.0; the `culture start associate`
mesh session through `pi-acp`; a run with the decider and Super unreachable; a
`cortex` run that spawns sub-agents; and **every** benchmark. The public suites
— BFCL, MMMU, LiveCodeBench, in
[`associate/bench/suites.json`](associate/bench/suites.json) — are wired but
unverified and have produced no score. Until those runs are recorded, treat
those paths as built and unit-tested, not as working.

## Quickstart

```bash
git clone https://github.com/agentculture/associate && cd associate
uv sync

uv run associate whoami                     # who this agent is
uv run associate learn                      # self-teaching prompt (add --json)
uv run associate run --harness stub         # plumbing check, no model
uv run associate bench                      # list the public suites
uv run pytest -n auto                       # Python tests
bash .pi/extensions/associate/tests/run.sh  # extension tests (Node >= 22)
uv run teken cli doctor . --strict          # the agent-first rubric gate
```

A real run needs `pi` 1.1.0 on PATH and a lane key:

```bash
ASSOCIATE_API_KEY=... uv run associate run --model senses "Summarize the gate design"
ASSOCIATE_API_KEY=... uv run associate run "Fix the failing parser test" \
  --test-command "uv run pytest -q"
```

## CLI

| Verb | What it does |
|------|--------------|
| `whoami` | Report this agent's nick, version, backend, and model from `culture.yaml`. |
| `learn` | Print a structured self-teaching prompt. |
| `explain <path>` | Markdown docs for any noun/verb path. |
| `overview` | Read-only descriptive snapshot of the agent. |
| `doctor` | Check the agent-identity invariants (prompt-file-present, backend-consistency). |
| `cli overview` | Describe the CLI surface itself. |
| `run [prompt]` | Run one task on a harness adapter (`pi` by default) with `--model`, `--test-command`, `--untrusted-checkout`. Exits `2` without serving unless a preflight proves the extension loaded correctly. |
| `bench` | List the public suites, or run one (`--suite NAME --model KEY`) through its upstream runner and scorer. |

Every command takes `--json`. **Results go to stdout, errors and diagnostics go
to stderr — never mixed.** Errors in JSON mode are `{code, message,
remediation}`. Exit codes: `0` success, `1` user error, `2` environment error,
`3+` reserved. The Python package has **no third-party dependencies**, and the
Pi extension declares no npm dependency.

## Environment

All configuration is through `ASSOCIATE_*` environment variables — the endpoint
(`ASSOCIATE_BASE_URL`, default the local lobes gateway), the bearer
(`ASSOCIATE_API_KEY`, never committed or logged), the model
(`ASSOCIATE_MODEL`, a registry key), and the session, isolation, test-command,
memory and ledger plumbing. The full table, each row tied to the code that
reads it, is in [`CLAUDE.md`](CLAUDE.md)'s Tooling prerequisites, with the exact
`pi` / `pi-acp` / Node pins.

## Identity and skills

`culture.yaml` declares `backend: acp` launched through `pi-acp`, so the
resident's runtime prompt is [`AGENTS.md`](AGENTS.md) plus the active model's
prompt; [`CLAUDE.md`](CLAUDE.md) is for Claude Code sessions working on the
repo. `AGENTS.colleague.md` is kept until the ACP path is verified live.

19 skills are vendored cite-don't-import under `.claude/skills/`, with
provenance in [`docs/skill-sources.md`](docs/skill-sources.md). Eight of them
are the [`devague`](https://github.com/agentculture/devague) chain — scope,
think, challenge, spec-to-plan, assign-to-workforce, deviate,
validate-delivery, summarize-delivery — which carried this work from idea to
delivery with three human gates (the spec, the split plan, the PR). The rest
cover the PR lane (`cicd`), cross-repo messages (`communicate`), second
opinions (`ask-colleague`), memory (`remember` / `recall`), tests, version
bumps, SonarCloud, agent config, PyPI source switching, and doc alignment.

## Contributing

Every PR bumps the version — including docs-only and CI-only changes; CI
enforces it. Vendored skills are never patched in place; fixes go upstream.
Both rules, and the CLI contract you must not break, are in
[`CLAUDE.md`](CLAUDE.md).

## License

Apache 2.0 — see [`LICENSE`](LICENSE).
