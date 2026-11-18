"""``associate check --continue-from`` reads the prior run (issue #20, t17).

A fact may cite ``prior:wN`` (the ``--continue-from`` export) or ``cN:wM`` (a
child run named by a ``child`` line of the walk). How the re-check resolves
those labels is evidence-cli's to test (its ``tests/test_runs.py``); this file
checks that associate's verb passes ``--continue-from`` through.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

QUOTE = "the quoted line is here"


def _export(
    root: Path,
    text: str = QUOTE + "\n",
    *,
    facts: list[dict[str, Any]] | None = None,
    child: dict[str, str] | None = None,
) -> Path:
    """One export directory: a format-2 walk with w1 saved, optionally facts and a child link."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "results").mkdir(exist_ok=True)
    (root / "results" / "w1.txt").write_text(text, encoding="utf-8")
    lines: list[dict[str, Any]] = [
        {"format": {"name": "associate-walk", "version": 2}},
        {
            "id": "w1",
            "ts": "2026-11-18T00:00:00+00:00",
            "tool": "read",
            "args": {},
            "result": {},
            "truncated": False,
            "saved_result": "results/w1.txt",
        },
    ]
    if child is not None:
        lines.append({"child": child})
    lines.append({"run": {"duration_ms": 1, "tool_calls": 1, "outcome": "ok", "truncated": False}})
    (root / "walk.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines), encoding="utf-8")
    if facts is not None:
        payload = {"facts": facts}
        (root / "facts.json").write_text(json.dumps(payload), encoding="utf-8")
    return root


def _fact(source: str, quote: str = QUOTE) -> dict[str, Any]:
    return {"id": "f1", "value": "", "source": source, "quote": quote}


def _verdicts(facts: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "facts": facts,
        "verdicts": [
            {"id": "v1", "text": "t", "verdict": "supported", "basis": ["f1"], "closing": True}
        ],
    }


def _write_facts(root: Path, facts: list[dict[str, Any]]) -> None:
    (root / "facts.json").write_text(json.dumps(_verdicts(facts)), encoding="utf-8")


def test_the_check_verb_takes_continue_from(tmp_path: Path, capsys):
    from associate.cli import main

    prior = _export(tmp_path / "prior" / "export", "prior text, quotable line\n")
    current = _export(tmp_path / "cur" / "export")
    _write_facts(current, [_fact("prior:w1", "prior text, quotable line")])

    assert main(["check", str(current), "--json"]) == 0
    without = json.loads(capsys.readouterr().out)
    assert without["facts"][0]["reason"] == "source_unknown"

    assert main(["check", str(current), "--continue-from", str(prior), "--json"]) == 0
    with_prior = json.loads(capsys.readouterr().out)
    assert with_prior["facts"][0]["verdict"] == "passed"
    assert with_prior["facts"][0]["run"] == "prior"
