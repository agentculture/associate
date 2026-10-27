"""Result types and the adapter plumbing a public-suite run reuses.

There is no in-house corpus any more: benchmarks are public suites only. What
stays is the shape of a result (:class:`Row`, :class:`SuiteResult`, rendered by
``table.py``) and :func:`run_task`, which drives one task through an adapter's
``start`` / ``submit`` / ``collect`` and times it. It knows nothing about any
particular adapter.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from associate import contract

__all__ = ["Row", "SuiteResult", "run_task"]

_ROW_CONFIG_KEYS = (
    "harness",
    "model_role",
    "served_model_id",
    "pi_version",
    "extension_version",
    "provider",
    "reasoning",
)


@dataclass
class Row:
    """One case's result, carried with the configuration it was measured on."""

    case_id: str
    category: str
    duration_ms: int
    failures: list[str] = field(default_factory=list)
    configuration: dict[str, Any] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return not self.failures

    @property
    def result(self) -> str:
        return "pass" if self.passed else "fail"

    @property
    def note(self) -> str:
        return "plumbing-only" if self.configuration.get("plumbing_only") else ""

    def as_dict(self) -> dict[str, Any]:
        row = {key: self.configuration.get(key, "unknown") for key in _ROW_CONFIG_KEYS}
        row.update(
            {
                "category": self.category,
                "case_id": self.case_id,
                "result": self.result,
                "duration_ms": self.duration_ms,
                "note": self.note,
                "failures": list(self.failures),
            }
        )
        return row


@dataclass
class SuiteResult:
    """Every row of one bench run, plus the configuration they share."""

    configuration: dict[str, Any]
    rows: list[Row]

    @property
    def passed(self) -> bool:
        return all(row.passed for row in self.rows)

    def as_dict(self) -> dict[str, Any]:
        return {
            "configuration": dict(self.configuration),
            "rows": [row.as_dict() for row in self.rows],
            "passed": self.passed,
            "failed": sum(1 for row in self.rows if not row.passed),
        }


def run_task(
    harness_cls: type, task: dict[str, Any], workdir: Path
) -> tuple[Any, dict[str, Any], int, str | None]:
    """Run one task through an adapter; return (harness, result, duration_ms, error).

    A broken adapter is reported as ``error`` rather than raised, so a suite can
    record it as a failed row and carry on.
    """
    checkout = Path(task["checkout"])
    harness: Any = None
    result: dict[str, Any] = {}
    error: str | None = None
    started = time.perf_counter()
    try:
        harness = harness_cls()
        harness.start(
            checkout=checkout,
            contract_dir=contract.contract_dir(),
            session_id=task["session_id"],
            export_dir=Path(task["export_dir"]),
        )
        harness.submit(task)
        result = harness.collect()
    except Exception as err:  # noqa: BLE001 - a broken adapter is a failed row
        error = f"{type(err).__name__}: {err}"
    duration_ms = max(0, int((time.perf_counter() - started) * 1000))
    return harness, result, duration_ms, error
