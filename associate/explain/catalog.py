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
- `associate runs start|show|list|overview` — start a detached run on a checkout and read
  its result by id (also an HTTP API).
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
checkout would leak into the system prompt. The extension injects associate's
own `AGENTS.md` as the runtime prompt instead (`ASSOCIATE_INJECT_PROMPT=1`);
the examined checkout's `AGENTS.md` is skipped under `--untrusted-checkout` and
otherwise injected labelled as repository context, never as the runtime prompt.

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

## The checkout lock

`--checkout-lock` (off by default) makes the run take the one-run-per-checkout
lock before anything else and hold it until its process ends: a kernel `flock`
on `<state>/locks/<sha256 of the checkout's real path>.lock`, where `<state>`
is `ASSOCIATE_RUNS_DIR` (default `$XDG_STATE_HOME/associate/runs`). While
another run holds it, this one exits `2` without starting. The extension's
`delegate_run` passes it, so two delegated runs never race to merge the same
checkout, whichever process started them.

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

## The hand-back result (issue #20)

After the model stops, the launcher re-checks the hand-back itself
(`associate.accuracy`, the same code as `associate check`) over the export
directory, the prior run named by `--continue-from` (label `prior`) and each child
run the walk links (`c1`, `c2`, ...). The result carries:

- `answer` and `answer_path`: the harness-rendered answer (`answer.md`), or null
  when the extension left none (a refused hand-back leaves none);
- `handback_outcome`: `accepted`; `refused_after_rounds` (enforce mode refused the
  hand-back on every allowed round and the run ended, walk outcome `refused`);
  `refused_unresolved` (a round was refused and the model did not hand back
  again); or `none` (no hand-back was recorded);
- `accuracy`: `python_recheck_ran` (false, with `not_applicable_reason`, for an
  export with no facts), `python_recheck_verdict` (`accepted` or `refused`),
  `check_mode_used` and `check_mode_source` (what the extension recorded),
  `extension_accepted` (the extension's own verdict, so a disagreement shows), and
  `report`: the counts (facts, conclusions, statements, by source kind, flags,
  children) from the Python re-check, never the extension's. `report.unchecked_text`
  is copied unchanged from the extension's `report.json` (it counts model text this
  side does not have) and `accuracy.unchecked_text_source` says `extension`;
- `check_mode`: the `--check-mode` value, or null when none was given.

`passed` means a fact's quote was found in the saved result it cites; it is not a
statement that the fact is true.

`--check-mode report|enforce` overrides accuracy.json's mode for the model by
setting `ASSOCIATE_CHECK_MODE` for this run only; an ambient value in the
operator's environment is not inherited. In `enforce` mode a failing hand-back is
refused and the model may answer again for accuracy.json `retry_rounds` more
rounds; a hand-back still failing ends the run with outcome `refused`, and the verb
exits `3`. `report` mode records what would have been refused and refuses nothing.

## The support-score switch

`--support-score on|off` overrides the model's switch in accuracy.json
(`support_score.enabled`) for this run only, by setting `ASSOCIATE_SUPPORT_SCORE`;
an ambient value in the operator's environment is not inherited, and any other
value is refused (exit `1`). Without the flag the variable is cleared and the
contract's switch for the model applies. The result's `support_score` is the flag's
value, or null when none was given: it says what was asked for, not that anything
was scored. The support score is a report-only signal that refuses nothing (for a
fact whose quote was found, the decider is asked whether the quote supports the
value). The switch and its reader in the extension are built and unit-tested;
nothing has been measured live with it, and it is not a measure of accuracy.

When the export holds a support score, the result carries it beside `accuracy`,
copied from the extension's `check.json` and never recomputed (the Python side
makes no network call for it):

- `support_source`: `extension`, naming who computed it;
- `support_facts`: one `{"id", "support"}` per fact the extension gave a result,
  where `support` is `{"status": "scored", "score", "at_or_above_cutoff"}`, or
  `{"status": "not_scored", "reason", "detail"}` (`detail` optional), or
  `{"status": "not_available", "reason"}` when the entry is malformed or sits on a
  fact whose quote the Python re-check did not find. A malformed entry is never
  shown as a score;
