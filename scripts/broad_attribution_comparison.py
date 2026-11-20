#!/usr/bin/env python3
"""Attribute the graded statements of the stored broad runs to answer items by structure.

The 36 broad runs of 2026-11-19 are not strict exports. Their ``answer.md`` lists
the accepted facts, conclusions and open items under the harness's label and the
model's finish summary and final message under the unchecked label. This script
reads that structure: each statement of the graded file is attributed to the item
(or to the summary or the final message) it was split from, by rebuilding the
statements the grading sheet was made from and requiring them to be the graded
statements, text for text and in order. A run for which they are not the same is
not attributed: its statements are counted as "structure cannot decide".

It does not reconstruct the earlier text-matching attribution. That attribution
was never stored per statement; only its totals are written down (the table
"Where the false statements are" of the support-score broad measurement note).
The output puts the structural totals beside those written totals, and says which
rows cannot be compared and why.

    python3 scripts/broad_attribution_comparison.py RESULTS_DIR GRADED_STATEMENTS \\
        [--json-out PATH] [--note-out PATH]

``RESULTS_DIR`` is the results directory of the broad comparison (``records/`` and
``work/``); ``GRADED_STATEMENTS`` is ``docs/accuracy/broad-graded-statements.json``
(it may be on another branch, so its path is an argument). The two outputs default
to ``docs/accuracy/broad-attribution-comparison.json`` and
``docs/notes/broad-attribution-comparison.md``. Nothing printed or written here is
accuracy or a score. Standard library only, besides this package.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from associate.measure import answer as answer_mod  # noqa: E402
from associate.measure import sheet as sheet_mod  # noqa: E402

DEFAULT_JSON = ROOT / "docs" / "accuracy" / "broad-attribution-comparison.json"
DEFAULT_NOTE = ROOT / "docs" / "notes" / "broad-attribution-comparison.md"
GRADERS = ("claude", "gemini")
VERDICTS = ("true", "false", "not_checkable")
UNGRADED = "no verdict"
CANNOT_DECIDE = "structure cannot decide"
CATEGORIES = (
    ("fact", "an accepted fact"),
    ("conclusion", "an accepted conclusion"),
    ("open_item", "an accepted open item"),
    ("summary", "the finish summary"),
    ("final_reply", "the final message"),
    ("summary_and_final", "a sentence of the summary and of the final message run together"),
    (CANNOT_DECIDE, "no structural source"),
)
_KIND_OF_ID = {"f": "fact", "v": "conclusion", "o": "open_item"}

#: The earlier attribution's totals, copied from the "Where the false statements are" table of
#: ``docs/notes/support-score-broad-measurement.md`` (decider-result branch): per grading, the
#: statements that rested on a fact whose quote was found, on a fact whose quote was refused,
#: and on the model's unchecked text, as (true, false, not checkable).
WRITTEN_TOTALS = {
    "claude": {
        "fact_quote_found": (239, 6, 7),
        "fact_quote_refused": (22, 0, 0),
        "unchecked_text": (1022, 65, 296),
    },
    "gemini": {
        "fact_quote_found": (228, 16, 8),
        "fact_quote_refused": (19, 1, 2),
        "unchecked_text": (965, 133, 285),
    },
}


class ComparisonError(ValueError):
    """An input is not of the expected shape."""


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ComparisonError(f"cannot read {path.name}: {exc}") from exc


def export_dir(results: Path, record: dict[str, Any], task: str, arm: str) -> Path | None:
    """The export of a stored run, found under the results directory (never from a stored path)."""
    attempt = record.get("attempt")
    base = results / "work" / task / arm / f"r{record.get('repeat')}" / f"a{attempt}"
    found = sorted((base / "export-root").glob("*/export")) if base.is_dir() else []
    return found[0] if len(found) == 1 else None


def structural_statements(export: Path) -> list[dict[str, str]] | None:
    """The statements the grading sheet was made from, each with its structural source.

    None when the export holds no ``answer.md``. Items first, in the order rendered, each
    split into sentences as the sheet splits them; then the finish summary and the final
    message the same way. The text builder that made the sheets joined the quoted lines of
    the summary and the final message without a blank line between, so when the summary's
    last sentence and the final message's first sentence were run together into one
    statement, that statement is attributed to ``summary_and_final`` (both sources).
    """
    try:
        rendered = (export / answer_mod.ANSWER_FILE).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    found: list[dict[str, str]] = []
    for item_id, words in answer_mod.accepted_item_words(rendered, export):
        kind = _KIND_OF_ID.get(item_id[0], "fact")
        found.extend(
            {"text": text, "category": kind, "item": item_id}
            for text in sheet_mod.split_statements(words)
        )
    unchecked: list[dict[str, str]] = []
    for part in answer_mod.unchecked_parts(rendered):
        unchecked.extend(
            {"text": text, "category": part["origin"], "item": ""}
            for text in sheet_mod.split_statements(part["text"])
        )
    return found + _as_the_sheet_ran_them_together(unchecked, export)


def _as_the_sheet_ran_them_together(
    unchecked: list[dict[str, str]], export: Path
) -> list[dict[str, str]]:
    """*unchecked* as the sheet had it: one statement where two sources were run together."""
    old = sheet_mod.split_statements(answer_mod.model_answer(None, export).text)
    if [s["text"] for s in unchecked] == old:
        return unchecked
    for k in range(len(unchecked) - 1):
        left, right = unchecked[k], unchecked[k + 1]
        if left["category"] == right["category"]:
            continue
        joined = {
            "text": f"{left['text']} {right['text']}",
            "category": "summary_and_final",
            "item": "",
        }
        merged = [*unchecked[:k], joined, *unchecked[k + 2 :]]
        if [s["text"] for s in merged] == old:
            return merged
    return unchecked


def _verdict(statement: dict[str, Any], grader: str) -> str:
    value = statement.get(grader)
    return value if value in VERDICTS else UNGRADED


def attribute(results: Path, graded: dict[str, Any]) -> dict[str, Any]:
    """Tally each statement's two gradings by its structural source."""
    runs = graded.get("runs")
    if not isinstance(runs, list) or not runs:
        raise ComparisonError("the graded statements file has no runs list")
    tally: dict[str, dict[str, Counter]] = {g: {} for g in GRADERS}
    undecided_runs: list[dict[str, Any]] = []
    attributed_runs = 0
    for run in runs:
        task, arm, repeat = run["task"], run["arm"], run["repeat"]
        record = _read_json(results / "records" / task / arm / f"r{repeat}.json")
        export = export_dir(results, record, task, arm)
        built = structural_statements(export) if export is not None else None
        texts = [s["text"] for s in run["statements"]]
        reason = None
        if built is None:
            reason = "the export or its answer.md is not in the results directory"
        elif [s["text"] for s in built] != texts:
            reason = (
                f"the statements rebuilt from the export ({len(built)}) are not the graded "
                f"statements ({len(texts)}) text for text"
            )
        if reason is not None:
            undecided_runs.append({"task": task, "arm": arm, "repeat": repeat, "reason": reason})
        else:
            attributed_runs += 1
        for index, statement in enumerate(run["statements"]):
            category = built[index]["category"] if reason is None and built else CANNOT_DECIDE
            for grader in GRADERS:
                cell = tally[grader].setdefault(category, Counter())
                cell[_verdict(statement, grader)] += 1
    return {
        "runs": len(runs),
        "runs_attributed": attributed_runs,
        "runs_not_attributed": undecided_runs,
        "by_source": {
            grader: {
                name: {v: tally[grader].get(name, Counter())[v] for v in (*VERDICTS, UNGRADED)}
                for name, _label in CATEGORIES
            }
            for grader in GRADERS
        },
    }


