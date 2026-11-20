#!/usr/bin/env python3
"""Build and count the derived-fact labelled set.

A derived fact is a conclusion that lists the facts it is based on. The set
(``docs/accuracy/derived-labelled-set.json``) holds real conclusions taken from
stored hand-backs (a verdict with its basis facts) and three planted groups made
from them, so that raters can label whether each conclusion follows from the
listed facts as written. It carries no labels and no decider answers when built;
later steps fill ``raters`` and ``decider``. No count taken from it is accuracy.

    python3 scripts/derived_set.py build EXPORTS_DIR [--out FILE]
    python3 scripts/derived_set.py counts [FILE]

``build`` walks EXPORTS_DIR for ``facts.json`` files and is deterministic: the
same exports give the same file. ``counts`` prints the items per group, per
source family and per half. Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SET = ROOT / "docs" / "accuracy" / "derived-labelled-set.json"
CONTRACT = ROOT / "associate" / "contract" / "accuracy.json"
SEED = 11
REAL = "real"
SWAPPED = "planted_swapped_basis"
CHANGED = "planted_changed_number"
NEGATED = "planted_negated"
GROUPS = (REAL, SWAPPED, CHANGED, NEGATED)
AIMS = {SWAPPED: 40, CHANGED: 30, NEGATED: 20}
MACHINE_PATH = re.compile(
    r"/home/|/Users/|/tmp/|/var/folders|/private/tmp|~/|\.worktrees|scratchpad"
    r"|\.associate-runs|[A-Za-z]:\\\\"
)
SECRET = re.compile(
    r"\bsk-[A-Za-z0-9_-]{8,}|\bghp_\w{8,}|\bgithub_pat_|\bAKIA[0-9A-Z]{8,}|\bBearer\s+\S{8,}"
    r"|\b(?=[A-Za-z]*\d)[A-Za-z0-9]{32,}\b"
    r"|\b(?=\w*[a-z])(?=\w*[A-Z])(?=\w*\d)[\w-]{24,}\b"
    r"|(?i:(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S{6,})"
)
WHOLE_NUMBER = re.compile(r"(?<![\w.])\d+(?![\w.])", re.ASCII)
OTHER_NEGATION = re.compile(r"\b(?:not|no|none|never|without|cannot)\b|n't")
FLIPS = (
    (re.compile(r"\bdoes not\b"), "does"),
    (re.compile(r"\bdoes\b(?! not)"), "does not"),
    (re.compile(r"\bis not\b"), "is"),
    (re.compile(r"\bis\b(?! not)"), "is not"),
    (re.compile(r"\bare not\b"), "are"),
    (re.compile(r"\bare\b(?! not)"), "are not"),
    (re.compile(r"\ball\b"), "none"),
)


def digest(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


def half_of(item_id: str) -> str:
    return "development" if int(digest("half", item_id), 16) % 2 == 0 else "held_out"


def machine_text(text: str) -> str | None:
    """Why a text must not be committed: a machine path or a key-like string."""
    if MACHINE_PATH.search(text):
        return "machine_path"
    if SECRET.search(text):
        return "key_like"
    return None


def source_of(exports: Path, facts_file: Path) -> tuple[str, str]:
    """A source family and a label, neither holding a machine path."""
    parts = [
        "tmp" if re.fullmatch(r"tmp[\w.]*", p) else "clone" if p.startswith(".worktrees") else p
        for p in facts_file.parent.relative_to(exports).parts
    ]
    parts = [p for p in parts if p != "export"] or ["root"]
    return parts[0], "/".join(parts)


def _item_from(verdict: Any, facts: dict[str, str]) -> dict[str, Any] | None:
    if (
        not isinstance(verdict, dict)
        or not isinstance(verdict.get("text"), str)
        or not verdict["text"].strip()
    ):
        return None
    basis = verdict.get("basis")
    if (
        not isinstance(basis, list)
        or not basis
        or not all(isinstance(b, str) and b in facts for b in basis)
    ):
        return None
    return {"conclusion": verdict["text"], "listed": [{"id": b, "value": facts[b]} for b in basis]}


def real_items(
    exports: Path, skip: frozenset[str] = frozenset()
) -> tuple[list[dict[str, Any]], Counter[str]]:
    """The real items under a directory of exports, and why others were skipped."""
    skipped: Counter[str] = Counter()
    items: dict[tuple[Any, ...], dict[str, Any]] = {}
    for facts_file in sorted(
        p
        for p in exports.rglob("facts.json")
        if p.is_file() and not skip & set(p.relative_to(exports).parts)
    ):
        family, label = source_of(exports, facts_file)
        try:
            document = json.loads(facts_file.read_text(encoding="utf-8"))
        except (OSError, ValueError, RecursionError):
            skipped["unreadable_file"] += 1
            continue
        raw = document.get("facts") if isinstance(document, dict) else None
        facts = {
            f["id"]: f["value"]
            for f in (raw if isinstance(raw, list) else [])
            if isinstance(f, dict)
            and isinstance(f.get("id"), str)
            and isinstance(f.get("value"), str)
            and f["value"].strip()
        }
        for verdict in (document.get("verdicts") if isinstance(document, dict) else None) or []:
            item = _item_from(verdict, facts)
            if item is None:
                skipped["basis_not_resolved_or_empty"] += 1
                continue
            texts = [item["conclusion"]] + [f["value"] for f in item["listed"]]
            why = next((w for w in map(machine_text, texts) if w), None)
            if why:
                skipped[why] += 1
                continue
            key = (item["conclusion"], tuple(f["value"] for f in item["listed"]))
            if key in items:
                skipped["duplicate"] += 1
                continue
            item.update(id="r" + digest(*map(str, key))[:10], group=REAL, source=label)
            item["family"] = family
            items[key] = item
    return sorted(items.values(), key=lambda i: i["id"]), skipped


def _planted(
    group: str, conclusion: str, listed: list[dict[str, str]], made_from: list[str]
) -> dict[str, Any]:
    key = [conclusion] + [f["value"] for f in listed]
    return {
        "id": "p" + digest(group, *key)[:10],
        "group": group,
        "conclusion": conclusion,
        "listed": listed,
        "made_from": made_from,
    }


def swapped(real: list[dict[str, Any]], rng: random.Random) -> list[dict[str, Any]]:
    """A real conclusion beside the listed facts of a real item from another run."""
    order = real[:]
    rng.shuffle(order)
    out: list[dict[str, Any]] = []
    used_b: set[str] = set()
    for a in order:
        if len(out) >= AIMS[SWAPPED]:
            break
        for b in order:
            same_values = {f["value"] for f in a["listed"]} & {f["value"] for f in b["listed"]}
            if b["id"] in used_b or b["source"] == a["source"] or same_values or b["id"] == a["id"]:
                continue
            used_b.add(b["id"])
            out.append(_planted(SWAPPED, a["conclusion"], b["listed"], [a["id"], b["id"]]))
            break
    return out


def changed_number(
    real: list[dict[str, Any]], rng: random.Random, avoid: set[str]
) -> list[dict[str, Any]]:
    """A real item with a number shared with its listed facts, changed in the conclusion only."""
    order = [r for r in real if r["id"] not in avoid]
    rng.shuffle(order)
    out: list[dict[str, Any]] = []
    for item in order:
        if len(out) >= AIMS[CHANGED]:
            break
        listed_numbers = {n for f in item["listed"] for n in WHOLE_NUMBER.findall(f["value"])}
        for m in WHOLE_NUMBER.finditer(item["conclusion"]):
            if m.group() not in listed_numbers or item["conclusion"].count(m.group()) != 1:
                continue
            n = int(m.group())
            new = str(n + 1 if n < 10 else max(2, n // 3))
            if new in listed_numbers:
                continue
            text = item["conclusion"][: m.start()] + new + item["conclusion"][m.end() :]
            out.append(_planted(CHANGED, text, item["listed"], [item["id"]]))
            break
    return out


def negated(
    real: list[dict[str, Any]], rng: random.Random, avoid: set[str]
) -> list[dict[str, Any]]:
    """A real item whose conclusion has exactly one flippable word, flipped."""
    order = [r for r in real if r["id"] not in avoid]
    rng.shuffle(order)
    out: list[dict[str, Any]] = []
    for item in order:
        if len(out) >= AIMS[NEGATED]:
            break
        hits = [(p, new) for p, new in FLIPS if p.search(item["conclusion"])]
        if len(hits) != 1 or len(hits[0][0].findall(item["conclusion"])) != 1:
            continue
        removes_not = " not" in hits[0][0].pattern
        if not removes_not and OTHER_NEGATION.search(item["conclusion"]):
            continue
        pattern, new = hits[0]
        out.append(
            _planted(
                NEGATED, pattern.sub(new, item["conclusion"], count=1), item["listed"], [item["id"]]
            )
        )
    return out


def build(exports: Path, skip: frozenset[str] = frozenset()) -> tuple[dict[str, Any], Counter[str]]:
    real, skipped = real_items(exports, skip)
    rng = random.Random(SEED)
    s = swapped(real, rng)
    avoid = {i for p in s for i in p["made_from"]}
    c = changed_number(real, rng, avoid)
    avoid |= {i for p in c for i in p["made_from"]}
    n = negated(real, rng, avoid)
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    derived = contract["strict"]["derived_question"]
    items = []
    for item in real:
        items.append(
            {k: item[k] for k in ("id", "group", "conclusion", "listed", "source")}
            | {"family": item["family"]}
        )
    items += s + c + n
    for item in items:
        item["half"] = half_of(item["id"])
        item["raters"] = {}
        item["decider"] = None
    document = {
        "$comment": (
            "A labelled set for the derived-fact question: does a conclusion follow from the "
            "facts it lists, taken together. Real items are verdicts with their basis facts "
            "from stored hand-backs; the planted groups are made from real items by the build"
            " script (seed in `seed`). Built with no labels and no decider answers: `raters` "
            "and `decider` are filled by later steps. Planted items are never counted with "
            "the real group. No count taken from this set is accuracy, and none says a "
            "conclusion is true."
        ),
        "seed": SEED,
        "contract_version": contract["version"],
        "question": derived["question"],
        "options": derived["options"],
        "items": items,
    }
    return document, skipped


def counts(document: dict[str, Any]) -> dict[str, Any]:
    items = document["items"]
    return {
        "by_group": dict(Counter(i["group"] for i in items)),
        "by_family": dict(Counter(i["family"] for i in items if i["group"] == REAL)),
        "by_half": dict(Counter(i["group"] + "/" + i["half"] for i in items)),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="rebuild the set from a directory of stored exports")
    b.add_argument("exports", type=Path)
    b.add_argument("--skip", action="append", default=[], help="a directory name to leave out")
    b.add_argument("--out", type=Path, default=DEFAULT_SET)
    c = sub.add_parser("counts", help="print counts from a set file")
    c.add_argument("file", type=Path, nargs="?", default=DEFAULT_SET)
    args = parser.parse_args(argv)
    if args.command == "build":
        document, skipped = build(args.exports, frozenset(args.skip))
        args.out.write_text(
            json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(
            json.dumps(
                {"written": len(document["items"]), "skipped": dict(skipped), **counts(document)},
                indent=1,
            )
        )
        return 0
    print(json.dumps(counts(json.loads(args.file.read_text(encoding="utf-8"))), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
