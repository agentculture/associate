"""The support score of each fact, copied from the export. Nothing here computes it.

When the support score is on for a run, the Pi extension asks the decider, for
each fact whose quote was found, whether the quote supports the value, and
writes the answer as ``facts[i].support`` in the export's ``check.json`` (and
the number of scored facts as ``support_scored`` in ``report.json``). The Python
re-check (evidence-cli) recomputes the quote check from the walk and the saved
results and knows nothing of that field.

This module copies what the extension wrote onto the facts the re-check found,
and says where it came from (``support_source: "extension"``). It reads two
files of the export directory and nothing else: it asks no decider, opens no
socket, and imports no module that could. An export with no such field (written
before the score existed, or with the score off) gets no key at all.

What is read is validated. An entry that is not one of the two shapes the
extension writes, or that sits on a fact whose quote the re-check did not find,
is shown as ``{"status": "not_available", "reason": ...}``, never as a score.
Nothing here raises on a bad file.

The support score is a report-only signal. It is not the quote check, it
refuses nothing, and it is counted under its own name only.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Iterable, Mapping, NamedTuple, Optional

#: Who computed the score; the label every copy carries.
SUPPORT_SOURCE = "extension"

_CHECK_FILE = "check.json"
_REPORT_FILE = "report.json"
_SUPPORT_KEY = "support"
_FACTS_KEY = "facts"
_SOURCE_KEY = "support_source"
_COUNT_KEY = "support_scored"
_REPORTED_KEY = "support_scored_reported"
_UNMATCHED_KEY = "support_unmatched"
_STATUS = "status"
_REASON = "reason"
_DETAIL = "detail"
_SCORE = "score"
_CUTOFF_FLAG = "at_or_above_cutoff"
_SCORED = "scored"
_NOT_SCORED = "not_scored"
_NOT_AVAILABLE = "not_available"
#: The re-check verdict of a fact whose quote was found (the only facts the extension scores).
_QUOTE_FOUND = "passed"
#: Larger than any check.json the extension writes; a bigger file is not read.
_MAX_BYTES = 16 * 1024 * 1024
_MAX_DETAIL = 200
_REASON_RE = re.compile(r"[a-z][a-z0-9_]{0,63}", re.ASCII)
_ID_RE = re.compile(r"[A-Za-z0-9_.:-]{1,64}", re.ASCII)
_MALFORMED_ID = "<malformed id>"


# --- reading ---------------------------------------------------------------------------------


def _read_object(export_dir: Path, name: str) -> dict[str, Any]:
    """One of the export's JSON files as an object; empty when absent, linked, or unreadable."""
    path = Path(export_dir) / name
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > _MAX_BYTES:
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return {}
    return value if isinstance(value, dict) else {}


def _entries(check: Mapping[str, Any]) -> list[tuple[Any, Any]]:
    """``(id, support)`` for each fact of check.json that carries a ``support`` field."""
    facts = check.get(_FACTS_KEY)
    if not isinstance(facts, list):
        return []
    return [
        (fact.get("id"), fact[_SUPPORT_KEY])
        for fact in facts
        if isinstance(fact, dict) and _SUPPORT_KEY in fact
    ]


def _reported(report: Mapping[str, Any]) -> Optional[int]:
    """report.json's ``support_scored`` when it is a count, else None."""
    value = report.get(_COUNT_KEY)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


# --- validating ------------------------------------------------------------------------------


def _not_available(reason: str) -> dict[str, Any]:
    return {_STATUS: _NOT_AVAILABLE, _REASON: reason}


def _one_line(text: str) -> str:
    """*text* with every control character a space, cut to the detail limit."""
    cleaned = "".join(char if char.isprintable() else " " for char in text)
    return cleaned[:_MAX_DETAIL]


def _scored(raw: Mapping[str, Any]) -> dict[str, Any]:
    score, flag = raw.get(_SCORE), raw.get(_CUTOFF_FLAG)
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        return _not_available("score_not_a_number")
    if not math.isfinite(score) or not 0 <= score <= 1:
        return _not_available("score_out_of_range")
    if not isinstance(flag, bool):
        return _not_available("cutoff_flag_not_boolean")
    return {_STATUS: _SCORED, _SCORE: score, _CUTOFF_FLAG: flag}


def _not_scored(raw: Mapping[str, Any]) -> dict[str, Any]:
    reason, detail = raw.get(_REASON), raw.get(_DETAIL)
    if not isinstance(reason, str) or not _REASON_RE.fullmatch(reason):
        return _not_available("reason_malformed")
    if detail is None:
        return {_STATUS: _NOT_SCORED, _REASON: reason}
    if not isinstance(detail, str):
        return _not_available("detail_not_a_string")
    return {_STATUS: _NOT_SCORED, _REASON: reason, _DETAIL: _one_line(detail)}


def validated(raw: Any) -> dict[str, Any]:
    """One support result as the extension writes it, or ``not_available`` with the reason."""
    if not isinstance(raw, dict):
        return _not_available("not_an_object")
    if raw.get(_STATUS) == _SCORED:
        return _scored(raw)
    if raw.get(_STATUS) == _NOT_SCORED:
        return _not_scored(raw)
    return _not_available("unknown_status")


# --- matching to the re-check's facts --------------------------------------------------------


def _by_id(entries: Iterable[tuple[Any, Any]]) -> dict[Any, dict[str, Any]]:
    """Each id's validated result; an id that appears twice has none."""
    found: dict[Any, dict[str, Any]] = {}
    for fact_id, raw in entries:
        if not isinstance(fact_id, str):
            fact_id = _MALFORMED_ID
        found[fact_id] = _not_available("duplicate_id") if fact_id in found else validated(raw)
    return found


