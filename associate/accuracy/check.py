"""The Python re-check of a hand-back (issue #20, t16).

A port of ``.pi/extensions/associate/lib/facts.ts`` ``checkHandback``: the same
inputs give the same verdicts, and both are compared against the whole-hand-back
cases in ``associate/contract/matcher_vectors.json``. Standard library only; no
model is called. Every setting (minimum quote length, source-kind table,
reason-to-check mapping) comes from the accuracy contract passed in.

:func:`check_handback` is the pure checker over parsed inputs. :func:`load_export`
reads an export directory (``walk.jsonl``, ``results/wN.txt``, and the facts
payload :data:`FACTS_FILENAME`); :func:`inspect_export` joins the two for the
``associate check`` verb. An export written before the walk format marker has
no facts: they are reported as not applicable, never as an error.

A fact value is a literal, and must occur inside its quote, when it is a string
with no whitespace once trimmed, a JSON number or a JSON boolean; numbers are
written as the TypeScript side's ``String(n)`` writes them (see
:func:`literal_of`). A ``min_quote_length`` that is not a positive integer is a
broken contract and fails closed: every fact is refused as a short quote, its
flag naming the contract value. A child that is not an object, or whose label
is not a run label, is skipped without a flag (no check id fits it).

``passed`` means a fact's quote was found in the saved result it cites; nothing
more is claimed (see :mod:`associate.accuracy.counts`).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional

from associate.accuracy.counts import (
    SOURCE_KINDS,
    conclusion_counts,
    counts_by_source_kind,
    fact_counts,
)
from associate.accuracy.matcher import check_quote

#: The walk's file name and the facts payload's file name in an export directory.
WALK_FILENAME = "walk.jsonl"
FACTS_FILENAME = "facts.json"
#: The files the extension writes at ``finish`` beside the facts payload.
CHECK_FILENAME = "check.json"
REPORT_FILENAME = "report.json"
ANSWER_FILENAME = "answer.md"
#: The run label of the ``--continue-from`` export, as in ``lib/torch.ts``.
PRIOR_RUN_LABEL = "prior"

# re.ASCII: \d is 0-9 only, as in the TypeScript checker (lib/facts.ts).
_REFERENCE = re.compile(r"(?:([A-Za-z0-9_-]+):)?(w[1-9]\d*)", re.ASCII)
_LABEL = re.compile(r"[A-Za-z0-9_-]+")  # used with fullmatch: no trailing newline
_ID = re.compile(r"^w[1-9]\d*$", re.ASCII)
_SAVED = re.compile(r"^results/(w[1-9]\d*)\.txt$", re.ASCII)
_CHILD_ID = re.compile(r"c[1-9]\d*", re.ASCII)  # used with fullmatch
_WS = re.compile(r"[ \t\n\r\f\v]")

#: Kinds that are another model's words or a remembered claim, not a measurement.
_SECOND_HAND = frozenset({"agent", "memory"})
_DELEGATE_STATUS = "delegate_status"
_CHILD_ACCOUNT_KEY = "final_reply"


def parse_source_ref(ref: Any) -> dict[str, Any]:
    """Parse ``[label:]wN``; a path or anything else is refused, never resolved."""
    if not isinstance(ref, str):
        return {"ok": False, "reason": "source_malformed"}
    if "/" in ref or "\\" in ref:
        return {"ok": False, "reason": "source_path"}
    match = _REFERENCE.fullmatch(ref)
    if not match:
        return {"ok": False, "reason": "source_malformed"}
    return {"ok": True, "label": match.group(1), "id": match.group(2)}


def _is_entry(line: Any) -> bool:
    return (
        isinstance(line, dict)
        and isinstance(line.get("id"), str)
        and bool(_ID.match(line["id"]))
        and isinstance(line.get("tool"), str)
    )


def _index_entries(entries: Any) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for line in entries or []:
        if _is_entry(line):
            index[line["id"]] = line
    return index


def _saved_text(results: Mapping[str, Any], entry_id: str) -> Optional[str]:
    text = results.get(entry_id)
    return text if isinstance(text, str) else None


def _kind_of(entry: Mapping[str, Any], accuracy: Mapping[str, Any]) -> Optional[str]:
    table = accuracy.get("source_kinds") or {}
    if entry["tool"] in table:
        return table[entry["tool"]]
    own = entry.get("source_kind")
    return own if isinstance(own, str) and own in SOURCE_KINDS else None


def _reports_failure(text: Optional[str]) -> bool:
    if text is None:
        return False
    try:
        parsed = json.loads(text)
    except ValueError:
        return False
    return isinstance(parsed, dict) and parsed.get("ok") is False


def _find_child_account(value: Any) -> Optional[str]:
    if isinstance(value, list):
        for item in value:
            found = _find_child_account(item)
            if found is not None:
                return found
        return None
    if isinstance(value, dict):
        if isinstance(value.get(_CHILD_ACCOUNT_KEY), str):
            return value[_CHILD_ACCOUNT_KEY]
        for item in value.values():
            found = _find_child_account(item)
            if found is not None:
                return found
    return None


def _harness_part(text: str) -> Optional[str]:
    """The delegate_status saved text with the child's ``final_reply`` emptied."""
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    account = _find_child_account(parsed)
    if account is None:
        return text
    key = json.dumps(_CHILD_ACCOUNT_KEY, ensure_ascii=False)
    # JSON.stringify (the TypeScript side) leaves non-ASCII as is.
    encoded = f"{key}:{json.dumps(account, ensure_ascii=False, separators=(',', ':'))}"
    if encoded not in text:
        return None
    return text.replace(encoded, f'{key}:""')


