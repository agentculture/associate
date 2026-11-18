"""Counts over checked facts (issue #20, t16): a plain tally, nothing more.

``passed`` means a fact's quote was found in the saved result it cites. It is
not a statement that the fact is true, and an ``unchecked`` fact (no saved text,
or only part of it) is never added to ``passed``. ``checked`` is ``passed`` plus
``refused``. Counts follow ``report.schema.json``; the TypeScript checker
(``lib/facts.ts``) builds the same numbers and both are compared in
``matcher_vectors.json``.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional

SOURCE_KINDS: tuple[str, ...] = ("file", "tool", "web", "memory", "agent", "harness")
VERDICTS: tuple[str, ...] = ("passed", "refused", "unchecked")


def empty_counts() -> dict[str, int]:
    return {"made": 0, "checked": 0, "passed": 0, "refused": 0, "unchecked": 0}


def count_fact(counts: dict[str, int], verdict: str) -> None:
    """Add one fact with *verdict* to *counts*. ``unchecked`` never reaches ``passed``."""
    counts["made"] += 1
    if verdict in VERDICTS:
        counts[verdict] += 1
    if verdict in ("passed", "refused"):
        counts["checked"] += 1


def fact_counts(facts: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    """Totals over every fact, whether or not its source resolved."""
    counts = empty_counts()
    for fact in facts:
        count_fact(counts, str(fact.get("verdict")))
    return counts


def counts_by_source_kind(facts: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, int]]:
    """The same counts per source kind; a fact with no source kind is in no row."""
    out = {kind: empty_counts() for kind in SOURCE_KINDS}
    for fact in facts:
        kind: Optional[str] = fact.get("source_kind")
        if kind in out:
            count_fact(out[kind], str(fact.get("verdict")))
    return out


def conclusion_counts(verdict_values: Iterable[str]) -> dict[str, int]:
    """Verdicts made, supported, refuted and open (open and cannot_tell)."""
    counts = {"made": 0, "supported": 0, "refuted": 0, "open": 0}
    for value in verdict_values:
        counts["made"] += 1
        if value == "supported":
            counts["supported"] += 1
        elif value == "refuted":
            counts["refuted"] += 1
        else:
            counts["open"] += 1
    return counts
