#!/usr/bin/env python3
"""Shares of labelled value-and-quote pairs that the support score passes.

Reads the committed labelled set (``docs/accuracy/support-labelled-set.json``):
pairs with a group, two raters' labels and the decider's score. For one cut-off
it reports, per group:

- of the pairs both raters call supported, the share with a score at or above
  the cut-off;
- of the pairs both raters call unsupported, the share with a score at or
  above the cut-off.

A pair the raters disagree on, or one with no score, is counted and left out of
both shares. Groups are never added together. These shares describe this set;
neither is accuracy and neither says a value is true.

    python3 scripts/support_shares.py                 # the contract's cut-off
    python3 scripts/support_shares.py --cutoff 0.7
    python3 scripts/support_shares.py --sweep         # every tenth from 0.1 to 0.9
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
CONTRACT = ROOT / "associate" / "contract" / "accuracy.json"
SUPPORTED = "supported"
UNSUPPORTED = "unsupported"
LABELS = (SUPPORTED, UNSUPPORTED)
SWEEP = tuple(round(step / 10, 1) for step in range(1, 10))


class SetError(ValueError):
    """The labelled set is not of the expected shape."""


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def load_pairs(document: Any) -> list[dict[str, Any]]:
    """The pairs of a labelled set, each checked for the fields the shares need."""
    pairs = document.get("pairs") if isinstance(document, dict) else None
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
        if "score" in pair and not _number(pair["score"]):
            raise SetError(f"pairs[{position}] has a score that is not a number")
    return pairs


def _agreed(pair: dict[str, Any]) -> str | None:
    first, second = pair["labels"].values()
    return first if first == second else None


def _share(passed: int, of: int) -> float | None:
    return round(passed / of, 4) if of else None


def group_shares(pairs: list[dict[str, Any]], cutoff: float) -> dict[str, dict[str, Any]]:
    """Per group: the counts, and the share passed among each kind of agreed pair."""
    groups: dict[str, dict[str, Any]] = {}
    for pair in pairs:
        found = groups.setdefault(
            pair["group"],
            {
                "pairs": 0,
                "raters_disagree": 0,
                "not_scored": 0,
                SUPPORTED: {"pairs": 0, "passed": 0},
                UNSUPPORTED: {"pairs": 0, "passed": 0},
            },
        )
        found["pairs"] += 1
        agreed = _agreed(pair)
        if agreed is None:
            found["raters_disagree"] += 1
            continue
        if "score" not in pair:
            found["not_scored"] += 1
            continue
        found[agreed]["pairs"] += 1
        found[agreed]["passed"] += 1 if pair["score"] >= cutoff else 0
    for found in groups.values():
        for label in LABELS:
            found[label]["share_passed"] = _share(found[label]["passed"], found[label]["pairs"])
    return dict(sorted(groups.items()))


def contract_cutoff() -> float:
    """The cut-off in the contract's ``support_score`` settings."""
    return float(json.loads(CONTRACT.read_text(encoding="utf-8"))["support_score"]["cutoff"])


def _shown(share: float | None) -> str:
    return "none" if share is None else f"{share * 100:.1f}%"


def render(cutoff: float, groups: dict[str, dict[str, Any]]) -> str:
    lines = [f"Cut-off {cutoff}: a pair is passed when its score is at or above it."]
    for name, found in groups.items():
        yes, no = found[SUPPORTED], found[UNSUPPORTED]
        lines += [
            f"  group {name}: {found['pairs']} pairs "
            f"({found['raters_disagree']} the raters disagree on, "
            f"{found['not_scored']} not scored)",
            f"    both raters say supported: {yes['passed']} of {yes['pairs']} passed "
            f"({_shown(yes['share_passed'])})",
            f"    both raters say unsupported: {no['passed']} of {no['pairs']} passed "
            f"({_shown(no['share_passed'])})",
        ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--set", type=Path, default=DEFAULT_SET, help="the labelled set file")
    parser.add_argument("--cutoff", type=float, help="default: the contract's cut-off")
    parser.add_argument("--sweep", action="store_true", help="report every tenth from 0.1 to 0.9")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        pairs = load_pairs(json.loads(args.set.read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        print(f"error: {args.set}: {error}", file=sys.stderr)
        return 1
    cutoffs = (
        SWEEP if args.sweep else (args.cutoff if args.cutoff is not None else contract_cutoff(),)
    )
    results = [{"cutoff": cutoff, "groups": group_shares(pairs, cutoff)} for cutoff in cutoffs]
    if args.json:
        print(json.dumps({"set": str(args.set), "pairs": len(pairs), "results": results}, indent=1))
    else:
        print("\n\n".join(render(found["cutoff"], found["groups"]) for found in results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