- `support_scored`: how many of those are `scored`, counted from what is shown;
- `support_scored_reported`: the extension's own count from `report.json`, when it
  wrote one;
- `support_unmatched`: fact ids `check.json` gave a result for that the re-check
  does not know, when there are any.

An export with no support score (the switch off, or written before it existed)
has none of these keys. The text form prints one `support_scored=` line. The
score is a separate signal from the quote check: it is not in `accuracy.report`,
changes no count there, and refuses nothing.

## The finish reminder

A model sometimes ends its task turn without calling `finish` and writes its
hand-back as a plain final message, which leaves no checked facts (deviation d3).
`--finish-reminder on|off` switches the reminder for this run by setting
`ASSOCIATE_FINISH_REMINDER`; an ambient value in the operator's environment is not
inherited, and any other value is refused (exit `1`). Without the flag it is `on`
when accuracy.json has a `finish_reminder` section, else `off`. When it is on and
the run is about to stop with no accepted `finish` (and not ended refused, aborted
or in a lane error), the extension sends the model the section's `text` once more
and lets it answer, up to the section's `max` reminders. The mesh resident and
spawned children get no variable and are never reminded.

The result carries `finish_reminder_switch` (`on` or `off`, what the run had) and
`finish_reminder`: `{"sent": n, "finish_followed": true|false|null}`.
`finish_followed` is true when the model called `finish` after the latest reminder
and null when none was sent; `sent` is null when the export's `reminder.json` is
not what the extension writes. Each reminder is also a `reminder` line in the walk.
The text form prints one `finish_reminder=` line. A run with no reminder sent
leaves every export file as it would without the reminder. Built and unit-tested
against a fake pi; no run of associate with the reminder has been measured.

## A run that times out

`--timeout` (default 900 seconds) bounds the task turn. When pi does not finish
in time it is killed with everything it started, and the run still returns a
result: the same object, built from what the export directory holds, with
`outcome` `timeout`, `timed_out` true, `timeout_seconds`, and the `export_dir`
and `walk_path` to read. The `accuracy` block carries the Python re-check counts
when the export holds facts, and says `python_recheck_ran` false with a
`not_applicable_reason` when it holds none (a killed run usually holds none). The
verb exits `4`. A *preflight* that does not finish proved nothing: it exits `2`
and prints no result. The task turn's `final_reply`, `stop_reason` and
`lane_error` are absent from a timeout result, because pi never reported them.

## Reasoning for one run

`--reasoning model-default|on|off` sets the reasoning for this run only.
`models.json` is never edited: the launcher copies the contract directory to a
temporary directory, changes `reasoning` in the copy, points pi at it with
`ASSOCIATE_CONTRACT_DIR`, and removes the copy when the run ends. The setting is
run-wide: it is written to every registry model that can run, not only the
run's own, because a child started with `spawn_subagent` reads the same copy. A
`pending` entry is left as it is. A run started with `delegate_run` is a
separate `associate run` and does not get it.
The result records `reasoning` and `reasoning_source`: `run` when the flag set
it (with `reasoning_applies_to`, the models it was set for), `registry` when
the model's own entry applied. Any other value exits `1`.
A harness that does not apply it (`--harness stub`) still records it, without
`reasoning_applies_to`.

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
    associate run "Summarize the gate" --check-mode enforce --json
    associate run "Summarize the gate" --support-score on --json
    associate run "Summarize the gate" --finish-reminder off --json
    associate run --continue-from <prior export dir>
    associate run "Summarize the gate" --reasoning off --timeout 1500 --json
    associate run --export-root <dir> --session-id <id>
    associate run "Fix the failing parser test" --test-command "uv run pytest -q"

## Exit codes

- `0` the run served; both artifact paths are on stdout
- `1` unknown `--harness` (the error lists the registered adapters), an
  unknown or pending `--model`, an empty or unsplittable `--test-command`, a
  non-positive `--test-timeout`, or a `--checkout` that is not a directory
