"""The finish reminder a run was sent, read from the export (deviation d3, issue #38).

When ``associate run`` switched the finish reminder on and the model was about
to stop without calling ``finish``, the Pi extension sent it the reminder text
from ``accuracy.json`` and wrote ``reminder.json`` in the export:
``{"sent": n, "finish_followed": bool}``. The file is written only once a
reminder was sent, so an export without it was reminded zero times.

This module reads that one file and nothing else. A file that is present but
not of that shape (or is a link) is reported as not known (``sent`` None),
never as zero. Nothing here raises on a bad file.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Optional

#: The export file the extension writes (``lib/reminder.ts`` ``REMINDER_FILENAME``).
REMINDER_FILE = "reminder.json"
#: The run result's key, and ``associate check``'s.
RESULT_KEY = "finish_reminder"

_SENT = "sent"
_FOLLOWED = "finish_followed"
#: Far larger than the file the extension writes; a bigger one is not read.
_MAX_BYTES = 4096


def _not_known() -> dict[str, Any]:
    return {_SENT: None, _FOLLOWED: None}


def read_reminder(export_dir: Path) -> Optional[dict[str, Any]]:
    """The export's reminder record; None when the export holds no ``reminder.json``.

    A file that is a link, too large, unreadable or not
    ``{"sent": <int at least 1>, "finish_followed": <bool>}`` is ``sent`` None.
    """
    path = Path(export_dir) / REMINDER_FILE
    if not path.is_symlink() and not path.exists():
        return None
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > _MAX_BYTES:
            return _not_known()
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return _not_known()
    if not isinstance(value, dict):
        return _not_known()
    sent, followed = value.get(_SENT), value.get(_FOLLOWED)
    if not isinstance(sent, int) or isinstance(sent, bool) or sent < 1:
        return _not_known()
    if not isinstance(followed, bool):
        return _not_known()
    return {_SENT: sent, _FOLLOWED: followed}


def run_field(export_dir: Path) -> dict[str, Any]:
    """The run result's ``finish_reminder``: none sent (``finish_followed`` None) without a file."""
    held = read_reminder(export_dir)
    return held if held is not None else {_SENT: 0, _FOLLOWED: None}


def describe(record: Mapping[str, Any]) -> str:
    """One line for a record: none sent, sent n and whether finish followed, or not known."""
    sent = record.get(_SENT)
    if sent is None:
        return f"not readable ({REMINDER_FILE} in the export is not what the extension writes)"
    if sent == 0:
        return "none sent"
    followed = "finish followed" if record.get(_FOLLOWED) is True else "finish did not follow"
    return f"sent {sent}; {followed}"


def check_lines(record: Optional[Mapping[str, Any]]) -> list[str]:
    """``associate check``'s closing lines about the reminder; empty when the export holds none."""
    if record is None:
        return []
    return ["", f"Finish reminder: {describe(record)}"]
