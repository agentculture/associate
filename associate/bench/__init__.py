"""Benchmarks: public suites only (BFCL, MMMU, LiveCodeBench) — none wired yet.

The in-house behavioral suite was dropped; suite entries arrive as data in a
later task. What remains here is infrastructure a public-suite run reuses::

    config.py     the complete configuration every row is stamped with
    runner.py     result types and the start/submit/collect plumbing
    table.py      render a result table
    walkstats.py  aggregate many runs' walk.jsonl into a latency/failure table
"""

from __future__ import annotations

from associate.bench.runner import Row, SuiteResult, run_task
from associate.bench.table import render

__all__ = ["Row", "SuiteResult", "render", "run_task"]
