"""The behavioral suite: the same seven cases against any adapter (claim c48).

The corpus is *portable* — it belongs to the contract side of the boundary, with
the role and permission bounds, the task and hand-back formats and the evidence
artifacts (c50). What is tailored to a runtime — prompts, tool schemas,
presentation, context policy — is not evaluated here; what is evaluated is the
outcome: did the run read what it should have read, cite what it read, refuse
what it must refuse, and hand back inside its budget.

Layout::

    corpus.py   the seven cases as data, plus the fixture writer
    replay.py   a case's expectations as a script for a replaying adapter
    checks.py   deterministic checks over walk.jsonl and statements.json
    config.py   the complete configuration every row is stamped with
    runner.py   run one case / the whole suite
    table.py    render the table
    walkstats.py  aggregate many runs' walk.jsonl into a latency/failure table

A run against the stub adapter exercises all of that with no pi and no lane. It
is labelled ``plumbing-only`` everywhere it is reported, and must never be
presented as a measurement of the model.
"""

from __future__ import annotations

from associate.bench.corpus import CATEGORIES, Case, CorpusError, load_cases
from associate.bench.runner import Row, SuiteResult, run_suite
from associate.bench.table import render

__all__ = [
    "CATEGORIES",
    "Case",
    "CorpusError",
    "Row",
    "SuiteResult",
    "load_cases",
    "render",
    "run_suite",
]
