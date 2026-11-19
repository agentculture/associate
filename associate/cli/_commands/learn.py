"""``associate learn`` — the learnability affordance.

Prints a structured self-teaching prompt. Must satisfy the agent-first rubric:
>=200 chars and mention purpose, command map, exit codes, --json, and explain.
"""

from __future__ import annotations

import argparse

from associate import __version__
from associate.cli._output import emit_result

_TEXT = """\
associate — a multi-model agent harness on Pi for AgentCulture.

Purpose
-------
Run one fleet model (worker, senses or cortex, from the contract's models.json)
on one task with its own tools and prompt, every mutating call behind a CLEF
safety gate, and hand back a walk of tool calls plus statements citing it.
Models that may change things run in their own git worktree, merged to main
locally only after a clean run. Live runs of senses and cortex, the mesh path
and every public benchmark are not yet measured.

Commands
--------
  associate whoami             Identity from culture.yaml.
  associate learn              This self-teaching prompt.
  associate explain <path>...  Markdown docs for any noun/verb path.
  associate overview           Descriptive snapshot of the agent.
  associate doctor             Check the agent-identity invariants.
  associate run [prompt]       Run one task on a harness adapter (--model,
                               --test-command, --check-mode, --support-score on|off),
                               or fail closed.
  associate bench              Run a public suite (--suite NAME --model KEY) or list suites.
  associate runs start         Start a detached run on a checkout (--checkout, --model,
                               --test-command, instruction); prints a run id at once.
  associate runs show <id>     Status, and when finished: ok, outcome, merge, tests,
                               base commit and changed paths. Nothing is ever pushed.
  associate runs list          The most recent runs with their status.
  associate runs overview      Describe the runs verbs (also served over HTTP).
  associate mcp                Serve the runs verbs as MCP tools over stdio (mcp extra).
  associate serve              Run the runs HTTP API (server extra): loopback, and a LAN
                               listener when --lan-host is set.
  associate tokens issue       Issue a service token (--name, --role); printed once.
  associate tokens list        List tokens (never a token or its hash).
  associate tokens revoke <id> Stop a token working.
  associate tokens overview    Describe the tokens verbs.
  associate check <export-dir> Re-check an export's hand-back facts; print counts.
                               check and run --json show each fact's
                               support score copied from the export (support_source:
                               extension) when the export holds one; never recomputed.
  associate measure run        Run a comparison of arms over tasks (--arms, --repeats,
                               --output-dir, --detach); needs the committed difference note
                               unless --harness stub (plumbing only). An arm may set
                               support_score (on or off); each stored record names it.
  associate measure status <dir>  Runs stored, failed and not yet stored; the lock; the log.
  associate measure report <dir>  The table of the stored results (--reading, --json).
  associate measure sample <dir>  The blank hand-grading sheet for a fixed-seed draw.
  associate measure agreement <dir> --sheet PATH  A filled sheet against the grader; the 48
                               hand-graded runs and 95% agreement conditions (read-only).
  associate measure run --broad  The broad tasks: each run stores its whole answer and a
                               first marking of the checklist facts; a real run needs the
                               committed, confirmed rule file.
  associate measure sheet <dir>  Broad tasks: the grading sheet (statements per run, arms
                               hidden, shuffled) and, in a separate file, its key.
  associate measure sheet-check <dir>  What a filled sheet lacks (a verdict per statement,
                               a file and line per false); exit 1 until acceptable.
  associate measure overview   Describe the measure verbs.
  associate cli overview       Describe the CLI surface itself.

Machine-readable output
-----------------------
Every command supports --json. Errors in JSON mode emit
{"code", "message", "remediation"} to stderr. Stdout and stderr never mix.

Exit-code policy
----------------
  0 success
  1 user-input error (bad flag, bad path, missing arg)
  2 environment / setup error
  3 `run` only: the hand-back was refused after the allowed rounds (the
    result is still printed)
  4 `run` only: pi did not finish within --timeout and was killed; the result
    (outcome `timeout`) is still printed
  5+ reserved

More detail
-----------
  associate explain associate
"""