def _sum(cell: dict[str, int]) -> tuple[int, int, int]:
    return tuple(cell[v] for v in VERDICTS)  # type: ignore[return-value]


def compare(structural: dict[str, Any]) -> dict[str, Any]:
    """The structural totals beside the written totals of the earlier attribution."""
    rows: dict[str, Any] = {}
    for grader in GRADERS:
        by_source = structural["by_source"][grader]
        items = [
            sum(x) for x in zip(*(_sum(by_source[k]) for k in ("fact", "conclusion", "open_item")))
        ]
        reply_keys = ("summary", "final_reply", "summary_and_final")
        reply = [sum(x) for x in zip(*(_sum(by_source[k]) for k in reply_keys))]
        written = WRITTEN_TOTALS[grader]
        found, refused, unchecked = (
            written["fact_quote_found"],
            written["fact_quote_refused"],
            written["unchecked_text"],
        )
        rows[grader] = {
            "structural_answer_items": items,
            "structural_summary_and_final_message": reply,
            "structural_cannot_decide": list(_sum(by_source[CANNOT_DECIDE])),
            "written_fact_quote_found": list(found),
            "written_fact_quote_refused": list(refused),
            "written_unchecked_text": list(unchecked),
            "written_found_plus_refused": [a + b for a, b in zip(found, refused)],
            "difference_answer_items_minus_written_found_plus_refused": [
                a - (b + c) for a, b, c in zip(items, found, refused)
            ],
            "difference_unchecked_minus_written_unchecked": [
                a - b for a, b in zip(reply, unchecked)
            ],
        }
    return rows