def _is_first_hand(
    kind: Optional[str],
    entry: Mapping[str, Any],
    quote: str,
    text: Optional[str],
    min_quote_length: int,
) -> Optional[bool]:
    if kind is None:
        return None
    if entry["tool"] == _DELEGATE_STATUS:
        if text is None:
            return False
        part = _harness_part(text)
        return part is not None and (
            check_quote(quote, None, part, min_quote_length)["verdict"] == "passed"
        )
    return kind not in _SECOND_HAND


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


#: Integers up to this size are exact doubles; a larger one is rounded first, as JSON.parse does.
_EXACT_INT = 2**53


def _number_text(value: Any) -> Optional[str]:
    """A JSON number as ECMAScript ``Number::toString`` writes it (``String(n)``).

    The shortest decimal that reads back as the same double (``repr`` gives the
    digits), no ``.0`` on an integer-valued number, ``0`` for -0, plain digits
    for 1e-6 <= |n| < 1e21 and exponent form (``1e-7``, ``1.5e+300``) outside
    that. None for a non-finite number or an integer no double can hold.
    """
    if isinstance(value, int) and abs(value) <= _EXACT_INT:
        return str(value)
    try:
        number = float(value)
    except OverflowError:
        return None
    if not math.isfinite(number):
        return None
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    mantissa, _, exp = repr(abs(number)).partition("e")
    whole, _, frac = mantissa.partition(".")
    all_digits = whole + frac
    stripped = all_digits.lstrip("0")
    # n: where the decimal point falls relative to the first significant digit.
    n = len(whole) - (len(all_digits) - len(stripped)) + (int(exp) if exp else 0)
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mark = "+" if e >= 0 else "-"
        head = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
        body = f"{head}e{mark}{abs(e)}"
    return sign + body


def literal_of(value: Any) -> Optional[str]:
    """The literal a fact value must show inside its quote, or None when it is not one.

    A string with no whitespace once trimmed, a JSON number (:func:`_number_text`)
    or a JSON boolean (``true`` / ``false``); null, objects, arrays and
    non-finite numbers are not literals. ``facts.ts`` ``literalOf`` gives the
    same text (shared ``literal_cases`` in ``matcher_vectors.json``).
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _number_text(value)
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed if trimmed != "" and not _WS.search(trimmed) else None


def _is_positive_integer(value: Any) -> bool:
    """A usable minimum quote length: a positive integer (8.0 counts as 8)."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 1
    return isinstance(value, float) and value.is_integer() and value >= 1


