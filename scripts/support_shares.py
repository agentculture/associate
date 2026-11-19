#!/usr/bin/env python3
"""Shares of labelled value-and-quote pairs that the support check passes.

Reads the committed labelled set (``docs/accuracy/support-labelled-set.json``):
pairs with a group, a half (development or held-out), two raters' labels and
the decider's answer, one of the set's ``options``. A pair is passed when its
answer is one of the set's ``passes``. Per group it reports:

- of the pairs both raters call supported, the share passed;
- of the pairs both raters call unsupported, the share passed;
- how many pairs got each answer, by what the raters said.

A pair the raters disagree on, or one with no answer, is counted and left out of
both shares. Groups are never added together. These shares describe this set;
neither is accuracy and neither says a value is true.

    python3 scripts/support_shares.py                    # every pair
    python3 scripts/support_shares.py --half held_out    # one half
    python3 scripts/support_shares.py --passes all       # another pass rule
    python3 scripts/support_shares.py --json

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SET = ROOT / "docs" / "accuracy" / "support-labelled-set.json"
SUPPORTED = "supported"
UNSUPPORTED = "unsupported"
DISAGREE = "raters_disagree"
LABELS = (SUPPORTED, UNSUPPORTED)
ANSWER = "answer"
PAIRS = "pairs"
PASSED = "passed"


class SetError(ValueError):
    """The labelled set is not of the expected shape."""


def _names(value: Any) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(v, str) for v in value)


def load_set(document: Any) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """The pairs, the options and the pass rule of a labelled set, each checked."""
    if not isinstance(document, dict):
        raise SetError("the set is not an object")
    options, passes = document.get("options"), document.get("passes")
    if not _names(options) or not _names(passes) or not set(passes) < set(options):
        raise SetError("the set needs options, and passes naming some but not all of them")
    pairs = document.get(PAIRS)
    if not isinstance(pairs, list) or not pairs:
        raise SetError("the set has no pairs list")
    for position, pair in enumerate(pairs):
        labels = pair.get("labels") if isinstance(pair, dict) else None
        if not isinstance(labels, dict) or len(labels) != 2:
            raise SetError(f"pairs[{position}] does not carry two raters' labels")
        if any(label not in LABELS for label in labels.values()):
            raise SetError(f"pairs[{position}] has a label that is not one of {LABELS}")
        if not isinstance(pair.get("group"), str):
            raise SetError(f"pairs[{position}] has no group")
        if ANSWER in pair and pair[ANSWER] not in options:
            raise SetError(f"pairs[{position}] has an answer that is not one of the options")
    return pairs, options, passes


def _agreed(pair: dict[str, Any]) -> str:
    first, second = pair["labels"].values()
    return first if first == second else DISAGREE


def _share(passed: int, of: int) -> float | None:
    return round(passed / of, 4) if of else None


def _empty(options: list[str]) -> dict[str, Any]:
    by_label = {name: dict.fromkeys(options, 0) for name in (*LABELS, DISAGREE)}
    return {
        PAIRS: 0,
        DISAGREE: 0,
        "not_answered": 0,
        SUPPORTED: {PAIRS: 0, PASSED: 0},
        UNSUPPORTED: {PAIRS: 0, PASSED: 0},
        "answers": by_label,
    }


def group_shares(
    pairs: list[dict[str, Any]], options: list[str], passes: list[str]
) -> dict[str, dict[str, Any]]:
    """Per group: the counts, the share passed among each kind of agreed pair, the answers."""
    groups: dict[str, dict[str, Any]] = {}
    for pair in pairs:
        found = groups.setdefault(pair["group"], _empty(options))
        found[PAIRS] += 1
        agreed = _agreed(pair)
        found[DISAGREE] += 1 if agreed == DISAGREE else 0
        if ANSWER not in pair:
            found["not_answered"] += 1
            continue
        found["answers"][agreed][pair[ANSWER]] += 1
        if agreed != DISAGREE:
            found[agreed][PAIRS] += 1
            found[agreed][PASSED] += 1 if pair[ANSWER] in passes else 0
    for found in groups.values():
        for label in LABELS:
            found[label]["share_passed"] = _share(found[label][PASSED], found[label][PAIRS])
    return dict(sorted(groups.items()))


def _shown(share: float | None) -> str:
    return "none" if share is None else f"{share * 100:.1f}%"


def render(passes: list[str], groups: dict[str, dict[str, Any]]) -> str:
    lines = [f"A pair is passed when the answer is one of: {', '.join(passes)}."]
    for name, found in groups.items():
        yes, no = found[SUPPORTED], found[UNSUPPORTED]
        lines += [
            f"  group {name}: {found[PAIRS]} pairs "
            f"({found[DISAGREE]} the raters disagree on, "
            f"{found['not_answered']} not answered)",
            f"    both raters say supported: {yes[PASSED]} of {yes[PAIRS]} passed "
            f"({_shown(yes['share_passed'])})",
            f"    both raters say unsupported: {no[PASSED]} of {no[PAIRS]} passed "
            f"({_shown(no['share_passed'])})",
        ]
        for label, counts in found["answers"].items():
            shown = ", ".join(f"{option} {count}" for option, count in counts.items())
            lines.append(f"    answers, {label.replace('_', ' ')}: {shown}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--set", type=Path, default=DEFAULT_SET, help="the labelled set file")
    parser.add_argument("--half", help="only the pairs of this half (development or held_out)")
    parser.add_argument("--passes", action="append", help="an answer that passes (repeatable)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        document = json.loads(args.set.read_text(encoding="utf-8"))
        if args.passes:
            document = (
                {**document, "passes": args.passes} if isinstance(document, dict) else document
            )
        pairs, options, passes = load_set(document)
    except (OSError, ValueError) as error:
        print(f"error: {args.set}: {error}", file=sys.stderr)
        return 1
    if args.half:
        pairs = [pair for pair in pairs if pair.get("half") == args.half]
    groups = group_shares(pairs, options, passes)
    if args.json:
        found = {"set": str(args.set), PAIRS: len(pairs), "passes": passes, "groups": groups}
        print(json.dumps(found, indent=1))
    else:
        print(render(passes, groups))
    return 0


if __name__ == "__main__":
    sys.exit(main())
