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
                               --test-command), or fail closed.
  associate bench              Run a public suite (--suite NAME --model KEY) or list suites.
  associate runs start         Start a detached run on a checkout (--checkout, --model,
                               --test-command, instruction); prints a run id at once.
  associate runs show <id>     Status, and when finished: ok, outcome, merge, tests,
                               base commit and changed paths. Nothing is ever pushed.
  associate runs list          The most recent runs with their status.
  associate runs overview      Describe the runs verbs (also served over HTTP).
  associate mcp                Serve the runs verbs as MCP tools over stdio (mcp extra).
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
  3+ reserved

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
                    "--test-command names checks the harness runs before merging); "
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
            {"path": ["cli", "overview"], "summary": "Describe the CLI surface."},
        ],
        "exit_codes": {
            "0": "success",
            "1": "user-input error",
            "2": "environment/setup error",
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