_MISSING = object()


def _contract_value_text(value: Any) -> str:
    """How a contract value is named in a refusal: the same text ``facts.ts`` writes."""
    if value is _MISSING:
        return "missing"
    if value is None:
        return "null"
    if isinstance(value, (bool, int, float)):
        return literal_of(value) or "not a finite number"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return "an array" if isinstance(value, list) else "an object"


def _is_checkable_child(child: Any) -> bool:
    """A child run the checker can read: an object whose label is a run label."""
    return (
        isinstance(child, dict)
        and isinstance(child.get("label"), str)
        and _LABEL.fullmatch(child["label"]) is not None
    )


@dataclass
class _Checker:
    """The contract settings one hand-back check reads, and the flags it raises."""

    accuracy: Mapping[str, Any]
    mapping: Mapping[str, Any]
    min_len: Any
    contract_text: Optional[str]
    flags: list[dict[str, str]] = field(default_factory=list)

    def check_for(self, reason: str) -> Optional[str]:
        return self.mapping.get(reason)

    def flag(
        self, reason: str, item_id: str, ref: Optional[str] = None, note: Optional[str] = None
    ) -> None:
        check = self.check_for(reason)
        if check is None:
            return
        detail = f"{item_id}: {reason}" if note is None else f"{item_id}: {reason} ({note})"
        out = {"check": check, "detail": detail}
        if ref is not None and parse_source_ref(ref)["ok"]:
            out["ref"] = ref
        self.flags.append(out)

    def refuse_fact(
        self,
        base: Mapping[str, Any],
        reason: str,
        extra: Optional[dict[str, Any]] = None,
        note: Optional[str] = None,
    ) -> dict[str, Any]:
        self.flag(reason, base["id"], base["source"], note)
        return {
            **base,
            "verdict": "refused",
            "reason": reason,
            "check": self.check_for(reason),
            **(extra or {}),
        }

    def refuse_item(self, item_id: str, reason: str) -> dict[str, Any]:
        self.flag(reason, item_id)
        return {
            "id": item_id,
            "outcome": "refused",
            "reason": reason,
            "check": self.check_for(reason),
        }


@dataclass
class _Runs:
    """The runs a source reference may name: this one, prior runs and children."""

    current: dict[str, Any]
    current_index: dict[str, dict[str, Any]]
    others: dict[str, Optional[dict[str, Any]]]
    prior_indexes: list[dict[str, dict[str, Any]]]
    children: list[dict[str, Any]]


def _new_checker(accuracy: Mapping[str, Any]) -> _Checker:
    raw_min = accuracy.get("min_quote_length", _MISSING)
    contract_ok = _is_positive_integer(raw_min)
    return _Checker(
        accuracy=accuracy,
        mapping=accuracy.get("refusal_checks") or {},
        min_len=raw_min if contract_ok else 0,
        contract_text=None if contract_ok else _contract_value_text(raw_min),
    )


def _build_runs(handback: Mapping[str, Any]) -> _Runs:
    current = {"entries": handback.get("entries") or [], "results": handback.get("results") or {}}
    current_index = _index_entries(current["entries"])

    prior_runs = handback.get("prior_runs") or {}
    # A child that is not an object or has no run label is skipped (no check id fits, so no flag).
    children = [c for c in _as_list(handback.get("children")) if _is_checkable_child(c)]
    others: dict[str, Optional[dict[str, Any]]] = {}
    for label, run in prior_runs.items():
        others[label] = {"run": run, "index": _index_entries(run.get("entries"))}
    for child in children:
        if child["label"] in others:
            others[child["label"]] = None
        else:
            others[child["label"]] = {"run": child, "index": _index_entries(child.get("entries"))}
    prior_indexes = [(others.get(label) or {"index": {}})["index"] for label in prior_runs]
    return _Runs(current, current_index, others, prior_indexes, children)