- `2` the adapter failed closed (no sentinel, or an active writer tool), pi is
  not on PATH, the preflight did not finish, or the export root is inside the
  checkout
- `3` the run served but its hand-back failed the check after the allowed rounds
  (`handback_outcome` `refused_after_rounds`, outcome `refused`). The result
  object is still printed on stdout, and a worktree run is kept, not merged
  (`merge=kept`). A caller that reads only the exit code sees a failure; read the
  result for what ran
- `4` pi did not finish the task turn within `--timeout` and was killed. The
  result object is still printed on stdout, with `outcome` `timeout`,
  `timed_out` true and `timeout_seconds`, built from whatever the export holds
  (the walk and any hand-back files); a worktree run is kept, not merged. See
  "A run that times out"
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

_CHECK = """\
# associate check

Re-checks one export directory's hand-back facts. It reads `walk.jsonl`, the saved
results beside it (`results/wN.txt`) and the facts payload (`facts.json`), runs the
Python re-check (the same rules as the extension's checker, compared on shared
test vectors), and prints:

- counts per kind (facts, conclusions, statements) and per source kind
  (file, tool, web, memory, agent, harness);
- each call's id, tool, stated purpose and outcome;
- each fact with its source kind and verdict.

`passed` means the fact's quote was found in the saved result it cites; it is not
a statement that the fact is true. A fact that could not be checked (no saved text,
or only part of it) is `unchecked` and is never counted as passed. An export written
before the walk format marker has no facts: they are reported as not applicable, and
the calls are still listed.

## The support score, copied

When the run had the support score on, the extension wrote a result for each fact
whose quote was found into the export's `check.json`. `associate check` copies it;
it does not recompute it and makes no network call for it. In `--json` each such
fact gains a `support` object and the result gains `support_source` (`extension`),
`support_scored` (how many shown results are scored), `support_scored_reported`
(the extension's own count from `report.json`, when present) and, when there are
any, `support_unmatched` (ids `check.json` scored that the re-check does not know).
`support` is `{"status": "scored", "score", "at_or_above_cutoff"}`, or
`{"status": "not_scored", "reason", "detail"}`, or `{"status": "not_available",
"reason"}` for an entry that is malformed or sits on a fact whose quote this
re-check did not find; such an entry is never shown as a score. The text form says
it under each fact, for example `quote supports the value (support 0.97)`,
`quote may not support the value (support 0.03)` or `support not scored (timeout)`,
and closes with where the score came from.

The support score is a separate signal from the quote check. It changes no count
above, and an export without it (the switch off, or written before it existed)
prints exactly what it printed before.

## The finish reminder

When the run was sent the finish reminder, the export holds `reminder.json`, and
`associate check` adds `finish_reminder` (`{"sent", "finish_followed"}`) to its
`--json` result and closes the text form with one `Finish reminder:` line (for
example `sent 1; finish followed`). An export without `reminder.json` prints exactly
what it printed before.

## Usage

    associate check <export-dir>
    associate check <export-dir> --json
    associate check <export-dir> --continue-from <prior-export-dir>

For a run started with `associate run --continue-from`, pass the same directory
here. The export does not record it, and without it every fact citing `prior:wN`
is reported as refused (`source_unknown`).

## Exit codes

- `0` the export was read
- `1` the directory does not exist, has no `walk.jsonl`, or its facts file is unreadable
"""

_CLI = """\
# associate cli

Noun group for CLI-surface introspection. `cli overview` describes the CLI
itself (distinct from the global `overview`, which describes the agent).

## Usage

    associate cli overview
    associate cli overview --json
"""


