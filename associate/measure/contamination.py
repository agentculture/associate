"""Contamination checks over a run's walk. Pure functions; no network.

A measured run is contaminated when its walk shows any of three signs:

- ``answer_key``: a tool call whose arguments name the answer key's path;
- ``repository_hosting``: a ``web_search`` or ``web_page`` call that reaches
  the measured repository's hosting (host and owner/name from the task);
- ``recalled_record``: an ``eidetic_recall`` that returned a record.

Each reason carries the walk id of the entry that shows it. A recall whose
result cannot be read is reported as a recalled record, never assumed empty.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlparse

ANSWER_KEY = "answer_key"
REPOSITORY_HOSTING = "repository_hosting"
RECALLED_RECORD = "recalled_record"

_WEB_TOOLS = ("web_search", "web_page")
_RECALL_TOOL = "eidetic_recall"
_RAW_HOSTING = {"github.com": ("githubusercontent.com",)}
# Where a URL starts, and a URL up to the next white space.
_URL_START = re.compile(r"[a-z][a-z\d+.-]*://", re.ASCII)
_URL = re.compile(r"[a-z][a-z\d+.-]*://\S*", re.ASCII)


@dataclass(frozen=True)
class Reason:
    kind: str
    walk_id: str
    detail: str


@dataclass
class Verdict:
    reasons: list[Reason] = field(default_factory=list)

    @property
    def contaminated(self) -> bool:
        return bool(self.reasons)


def load_walk(path: str | os.PathLike[str]) -> list[dict]:
    """Read the call entries of a ``walk.jsonl``, skipping the format marker
    and the gate, child and run lines."""
    entries = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if isinstance(record, dict) and "id" in record and "tool" in record:
                entries.append(record)
    return entries


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


def _arg_strings(entry: dict) -> list[str]:
    return [*_strings(entry.get("args")), *_strings(entry.get("args_used"))]


def _host_matches(hostname: str, host: str) -> bool:
    hosts = (host, *_RAW_HOSTING.get(host, ()))
    return any(hostname == h or hostname.endswith("." + h) for h in hosts)


def _hostname(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").strip(".")
    except ValueError:
        return ""


def _urls(text: str) -> list[str]:
    """Every URL in *text*, a URL inside another URL's path or query included."""
    return [text[m.start() :].split(None, 1)[0] for m in _URL_START.finditer(text)]


def _reaches_repository(text: str, host: str, slug: str) -> bool:
    """Whether *text* names the repository: in words, or in any URL on its hosting.

    Every URL found anywhere in the text is checked, percent-encoded ones and
    one embedded in another URL (a proxy or an archive address) included. The
    owner/name in a URL on another host is not a sign; outside any URL it is.
    """
    lowered = unquote(text).lower()
    if slug not in lowered:
        return False
    if slug in _URL.sub(" ", lowered):
        # A search query or bare text naming owner/name.
        return True
    return any(slug in url and _host_matches(_hostname(url), host) for url in _urls(lowered))


def _key_reason(entry: dict, answer_key_paths: list[str]) -> Reason | None:
    for text in _arg_strings(entry):
        for key in answer_key_paths:
            if key and key in text:
                return Reason(ANSWER_KEY, entry["id"], f"argument names {key}")
    return None


def _hosting_reason(entry: dict, host: str, slug: str) -> Reason | None:
    if entry["tool"] not in _WEB_TOOLS:
        return None
    for text in _arg_strings(entry):
        if _reaches_repository(text, host, slug):
            return Reason(REPOSITORY_HOSTING, entry["id"], f"{entry['tool']} reaches {host}/{slug}")
    return None


def _result_text(entry: dict, export_dir: Path | None) -> str | None:
    content = (entry.get("result") or {}).get("content")
    if isinstance(content, str):
        return content
    saved = entry.get("saved_result")
    if saved and export_dir is not None:
        try:
            return (export_dir / saved).read_text(encoding="utf-8")
        except OSError:
            return None
    return None


def _recall_returned_record(text: str | None) -> str | None:
    """Why the recall counts as having returned a record, or None if empty."""
    if text is None:
        return "recall result could not be read"
    try:
        parsed = json.loads(text)
    except ValueError:
        return "recall result is not JSON" if text.strip() else None
    items = parsed.get("items") if isinstance(parsed, dict) else None
    if not isinstance(items, list):
        return "recall result has no items list"
    return f"recall returned {len(items)} record(s)" if items else None


def _recall_reason(entry: dict, export_dir: Path | None) -> Reason | None:
    if entry["tool"] != _RECALL_TOOL or entry.get("error"):
        return None
    why = _recall_returned_record(_result_text(entry, export_dir))
    return Reason(RECALLED_RECORD, entry["id"], why) if why else None


def check_walk(
    walk: list[dict],
    *,
    answer_key_paths: list[str],
    host: str,
    owner: str,
    name: str,
    export_dir: str | os.PathLike[str] | None = None,
) -> Verdict:
    """Report every contamination sign in ``walk``, in walk order."""
    slug = f"{owner}/{name}".lower()
    host = host.lower()
    base = Path(export_dir) if export_dir is not None else None
    reasons: list[Reason] = []
    for entry in walk:
        for reason in (
            _key_reason(entry, answer_key_paths),
            _hosting_reason(entry, host, slug),
            _recall_reason(entry, base),
        ):
            if reason is not None:
                reasons.append(reason)
    return Verdict(reasons)
