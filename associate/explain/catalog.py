"""Markdown catalog for ``associate explain <path>``.

Each entry is verbatim markdown. Keys are command-path tuples. The empty tuple
and ``("associate",)`` both resolve to the root entry.

Keep bodies self-contained: an agent reading one entry should get enough
context without chaining reads.
"""

from __future__ import annotations

_ROOT = """\
# associate

A multi-model agent harness on Pi. `associate run` runs one model from the
contract's registry (`associate/contract/models.json`: `worker`, `senses`,
`cortex`) on one task with that model's own tools and prompt, behind a CLEF
safety gate for every mutating call, and hands back a walk of every tool call
plus statements that cite it. A model that may change things runs in its own
git worktree, merged to `main` locally only after a clean run. Models are
addressed by lobes role through the gateway, never by checkpoint id. Live runs
of senses and cortex, the mesh path, and every public benchmark are not yet
measured.

## Verbs

- `associate whoami` — identity probe from `culture.yaml`.
- `associate learn` — structured self-teaching prompt.
- `associate explain <path>` — markdown docs for any noun/verb.
- `associate overview` — descriptive snapshot of the agent.
- `associate doctor` — check the agent-identity invariants.
- `associate run` — run one task on a harness adapter, or fail closed.
- `associate bench` — run a public benchmark suite (BFCL, MMMU, LiveCodeBench) or list them.
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

_RUN = """\
# associate run

Runs one task on a harness adapter — and refuses to run it at all unless the
adapter can prove it is contained. That refusal is the verb's point.

## Failing closed

Pi's non-interactive modes load a project's `.pi/extensions` only on a trusted
checkout; without trust they fall back to Pi's **full built-in tool set**,
`edit` and `write` included. So the launcher checks the tool list **pi itself
reports**, never the presence of a config file on disk. A run with no report, or
whose report lists an active writer tool for a model the registry does not mark
`may_mutate` (`senses`), exits `2` and serves nothing. For `worker` and
`cortex` the writers are expected; their mutating calls pass the CLEF gate.

Readiness is proven by a **preflight**, not by the task turn. Every run is two
pi invocations: the first adds `-e lib/preflight.ts`, an extension whose only
handler ends the process on `before_agent_start`, so pi loads every extension,
fires `session_start` — where the associate extension writes its report to
`<export dir>/ready.json` — and then exits before any model request. The
launcher reads that file, and only then runs the real task turn, unchanged.
Asking the model to call `associate_ready` in the same turn as the task was the
earlier design and it was not a proof: a model handed real work goes to the
work, and healthy runs were refused for it. The extension itself is passed
explicitly with `-e <index.ts>` in both invocations, so the lane loads in **any**
checkout — a fixture repo, an unrelated project — rather than depending on the
examined checkout carrying its own `.pi/`. `$ASSOCIATE_EXTENSION_PATH` overrides
which `index.ts` that is.

Measured against pi 0.84.2 and re-measured on the pinned 1.1.0: the *full*
tool list still names `edit` and `write` even when they are inactive, so the
check is on `active_tools` and `writer_tools_active` — never on the full list.

## What it passes pi

`-p --mode json --no-session --approve --no-context-files -e <index.ts>`, with
`--no-context-files` there because pi otherwise loads `AGENTS.md`/`CLAUDE.md`
from every *ancestor* directory — a workspace-level file one level above the
checkout would leak into the system prompt. The checkout's own `AGENTS.md` is
injected by the extension instead (`ASSOCIATE_INJECT_PROMPT=1`).

