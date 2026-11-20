"""A strict hand-back: the extension's counts, copied, and evidence-cli's re-check of them.

A run with strict facts on (``ASSOCIATE_STRICT``, or accuracy.json
``strict.enabled``) writes ``check.json`` with ``"mode": "strict"`` and a
``strict`` object, and ``report.json`` with a ``strict`` object. Its facts point
at lines (``at``) instead of quoting.

Two things are reported for such an export, and they are kept apart:

* **the extension's own counts**, read from the two files and never recomputed
  here, labelled ``source: extension`` (:func:`read_strict`). The same code that
  dropped the items counted them;
* **the Python re-check**, evidence-cli's ``recheck_strict_export`` (0.8.0 on):
  a second implementation of the strict check run over the export's saved
  files, compared part by part with what ``check.json`` recorded
  (:func:`run_recheck`, :func:`summarise`). It never asks a decider: the
  decider's answers stored in ``check.json`` are an input, so it cannot
  disagree with them. It also takes the facts recorded as ``keep_marked`` while
  a round was left as returned in an earlier round, so it cannot disagree with
  the record on ``keep_marked`` against ``returned``.

A fact with outcome ``pass`` had its evidence copied from a saved result, or its
quote found in one. That does not mean the value is true, and no count here
measures correctness.

Nothing here raises on a bad file: what cannot be read is absent from the copy,
and a re-check that cannot read the export is reported as not run, with the
reason.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Optional

from evidence.accuracy.check import ExportError
from evidence.accuracy.strict_export import recheck_strict_export

#: Who computed the counts; the label every copy carries.
STRICT_SOURCE = "extension"

#: The ``mode`` ``check.json`` carries for a strict hand-back.
STRICT_MODE = "strict"

#: The key of the copy in a run result and in ``associate check``'s output.
RESULT_KEY = "strict"

#: The key of evidence-cli's whole re-check result in ``associate check``'s output.
RECHECK_KEY = "strict_recheck"

#: The ``check`` value evidence-cli gives a result it produced with the strict re-check.
STRICT_CHECK = "strict"

#: What the comparison adds to a result, beside ``python_recheck_ran``:
#: the summary key (see :func:`summarise`) and the result key that carries it.
_RESULT_FIELDS = (
    ("agrees", "python_recheck_agrees"),
    ("compared", "python_recheck_compared"),
    ("not_compared", "python_recheck_not_compared"),
    ("disagreements", "python_recheck_disagreements"),
)

#: The outcomes the extension counts facts under, in the order shown.
_OUTCOMES = ("pass", "keep_marked", "returned", "dropped", "not_judged")

_CHECK_FILE = "check.json"
_REPORT_FILE = "report.json"
#: Larger than any file the extension writes; a bigger one is not read.
_MAX_BYTES = 16 * 1024 * 1024
#: The ``strict`` fields of ``check.json`` that are copied (not the item lists).
_CHECK_FIELDS = (
    "enabled",
    "source",
    "retry_rounds",
    "rounds_used",
    "round_open",
    "counts",
    "drop_reasons",
    "judge_counts",
)


def _read_json(path: Path) -> Optional[dict[str, Any]]:
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > _MAX_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def is_strict(export_dir: Path) -> bool:
    """Whether the export's ``check.json`` says it was written by the strict flow."""
    check = _read_json(Path(export_dir) / _CHECK_FILE)
    return bool(check) and check.get("mode") == STRICT_MODE


def read_strict(export_dir: Path) -> Optional[dict[str, Any]]:
    """The extension's strict counts for *export_dir*; None when it is not a strict export.

    Keys: ``source`` (always ``"extension"``), ``switch_source`` (what decided
    strict was on: ``environment`` or ``contract``), ``rounds_used``,
    ``retry_rounds``, ``round_open``, ``counts`` (facts per outcome: pass,
    keep_marked, returned, dropped, not_judged), ``dropped`` (``{"total",
    "by_reason"}``), ``returned``, ``not_judged``, ``judge_counts``, and
    ``report`` (the ``strict`` object of ``report.json``, when it holds one).
    A field the files do not hold is None. ``recheck`` (whether the Python
    re-check ran, and whether it agrees) is added by :func:`with_recheck`.
    """
    export_dir = Path(export_dir)
    check = _read_json(export_dir / _CHECK_FILE)
    if not check or check.get("mode") != STRICT_MODE:
        return None
    held = check.get("strict") if isinstance(check.get("strict"), dict) else {}
    report_file = _read_json(export_dir / _REPORT_FILE) or {}
    report = report_file.get("strict") if isinstance(report_file.get("strict"), dict) else None
    counts = held.get("counts") if isinstance(held.get("counts"), dict) else None
    reasons = held.get("drop_reasons") if isinstance(held.get("drop_reasons"), dict) else None
    out: dict[str, Any] = {"source": STRICT_SOURCE, "switch_source": held.get("source")}
    out.update({key: held.get(key) for key in _CHECK_FIELDS if key not in ("source", "enabled")})
    out["dropped"] = {
        "total": counts.get("dropped") if counts else None,
        "by_reason": dict(reasons) if reasons is not None else None,
    }
    out["returned"] = counts.get("returned") if counts else None
    out["not_judged"] = counts.get("not_judged") if counts else None
    out["report"] = report
    return out


