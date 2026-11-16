# The associate bridge

Use the bridge to let another service start an `associate run` on a checkout
and read the result later. A rules engine is the intended caller: a rule fires,
the engine starts a run in a dedicated clone, and a later step reads whether
the run merged and whether its tests passed.

In this repo, **bridge** means one app with three surfaces over the same verbs:
a CLI, an HTTP API and an MCP server. The verbs are `runs start`, `runs show`
and `runs list`. A web UI is planned and is not built; nothing in the repo
serves one today.

This page has three parts: [operators](#for-operators) (install, serve, tokens,
the checkout allowlist, state), [agents](#for-agents) (the CLI and MCP tools)
and [integrators](#for-integrators) (the HTTP routes). The
[run lifecycle](#the-run-lifecycle-and-its-result) and
[known limits](#known-limits) apply to all three.

## What a run does to the checkout

Read this before you point the bridge at a repository.

- A run is `associate run --json --untrusted-checkout --session-id <run id>`
  with the model, test commands and timeout you gave. It is started as an
  argument list, never through a shell.
- A model that may change things (`worker`, `cortex`) works in its own git
  worktree beside the checkout. When the run is clean (outcome `ok`) and every
  test command passed, the harness commits and merges that work into the
  checkout's **local `main`** branch. Otherwise it keeps the worktree and the
  branch and merges nothing.
- Nothing is ever pushed, by the harness or by the bridge. Every start and show
  reply carries `"pushed": false`.
- The run's commits land in the checkout you name. Use a **dedicated clone** for
  bridge runs, not the working copy you edit by hand, and keep its `main` free
  of uncommitted changes to tracked files: the harness refuses to merge over
  them when `main` is checked out, and refuses a run whose base is not on
  `main`.

## For operators

### Install

The base package has no third-party dependencies. The `runs` and `tokens` verbs
need nothing more. The HTTP API and the MCP server are optional extras:

```bash
pip install 'associate[server,mcp]'     # or: uv sync --extra server --extra mcp
```

| Extra | Brings | Needed by |
|-------|--------|-----------|
| `server` | FastAPI and uvicorn | `associate serve` |
| `mcp` | the `mcp` SDK | `associate mcp` |

Without the extra, `serve` and `mcp` exit `2` and name it.

A run also needs what `associate run` needs: `pi` 1.1.0 on `PATH` and the lane
key. The run inherits the caller's environment, so the process that starts it
(`serve`, `mcp` or the CLI) must have `ASSOCIATE_API_KEY` set. Only the
per-run `ASSOCIATE_*` variables, every `ASSOCIATE_RUNS_*` and every
`ASSOCIATE_SERVER_*` variable are dropped.

### Serve the API

```bash
export ASSOCIATE_RUNS_ROOTS=/srv/associate-clones
associate serve
```

`serve` prints one line per listener once it has bound its sockets, then the
allowlist state, and runs until SIGINT or SIGTERM:

```text
associate serve: loopback listening on 127.0.0.1:8794
associate serve: checkout allowlist: /srv/associate-clones
```

With `--json` it prints one JSON object (`listening`, `allowlist_empty`,
`runs_roots`). The uvicorn access log goes to stderr, so stdout stays the
result channel.

There are two listeners, on purpose:

| Listener | Binds | Accepts | When |
|----------|-------|---------|------|
| `loopback` | `127.0.0.1:8794` by default; always a loopback address | service tokens, and a Cloudflare Access assertion when Access is configured | always on |
| `lan` | nothing by default; port `8795` by default | service tokens only; an Access header is ignored | only when a LAN host is given |

The loopback listener is the one that trusts a Cloudflare Access assertion
(`Cf-Access-Jwt-Assertion`), so it must be reachable only by `cloudflared` on
the same host. A non-loopback address for it is refused (exit `1`). To reach
the API from other machines, set a LAN host: that listener ignores Access
headers and takes a service token only. The two listeners cannot share an
address.

| Flag | Environment variable | Default | Meaning |
|------|----------------------|---------|---------|
| `--host` | `ASSOCIATE_HOST` | `127.0.0.1` | loopback listener address |
| `--port` | `ASSOCIATE_PORT` | `8794` | loopback listener port |
| `--lan-host` | `ASSOCIATE_LAN_HOST` | unset (no LAN listener) | LAN listener address |
| `--lan-port` | `ASSOCIATE_LAN_PORT` | `8795` | LAN listener port |
| `--tokens` | `ASSOCIATE_SERVER_TOKENS` | `$XDG_STATE_HOME/associate/service_tokens.json` (`~/.local/state/...` when unset) | service-token file |
| `--log-level` | none | `info` | `critical`, `error`, `warning`, `info` or `debug` |
| none | `ASSOCIATE_ACCESS_LISTEN` | unset | loopback `host:port` for the Access-trusting listener |
| none | `ASSOCIATE_ACCESS_TEAM_DOMAIN` | unset | the Cloudflare Access team domain |
| none | `ASSOCIATE_ACCESS_AUD` | unset | the Access application's AUD tag |
| none | `ASSOCIATE_ADMINS` | empty | comma-separated identities raised to `admin` |
| none | `ASSOCIATE_EDITORS` | empty | comma-separated identities raised to `editor` |
| none | `ASSOCIATE_RUNS_DIR` | `$XDG_STATE_HOME/associate/runs` (else `~/.local/state/associate/runs`) | run state directory |
| none | `ASSOCIATE_RUNS_ROOTS` | empty | the checkout allowlist |

A flag wins over its variable. Notes:

- The three Access variables go together. Set all three or none; a partial set
  is refused (exit `1`). With Access on and no `--host`/`--port`, the loopback
  listener binds `ASSOCIATE_ACCESS_LISTEN`, which must be a loopback address
  (`:8794` alone means every interface and is refused).
- A port must be 1 to 65535. A port that is already taken is not handled
  (see [known limits](#known-limits)).
- `associate serve` starts even when `ASSOCIATE_RUNS_ROOTS` is empty. Every
  `POST /runs` is then refused with 403, and the startup line says so.
- The server never enables the dev identity header; the only credentials are
  service tokens and, on the loopback listener, Access.
- `ASSOCIATE_ADMINS` match a principal's identity, whether an Access person's
  or a token's `--name`. `ASSOCIATE_EDITORS` raises Access identities only.
  An Access person who is in neither list is a `viewer`.

### Tokens and roles

Tokens are issued, listed and revoked from the CLI. These verbs need no server
and no extra: whoever can write the token file administers the tokens.

```bash
associate tokens issue --name rules-engine --role admin
associate tokens issue --name dashboard --role viewer --tokens ./tokens.json
associate tokens list
associate tokens revoke 5394a08788014de6
```

- `issue` prints the token once, as `asc_<id>.<secret>`, and stores only a hash.
  With `--json` the object has the record fields and `token`. Keep the token
  now; it cannot be read back.
- `list` shows id, identity (the `--name`), roles and `active` or `revoked`,
  never a token or a hash.
- `revoke ID` stops the token working at once.
- The store is one file, mode `0600`, chosen by `--tokens`, else
  `ASSOCIATE_SERVER_TOKENS`, else the XDG state path. `serve` and `tokens`
  must read the same file.
- A token grants one role per `issue`. A token's identity listed in
  `ASSOCIATE_ADMINS` is raised to `admin`.

Callers send `Authorization: Bearer <token>`.

| Role | May do |
|------|--------|
| `viewer` | read: `GET /runs`, `GET /runs/{run_id}` |
| `editor` | the same as `viewer` today; no route needs it |
| `admin` | everything a viewer may, and start a run: `POST /runs` |

Who may start a run: `admin` only, because a start runs an agent and your test
commands in a checkout. Who may read one: `viewer` and above. `GET /health` is
public and returns no secret. Any path that is not listed needs `admin`, so a
forgotten route is closed.

### The checkout allowlist

`ASSOCIATE_RUNS_ROOTS` is a list of directories separated by `os.pathsep` (`:`
on Linux). A checkout's real path (symlinks resolved) must be one of them or
below one.

- **Empty means every start over HTTP and over MCP is refused** (403,
  `forbidden`). The local CLI is not restricted while the list is empty; once it
  is set, the CLI obeys it too.
- The checkout must exist, be a directory, be the **root** of a git work tree
  (a subdirectory is refused) and have at least one commit.
- The state directory must not be inside the checkout or its work tree. Set
  `ASSOCIATE_RUNS_DIR` somewhere else if it would be.

### Where run state lives

State lives in `ASSOCIATE_RUNS_DIR`, outside every checkout. Directories are
mode `0700` and files `0600`. Every JSON file is written to a temporary name
and renamed into place, so a reader sees the old file or the new one.

| Path under the state directory | Holds |
|--------------------------------|-------|
| `locks/<sha256 of the checkout's real path>.lock` | the checkout lock; its content is the holder's run id |
| `runs/<run id>/request.json` | what was asked, the argument list, the base commit, the start time |
| `runs/<run id>/supervisor.json` | the supervisor's pid |
| `runs/<run id>/child.json` | the `associate run` child's pid |
| `runs/<run id>/stdout.json` | the child's stdout (its `--json` result) |
| `runs/<run id>/stderr.log` | the child's stderr |
| `runs/<run id>/supervisor.log` | the supervisor's own output |
| `runs/<run id>/export/` | the run's export root (walk and statements) |
| `runs/<run id>/result.json` | written last, by the supervisor, when the child ends |

`request.json` holds the instruction text. Nothing prunes this directory; remove
old run directories yourself.

## The run lifecycle and its result

A run id is `run-` and 32 lowercase hex digits.

1. **Start.** Everything is validated, the checkout's lock is taken, the
   supervisor (`python -m associate.runs.supervisor`) is started in a new
   session so it outlives the caller, and the run id is returned at once. The
   run continues after the call returns.
2. **Run.** The supervisor runs `python -m associate run ...` from the same
   interpreter and source tree (never the `associate` on `PATH`), waits for it,
   then writes `result.json`.
3. **Read.** `runs show` reports `status`, and once finished the outcome.

Start parameters:

| Parameter | Required | Rule |
|-----------|----------|------|
| `checkout` | yes | see the allowlist rules above; at most 4096 characters |
| `model` | yes | a registry key from `associate/contract/models.json` that is not `pending` (`worker`, `senses`, `cortex`) |
| `instruction` | yes | non-empty, no NUL, at most 100,000 bytes as UTF-8 |
| `test_commands` | yes | 1 to 16 command lines, each at most 4096 characters, no NUL; each is split like a shell would and run without one |
| `timeout` | no | seconds, above 0 and at most 14,400; default 1800 (the contract's `budgets.delegate.timeout_ms`) |

At least one test command is required, because a run merges only when the
operator's tests pass.

### Status values

| `status` | Meaning |
|----------|---------|
| `running` | the supervisor or the child is alive and no result is written |
| `finished` | the child ended and `result.json` exists; read `ok` |
| `failed-to-start` | the supervisor or the child could not be started; `error` says why |
| `lost` | no process is alive and no result was written; `error` explains. The checkout is free again |

### Result fields

A `finished` reply adds these fields to `run_id`, `status`, `checkout`,
`model`, `started_at`, `base_commit` and `pushed` (always `false`):

| Field | Meaning |
|-------|---------|
| `ok` | `true` only when **all** of these hold: the exit code is 0, `outcome` is `ok`, `tests.passed` is `true`, and `merge` is `merged` or `nothing_to_merge`. Otherwise `false`, and `not_ok_because` says why. Never read the exit code alone: `associate run` exits 0 even when it refuses to merge |
| `not_ok_because` | `null` when `ok`; otherwise the reasons, joined by semicolons |
| `outcome` | the run's own verdict word; `ok` is a clean finish |
| `merge` | one of `merged`, `refused`, `nothing_to_merge`, `not_attempted` (below) |
| `merge_reason` | why a kept run was not merged |
| `worktree`, `run_branch` | where a kept run's work is |
| `exit_code`, `signal` | how the child ended; one of them is `null` |
| `tests.passed` | `true`, `false`, or `null` when there is no test result |
| `tests.commands`, `tests.failed` | how many commands ran, and how many exited non-zero |
| `tests.error` | the tests' own error text, if any |
| `base_commit` | when merged, the merge base of the merge commit; otherwise the commit `HEAD` was at when the run started |
| `changed_paths` | the files the run changed (below) |
| `changed_paths_total` | how many files changed, before any cut |
| `changed_paths_truncated` | `true` when `changed_paths` is shorter than the total or a path was cut |
| `changed_paths_error` | why the paths could not be read, if they could not |
| `final_reply` | the model's final reply, cut at 4000 characters |
| `error` | an error from the supervisor or from the child's stderr |
| `finished_at` | when the child ended |

The four `merge` values:

| Value | When |
|-------|------|
| `merged` | the run was clean, tests passed, and its work is merged into the checkout's local `main` |
| `nothing_to_merge` | the run was clean but changed nothing |
| `refused` | the run was clean and tests passed, but the merge was refused (for example `main` has uncommitted changes, the base is not on `main`, or the merge conflicts); the worktree and branch are kept |
| `not_attempted` | the run was not clean or its tests failed, so no merge was tried; the worktree is kept. A run with no merge result at all, such as a read-only model's, also reads `not_attempted` |

`changed_paths` for a merged run is the difference between the merge base and
the run branch. For a kept run it is the kept worktree's tracked changes
against the base recorded at start, plus its untracked files. For anything else
it is empty. A run of a read-only model such as `senses` makes no merge, so its
`ok` is `false` by this definition; read its `status` and `final_reply`
instead.

### The 64 KiB bound

A `runs show` reply, over the CLI or HTTP, is always smaller than 64 KiB
(65,536 bytes). Free text is cut first (`final_reply` at 4000 characters, other
texts at 2000, paths at 512, at most 200 paths). If the reply is still too
large, the path list is halved until it fits, then `final_reply` is dropped
(`final_reply_dropped: true`), then every free-text detail is dropped
(`details_dropped: true`). `result.json` keeps up to 5000 paths of up to 4096
characters, so the full record stays on disk.

### One run per checkout

A second `runs start` on a checkout that already has a run is refused (409,
`busy`) and names the holder. The key is the checkout's real path, so a symlink
names the same checkout. The lock is an `flock` on a file in the state
directory, inherited by the supervisor and its child. The kernel releases it
when the last holder exits, so a run that ends, crashes or is killed frees its
checkout and leaves no stale lock.

### What `lost` means

`lost` means the run is no longer running and left no `result.json`. This
happens when the supervisor is killed: it is the only process that writes the
result. While the child survives, `show` still says `running`; when the child
then ends, the status becomes `lost`. A `lost` run may still have changed or
merged the checkout, because the child kept going; check the checkout's `git
log` and any `associate-run/<run id>` branch. The bridge does not recover a
`lost` run.

## For agents

### The CLI

```bash
associate runs start --checkout /srv/associate-clones/app --model worker \
  --test-command "uv run pytest -q" \
  "Fix the failing parser test in tests/test_parser.py"
associate runs show run-0123456789abcdef0123456789abcdef
associate runs list --limit 10
```

| Verb | Does | Notes |
|------|------|-------|
| `runs start INSTRUCTION --checkout DIR --model KEY --test-command CMD [--timeout S]` | starts a detached run and prints its run id | `--test-command` is repeatable and required; the instruction must be complete and self-contained |
| `runs show RUN_ID` | status and, once finished, the result | |
| `runs list [--limit N]` | the newest runs first | `N` is 1 to 100, default 20 |
| `runs overview` | describes these verbs | |

Every verb takes `--json`. Results go to stdout and errors to stderr. Exit
codes: `0` the request was served (a finished run that is not `ok` also exits
0, so read `ok`); `1` bad input, a checkout outside the allowlist, a busy
checkout or an unknown run id; `2` the state directory, git or the process
could not be used.

Poll with `runs show` until `status` is no longer `running`. A live run on a
writing model has taken up to about 25 minutes, so poll at a gentle interval.

### The MCP server

`associate mcp` serves the same verbs as MCP tools over stdio. It needs the
`mcp` extra and writes only protocol messages to stdout, so a client launches
it as a subprocess: command `associate`, argument `mcp`.

| Tool | Arguments | Requires |
|------|-----------|----------|
| `runs_start` | `checkout`, `model`, `instruction`, `test_commands` (required); `timeout` | role `admin` |
| `runs_show` | `run_id` (required) | role `viewer` |
| `runs_list` | `limit` (1 to 100) | role `viewer` |

Each tool takes the verb's own JSON schema as its input schema; unknown
arguments are refused. The role is stated in the tool's description. The stdio
server does not authenticate a caller: whoever can launch it can call every
tool. `runs_start` applies the checkout allowlist exactly as HTTP does, so
while `ASSOCIATE_RUNS_ROOTS` is empty every start is refused. A refused request
is a tool error `<kind>: <message> (hint: <remediation>)`; any other failure
reports only the exception class. A parity test
(`tests/test_surface_parity.py`) keeps the CLI, the MCP tools and the HTTP
routes in step: a verb missing from one surface fails it.

## For integrators

### Routes

| Method and path | Role | Body or query | Reply |
|-----------------|------|---------------|-------|
| `GET /health` | none | | `{"status": "ok", "service": "associate-runs", "version": "..."}` |
| `POST /runs` | `admin` | JSON body, at most 512 KiB: `checkout`, `model`, `instruction`, `test_commands`, optional `timeout` | 202 and the start reply |
| `GET /runs/{run_id}` | `viewer` | | 200 and the show reply |
| `GET /runs` | `viewer` | `?limit=` 1 to 100, default 20 | 200 and `{"runs": [...], "total": N}` |

The API publishes no OpenAPI document and no docs page; the table above is the
contract. Send `Authorization: Bearer <token>` on every route except
`/health`.

The start reply (202) holds `run_id`, `status` (`running`), `checkout` (its real
path), `model`, `base_commit` (`HEAD` when the run started), `started_at`,
`pushed` (`false`) and a `note`.

The list reply holds, per run, `run_id`, `status`, `ok`, `model`, `started_at`
and `checkout` (cut at 256 characters), newest first. `total` counts every run
in the state directory, not only those returned.

A start in full:

```bash
curl -s -X POST http://127.0.0.1:8794/runs \
  -H "Authorization: Bearer $ASSOCIATE_TOKEN" \
  -d '{"checkout": "/srv/associate-clones/app", "model": "worker",
       "instruction": "Fix the failing parser test",
       "test_commands": ["uv run pytest -q"]}'
```

### Errors

A refused request has a JSON body `{code, message}`, plus `remediation` when the
bridge has one.

| Status | `code` | When |
|--------|--------|------|
| 400 | `invalid` | bad input: an unknown field, a body that is not a JSON object or is over 512 KiB, an unknown model, a bad run id, a bad `limit` value, a checkout that is not a work tree root |
| 401 | `no_credentials`, `bad_token` | no credential, or a token that is unknown or revoked |
| 403 | `forbidden` | the role is too low, the checkout is outside the allowlist, or the allowlist is empty |
| 404 | `not_found` | no such run |
| 409 | `busy` | the checkout already has a run |
| 422 | none | a `limit` that is not an integer (FastAPI's own `detail` body) |
| 500 | `env` | the state directory, git or the process could not be used |

A 401 or 403 from authentication comes before any handler runs.

## Known limits

- **No real run was exercised by the bridge's tests.** Every run in the tests
  uses a stand-in child (`tests/runs_fake_child.py`) that never starts a model.
  The real worktree commit and merge code does run in some of those tests, but
  the path through `pi` and the lobes gateway under the bridge has not been
  measured. Treat the bridge as built and unit-tested.
- **A killed supervisor reads `lost`.** The result is written only by the
  supervisor, so if it dies while the agent continues, the run is later `lost`
  although it may have changed or merged the checkout.
- **Linux only.** The checkout lock uses `fcntl.flock`, and liveness checks read
  `/proc/<pid>/cmdline` to guard against pid reuse. Where `/proc` is missing,
  the check falls back to a bare signal probe.
- **No web UI.** It is planned, pending a confirmed design. The cited framework
  carries a static-file helper, but the app does not serve a web build.
- **No retention.** Run directories are never pruned.
- **No cancel.** There is no verb to stop a run. A run ends when the model
  finishes, when the timeout elapses, or when you kill its processes.
- **Tokens are shown once** and cannot be recovered; issue a new one and revoke
  the old.
- **The gate is tentative.** A bridge run uses the same CLEF safety gate as any
  `associate run`, and its thresholds are tentative
  ([`gate-calibration.md`](../notes/gate-calibration.md)).

## Where the code is

| What | Where |
|------|-------|
| the three verbs and their schemas | `associate/runs/service.py` (`VERBS`) |
| state layout and the checkout lock | `associate/runs/state.py` |
| the detached supervisor | `associate/runs/supervisor.py` |
| MCP tools | `associate/runs/mcp_tools.py` |
| HTTP app, listeners, token file | `associate/server/` (`app.py`, `serve.py`, `tokenstore.py`) |
| the cited framework (auth, role policy, Access, tokens, MCP server) | `associate/bridge/` |
| CLI verbs | `associate/cli/_commands/` (`runs.py`, `serve.py`, `tokens.py`, `mcp.py`) |

`associate/bridge/` is cited, not imported: it comes from qodo-cli, which cited
it from culture-rules, and this repo owns its copy. Each file's header names its
source and commit.