def _for_fact(fact: Mapping[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """*result* for a fact whose quote the re-check found, else ``not_available``."""
    if fact.get("verdict") != _QUOTE_FOUND:
        return _not_available("quote_not_found_by_recheck")
    return result


def _shown_id(fact_id: str) -> str:
    return fact_id if _ID_RE.fullmatch(fact_id) else _MALFORMED_ID


class Copied(NamedTuple):
    """What one export holds, matched to the re-check's facts."""

    #: A fact id to its result, for the facts check.json gave one.
    by_id: dict[Any, dict[str, Any]]
    #: How many of those results are shown as scored.
    scored: int
    #: The extension's own count from report.json, or None.
    reported: Optional[int]
    #: The ids check.json gave a result for that are not among the re-check's facts.
    unmatched: list[str]


class Held(NamedTuple):
    """What the export's two score files hold, read once."""

    #: ``(id, support)`` for each fact of check.json that carries a ``support`` field.
    entries: list[tuple[Any, Any]]
    #: report.json's ``support_scored`` count, or None.
    reported: Optional[int]


def read_support(export_dir: Path) -> Optional[Held]:
    """Read check.json and report.json once; None when the export holds no support result."""
    entries = _entries(_read_object(export_dir, _CHECK_FILE))
    reported = _reported(_read_object(export_dir, _REPORT_FILE))
    if not entries and reported is None:
        return None
    return Held(entries=entries, reported=reported)


def match_support(held: Held, facts: Iterable[Mapping[str, Any]]) -> Copied:
    """The results *held* for the re-check's *facts*."""
    found = _by_id(held.entries)
    known = {fact.get("id"): fact for fact in facts}
    by_id = {
        fact_id: _for_fact(known[fact_id], result)
        for fact_id, result in found.items()
        if fact_id in known
    }
    return Copied(
        by_id=by_id,
        scored=sum(1 for result in by_id.values() if result[_STATUS] == _SCORED),
        reported=held.reported,
        unmatched=sorted({_shown_id(fact_id) for fact_id in found if fact_id not in known}),
    )


def copy_support(export_dir: Path, facts: Iterable[Mapping[str, Any]]) -> Optional[Copied]:
    """The export's support results for the re-check's *facts*; None when it holds none."""
    held = read_support(export_dir)
    return None if held is None else match_support(held, facts)


def _summary_keys(copied: Copied) -> dict[str, Any]:
    """The keys beside the facts: the source label, the count, and what did not match."""
    keys: dict[str, Any] = {_SOURCE_KEY: SUPPORT_SOURCE, _COUNT_KEY: copied.scored}
    if copied.reported is not None:
        keys[_REPORTED_KEY] = copied.reported
    if copied.unmatched:
        keys[_UNMATCHED_KEY] = copied.unmatched
    return keys


def _facts_of(inspected: Mapping[str, Any]) -> list[Any]:
    return inspected.get(_FACTS_KEY) or []


def with_support(inspected: Mapping[str, Any], export_dir: Path) -> dict[str, Any]:
    """An ``inspect_export`` result with each fact's ``support`` copied on; unchanged when none."""
    facts = _facts_of(inspected)
    copied = copy_support(export_dir, facts)
    if copied is None:
        return dict(inspected)
    by_id = copied.by_id
    marked = [
        {**fact, _SUPPORT_KEY: by_id[fact["id"]]} if fact.get("id") in by_id else fact
        for fact in facts
    ]
    return {**inspected, _FACTS_KEY: marked, **_summary_keys(copied)}


def run_fields(inspected: Mapping[str, Any], held: Held) -> dict[str, Any]:
    """The run result's support keys from the files *held*: ``support_facts`` and the summary."""
    facts = _facts_of(inspected)
    copied = match_support(held, facts)
    by_id = copied.by_id
    listed = [
        {"id": fact["id"], _SUPPORT_KEY: by_id[fact["id"]]}
        for fact in facts
        if fact.get("id") in by_id
    ]
    return {**_summary_keys(copied), "support_facts": listed}


# --- plain words -----------------------------------------------------------------------------


def describe(result: Mapping[str, Any]) -> str:
    """One support result in plain words."""
    status = result.get(_STATUS)
    if status == _SCORED:
        words = "supports" if result[_CUTOFF_FLAG] else "may not support"
        return f"quote {words} the value (support {result[_SCORE]:.2f})"
    detail = f": {result[_DETAIL]}" if result.get(_DETAIL) else ""
    if status == _NOT_SCORED:
        return f"support not scored ({result[_REASON]}{detail})"
    return f"support not available ({result[_REASON]})"


def count_line(scored: int, shown: int) -> str:
    """How many of the shown results are scored, and where they came from."""
    return (
        f"{scored} of {shown} facts with a support result "
        f"(copied from the extension's check.json, not recomputed)"
    )


def summary_lines(result: Mapping[str, Any]) -> list[str]:
    """The closing lines of ``associate check`` about the support score; empty when none."""
    if result.get(_SOURCE_KEY) is None:
        return []
    scored = result[_COUNT_KEY]
    shown = sum(1 for fact in _facts_of(result) if _SUPPORT_KEY in fact)
    lines = [
        "",
        f"Support: scored {scored} of {shown} facts with a support result",
        "  the support score is copied from the extension's check.json and was not recomputed",
        "  here. It says whether the decider judged the quote to support the value; it is a",
        "  separate signal from the quote check and refuses nothing.",
    ]
    reported = result.get(_REPORTED_KEY)
    if reported is not None and reported != scored:
        lines.append(f"  the extension's report.json counts {reported} scored")
    unmatched = result.get(_UNMATCHED_KEY) or []
    if unmatched:
        lines.append(
            f"  check.json holds a support result for {', '.join(unmatched)}, which this "
            "re-check does not know; not shown"
        )
    return lines