def not_run(reason: Optional[str]) -> dict[str, Any]:
    """The re-check summary of a strict export the re-check did not run on."""
    return {
        "ran": False,
        "reason": reason,
        "agrees": None,
        "compared": None,
        "not_compared": None,
        "disagreements": None,
    }


def summarise(recheck: Mapping[str, Any]) -> dict[str, Any]:
    """What evidence-cli's strict re-check result says, in six keys.

    ``ran`` (true), ``reason`` (None), ``agrees`` (no compared part differs from
    the export's ``check.json``), ``compared`` and ``not_compared`` (the parts of
    the record that were and were not compared) and ``disagreements`` (one
    ``{"id", "field", "recorded", "recheck"}`` per field that differs).
    """
    comparison = recheck.get("comparison")
    comparison = comparison if isinstance(comparison, dict) else {}
    return {
        "ran": True,
        "reason": None,
        "agrees": comparison.get("agrees") is True,
        "compared": list(comparison.get("compared") or []),
        "not_compared": list(comparison.get("not_compared") or []),
        "disagreements": [dict(found) for found in comparison.get("disagreements") or []],
    }


def run_recheck(
    export_dir: Path, accuracy: Mapping[str, Any], continue_from: Optional[Path] = None
) -> tuple[dict[str, Any], Optional[dict[str, Any]]]:
    """Run evidence-cli's strict re-check on *export_dir*: (summary, its whole result).

    An export the re-check cannot read gives ``(not_run(reason), None)``, never
    an exception.
    """
    try:
        recheck = recheck_strict_export(Path(export_dir), accuracy, continue_from=continue_from)
    except ExportError as err:
        return not_run(f"strict export: the Python re-check could not read it: {err}"), None
    return summarise(recheck), recheck


def result_fields(summary: Mapping[str, Any]) -> dict[str, Any]:
    """The ``python_recheck_*`` keys a strict result gains from a re-check summary."""
    return {key: summary.get(name) for name, key in _RESULT_FIELDS}


def with_recheck(strict: Mapping[str, Any], summary: Mapping[str, Any]) -> dict[str, Any]:
    """The extension's copy with ``recheck``: whether the re-check ran, why not, and agreement."""
    return {
        **strict,
        "recheck": {key: summary.get(key) for key in ("ran", "reason", "agrees")},
    }


def checked_accuracy(accuracy: Mapping[str, Any], summary: Mapping[str, Any]) -> dict[str, Any]:
    """A run result's ``accuracy`` object for a strict export, with the comparison beside it.

    evidence-cli's own fields stay as they are (``python_recheck_ran``,
    ``python_recheck_verdict``, ``not_applicable_reason``, ``report``, ``check``).
    When the re-check could not be compared, ``python_recheck_ran`` is false and
    the reason is given.
    """
    out = {**accuracy, **result_fields(summary)}
    if not summary.get("ran"):
        out.update(
            python_recheck_ran=False,
            python_recheck_verdict=None,
            not_applicable_reason=accuracy.get("not_applicable_reason") or summary.get("reason"),
            report=None,
        )
    return out


def checked_inspected(inspected: Mapping[str, Any], strict: Mapping[str, Any]) -> dict[str, Any]:
    """*inspected* (evidence-cli's ``inspect_export``) for a strict export, as ``associate check``
    prints it.

    evidence-cli puts its whole strict re-check under ``strict``; here that key
    holds the extension's copy (as it always has), so the re-check moves to
    ``strict_recheck``. The result gains ``python_recheck_ran`` and the four
    ``python_recheck_*`` comparison keys. When the re-check did not run (the
    export holds no facts payload, or its walk format is not supported), they
    say so and ``not_applicable_reason`` is evidence-cli's.
    """
    recheck = inspected.get(RESULT_KEY) if inspected.get("check") == STRICT_CHECK else None
    out = {key: value for key, value in inspected.items() if key != RESULT_KEY}
    if isinstance(recheck, dict) and inspected.get("applicable") is True:
        summary = summarise(recheck)
        out[RECHECK_KEY] = recheck
    else:
        summary = not_run(inspected.get("not_applicable_reason"))
    out.update(
        python_recheck_ran=summary["ran"],
        **result_fields(summary),
        **{RESULT_KEY: with_recheck(strict, summary)},
    )
    return out


