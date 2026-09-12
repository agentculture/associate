"""Run the behavioral corpus against one adapter and report a row per case.

The runner is the shared engine: ``associate bench`` and ``pytest`` both call
:func:`run_suite`, so the CLI verb and the test suite can never drift apart.

It knows nothing about any particular adapter. It resolves a name through
:func:`associate.harness.get_harness`, and an adapter that replays a script (the
stub) is detected generically — by whether its constructor accepts one — so
adding the pi adapter later needs no change here.
"""

from __future__ import annotations

import inspect
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from associate import contract
from associate.bench import checks as _checks
from associate.bench import config as _config
from associate.bench import replay as _replay
from associate.bench.corpus import Case, load_cases, materialize
from associate.harness import get_harness

__all__ = ["Row", "SuiteResult", "run_case", "run_suite"]

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


def _build(harness_cls: type, case: Case, checkout: Path) -> Any:
    """Instantiate the adapter, feeding a replaying one the case's script."""
    try:
        parameters = inspect.signature(harness_cls).parameters
    except (TypeError, ValueError):  # pragma: no cover - exotic callables
        parameters = {}
    if "script" in parameters:
        return harness_cls(**_replay.replay_kwargs(case, checkout))
    return harness_cls()


def run_case(harness_cls: type, case: Case, workdir: Path) -> tuple[Row, Any, dict[str, Any]]:
    """Materialise the fixture, run one case, and check what came back."""
    root = workdir / case.id
    checkout = materialize(case, root / "checkout")
    export_dir = root / "export"
    session_id = f"bench-{case.id}-{uuid.uuid4().hex[:8]}"
    task = {
        "id": case.id,
        "prompt": case.prompt,
        "checkout": str(checkout),
        "session_id": session_id,
        "export_dir": str(export_dir),
    }
    before = _checks.digest_files(checkout, case.expect.get("unchanged_files", []))

    harness: Any = None
    result: dict[str, Any] = {}
    failures: list[str] = []
    started = time.perf_counter()
    try:
        harness = _build(harness_cls, case, checkout)
        harness.start(
            checkout=checkout,
            contract_dir=contract.contract_dir(),
            session_id=session_id,
            export_dir=export_dir,
        )
        harness.submit(task)
        result = harness.collect()
    except Exception as err:  # noqa: BLE001 - a broken adapter is a failed row
        failures.append(f"{type(err).__name__}: {err}")
    duration_ms = max(0, int((time.perf_counter() - started) * 1000))

    if not failures:
        try:
            artifacts = _checks.load_artifacts(result)
            failures = _checks.run_checks(case, checkout, result, artifacts, before)
        except Exception as err:  # noqa: BLE001 - unreadable artifacts are a failed row
            failures = [f"artifacts unreadable: {type(err).__name__}: {err}"]

    row = Row(case_id=case.id, category=case.category, duration_ms=duration_ms, failures=failures)
    return row, harness, result


def run_suite(
    harness_name: str,
    *,
    cases: list[Case] | None = None,
    cases_dir: Path | str | None = None,
    workdir: Path | str | None = None,
) -> SuiteResult:
    """Run every corpus case against the named adapter.

    Raises ``KeyError`` (naming the available adapters) for an unknown harness
    and ``CorpusError`` when the corpus cannot be loaded — both before any case
    runs, so a misconfigured invocation never reports partial numbers.
    """
    harness_cls = get_harness(harness_name)
    corpus_cases = cases if cases is not None else load_cases(cases_dir)
    base = Path(workdir) if workdir is not None else Path(tempfile.mkdtemp(prefix="associate-"))
    base.mkdir(parents=True, exist_ok=True)

    rows: list[Row] = []
    last_harness: Any = None
    last_result: dict[str, Any] = {}
    for case in corpus_cases:
        row, harness, result = run_case(harness_cls, case, base)
        rows.append(row)
        if result:
            last_harness, last_result = harness, result

    configuration = _config.describe(harness_name, last_harness, last_result)
    for row in rows:
        row.configuration = configuration
    return SuiteResult(configuration=configuration, rows=rows)