def _as_json_payload() -> dict[str, object]:
    return {
        "tool": "associate",
        "version": __version__,
        "purpose": (
            "Multi-model agent harness on Pi: run one registry model on one task "
            "behind a CLEF safety gate and hand back an evidenced result."
        ),
        "commands": [
            {"path": ["whoami"], "summary": "Identity probe from culture.yaml."},
            {"path": ["learn"], "summary": "Self-teaching prompt."},
            {"path": ["explain"], "summary": "Markdown docs by path."},
            {"path": ["overview"], "summary": "Descriptive snapshot of the agent."},
            {"path": ["doctor"], "summary": "Check the agent-identity invariants."},
            {
                "path": ["run"],
                "summary": (
                    "Run one task on a harness adapter (--model picks a registry model; "
                    "--test-command names checks the harness runs before merging; "
                    "--support-score on|off overrides the model's support-score switch "
                    "for one run); "
                    "the result carries the support score the export holds as "
                    "support_facts, labelled support_source: extension; "
                    "exits 2 without serving when the adapter cannot prove its "
                    "extension loaded."
                ),
            },
            {
                "path": ["bench"],
                "summary": "Run a public suite (--suite NAME --model KEY) or list suites.",
            },
            {
                "path": ["runs", "start"],
                "summary": (
                    "Start a detached associate run on a checkout (one per checkout at a time); "
                    "returns a run id at once."
                ),
            },
            {
                "path": ["runs", "show"],
                "summary": (
                    "A run's status and, when finished, ok (outcome ok AND merged AND tests "
                    "passed), merge, tests, base commit and changed paths."
                ),
            },
            {"path": ["runs", "list"], "summary": "The most recent runs with their status."},
            {"path": ["runs", "overview"], "summary": "Describe the runs verbs."},
            {
                "path": ["mcp"],
                "summary": "Serve the runs verbs as MCP tools over stdio (the mcp extra).",
            },
            {
                "path": ["serve"],
                "summary": "Run the runs HTTP API under uvicorn (the server extra).",
            },
            {"path": ["tokens", "issue"], "summary": "Issue a service token (printed once)."},
            {"path": ["tokens", "list"], "summary": "List tokens, never the token or its hash."},
            {"path": ["tokens", "revoke"], "summary": "Revoke a service token by id."},
            {"path": ["tokens", "overview"], "summary": "Describe the tokens verbs."},
            {
                "path": ["check"],
                "summary": (
                    "Re-check an export directory's hand-back facts against its walk and "
                    "saved results; print counts per kind and per source kind. A support "
                    "score the export holds is copied onto each fact (support_source: "
                    "extension), never recomputed."
                ),
            },
            {
                "path": ["measure", "run"],
                "summary": (
                    "Run a comparison of arms over tasks and store one graded result per task, "
                    "arm and repeat; --detach runs it in the background. An arm may set "
                    "support_score (on or off), named in each stored record. Refuses without the "
                    "committed difference note except on the stub harness (plumbing only). "
                    "--broad runs the broad tasks and needs the committed, confirmed rule file."
                ),
            },
            {
                "path": ["measure", "status"],
                "summary": "Read-only: runs stored, failed and not yet stored; the lock; the log.",
            },
            {
                "path": ["measure", "report"],
                "summary": (
                    "Print the table of the stored results (--reading, --json); for a broad "
                    "comparison, per run: checklist facts marked as stated (a first marking) "
                    "and, once every run is graded, statements counted false."
                ),
            },
            {
                "path": ["measure", "sample"],
                "summary": "Write the blank hand-grading sheet for a fixed-seed draw of runs.",
            },
            {
                "path": ["measure", "agreement"],
                "summary": (
                    "Read a filled hand-grading sheet back and compare it with the grader: "
                    "agreement and the 48-run and 95% conditions, met or not met (read-only)."
                ),
            },
            {
                "path": ["measure", "sheet"],
                "summary": (
                    "Broad tasks: write the grading sheet (each run's statements, runs "
                    "shuffled under ids that hide the arm) and, separately, the key."
                ),
            },
            {
                "path": ["measure", "sheet-check"],
                "summary": (
                    "Broad tasks: list what a filled grading sheet lacks (a verdict per "
                    "statement, a file and positive line per false; --clone-root looks "
                    "them up); exit 1 until acceptable."
                ),
            },
            {"path": ["measure", "overview"], "summary": "Describe the measure verbs."},
            {"path": ["cli", "overview"], "summary": "Describe the CLI surface."},
        ],
        "exit_codes": {
            "0": "success",
            "1": "user-input error",
            "2": "environment/setup error",
            "3": "run only: hand-back refused after the allowed rounds; result still printed",
            "4": "run only: pi timed out at --timeout; result with outcome timeout still printed",
        },
        "json_support": True,
        "explain_pointer": "associate explain <path>",
    }


def cmd_learn(args: argparse.Namespace) -> int:
    if getattr(args, "json", False):
        emit_result(_as_json_payload(), json_mode=True)
    else:
        emit_result(_TEXT, json_mode=False)
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "learn",
        help="Print a structured self-teaching prompt for agent consumers.",
    )
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_learn)