`--model <key>` picks an entry of the contract's `models.json` registry
(default: the registry's `default`). With `ASSOCIATE_API_KEY` set the launcher
passes `--provider associate --model <lobes_role>`; either way it sets
`ASSOCIATE_MODEL=<key>` so the extension knows the active registry entry. With
no key the extension registers no provider, so pi's own default model applies
and the launcher says so on stderr. An unknown `--model` (the error lists the
registry's models) or a `pending` one exits `1`.

`--untrusted-checkout` (off by default) launches pi with `--no-approve
--no-extensions` instead of `--approve`: the examined checkout's own `.pi`
settings, extensions and MCP config are ignored and no built-in pi extension
loads, so associate's extension (named with `-e`) is the only one that runs.
Use it for a repo you do not control, and when associate examines a worktree
of itself.

## Worktree isolation

A model the registry marks `may_mutate` runs in its own git worktree,
`dirname(repo)/.worktrees.<name>/run-<session>`, on branch
`associate-run/<session>`, based on the checkout's `HEAD`; uncommitted operator
changes are not carried in, and `ASSOCIATE_ISOLATION=worktree` tells the gate so.
A clean run (outcome `ok`, and every test command passing) is committed there
and merged to `main` locally — never pushed. Anything else is kept, its
location printed, and `merge=kept` with `merge_reason` reported; the exit code
stays `0` because the run served. A merge is refused (and the run kept) when
there is no `main`, the base commit is not on `main`, `main` is checked out with
uncommitted changes, or the merge does not apply cleanly. A read-only model
(`senses`) runs in place; a mutating run on a non-git directory runs in place
with a stderr warning.

## Test commands (deviation d12)

`--test-command "<command line>"` (repeatable, no default) names a command the
**harness** runs after the model finishes: split like a shell would
(`shlex.split`) but run without one, in the run checkout, stdin closed, with
`--test-timeout` seconds each (default 900), and with every `ASSOCIATE_*`
variable — the lane key included — removed from its environment. All commands
run, in order, even after a failure. A worktree run is merged only when the
outcome is `ok` **and** every command exited `0`; otherwise nothing is
committed, the worktree is kept, and `merge_reason` names the failing command.

Side effects never become the model's work: in a git checkout the harness
snapshots every uncommitted path before the tests and afterwards restores each
path that was dirty before or after (pre-test bytes, or `HEAD`); gitignored
files are left alone. Restored paths are listed in `tests.reverted`. Above a
64 MiB snapshot the tests are not run and are reported failed. In a non-git
checkout they run unprotected, with a stderr note. The same commands reach the
extension as `ASSOCIATE_TEST_COMMANDS` for the model's `run_tests` tool.

## Output

`walk_path`, `statements_path`, `statements_md_path`, `export_dir`, `outcome`
and `session_id` on stdout — `key=value` lines, or one JSON object with
`--json` — plus `isolation`, `merge`, `merge_reason`, `worktree` and
`run_branch` when they apply, the model and lobes role that ran, and how the
task turn ended (final reply, stop reason, lane error). With test commands,
`tests` too: `{passed, commands: [{argv, exit_code, timed_out, duration_ms,
output_tail}], reverted}` in JSON (the output tail redacted and bounded), one
summary line in text. Diagnostics (the
pi version warning, the no-lane note) go to stderr.

## How the turn ended

With `--json`, the result also says how the task turn ended: `final_reply`
is the model's last assistant reply (text only, redacted, at most 2000
characters); `stop_reason` is pi's stop reason for that reply (for example
`stop` or `length`), or null when no assistant reply arrived; and
`lane_error` is present only when pi reported an error from the model lane.
A run that ended without `finish` is visible here: the reply says why, or
is empty.

## Usage

    associate run
    associate run "Find every caller of load_policy" --json
    associate run --model senses
    associate run --harness stub
    associate run --continue-from <prior export dir>
    associate run --export-root <dir> --session-id <id>
    associate run "Fix the failing parser test" --test-command "uv run pytest -q"

## Exit codes

- `0` the run served; both artifact paths are on stdout
- `1` unknown `--harness` (the error lists the registered adapters), an
  unknown or pending `--model`, an empty or unsplittable `--test-command`, a
  non-positive `--test-timeout`, or a `--checkout` that is not a directory
- `2` the adapter failed closed (no sentinel, or an active writer tool), pi is
  not on PATH, the run timed out, or the export root is inside the checkout
"""

_BENCH = """\
# associate bench

Runs a **public** benchmark suite (BFCL, MMMU, LiveCodeBench) against a registry
model through the gateway. Suites are data (`associate/bench/suites.json`, or the
file named by `ASSOCIATE_BENCH_SUITES`): name, pinned version, the upstream runner
as an argv template, the upstream's own scorer, and the models it applies to.
`associate` never re-implements a scorer or touches a dataset itself; it launches
the upstream runner/scorer and reads the score the scorer wrote. Adding a suite is
a data addition.

Each row carries the suite name and version, the scorer, the score, the model key
and lobes role, and the full configuration stamp. Entries marked
`verified: false` are best-reference entry points not yet run end to end.

The endpoint comes from `ASSOCIATE_BASE_URL` / `ASSOCIATE_API_KEY` (never printed).

## Usage

    associate bench                       # list suites
    associate bench --suite               # list suites (--json supported)
    associate bench --suite bfcl --model worker
    associate bench --suite mmmu --model senses --json --output-dir ./out

## Exit codes

- `0` listed suites, or the run produced a score
- `1` unknown suite, unknown or pending model, a model the suite does not list,
  or `--model` missing
- `2` upstream runner/scorer not on PATH or failed, its result file unreadable,
  or the suites file is malformed
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
    ("run",): _RUN,
    ("bench",): _BENCH,
    ("cli",): _CLI,
    ("cli", "overview"): _CLI,
}
