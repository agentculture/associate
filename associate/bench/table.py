"""Render a suite result as the configuration table claim c48 asks for.

One row per category, and every row carries the *whole* configuration — harness,
model role, served model id, pi version, extension version, provider and
reasoning settings — so two tables from two runs can be compared without hunting
for the context they were produced in. A run whose adapter never touched a model
is labelled ``plumbing-only`` in the note column.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from associate.bench.runner import SuiteResult

__all__ = ["render", "COLUMNS"]

#: (header, row key) pairs, in print order.
COLUMNS: tuple[tuple[str, str], ...] = (
    ("harness", "harness"),
    ("model role", "model_role"),
    ("served model", "served_model_id"),
    ("pi", "pi_version"),
    ("extension", "extension_version"),
    ("provider", "provider"),
    ("reasoning", "reasoning"),
    ("category", "category"),
    ("result", "result"),
    ("ms", "duration_ms"),
    ("note", "note"),
)


def render(suite: "SuiteResult") -> str:
    """Return the table plus a one-line verdict."""
    rows = [row.as_dict() for row in suite.rows]
    cells = [[header for header, _ in COLUMNS]]
    cells += [[str(row.get(key, "")) for _, key in COLUMNS] for row in rows]
    widths = [max(len(line[index]) for line in cells) for index in range(len(COLUMNS))]

    def line(values: list[str]) -> str:
        return "| " + " | ".join(v.ljust(widths[i]) for i, v in enumerate(values)) + " |"

    separator = "|-" + "-|-".join("-" * width for width in widths) + "-|"
    out = [line(cells[0]), separator]
    out += [line(values) for values in cells[1:]]

    failed = sum(1 for row in suite.rows if not row.passed)
    verdict = "PASS" if suite.passed else f"FAIL ({failed} of {len(suite.rows)})"
    if suite.configuration.get("plumbing_only"):
        verdict += " — plumbing-only: this run verifies wiring, not model reliability"
    out += ["", f"bench: {verdict}"]
    return "\n".join(out)