def _find_entry(
    ctx: _Checker, runs: _Runs, parsed: Mapping[str, Any], base: Mapping[str, Any]
) -> Optional[tuple[Mapping[str, Any], dict[str, Any]]]:
    """The run and entry a parsed reference names, or None when it names neither."""
    if parsed["label"] is None:
        run, index = runs.current, runs.current_index
        if any(parsed["id"] in prior for prior in runs.prior_indexes):
            ctx.flag("ambiguous_reference", base["id"], base["source"])
    else:
        other = runs.others.get(parsed["label"])
        if not other:
            return None
        run, index = other["run"], other["index"]
    entry = index.get(parsed["id"])
    if entry is None:
        return None
    return run, entry


def _action_refusal(
    fact: Mapping[str, Any], entry: Mapping[str, Any], text: Optional[str]
) -> Optional[str]:
    """Why a fact that an action happened is refused, or None when it is not."""
    if fact.get("action") is not True:
        return None
    tool = fact.get("tool") if isinstance(fact.get("tool"), str) and fact["tool"] != "" else None
    if tool is None:
        return "action_tool_missing"
    if entry["tool"] != tool:
        return "action_wrong_tool"
    if "error" in entry or _reports_failure(text):
        return "action_failed"
    return None


def _quote_outcome(
    ctx: _Checker,
    base: Mapping[str, Any],
    located: dict[str, Any],
    match: Mapping[str, Any],
    partial: bool,
) -> dict[str, Any]:
    """The fact's verdict from the matcher's answer for its quote."""
    text_independent = match["reason"] in ("quote_short", "literal_not_in_quote")
    if match["verdict"] == "unchecked":
        return {
            **base,
            **located,
            "verdict": "unchecked",
            "reason": "no_saved_text",
            "check": None,
        }
    if partial and not text_independent:
        return {
            **base,
            **located,
            "verdict": "unchecked",
            "reason": "partial_result",
            "check": None,
        }
    if match["verdict"] == "refused":
        return ctx.refuse_fact(base, match["reason"], {**located, "nearest": match["nearest"]})
    return {**base, **located, "verdict": "passed", "reason": None, "check": None}


def _check_fact(ctx: _Checker, runs: _Runs, raw: Any) -> dict[str, Any]:
    fact = _as_dict(raw)
    quote = _str(fact.get("quote"))
    base: dict[str, Any] = {
        "id": _str(fact.get("id")),
        "source": _str(fact.get("source")),
        "run": None,
        "nearest": None,
        "source_kind": None,
        "first_hand": None,
    }

    if ctx.contract_text is not None:
        note = f"accuracy.json min_quote_length is {ctx.contract_text}, not a positive integer"
        return ctx.refuse_fact(base, "quote_short", note=note)

    parsed = parse_source_ref(fact.get("source"))
    if not parsed["ok"]:
        return ctx.refuse_fact(base, parsed["reason"])
    found = _find_entry(ctx, runs, parsed, base)
    if found is None:
        return ctx.refuse_fact(base, "source_unknown", {"run": parsed["label"]})
    run, entry = found

    text = _saved_text(run.get("results") or {}, entry["id"])
    kind = _kind_of(entry, ctx.accuracy)
    located = {
        "run": parsed["label"],
        "source_kind": kind,
        "first_hand": _is_first_hand(kind, entry, quote, text, ctx.min_len),
    }

    action_reason = _action_refusal(fact, entry, text)
    if action_reason is not None:
        return ctx.refuse_fact(base, action_reason, located)
    match = check_quote(quote, literal_of(fact.get("value")), text, ctx.min_len)
    return _quote_outcome(ctx, base, located, match, entry.get("partial") is True)


def _accept(item_id: str) -> dict[str, Any]:
    return {"id": item_id, "outcome": "accepted", "reason": None, "check": None}


def _has_check(item: Mapping[str, Any]) -> bool:
    return isinstance(item.get("check"), str) and item["check"].strip() != ""


