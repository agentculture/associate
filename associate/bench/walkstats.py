"""Aggregate the run records of many walks into a latency and failure table.

Claim c36 — *reliability is observable* — is only half satisfied by the walk
recorder stamping ``duration_ms``, ``tool_calls``, ``outcome`` and ``truncated``
onto the last line of every ``walk.jsonl``. The other half is being able to
*report* latency and failure rate per task class rather than assert them, which
is what this module does: point it at ten runs and it prints the table.

It reads nothing but what the harness already wrote. A walk with no run record
is a run that did not finish — it is counted as ``incomplete`` and counted
against the failure rate, never silently skipped, because an unfinished run is
exactly the kind of failure the table exists to surface.

Usage::

    python -m associate.bench.walkstats <dir-or-walk.jsonl> [...] [--per-run]
    python -m associate.bench.walkstats <dir> --json

stdlib only, like the rest of this package.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

__all__ = [
    "WALK_FILENAME",
    "OUTCOMES",
    "Stats",
    "aggregate",
    "find_walks",
    "load_run_record",
    "main",
    "render",
]

#: The file the walk recorder writes inside a session export directory.
WALK_FILENAME = "walk.jsonl"

#: The outcomes ``walk.schema.json`` allows, plus the harness-side pseudo
#: outcome for a walk whose run never closed.
OUTCOMES: tuple[str, ...] = ("ok", "error", "refused", "budget_exceeded", "incomplete")

#: Every outcome that is not a clean finish.
FAILURE_OUTCOMES = frozenset(OUTCOMES) - {"ok"}


def find_walks(paths: Sequence[str | Path]) -> list[Path]:
    """Every ``walk.jsonl`` named by, or beneath, *paths*, in sorted order."""
    found: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            found.extend(sorted(path.rglob(WALK_FILENAME)))
        elif path.is_file() and path.name == WALK_FILENAME:
            # Only a file actually named walk.jsonl is ever opened: an argument
            # naming any other file (or a path that escapes via symlink) is
            # ignored rather than read.
            found.append(path)
    # A directory tree can name the same walk twice; keep the first mention.
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in found:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(path)
    return unique


def load_run_record(walk_path: Path) -> dict[str, Any]:
    """The run record of one walk, or an ``incomplete`` stand-in.

    The stand-in carries ``complete: False`` so a caller can tell a run that
    reported ``outcome: "error"`` from a run that never got to report at all.
    """
    record: dict[str, Any] = {}
    walk_path = Path(walk_path)
    resolved = walk_path.resolve()
    if resolved.name != WALK_FILENAME or not resolved.is_file():
        text = ""
    else:
        try:
            text = resolved.read_text(encoding="utf-8")
        except OSError:
            text = ""
    entries = 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            # A partially written final line is what a killed run leaves; the
            # lines before it are still good, so this is not fatal.
            continue
        if isinstance(parsed, dict) and set(parsed) == {"run"} and isinstance(parsed["run"], dict):
            record = dict(parsed["run"])
        elif isinstance(parsed, dict):
            entries += 1

    if not record:
        return {
            "path": str(walk_path),
            "complete": False,
            "outcome": "incomplete",
            "duration_ms": None,
            "tool_calls": entries,
            "truncated": False,
        }
    record.setdefault("outcome", "incomplete")
    record.setdefault("tool_calls", entries)
    record.setdefault("truncated", False)
    record.setdefault("duration_ms", None)
    record["path"] = str(walk_path)
    record["complete"] = True
    return record


def percentile(values: Sequence[float], fraction: float) -> float:
    """Nearest-rank percentile over *values* (already unsorted is fine).

    Nearest-rank rather than an interpolating definition: with ten runs an
    interpolated p90 reports a latency no run actually had, and this table is
    read as a claim about observed runs.
    """
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, min(len(ordered), int(-(-fraction * len(ordered) // 1))))
    return float(ordered[rank - 1])


@dataclass
class Stats:
    """One row of the table: the aggregate over a group of runs."""

    label: str
    runs: int = 0
    outcomes: dict[str, int] = field(default_factory=dict)
    durations: list[int] = field(default_factory=list)
    tool_calls: list[int] = field(default_factory=list)
    truncated: int = 0

    @property
    def failures(self) -> int:
        return sum(count for name, count in self.outcomes.items() if name in FAILURE_OUTCOMES)

    @property
    def failure_rate(self) -> float:
        return (self.failures / self.runs) if self.runs else 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "runs": self.runs,
            "ok": self.outcomes.get("ok", 0),
            "failures": self.failures,
            "failure_rate": round(self.failure_rate, 4),
            "outcomes": {name: self.outcomes[name] for name in OUTCOMES if name in self.outcomes},
            "truncated": self.truncated,
            "p50_ms": int(percentile(self.durations, 0.50)),
            "p90_ms": int(percentile(self.durations, 0.90)),
            "max_ms": int(max(self.durations)) if self.durations else 0,
            "mean_tool_calls": (
                round(sum(self.tool_calls) / len(self.tool_calls), 2) if self.tool_calls else 0.0
            ),
        }


def aggregate(records: Iterable[dict[str, Any]], label: str = "all") -> Stats:
    """Fold run records into one :class:`Stats`."""
    stats = Stats(label=label)
    for record in records:
        stats.runs += 1
        outcome = record.get("outcome") or "incomplete"
        if outcome not in OUTCOMES:
            outcome = "incomplete"
        stats.outcomes[outcome] = stats.outcomes.get(outcome, 0) + 1
        duration = record.get("duration_ms")
        if isinstance(duration, int) and not isinstance(duration, bool):
            stats.durations.append(duration)
        calls = record.get("tool_calls")
        if isinstance(calls, int) and not isinstance(calls, bool):
            stats.tool_calls.append(calls)
        if record.get("truncated") is True:
            stats.truncated += 1
    return stats


#: (header, row key) pairs, in print order — the same shape ``bench.table`` uses.
COLUMNS: tuple[tuple[str, str], ...] = (
    ("group", "label"),
    ("runs", "runs"),
    ("ok", "ok"),
    ("fail", "failures"),
    ("fail rate", "failure_rate"),
    ("truncated", "truncated"),
    ("p50 ms", "p50_ms"),
    ("p90 ms", "p90_ms"),
    ("max ms", "max_ms"),
    ("mean calls", "mean_tool_calls"),
)


def render(rows: Sequence[Stats], breakdown: Sequence[dict[str, Any]] = ()) -> str:
    """Render the latency and failure table, plus an outcome breakdown line."""
    dicts = [row.as_dict() for row in rows]
    cells = [[header for header, _ in COLUMNS]]
    cells += [[str(row.get(key, "")) for _, key in COLUMNS] for row in dicts]
    widths = [max(len(line[index]) for line in cells) for index in range(len(COLUMNS))]

    def line(values: list[str]) -> str:
        return "| " + " | ".join(v.ljust(widths[i]) for i, v in enumerate(values)) + " |"

    separator = "|-" + "-|-".join("-" * width for width in widths) + "-|"
    out = [line(cells[0]), separator]
    out += [line(values) for values in cells[1:]]

    for row in dicts:
        counts = ", ".join(f"{name}={count}" for name, count in row["outcomes"].items())
        out.append(f"outcomes ({row['label']}): {counts or 'none'}")

    for record in breakdown:
        out.append(
            f"  {record.get('outcome')}\t{record.get('duration_ms')}ms\t"
            f"{record.get('tool_calls')} calls\t{record.get('path')}"
        )
    return "\n".join(out)


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for ``python -m associate.bench.walkstats``."""
    parser = argparse.ArgumentParser(
        prog="associate.bench.walkstats",
        description="Aggregate walk.jsonl run records into a latency and failure table.",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        default=["."],
        help="walk.jsonl files, or directories searched recursively for them",
    )
    parser.add_argument("--per-run", action="store_true", help="list every run under the table")
    parser.add_argument("--json", action="store_true", help="emit the aggregate as JSON")
    args = parser.parse_args(argv)

    walks = find_walks(args.paths or ["."])
    if not walks:
        print(f"no {WALK_FILENAME} found under: {', '.join(args.paths or ['.'])}", file=sys.stderr)
        return 1

    records = [load_run_record(path) for path in walks]
    stats = aggregate(records)
    if args.json:
        print(json.dumps({"aggregate": stats.as_dict(), "runs": records}, indent=2))
    else:
        print(render([stats], records if args.per_run else ()))
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised via main()
    raise SystemExit(main())