_RUNS = """\
# associate runs

Start a **detached** `associate run` on a checkout and read its result by run id,
from the CLI or over HTTP (`associate.server.app`, the `server` extra). One module,
`associate/runs/service.py`, holds the logic; both surfaces call it.

## Verbs

- `associate runs start` — validate, take the checkout's lock, start the run in a
  new session and print its run id at once (HTTP `POST /runs`, role `admin`).
- `associate runs show <run id>` — status and result (HTTP `GET /runs/{run_id}`,
  role `viewer`).
- `associate runs list` — the most recent runs (HTTP `GET /runs`, role `viewer`).
- `associate runs overview` — describe these verbs.

`GET /health` needs no token and returns no secret.

## Rules

- **One run per checkout at a time**, keyed by the checkout's real path (a symlink
  names the same checkout). A crashed run frees its checkout by itself: the lock is
  an `flock` held by the run's processes, released by the kernel when they die.
- The run is `associate run --json --untrusted-checkout --session-id <run id>`,
  started as an argv list (never a shell); the instruction is one argument after
  `--` and each test command one `--test-command`.
- A clean run whose tests pass is **merged into the checkout's local `main`**;
  nothing is ever pushed. `associate run` exits 0 even when the merge is refused,
  so `ok` is true only when the exit code is 0, the outcome is `ok`, the merge
  happened and the tests passed.
- State lives in `ASSOCIATE_RUNS_DIR` (default `$XDG_STATE_HOME/associate/runs`),
  never inside a checkout. A checkout must be a git work tree under a root in
  `ASSOCIATE_RUNS_ROOTS`; while that is empty the HTTP API refuses every start.
"""

_RUNS_START = """\
# associate runs start

Start a detached `associate run` on a git checkout and return its run id at once.

## Usage

    associate runs start --checkout DIR --model worker \\
        --test-command "uv run pytest -q" [--timeout SECONDS] [--json] -- "the task"

The checkout must be a git work tree with a commit, under a root listed in
`ASSOCIATE_RUNS_ROOTS` when that is set (the HTTP API requires it set). The model
is an active registry key. At least one `--test-command` is required: the run
merges only when every one passes. `--timeout` defaults to the contract's
`budgets.delegate.timeout_ms`. The checkout is always treated as untrusted.

## Output

`run_id`, `status` (`running`), `checkout` (its real path), `model`,
`base_commit` (the checkout's HEAD), `started_at`, `pushed: false`.

## Exit codes

- `0` started
- `1` bad input, a checkout outside the allowed roots or not a git work tree, or a
  checkout with a run in progress (the error names that run)
- `2` the state directory, git or the process could not be used
"""

_RUNS_SHOW = """\
# associate runs show

A run's status, and once it has finished, its result.

## Usage

    associate runs show RUN_ID [--json]

## Output

- `status`: `running | finished | failed-to-start | lost` (lost: the run's
  processes are gone and left no result; a run still starting reads `running`, and one
  whose supervisor was never recorded within 120 s reads `failed-to-start`).
- `ok`: true only when the exit code is 0, `outcome` is `ok`, `tests.passed` is
  true and `merge` is `merged` or `nothing_to_merge` (a clean run that changed
  nothing); `not_ok_because` says why not. Read `merge` to know whether anything
  changed.
- `merge`: `merged`, `refused` (a clean run whose merge was refused),
  `not_attempted` (the outcome was not ok or the tests failed) or
  `nothing_to_merge`; `merge_reason` is `associate run`'s own.
- `tests`: `passed`, `commands`, `failed`.
- `base_commit` and `changed_paths` (read from git: the merge commit for a merged
  run, the kept worktree otherwise), `changed_paths_total` and
  `changed_paths_truncated`. The whole reply stays under 64 KiB.
- `pushed`: always false.

## Exit codes

- `0` the run was found (whatever its status)
- `1` a malformed or unknown run id
"""

_RUNS_LIST = """\
# associate runs list

The most recent runs, newest first, each with `run_id`, `status`, `ok`, `model`,
`started_at` and `checkout`.

## Usage

    associate runs list [--limit N] [--json]

## Exit codes

- `0` listed (possibly none)
- `1` a limit outside 1-100
"""

