"""Markdown catalog for ``associate explain <path>``.

Each entry is verbatim markdown. Keys are command-path tuples. The empty tuple
and ``("associate",)`` both resolve to the root entry.

Keep bodies self-contained: an agent reading one entry should get enough
context without chaining reads.
"""

from __future__ import annotations

_ROOT = """\
# associate

A clonable template for AgentCulture mesh agents. It carries an agent-first CLI
(cited from the teken `python-cli` reference), a mesh identity (`culture.yaml` +
`CLAUDE.md`), the canonical guildmaster skill kit under `.claude/skills/`, and a
buildable/deployable package baseline. Clone it, rename the package, edit
`culture.yaml`, and you have a new agent.

## Verbs

- `associate whoami` — identity probe from `culture.yaml`.
- `associate learn` — structured self-teaching prompt.
- `associate explain <path>` — markdown docs for any noun/verb.
- `associate overview` — descriptive snapshot of the agent.
- `associate doctor` — check the agent-identity invariants.
- `associate bench` — run the behavioral suite against a harness adapter.
- `associate cli overview` — describe the CLI surface.

## Exit-code policy

- `0` success
- `1` user-input error
- `2` environment / setup error
- `3+` reserved

## See also

- `associate explain whoami`
- `associate explain doctor`
"""

_WHOAMI = """\
# associate whoami

Reports the agent's identity from `culture.yaml`: nick (`suffix`), backend,
served model, and the package version. Read-only.

## Usage

    associate whoami
    associate whoami --json
"""

_LEARN = """\
# associate learn

Prints a structured self-teaching prompt covering purpose, command map,
exit-code policy, `--json` support, and the `explain` pointer.

## Usage

    associate learn
    associate learn --json
"""

_EXPLAIN = """\
# associate explain <path>

Prints markdown documentation for any noun/verb path. Unlike `--help` (terse,
positional), `explain` is global and addressable by path.

## Usage

    associate explain associate
    associate explain whoami
    associate explain --json <path>
"""

_OVERVIEW = """\
# associate overview

Read-only descriptive snapshot of the agent: identity (from `culture.yaml`), the
verb surface, and the sibling-pattern artifacts the template carries. Accepts an
ignored `target` so a stray path never hard-fails.

## Usage

    associate overview
    associate overview --json
"""

_DOCTOR = """\
# associate doctor

Checks the agent-identity invariants `steward doctor` verifies:
prompt-file-present and backend-consistency (`colleague` → `AGENTS.colleague.md`), plus a
skills-present check. Exits 1 when unhealthy.

## Usage

    associate doctor
    associate doctor --json
"""

_BENCH = """\
# associate bench

Runs the behavioral suite — seven cases, one per category — against a harness
adapter and prints a table whose rows carry the complete configuration the run
was measured on. Exits non-zero if any category failed.

The corpus is adapter-free: the *same* seven cases run for every adapter, so two
tables differ only in their adapter and model-role columns.

## Categories

`local read/find`, `repo exploration`, `summarization`, `structured evidence
extraction`, `tool-call reliability`, `forbidden mutation attempts`, `bounded
completion and hand-back`.

## Columns

harness, model role, served model id (as the endpoint reports it), pi version,
extension version, provider, reasoning setting, category, pass/fail, wall time,
and a note. A run against the `stub` adapter is labelled **plumbing-only**: it
verifies the wiring — artifact shapes, schemas, checks — with no pi and no lane,
and is never a measurement of model reliability.

## Usage

    associate bench --harness stub
    associate bench --harness stub --json
    associate bench --harness stub --cases tests/behavioral/cases

## Exit codes

- `0` every category passed
- `1` a category failed, or the named adapter is unknown (the error lists the
  available adapters)
- `2` the behavioral corpus could not be found (pass `--cases <dir>`)
"""

_CLI = """\
# associate cli

Noun group for CLI-surface introspection. `cli overview` describes the CLI
itself (distinct from the global `overview`, which describes the agent).

## Usage

    associate cli overview
    associate cli overview --json
"""


ENTRIES: dict[tuple[str, ...], str] = {
    (): _ROOT,
    ("associate",): _ROOT,
    ("whoami",): _WHOAMI,
    ("learn",): _LEARN,
    ("explain",): _EXPLAIN,
    ("overview",): _OVERVIEW,
    ("doctor",): _DOCTOR,
    ("bench",): _BENCH,
    ("cli",): _CLI,
    ("cli", "overview"): _CLI,
}