def _closing_index(verdict_items: list[dict[str, Any]]) -> int:
    marked = next((i for i, v in enumerate(verdict_items) if v.get("closing") is True), -1)
    return marked if marked >= 0 else len(verdict_items) - 1


def _verdict_refusal(
    item: Mapping[str, Any], basis: list[str], known: list[dict[str, Any]], closing: bool
) -> Optional[str]:
    """Why one verdict is refused, or None when it is accepted."""
    decided = _str(item.get("verdict")) in ("supported", "refuted")
    if len(known) < len(basis):
        return "unknown_fact"
    if any(f["verdict"] == "refused" for f in known):
        return "basis_refused"
    if decided and not basis:
        return "no_basis"
    if decided and _as_list(item.get("unread")):
        return "verdict_with_unread"
    if not decided and not _has_check(item):
        return "open_without_check"
    if decided and closing and not any(f["first_hand"] is True for f in known):
        return "closing_second_hand"
    return None


def _check_verdicts(
    ctx: _Checker, verdict_items: list[dict[str, Any]], fact_by_id: Mapping[str, dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    """Each verdict's outcome, and how many verdicts rest on no known fact."""
    closing_index = _closing_index(verdict_items)
    without_fact = 0
    verdicts: list[dict[str, Any]] = []
    for position, item in enumerate(verdict_items):
        item_id = _str(item.get("id"))
        basis = [_str(b) for b in _as_list(item.get("basis"))]
        known = [fact_by_id[b] for b in basis if b in fact_by_id]
        if not known:
            without_fact += 1
        reason = _verdict_refusal(item, basis, known, position == closing_index)
        verdicts.append(_accept(item_id) if reason is None else ctx.refuse_item(item_id, reason))
    return verdicts, without_fact


def _check_open_items(
    ctx: _Checker, raw_items: Any, fact_by_id: Mapping[str, dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    """Each open item's outcome, and how many open items rest on no known fact."""
    without_fact = 0
    open_items: list[dict[str, Any]] = []
    for raw in _as_list(raw_items):
        item = _as_dict(raw)
        item_id = _str(item.get("id"))
        if not any(_str(b) in fact_by_id for b in _as_list(item.get("basis"))):
            without_fact += 1
        open_items.append(
            _accept(item_id) if _has_check(item) else ctx.refuse_item(item_id, "open_without_check")
        )
    return open_items, without_fact


def check_handback(handback: Mapping[str, Any], accuracy: Mapping[str, Any]) -> dict[str, Any]:
    """Check one hand-back against its walk entries and saved results.

    *handback* has ``payload``, ``entries``, ``results`` and optionally
    ``prior_runs`` (label to ``{entries, results}``) and ``children`` (each a
    hand-back with a ``label``). Returns ``accepted``, ``facts``, ``verdicts``,
    ``open_items`` and ``report``, shaped like the TypeScript checker's result.
    """
    ctx = _new_checker(accuracy)
    runs = _build_runs(handback)
    payload = _as_dict(handback.get("payload"))

    # --- facts ---------------------------------------------------------------
    facts = [_check_fact(ctx, runs, raw) for raw in _as_list(payload.get("facts"))]

    # --- verdicts and open items ---------------------------------------------
    fact_by_id: dict[str, dict[str, Any]] = {}
    for fact_check in facts:
        fact_by_id.setdefault(fact_check["id"], fact_check)

    verdict_items = [_as_dict(v) for v in _as_list(payload.get("verdicts"))]
    verdicts, verdicts_without_fact = _check_verdicts(ctx, verdict_items, fact_by_id)
    open_items, open_without_fact = _check_open_items(ctx, payload.get("open_items"), fact_by_id)
    without_fact = verdicts_without_fact + open_without_fact

    # --- counts ----------------------------------------------------------------
    report = {
        "facts": fact_counts(facts),
        "conclusions": conclusion_counts(_str(v.get("verdict")) for v in verdict_items),
        "statements": {"made": len(verdicts) + len(open_items), "without_fact": without_fact},
        "by_source_kind": counts_by_source_kind(facts),
        "flags": ctx.flags,
        "python_recheck_ran": False,
        "children": [
            {"label": child["label"], "report": check_handback(child, accuracy)["report"]}
            for child in runs.children
        ],
    }
    accepted = (
        all(f["verdict"] != "refused" for f in facts)
        and all(v["outcome"] != "refused" for v in verdicts)
        and all(v["outcome"] != "refused" for v in open_items)
    )
    return {
        "accepted": accepted,
        "facts": facts,
        "verdicts": verdicts,
        "open_items": open_items,
        "report": report,
    }


# --- reading an export directory ------------------------------------------------


class ExportError(Exception):
    """An export directory that cannot be read (the verb turns it into a CliError)."""


def _read_walk(walk_path: Path) -> tuple[Optional[dict[str, Any]], list[dict[str, Any]]]:
    """The format marker (or None for a pre-marker walk) and the tool entries."""
    marker: Optional[dict[str, Any]] = None
    entries: list[dict[str, Any]] = []
    try:
        text = walk_path.read_text(encoding="utf-8")
    except OSError as err:
        raise ExportError(f"cannot read {walk_path}: {err.strerror or err}") from err
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except ValueError:
            continue  # a partly written last line is what a killed run leaves
        if not isinstance(parsed, dict):
            continue
        if set(parsed) == {"format"} and isinstance(parsed["format"], dict):
            marker = parsed["format"]
        elif _is_entry(parsed):
            entries.append(parsed)
    return marker, entries


def _read_results(export_dir: Path, entries: list[dict[str, Any]]) -> dict[str, str]:
    """Walk id to saved text, for each ``results/wN.txt`` inside the export directory."""
    root = export_dir.resolve()
    results: dict[str, str] = {}
    for entry in entries:
        saved = entry.get("saved_result")
        if not isinstance(saved, str) or not _SAVED.match(saved):
            continue
        target = (export_dir / saved).resolve()
        if root not in target.parents or not target.is_file():
            continue
        try:
            results[entry["id"]] = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
    return results


def _read_payload(export_dir: Path) -> Optional[dict[str, Any]]:
    """The facts payload, or None when the export has no facts file."""
    facts_path = export_dir / FACTS_FILENAME
    if not facts_path.is_file():
        return None
    try:
        loaded = json.loads(facts_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise ExportError(f"cannot read {facts_path}: {err}") from err
    if not isinstance(loaded, dict):
        raise ExportError(f"{facts_path} is not a JSON object")
    return loaded


def load_export(export_dir: Path) -> dict[str, Any]:
    """Read an export directory: walk entries, saved results and the facts payload.

    Returns ``format`` (the walk format version, 1 when there is no marker),
    ``entries``, ``results`` (walk id to text) and ``payload`` (None when no
    facts file exists). Only ``results/wN.txt`` names an entry's ``saved_result``
    may be read, and only inside the export directory.
    """
    export_dir = Path(export_dir)
    walk_path = export_dir / WALK_FILENAME
    if not export_dir.is_dir():
        raise ExportError(f"{export_dir} is not a directory")
    if not walk_path.is_file():
        raise ExportError(f"{export_dir} has no {WALK_FILENAME}")
    marker, entries = _read_walk(walk_path)
    version = marker.get("version") if marker else None
    results = _read_results(export_dir, entries)
    payload = _read_payload(export_dir)
    return {
        "format": version if isinstance(version, int) and not isinstance(version, bool) else 1,
        "entries": entries,
        "results": results,
        "payload": payload,
    }


def _call_outcome(entry: Mapping[str, Any]) -> str:
    return "error" if "error" in entry else "ok"


def summarise_calls(
    entries: list[dict[str, Any]], accuracy: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Each call's id, tool, stated purpose (None when it had none) and outcome."""
    calls = []
    for entry in entries:
        purpose = entry.get("purpose")
        calls.append(
            {
                "id": entry["id"],
                "tool": entry["tool"],
                "purpose": purpose if isinstance(purpose, str) else None,
                "outcome": _call_outcome(entry),
                "error": entry.get("error") if isinstance(entry.get("error"), str) else None,
                "source_kind": _kind_of(entry, accuracy),
                "partial": entry.get("partial") is True,
            }
        )
    return calls


def _child_links(walk_path: Path) -> list[tuple[str, str]]:
    """Each ``child`` line's id and ``child_walk``, first line per id, in walk order."""
    links: list[tuple[str, str]] = []
    try:
        text = walk_path.read_text(encoding="utf-8")
    except OSError:
        return links
    for line in text.splitlines():
        try:
            parsed = json.loads(line)
        except ValueError:
            continue
        child = parsed.get("child") if isinstance(parsed, dict) else None
        if not isinstance(child, dict):
            continue
        child_id, child_walk = child.get("id"), child.get("child_walk")
        if (
            isinstance(child_id, str)
            and _CHILD_ID.fullmatch(child_id)
            and isinstance(child_walk, str)
            and child_id not in [existing for existing, _ in links]
        ):
            links.append((child_id, child_walk))
    return links


def _prior_dir(continue_from: Path) -> Optional[Path]:
    """The directory itself, or its ``export/`` child, whichever holds a walk."""
    for candidate in (continue_from, continue_from / "export"):
        if (candidate / WALK_FILENAME).is_file():
            return candidate
    return None


def _run_data(directory: Path) -> Optional[dict[str, Any]]:
    try:
        loaded = load_export(directory)
    except ExportError:
        return None
    return {
        "entries": loaded["entries"],
        "results": loaded["results"],
        "payload": loaded["payload"],
    }


def load_handback_input(export_dir: Path, continue_from: Optional[Path] = None) -> dict[str, Any]:
    """Everything :func:`check_handback` reads for one run.

    The current run (``entries``, ``results``, ``payload``), the prior run under
    the label ``prior`` when *continue_from* names an export holding a walk, and
    each child the walk links, under its ``cN`` label. Labels are looked up, never
    taken from a fact: a child's directory is the parent of the ``child_walk``
    its ``child`` line (written by the harness) names. A prior run with no walk is
    skipped; a child whose walk cannot be read counts as an empty run, the way the
    extension reads it.
    """
    export_dir = Path(export_dir)
    current = load_export(export_dir)
    prior_runs: dict[str, dict[str, Any]] = {}
    if continue_from is not None:
        prior_dir = _prior_dir(Path(continue_from))
        data = _run_data(prior_dir) if prior_dir is not None else None
        if data is not None:
            prior_runs[PRIOR_RUN_LABEL] = {"entries": data["entries"], "results": data["results"]}
    children: list[dict[str, Any]] = []
    for label, child_walk in _child_links(export_dir / WALK_FILENAME):
        data = _run_data(Path(child_walk).parent)
        children.append(
            {
                "label": label,
                "payload": (data or {}).get("payload") or {},
                "entries": (data or {}).get("entries") or [],
                "results": (data or {}).get("results") or {},
            }
        )
    return {
        "format": current["format"],
        "payload": current["payload"],
        "entries": current["entries"],
        "results": current["results"],
        "prior_runs": prior_runs,
        "children": children,
    }


def _not_applicable_reason(loaded: Mapping[str, Any]) -> Optional[str]:
    if loaded["format"] < 2:
        return "pre-change export: the walk has no format marker, so it carries no facts"
    if loaded["payload"] is None:
        return f"no {FACTS_FILENAME} in the export: no hand-back facts were written"
    return None


def inspect_export(
    export_dir: Path, accuracy: Mapping[str, Any], continue_from: Optional[Path] = None
) -> dict[str, Any]:
    """What ``associate check`` reports for one export directory.

    With no facts (a walk with no format marker, or no facts file) ``applicable``
    is false, ``facts`` is an empty list and ``report`` is None: facts are not
    applicable, not zero. *continue_from* adds the prior run under ``prior``;
    children are always read from the walk's ``child`` lines.
    """
    loaded = load_handback_input(export_dir, continue_from)
    calls = summarise_calls(loaded["entries"], accuracy)
    base: dict[str, Any] = {
        "export": str(export_dir),
        "walk_format": loaded["format"],
        "calls": calls,
    }
    reason = _not_applicable_reason(loaded)
    if reason is not None:
        return {
            **base,
            "applicable": False,
            "not_applicable_reason": reason,
            "facts": [],
            "report": None,
            "accepted": None,
        }
    result = check_handback(loaded, accuracy)
    result["report"]["python_recheck_ran"] = True
    return {
        **base,
        "applicable": True,
        "not_applicable_reason": None,
        "facts": result["facts"],
        "verdicts": result["verdicts"],
        "open_items": result["open_items"],
        "report": result["report"],
        "accepted": result["accepted"],
    }


# --- the run result ---------------------------------------------------------------


def _read_json(path: Path) -> Optional[dict[str, Any]]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return loaded if isinstance(loaded, dict) else None


def _read_text(path: Path) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _handback_outcome(check: Optional[Mapping[str, Any]]) -> str:
    """``accepted``, ``refused_after_rounds`` (the run ended on a refused hand-back),
    ``refused_unresolved`` (a round was refused and the model did not hand back
    again) or ``none`` (no hand-back was recorded)."""
    if check is None:
        return "none"
    if check.get("outcome") == "accepted":
        return "accepted"
    if check.get("outcome") == "refused":
        return "refused_after_rounds" if check.get("run_ended") is True else "refused_unresolved"
    return "none"


def accuracy_result(
    export_dir: Path,
    accuracy: Mapping[str, Any],
    *,
    continue_from: Optional[Path] = None,
    check_mode: Optional[str] = None,
) -> dict[str, Any]:
    """The accuracy fields of an ``associate run`` result, after the model stopped.

    ``answer`` is the harness-rendered ``answer.md`` (``None`` when the extension
    wrote none). ``accuracy.report`` holds the counts from the Python re-check of
    the saved facts, never the extension's own; only ``unchecked_text`` is copied
    from the extension's ``report.json`` (it counts model text this side does not
    have) and ``unchecked_text_source`` says so. ``check_mode`` is the per-run
    override the operator passed (``None`` when none), and ``check_mode_used`` the
    mode the extension recorded in ``check.json``.
    """
    export_dir = Path(export_dir)
    check = _read_json(export_dir / CHECK_FILENAME)
    answer_path = export_dir / ANSWER_FILENAME
    answer = _read_text(answer_path)
    summary: dict[str, Any] = {
        "check_mode_used": check.get("mode") if check else None,
        "check_mode_source": check.get("mode_source") if check else None,
        "python_recheck_ran": False,
        "python_recheck_verdict": None,
        "extension_accepted": check.get("accepted") if check else None,
        "not_applicable_reason": None,
        "report": None,
        "unchecked_text_source": None,
    }
    try:
        inspected = inspect_export(export_dir, accuracy, continue_from)
    except ExportError as err:
        inspected = {"applicable": False, "not_applicable_reason": str(err)}
    if inspected["applicable"]:
        report = dict(inspected["report"])
        ext_report = _read_json(export_dir / REPORT_FILENAME) or {}
        unchecked = ext_report.get("unchecked_text")
        if isinstance(unchecked, dict):
            report["unchecked_text"] = dict(unchecked)
            summary["unchecked_text_source"] = "extension"
        summary.update(
            python_recheck_ran=True,
            python_recheck_verdict="accepted" if inspected["accepted"] else "refused",
            report=report,
        )
    else:
        summary["not_applicable_reason"] = inspected["not_applicable_reason"]
    return {
        "check_mode": check_mode,
        "answer": answer,
        "answer_path": str(answer_path) if answer is not None else None,
        "handback_outcome": _handback_outcome(check),
        "accuracy": summary,
    }