_MCP = """\
# associate mcp

Serve the runs verbs as MCP tools over stdio, for an MCP client (an agent) to call.

## Usage

    associate mcp [--json]

Needs the `mcp` extra: `pip install 'associate[mcp]'`. Without it the verb exits `2`
with a message naming the extra; it never prints a traceback. Stdout is the protocol
channel, so the verb writes nothing else there (a status line goes to stderr, and
`--json` only shapes an error on stderr).

## Tools

One tool per runs verb, with the verb's own JSON schema as its input schema, calling the
same code as the CLI and HTTP:

- `runs_start` — `checkout`, `model`, `instruction`, `test_commands` (required),
  `timeout`; a remote caller, so the checkout must be under `ASSOCIATE_RUNS_ROOTS`
  (empty: every start is refused `forbidden`), exactly as `POST /runs`.
- `runs_show` — `run_id` (required).
- `runs_list` — `limit` (1-100).

A refused request is a tool error `<kind>: <message> (hint: ...)` with kind `invalid`,
`forbidden`, `not_found`, `busy` or `env`; no traceback is ever returned. A test fails if
a verb lacks a CLI command, an MCP tool or an HTTP operation.

## Exit codes

- `0` the client disconnected
- `2` the `mcp` extra is not installed
"""


_SERVE = """\
# associate serve

Run the runs HTTP API under uvicorn (the `server` extra): `POST /runs` (admin),
`GET /runs/{run_id}` and `GET /runs` (viewer), and the public `GET /health`. When the
installed package holds a built web UI (`associate/web_dist`, shipped in the wheel), it also
serves that read-only UI (the runs list and one run) to any viewer, and the same routes under
the same-origin `/api` prefix; without one, `/` is a JSON 404.

## Usage

    associate serve [--host H] [--port N] [--lan-host H] [--lan-port N] [--tokens PATH]
                    [--log-level LEVEL] [--json]

Two listeners:

- **loopback**, always on, `127.0.0.1:8794` by default, and always a loopback address (anything
  else is refused, exit 1): it is the one that trusts a Cloudflare Access assertion.
- **lan**, off unless `--lan-host` is given (`ASSOCIATE_LAN_HOST`), port `8795` by default:
  service tokens only; an Access header is ignored there. The two cannot share an address.

Environment: `ASSOCIATE_HOST`, `ASSOCIATE_PORT`, `ASSOCIATE_LAN_HOST`, `ASSOCIATE_LAN_PORT`
(flags win), `ASSOCIATE_ACCESS_LISTEN` + `ASSOCIATE_ACCESS_TEAM_DOMAIN` + `ASSOCIATE_ACCESS_AUD`
(all three or none; Access on the loopback listener), `ASSOCIATE_ADMINS` / `ASSOCIATE_EDITORS`
(comma-separated identities Access lets through; others are viewers),
`ASSOCIATE_SERVER_TOKENS` (the token file) and `ASSOCIATE_RUNS_ROOTS` / `ASSOCIATE_RUNS_DIR`.

The server starts even while `ASSOCIATE_RUNS_ROOTS` is empty; every `POST /runs` is then
refused (403). The startup line says so. "listening" is printed once every listener has bound
its socket; SIGINT or SIGTERM stops them together.

A write (any method but GET, HEAD and OPTIONS) needs `Content-Type: application/json` (415
otherwise) and is refused 403, before authentication, when `Sec-Fetch-Site` is `cross-site`
or `Origin` is not the server's own; a body over 512 KiB is 413 as soon as it is counted. No
CORS header is ever sent.

## Exit codes

- `0` stopped by a signal
- `1` a bad address or port, a non-loopback loopback host, a partial Access configuration
- `2` the `server` extra is not installed (`pip install 'associate[server]'`), or a port is taken
"""