def build(results: Path, graded_path: Path) -> dict[str, Any]:
    graded = _read_json(graded_path)
    structural = attribute(results, graded)
    return {
        "format": 1,
        "kind": "broad_attribution_comparison",
        "note": (
            "Statements of the 36 stored broad runs attributed by the structure of each run's "
            "export, beside the totals of the earlier text-matching attribution, which are "
            "all that was written down. Counts of statements; none is a score."
        ),
        "structural": structural,
        "written_totals": {
            g: {k: list(v) for k, v in t.items()} for g, t in WRITTEN_TOTALS.items()
        },
        "comparison": compare(structural),
        "per_statement_comparison": {
            "possible": False,
            "why": (
                "the earlier attribution was not stored per statement, only as totals, so "
                "no statement can be listed as attributed differently; the totals above are "
                "the whole comparison there is"
            ),
        },
    }


def _fmt(values: Any) -> str:
    true, false, nc = values
    return f"{true} / {false} / {nc}"


def _total(structural: dict[str, Any]) -> int:
    return sum(sum(_sum(cell)) for cell in structural["by_source"][GRADERS[0]].values())


def _written_total() -> int:
    return sum(sum(row) for row in WRITTEN_TOTALS[GRADERS[0]].values())


def note_text(result: dict[str, Any]) -> str:
    """The short note, markdown, from the comparison."""
    s, c = result["structural"], result["comparison"]
    lines = [
        "# Broad runs: attribution by structure and the earlier text matching",
        "",
        "This compares two ways of saying where a graded statement of the 36 stored broad runs",
        "(2026-11-19) came from. Every cell is a count of statements as true / false / not",
        "checkable. None is a score and none is accuracy.",
        "",
        "## What was done",
        "",
        "The stored runs are not strict exports, so there is no item id on a statement. The",
        "structure they do have is the rendered `answer.md`: accepted facts, conclusions and",
        "open items under the harness's label, then the model's finish summary and final",
        "message under the unchecked label. `scripts/broad_attribution_comparison.py` rebuilds",
        "each run's statements from that structure, with the same splitting the grading sheet",
        "used, and attributes a graded statement to its item (or to the summary or the final",
        "message) only when the rebuilt statements are the graded statements, text for text",
        f"and in order. {s['runs_attributed']} of {s['runs']} runs were attributed that way.",
        "",
    ]
    undecided = s["runs_not_attributed"]
    if undecided:
        lines += [
            f"{len(undecided)} runs could not be attributed, and their statements are counted",
            "as structure cannot decide:",
            "",
        ]
        lines += [f"- {u['task']} {u['arm']} r{u['repeat']}: {u['reason']}" for u in undecided]
        lines.append("")
    lines += ["## Totals by structural source", ""]
    for grader in GRADERS:
        lines += [f"Grading by {grader} (true / false / not checkable):", ""]
        lines += ["| Structural source | Statements |", "|---|---|"]
        for name, label in CATEGORIES:
            lines.append(f"| {label} | {_fmt(_sum(s['by_source'][grader][name]))} |")
        lines.append("")
    lines += ["## Beside the earlier attribution", ""]
    lines += [
        "The earlier attribution is not stored per statement. Its totals are written in the",
        'table "Where the false statements are" of the support-score broad measurement',
        "note: statements resting on a fact whose quote was found, on a fact whose quote was",
        "refused, and on the model's unchecked text. They are copied into the script and",
        "put next to the structural totals. This was not rebuilt from the old text matching.",
        "",
        "| Grading | Row | Structure | Earlier (written) | Difference |",
        "|---|---|---|---|---|",
    ]
    for grader in GRADERS:
        row = c[grader]
        lines.append(
            f"| {grader} | answer items vs found + refused facts | "
            f"{_fmt(row['structural_answer_items'])} | {_fmt(row['written_found_plus_refused'])} | "
            f"{_fmt(row['difference_answer_items_minus_written_found_plus_refused'])} |"
        )
        lines.append(
            f"| {grader} | summary and final message vs unchecked text | "
            f"{_fmt(row['structural_summary_and_final_message'])} | "
            f"{_fmt(row['written_unchecked_text'])} | "
            f"{_fmt(row['difference_unchecked_minus_written_unchecked'])} |"
        )
    lines += [""]
    for grader in GRADERS:
        row, own = c[grader], s["by_source"][grader]
        opened = sum(_sum(own["open_item"]))
        lines.append(
            f"By {grader}'s grading, structure puts {sum(row['structural_answer_items'])} "
            f"statements in the answer's items and the earlier totals put "
            f"{sum(row['written_found_plus_refused'])} on facts; {opened} of the structural ones "
            f"are open items, {own['open_item']['not_checkable']} of them graded not checkable."
        )
    lines += [
        "",
        "## What could not be compared",
        "",
        "- The earlier table's rows are defined by how a statement was matched to a fact, and",
        "  that matching was not stored, so a difference in the verdict mix between the two",
        "  tables cannot be traced to a cause here. The structural totals cover "
        f"{_total(s)} statements and the written totals add up to {_written_total()}.",
        "- No statement can be listed as attributed differently, because the earlier",
        "  attribution of a single statement was not kept. Only the totals above exist.",
        "- By structure no statement rests on a fact whose quote was refused: the harness does",
        "  not render a refused fact, so such a statement can only be in the model's own text.",
        '  The earlier "refused" row therefore has no structural counterpart and is compared',
        "  with the other two rows combined, as the table above does.",
        "- A statement of the model's own text that repeats an accepted fact is, by structure,",
        "  unchecked text. The comparison says nothing about whether it repeats one.",
        "- The summary and the final message are separate sources by structure; the earlier",
        "  table has one unchecked row, so they are compared together.",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("results", type=Path, help="The results directory of the broad runs.")
    parser.add_argument("graded", type=Path, help="broad-graded-statements.json (any path).")
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--note-out", type=Path, default=DEFAULT_NOTE)
    args = parser.parse_args(argv)
    try:
        result = build(args.results, args.graded)
    except (ComparisonError, KeyError, TypeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    args.json_out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    args.note_out.write_text(note_text(result), encoding="utf-8")
    print(f"wrote {args.json_out.name} and {args.note_out.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
