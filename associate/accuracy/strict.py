"""The strict hand-back's counts, copied from the export. Nothing here computes them.

A run with strict facts on (``ASSOCIATE_STRICT``, or accuracy.json
``strict.enabled``) writes ``check.json`` with ``"mode": "strict"`` and a
``strict`` object, and ``report.json`` with a ``strict`` object. Its facts point
at lines (``at``) instead of quoting; the Python re-check in evidence-cli
(0.7.x) knows only the quote shape. Run on such an export it reads every fact
as a quote of length zero and refuses it (``quote_short``), which says nothing
about the facts.

So for a strict export associate does not present evidence-cli's result:

* the re-check is reported as **not run** (``python_recheck_ran`` false, and
  :data:`STRICT_REASON` as the ``not_applicable_reason``), with no verdict and
  no counts from it;
* the extension's own counts are printed, labelled ``source: extension``. They
  are read from the two files, never recomputed, and are not a second,
  independent check: the same code that dropped the items counted them.

Nothing here raises on a bad file: what cannot be read is absent from the copy.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Optional

#: Who computed the counts; the label every copy carries.
STRICT_SOURCE = "extension"

#: The ``mode`` ``check.json`` carries for a strict hand-back.
STRICT_MODE = "strict"

#: The key of the copy in a run result and in ``associate check``'s output.
RESULT_KEY = "strict"

#: Why the Python re-check did not run on a strict export.
STRICT_REASON = "strict export: the Python re-check for strict facts is not in evidence-cli yet"

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
    ``recheck`` says the Python re-check did not run. A field the files do not
    hold is None.
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
    out["recheck"] = {"ran": False, "reason": STRICT_REASON}
    return out


def mask_inspected(inspected: Mapping[str, Any], strict: Mapping[str, Any]) -> dict[str, Any]:
    """*inspected* (evidence-cli's ``inspect_export``) made honest for a strict export.

    The calls and the walk format stay; the facts, verdicts and counts the
    re-check produced from the wrong shape are removed, and the result says the
    re-check did not run. The extension's counts sit beside, under ``strict``.
    """
    out = {
        key: value
        for key, value in inspected.items()
        if key not in ("facts", "verdicts", "open_items", "report", "accepted")
    }
    out.update(
        applicable=False,
        not_applicable_reason=STRICT_REASON,
        facts=[],
        verdicts=[],
        open_items=[],
        python_recheck_ran=False,
        **{RESULT_KEY: dict(strict)},
    )
    return out


def mask_accuracy(accuracy: Mapping[str, Any]) -> dict[str, Any]:
    """A run result's ``accuracy`` object with the re-check shown as not run."""
    return {
        **accuracy,
        "python_recheck_ran": False,
        "python_recheck_verdict": None,
        "not_applicable_reason": STRICT_REASON,
        "report": None,
    }


def count_lines(strict: Mapping[str, Any]) -> list[str]:
    """The text form of the extension's strict counts, labelled as the extension's."""
    counts = strict.get("counts") or {}
    dropped = strict.get("dropped") or {}
    reasons = dropped.get("by_reason") or {}
    named = ", ".join(f"{k} {v}" for k, v in reasons.items()) or "none"
    rounds = f"rounds used {strict.get('rounds_used')} of {strict.get('retry_rounds')}"
    return [
        "Strict (counted by the extension, copied from the export; not a second check)",
        f"  {rounds}",
        "  facts: " + "  ".join(f"{k} {counts.get(k)}" for k in _OUTCOMES),
        f"  dropped {dropped.get('total')}: {named}",
        "  The Python re-check did not run on these facts; a count above is not a quote check.",
    ]