_TOKENS = """\
# associate tokens

Issue, list and revoke the service tokens the HTTP API (`associate serve`) checks.

## Usage

    associate tokens issue --name NAME --role viewer|editor|admin [--tokens PATH] [--json]
    associate tokens list [--tokens PATH] [--json]
    associate tokens revoke ID [--tokens PATH] [--json]
    associate tokens overview [--json]

`issue` prints the plain token (`asc_<id>.<secret>`) **once**; it is never stored (only a hash
is) and never logged. `list` shows id, identity, roles and state, never a token or a hash.
`revoke` stops a token working at once. The store is one `0600` file: `--tokens`, else
`ASSOCIATE_SERVER_TOKENS`, else `$XDG_STATE_HOME/associate/service_tokens.json`. Whoever can
write that file administers the tokens, so these verbs need no server and no extra.

Roles: `viewer` reads (`GET /runs`), `editor` is above it, `admin` starts runs (`POST /runs`).

## Exit codes

- `0` done
- `1` a bad name or role, an unknown or already revoked id
- `2` the token file cannot be read or written
"""


_MEASURE = """\
# associate measure

Runs a comparison of arms over tasks, follows it, and reports what it stored. An
arm is a harness commit, a model, and optionally a check mode, a reasoning
setting, a support-score setting and a finish-reminder setting. Every task runs
for every arm and repeat, each against a fresh filtered clone of the task's
repository without the answer key (`docs/accuracy`), and one graded result is
stored per task, arm and repeat. A count here is a count of stored runs; it is
never a score.

## Usage

    associate measure run --arms arms.json --repeats 3 --output-dir RESULTS
    associate measure run --arms arms.json --output-dir RESULTS --detach
    associate measure status RESULTS
    associate measure report RESULTS [--reading answer_text|answer_text_plus_handback_values]
    associate measure sample RESULTS [--sheet PATH] [--seed N] [--size N] [--reading R]
    associate measure agreement RESULTS --sheet PATH
    associate measure run --broad --arms arms.json --repeats 3 --output-dir RESULTS
    associate measure sheet RESULTS [--sheet PATH] [--key PATH] [--seed N] [--overwrite]
    associate measure sheet-check RESULTS [--sheet PATH] [--clone-root DIR]
    associate measure report RESULTS [--sheet PATH] [--key PATH] [--clone-root DIR]
    associate measure overview

Every sub-verb takes `--json`.

## run

- `--arms FILE`: a JSON list of arms, each `{"name", "harness_commit", "model"}` and
  optionally `"check_mode"` (`report` or `enforce`), `"reasoning"` (`model-default`,
  `on` or `off`), `"support_score"` (`on` or `off`) and `"finish_reminder"` (`on` or
  `off`). An unknown key or a duplicate
  name is refused with the reason. `harness_commit` is a commit id of 7 to 64
  hexadecimal characters; a branch or tag name is refused.
- `"support_score"` is passed to every run of the arm as `associate run
  --support-score`; an arm without it passes nothing and the switch in its harness
  commit's accuracy.json applies. Each stored record names the setting under
  `support_score`: `on`, `off` or `contract default`. That is what the run was asked
  to use, not a score and not a statement that anything was scored.
- `"finish_reminder"` is passed to every run of the arm as `associate run
  --finish-reminder`; an arm without it passes nothing and that commit's `associate
  run` default applies. Each stored record names it under `finish_reminder`: `on`,
  `off` or `contract default`. An arm that sets it on a harness commit whose
  `associate run` has no `--finish-reminder` is refused before any run.
- Before the first run the arms are checked. When they carry more than one
  support-score setting (an arm without one counts as a setting), each arm that sets
  it must have another arm with a different setting and the same model, reasoning,
  check mode and harness commit; every arm of one comparison already runs the same
  tasks and repeats. An arm with no such partner is refused, naming the nearest arm
  and what differs. An arm that sets it on a harness commit whose `associate run` has
  no `--support-score` is refused too, before any run.
- `--tasks FILE` (default `docs/accuracy/tasks.json`), `--tasks-filter ID` (repeatable,
  runs only those tasks), `--repeats N` (default 1, at most 1000), `--output-dir DIR`.
- `--timeout SECONDS`: the limit for one run, default 3600. There is no unlimited
  value: zero or less is refused.
- `--checkout-of NAME=PATH` (repeatable): the local checkout of a task repository.
  A repository not named defaults to a directory of that name beside this
  repository's main checkout when it exists, and `associate` is this repository.
  A repository with no checkout is not a refusal: its runs are stored as failed
  launches with the reason, and the start-up text says so.
- `--detach`: start the comparison as a background process in its own session
  (stdin closed, stdout and stderr appended to `measure-run.log` in the output
  directory), print the results path, the log path and the process id, and return
  at once. One runner per output directory: a second one is refused.
- The run writes `manifest.json` into the output directory; `status` reads it.

It refuses to start unless a note stating the difference that will be called a
change is committed: `docs/accuracy/difference-threshold.md`, tracked by git and
unmodified in the working tree (`--difference-note PATH` names another file). The
refusal names the path. A stub comparison (`--harness stub`) is plumbing only: it
needs no note and its output is labelled plumbing only.

## status

Reads only. Prints how many of the expected runs (tasks by arms by repeats, from the
manifest) are stored as finished, stored as failed launches and not yet stored;
whether a runner holds the lock and whether that process is alive; and the log path.

## report and sample

`report` prints the table of the stored results; `--reading` picks which of the two
readings of the grade is counted. `sample` writes the blank hand-grading sheet for a
fixed-seed draw (it refuses to replace a sheet without `--overwrite`).

## agreement

Reads only; it never writes the sheet or the results. It reads the sheet's seed,
reading and number of entries, redraws the same sample from the stored results and
refuses (exit 1, with a remediation) when the redrawn runs are not exactly the sheet's
runs, which means the stored results changed since the sheet was drawn, or when the
sheet is missing, is not JSON or lacks those fields. It then prints how many hand-graded
runs agree with the grader (agreed over hand-graded; a missing or invalid hand grade is
never agreement) and states two conditions, each met or not met with its numbers: at
least 48 hand-graded runs, and agreement on at least 95% of them. A share is never
rounded up to reach 95%. `--json` carries the same numbers and the share, null when no
run is hand graded.

## Broad tasks: run --broad, sheet, sheet-check, report

A broad task asks one open question about a repository and is read against a
checklist of facts (`docs/accuracy/broad-tasks.json`: one prompt, and per task a
repository, a pinned commit and the facts).

- `run --broad` runs the broad tasks (`--tasks FILE` names another broad file). Each
  stored run holds the whole answer, `answer_source` (where it came from), `finished`
  (whether `finish` was accepted, from the result's `handback_outcome`; null when the
  result does not say) and `at_cap`, and per checklist fact whether it was marked as
  stated. The answer of a run that finished is what `answer.md` hands the caller, in
  the model's words: the value of each accepted fact and the text of each accepted
  conclusion and open item, then the model's unchecked text. The quote, walk id and
  marks the harness wrote after a fact are left out, so a grader cannot tell the arm
  from a support mark. A run
  that ended without `finish` leaves no `answer.md`, and its result keeps only the
  last 2,000 characters of its last message, so its answer is the fullest text there
  is, with no line removed, in this order: `final_message.md` (the export's copy of
  the whole last message; older exports have none), `final_reply` (the result's final
  reply when it is shorter than the cap, so nothing was cut), `statements.json` (the
  export's statements joined by blank lines: every paragraph and list item the model
  wrote in a message without a tool call, but no heading, no list marker and no code
  block), `final_reply_capped` (the cut final reply; only here is `at_cap` true). A fact
  is marked when every group of its `match` is found in the answer text by one of the
  group's alternatives, case-insensitively. That is a first marking: the words were
  found. Every marking is read by hand. No grade of the whole task is stored.
- The clone a broad run examines never holds `docs/accuracy/broad-tasks.json`, and a
  call whose arguments name `broad-tasks.json` is a read of the answer key.
- A real broad run is refused unless `docs/accuracy/broad-difference-threshold.md`
  (`--difference-note PATH` names another file) is tracked by git, unmodified and
  confirmed: `status` in its parameters is `confirmed` and the word DRAFT is nowhere
  in it. A stub run needs no rule file.
- `sheet` splits every finished run's answer into statements (sentences, list items,
  headings, table rows, code blocks; the answer's order is kept) and writes two files.
  The sheet (`broad-grading-sheet.json`) lists the runs in shuffled order under ids
  (`s01`, ...) with the task, repository and pinned commit, and no arm. The key
  (`broad-grading-key.json`) maps each id to its run and arm and holds the seed of
  the shuffle. The grader must not open the key until every run is graded. `--seed N`
  fixes the shuffle; without it a new random seed is used. An existing sheet or key
  is replaced only with `--overwrite`.
- The grader gives every statement a `verdict`: the string `true`, `false` or
  `not_checkable`. A `false` needs `file` and `line` (a positive whole number): the
  place in the repository that contradicts the statement. `note` is optional.
- `sheet-check` reads the sheet (never the key) and lists every problem: a statement
  without a verdict, a verdict that is not one of the three, a false without a file
  and a positive line. With `--clone-root DIR` (one checkout per repository, named as
  the repository) it also checks that the file exists at the task's pinned commit and
  has that line. It exits 1 while there is a problem and 0 when the sheet is
  acceptable.
- `report` on a broad comparison prints one line per run, grouped by repository and
  arm: checklist facts marked as stated (n of that repository's facts), the answer
  source, the cap flag and how the run ended (finish accepted, ended without finish,
  or not recorded). After the runs it prints, per arm, how many runs ended without
  `finish` (`without_finish` in `--json`) and how many were reminded to finish (a
  run's `reminded`, from its result's `finish_reminder`; a reminded run's line says
  "reminded to finish"). Such a run is graded like the others on its
  final message (first marking, sheet, statements counted false); the report says in
  one line that it handed back no checked facts. With no sheet written it says the
  hand count is not joined. Once
  a sheet exists it joins sheet and key only when the sheet passes the check, every
  run of the key is fully graded with its statements unchanged, and the key covers the
  stored finished runs; then each line also has statements counted false, statements
  not checkable and the number of statements. Otherwise it refuses (exit 1) and prints
  nothing. Counts are per run; they are never added up over runs and never printed as
  a percentage.
- The report applies the rule file to each count on its own when that file is
  committed, unmodified and confirmed: per repository an arm is better when every one
  of its runs is at least as good as every run of the other arm and one is strictly
  better; "a change" needs that in the stated number of repositories, anything else is
  "no difference shown". When the stored runs are not the ones the rule was written
  for it says "not applicable" with the reason. A run that read the answer key, or
  whose answer was cut at the cap, is left out; a run with no statement to grade is
  left out of the count of false statements. A rule file whose required number of
  repositories is not more than half of them is refused. While the rule file is a
  draft the report says the verdict is not computed.

## Exit codes

- `0` done
- `1` a user-input error: a bad arms or task file, a missing difference note or rule
  file, a bad flag, a second runner on the same directory, nothing stored to report, a
  grading sheet that is not acceptable or not fully graded
- `2` the background process could not be started
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
    ("runs",): _RUNS,
    ("runs", "overview"): _RUNS,
    ("runs", "start"): _RUNS_START,
    ("runs", "show"): _RUNS_SHOW,
    ("runs", "list"): _RUNS_LIST,
    ("mcp",): _MCP,
    ("serve",): _SERVE,
    ("tokens",): _TOKENS,
    ("tokens", "issue"): _TOKENS,
    ("tokens", "list"): _TOKENS,
    ("tokens", "revoke"): _TOKENS,
    ("tokens", "overview"): _TOKENS,
    ("check",): _CHECK,
    ("measure",): _MEASURE,
    ("measure", "overview"): _MEASURE,
    ("measure", "run"): _MEASURE,
    ("measure", "status"): _MEASURE,
    ("measure", "report"): _MEASURE,
    ("measure", "sample"): _MEASURE,
    ("measure", "agreement"): _MEASURE,
    ("measure", "sheet"): _MEASURE,
    ("measure", "sheet-check"): _MEASURE,
    ("cli",): _CLI,
    ("cli", "overview"): _CLI,
}