def _named(counts: Mapping[str, Any]) -> str:
    return ", ".join(f"{k} {v}" for k, v in counts.items()) or "none"


def _fact_line(fact: Mapping[str, Any], source: Any) -> str:
    judge = fact.get("judge") if isinstance(fact.get("judge"), dict) else None
    asked = ""
    if judge is not None:
        answer = judge.get("option") if judge.get("option") is not None else judge.get("reason")
        asked = f" (decider's stored answer: {answer})"
    reason = f" ({fact['drop_reason']})" if fact.get("drop_reason") else ""
    return (
        f"  {fact.get('id')}  {source or 'no source'}  kind checked: "
        f"{fact.get('kind_checked') or 'none'}  {fact.get('status')}{asked}  "
        f"{fact.get('strict_outcome')}{reason}"
    )


def _disagreement_line(found: Mapping[str, Any]) -> str:
    where = f"{found.get('id')} " if found.get("id") is not None else ""
    return (
        f"    {where}{found.get('field')}: check.json has {found.get('recorded')!r}, "
        f"the re-check has {found.get('recheck')!r}"
    )


def comparison_lines(result: Mapping[str, Any]) -> list[str]:
    """Whether the re-check agrees with ``check.json``, what was compared, each disagreement."""
    found = result.get("python_recheck_disagreements") or []
    lines = [
        "Compared with the export's check.json",
        f"  agrees: {'yes' if result.get('python_recheck_agrees') else 'no'}",
        f"  compared: {', '.join(result.get('python_recheck_compared') or []) or 'none'}",
        f"  not compared: {', '.join(result.get('python_recheck_not_compared') or []) or 'none'}",
        f"  disagreements: {len(found) or 'none'}",
        *[_disagreement_line(one) for one in found],
        "  The decider's stored answers are an input: the re-check asks no decider and cannot",
        "  disagree with them, nor on keep_marked against returned.",
    ]
    return lines


def recheck_lines(result: Mapping[str, Any]) -> list[str]:
    """The text form of a strict re-check that ran: its counts, each fact, the comparison."""
    recheck = result.get(RECHECK_KEY) or {}
    ours = recheck.get("recheck") or {}
    counts = ours.get("counts") or {}
    rows = (recheck.get("comparison") or {}).get("facts") or []
    sources = {row.get("position"): row.get("source") for row in rows}
    lines = [
        "  strict facts, re-checked by evidence-cli from the saved files",
        "  facts: " + "  ".join(f"{k} {counts.get(k)}" for k in _OUTCOMES),
        f"  dropped by reason: {_named(ours.get('drop_reasons') or {})}",
        f"  checker verdict: {'accepted' if result.get('accepted') else 'refused'}",
        "  Each fact",
    ]
    lines += [
        _fact_line(fact, sources.get(position)) for position, fact in enumerate(result["facts"])
    ]
    lines.append(
        f"  conclusions {len(result.get('verdicts') or [])}  "
        f"open items {len(result.get('open_items') or [])}"
    )
    return [
        *lines,
        "",
        *comparison_lines(result),
        "",
        *count_lines(result[RESULT_KEY]),
        "",
        "pass means the fact's evidence was copied from a saved result, or its quote was found",
        "in one; it is not a statement that the fact is true.",
    ]


def count_lines(strict: Mapping[str, Any]) -> list[str]:
    """The text form of the extension's strict counts, labelled as the extension's."""
    counts = strict.get("counts") if isinstance(strict.get("counts"), dict) else {}
    dropped = strict.get("dropped") or {}
    rounds = f"rounds used {strict.get('rounds_used')} of {strict.get('retry_rounds')}"
    ran = (strict.get("recheck") or {}).get("ran") is True
    return [
        "Strict (counted by the extension, copied from the export; not a second check)",
        f"  {rounds}",
        "  facts: " + "  ".join(f"{k} {counts.get(k)}" for k in _OUTCOMES),
        f"  dropped {dropped.get('total')}: {_named(dropped.get('by_reason') or {})}",
        (
            "  These are the extension's own counts; the Python re-check's are above."
            if ran
            else "  The Python re-check did not run on these facts."
        ),
    ]
