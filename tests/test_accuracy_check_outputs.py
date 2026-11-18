"""``associate check`` prints what it printed before the re-check moved to evidence-cli.

The re-check moved from ``associate/accuracy/`` (commit ``266dad3``) into the
first-party package evidence-cli. ``tests/fixtures/check_before_266dad3.json``
holds what ``associate check`` printed, in text and ``--json``, for every export
built below, recorded from the tree before the move (see its ``_origin``).

Each export below is built the same way every time. For most of them the output
must be the same as before. The exceptions are the behaviours evidence-cli's
0.7.0 changelog lists as different from associate at ``266dad3``; each is in
``CHANGED`` with the changelog item that explains it and an assertion of the new
behaviour. One difference applies to every ``--json`` result and is listed in
``JSON_KEY_ADDED``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

import pytest

from associate.cli import main

BEFORE_FILE = Path(__file__).parent / "fixtures" / "check_before_266dad3.json"
REPLAYS = Path(__file__).parent / "fixtures" / "accuracy"
ROOT_TOKEN = "<ROOT>"
QUOTE = "the quoted line is here"
MARKER = {"format": {"name": "associate-walk", "version": 2}}
RUN_LINE = {"run": {"duration_ms": 1, "tool_calls": 1, "outcome": "ok", "truncated": False}}
DEEP = 100_000  # deeper than the json module can parse


# --- building exports ------------------------------------------------------------------------


def entry(n: int, tool: str = "read", kind: str = "file", **extra: Any) -> dict[str, Any]:
    e = {
        "id": f"w{n}",
        "ts": "2026-11-18T00:00:00Z",
        "tool": tool,
        "args": {},
        "result": {},
        "truncated": False,
        "source_kind": kind,
        "saved_result": f"results/w{n}.txt",
    }
    e.update(extra)
    return e


def write_export(
    export: Path,
    entries: list[dict[str, Any]],
    results: dict[str, str],
    payload: dict[str, Any] | None = None,
    *,
    first: list[Any] | None = None,
    extra_lines: list[Any] | None = None,
) -> Path:
    """An export: ``first`` lines (the format marker by default), entries, extra lines, run."""
    (export / "results").mkdir(parents=True, exist_ok=True)
    lines = [MARKER] if first is None else first
    lines = [*lines, *entries, *(extra_lines or []), RUN_LINE]
    (export / "walk.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines), "utf-8")
    for walk_id, text in results.items():
        (export / "results" / f"{walk_id}.txt").write_text(text, encoding="utf-8")
    if payload is not None:
        (export / "facts.json").write_text(json.dumps(payload), encoding="utf-8")
    return export


def one_fact(source: str = "w1", quote: str = QUOTE) -> dict[str, Any]:
    return {"facts": [{"id": "f1", "value": "here", "source": source, "quote": quote}]}


def simple(export: Path, **kw: Any) -> Path:
    return write_export(export, [entry(1)], {"w1": QUOTE + "\n"}, one_fact(), **kw)


Built = tuple[Path, list[str]]


def hand_count(root: Path) -> Built:
    entries = [
        entry(1, purpose="read the config"),
        entry(2, "grep", "tool", purpose="find the call"),
        entry(3, "bash", "tool", purpose="run the check"),
        entry(4, "ledger_append", "tool", error="refused: gate", partial=True),
    ]
    del entries[1]["saved_result"], entries[3]["saved_result"]
    results = {"w1": "The quick brown fox jumps over the lazy dog", "w3": "tests passed: 12 of 12"}
    facts = [
        ("f1", "w1", "over the lazy dog"),
        ("f2", "w1", "brown fox leaps"),
        ("f3", "w2", "some grep output"),
        ("f4", "w3", "tests passed: 12 of 12"),
        ("f5", "nowhere", "whatever it was"),
    ]
    payload = {
        "facts": [{"id": i, "value": "v", "source": s, "quote": q} for i, s, q in facts],
        "verdicts": [
            {"id": "v1", "text": "t", "verdict": "supported", "basis": ["f1"], "closing": True}
        ],
        "summary": "one sentence. another sentence.",
    }
    return write_export(root / "export", entries, results, payload), []


def pre_marker(root: Path) -> Built:
    return write_export(root / "export", [entry(1)], {}, first=[]), []


def no_facts(root: Path) -> Built:
    return write_export(root / "export", [entry(1)], {"w1": QUOTE}), []


def partial_entry(root: Path) -> Built:
    export = write_export(root / "export", [entry(1, partial=True)], {"w1": QUOTE + " more"})
    (export / "facts.json").write_text(json.dumps(one_fact()), encoding="utf-8")
    return export, []


def bad_facts(root: Path) -> Built:
    export = write_export(root / "export", [], {})
    (export / "facts.json").write_text("{not json", encoding="utf-8")
    return export, []


def missing_dir(root: Path) -> Built:
    return root / "missing", []


def continued(root: Path) -> Built:
    prior = simple(root / "prior")
    export = write_export(root / "export", [entry(1)], {"w1": "other"}, one_fact("prior:w1"))
    return export, ["--continue-from", str(prior)]


def absolute_child(root: Path) -> Built:
    child = simple(root / "kid")
    link = {"child": {"id": "c1", "child_walk": str(child / "walk.jsonl")}}
    export = write_export(
        root / "export", [entry(1)], {"w1": "x"}, one_fact("c1:w1"), extra_lines=[link]
    )
    return export, []


def _replay_entries(entries: list[dict[str, Any]]) -> tuple[list[dict], dict[str, str]]:
    walk = [
        {
            **e,
            "ts": "2026-11-17T00:00:00Z",
            "truncated": False,
            "saved_result": f"results/{e['id']}.txt",
        }
        for e in entries
    ]
    return walk, {e["id"]: e["result"]["content"] for e in entries}


def _replay(name: str) -> dict[str, Any]:
    return json.loads((REPLAYS / name).read_text(encoding="utf-8"))


def replay_quote_absent(root: Path) -> Built:
    fx = _replay("quote_absent_example_markers.json")
    payload = {"facts": [*fx["facts"], fx["control_fact"]]}
    return write_export(root / "export", *_replay_entries(fx["entries"]), payload), []


def replay_prior_ids(root: Path) -> Built:
    fx = _replay("prior_run_ids.json")
    prior = write_export(root / "prior", *_replay_entries(fx["prior_entries"]))
    bare, labelled = fx["fact"], {**fx["fact"], "id": "f2", "source": "prior:w10"}
    payload = {"facts": [bare, labelled]}
    export = write_export(root / "export", *_replay_entries(fx["current_entries"]), payload)
    return export, ["--continue-from", str(prior)]


def replay_pyproject(root: Path) -> Built:
    fx = _replay("finish_summary_pyproject.json")
    payload = {"summary": fx["summary"], "facts": [fx["fact"]]}
    return write_export(root / "export", *_replay_entries(fx["entries"]), payload), []


def replay_senses(root: Path) -> Built:
    fx = _replay("senses_remember_success.json")
    payload = {"facts": fx["facts"]}
    return write_export(root / "export", *_replay_entries(fx["entries"]), payload), []


# --- the exports whose output differs, each for a changelog item --------------------------


def format_3(root: Path) -> Built:
    return simple(root / "export", first=[{"format": {"name": "associate-walk", "version": 3}}]), []


def format_string(root: Path) -> Built:
    return (
        simple(root / "export", first=[{"format": {"name": "associate-walk", "version": "2"}}]),
        [],
    )


def marker_extra_key(root: Path) -> Built:
    return simple(root / "export", first=[{**MARKER, "note": "written by a later harness"}]), []


def facts_linked_outside(root: Path) -> Built:
    export = write_export(root / "export", [entry(1)], {"w1": QUOTE})
    outside = root / "outside-facts.json"
    outside.write_text(json.dumps(one_fact()), encoding="utf-8")
    os.symlink(outside, export / "facts.json")
    return export, []


def walk_linked_outside(root: Path) -> Built:
    source = simple(root / "elsewhere")
    export = root / "export"
    (export / "results").mkdir(parents=True)
    (export / "results" / "w1.txt").write_text(QUOTE, encoding="utf-8")
    os.symlink(source / "walk.jsonl", export / "walk.jsonl")
    return export, []


def relative_child(root: Path) -> Built:
    export = root / "export"
    simple(export / "kid")
    link = {"child": {"id": "c1", "child_walk": "kid/walk.jsonl"}}
    write_export(export, [entry(1)], {"w1": "x"}, one_fact("c1:w1"), extra_lines=[link])
    return export, []


def prior_format_3(root: Path) -> Built:
    prior = simple(root / "prior", first=[{"format": {"name": "associate-walk", "version": 3}}])
    export = write_export(root / "export", [entry(1)], {"w1": "other"}, one_fact("prior:w1"))
    return export, ["--continue-from", str(prior)]


def non_utf8_line(root: Path) -> Built:
    export = simple(root / "export")
    with (export / "walk.jsonl").open("ab") as walk:
        walk.write(b'{"id": "w2", "tool": "read", "note": "cut \xe2\x82')
    return export, []


def deep_walk_line(root: Path) -> Built:
    export = simple(root / "export")
    with (export / "walk.jsonl").open("a", encoding="utf-8") as walk:
        walk.write("[" * DEEP + "]" * DEEP + "\n")
    return export, []


def deep_facts(root: Path) -> Built:
    export = write_export(root / "export", [entry(1)], {"w1": QUOTE})
    (export / "facts.json").write_text('{"facts": ' + "[" * DEEP + "]" * DEEP + "}", "utf-8")
    return export, []


SCENARIOS: dict[str, Callable[[Path], Built]] = {
    "hand_count": hand_count,
    "pre_marker": pre_marker,
    "no_facts": no_facts,
    "partial_entry": partial_entry,
    "bad_facts": bad_facts,
    "missing_dir": missing_dir,
    "continued": continued,
    "absolute_child": absolute_child,
    "replay_quote_absent": replay_quote_absent,
    "replay_prior_ids": replay_prior_ids,
    "replay_pyproject": replay_pyproject,
    "replay_senses": replay_senses,
    "format_3": format_3,
    "format_string": format_string,
    "marker_extra_key": marker_extra_key,
    "facts_linked_outside": facts_linked_outside,
    "walk_linked_outside": walk_linked_outside,
    "relative_child": relative_child,
    "prior_format_3": prior_format_3,
    "non_utf8_line": non_utf8_line,
    "deep_walk_line": deep_walk_line,
    "deep_facts": deep_facts,
}

# --- what changed, and why -------------------------------------------------------------------

UNSUPPORTED_NEWER = (
    "An export whose walk format is newer than supported is reported as unsupported, and the "
    "format is tested before anything else of the export is read."
)
UNSUPPORTED_MARKER = (
    "A format marker whose version is not a positive integer is unsupported too, the value named"
)
MARKER_WITH_KEYS = "a line with a `format` key is the marker even with other keys."
LINK_GUARD = (
    "The export's own files are never read through a link pointing outside it (`facts.json` or "
    "`walk.jsonl` linked from outside is an error; ...)"
)
RELATIVE_CHILD = (
    "A relative `child_walk` is taken from the export directory, not the process's working "
    "directory."
)
UNSUPPORTED_RUN = (
    "A prior or child run whose walk format is not supported is not loaded (a fact citing it is "
    "refused as an unknown source) and is listed under `unsupported_runs`."
)
NOT_UTF8 = (
    "A walk line that is not UTF-8 (cut mid character by a killed run) is skipped like a line "
    "that is not JSON, instead of failing the check."
)
TOO_DEEP = (
    "JSON nested too deeply for the json module is handled: in a walk line it is skipped, in "
    "`facts.json` it is an export error, ..."
)

#: Every ``--json`` result gains this key; it is [] unless a prior or child run was skipped.
JSON_KEY_ADDED = ("unsupported_runs", UNSUPPORTED_RUN)


def _facts(result: dict[str, Any]) -> dict[str, tuple[str, Any]]:
    return {f["id"]: (f["verdict"], f["reason"]) for f in result["facts"]}


def _unsupported(version: Any, words: str) -> Callable[[dict, str], None]:
    def check(after: dict, text: str) -> None:
        assert after["rc"] == 0
        assert after["json"]["unsupported"] is True
        assert after["json"]["walk_format"] == version
        assert after["json"]["calls"] == []
        assert words in after["json"]["not_applicable_reason"]
        assert words in text

    return check


def _passes_one_fact(after: dict, text: str) -> None:
    assert after["rc"] == 0
    assert after["json"]["report"]["facts"]["passed"] == 1
    assert "f1" in text


def _link_refused(after: dict, text: str) -> None:
    assert after["rc"] == 1
    assert "points outside the export directory" in after["error"]["message"]


def _prior_not_loaded(after: dict, text: str) -> None:
    assert after["rc"] == 0
    assert after["json"]["unsupported_runs"] == [{"label": "prior", "walk_format": 3}]
    assert _facts(after["json"]) == {"f1": ("refused", "source_unknown")}
    assert "not loaded: prior (walk format 3)" in text


def _deep_facts_refused(after: dict, text: str) -> None:
    assert after["rc"] == 1
    assert "facts.json" in after["error"]["message"]
    assert "unexpected" not in after["error"]["message"]


#: Scenario -> (the evidence-cli 0.7.0 changelog item, a check of the new output).
CHANGED: dict[str, tuple[str, Callable[[dict, str], None]]] = {
    "format_3": (UNSUPPORTED_NEWER, _unsupported(3, "walk format 3 is newer")),
    "format_string": (UNSUPPORTED_MARKER, _unsupported("2", "not a positive integer")),
    "marker_extra_key": (MARKER_WITH_KEYS, _passes_one_fact),
    "facts_linked_outside": (LINK_GUARD, _link_refused),
    "walk_linked_outside": (LINK_GUARD, _link_refused),
    "relative_child": (RELATIVE_CHILD, _passes_one_fact),
    "prior_format_3": (UNSUPPORTED_RUN, _prior_not_loaded),
    "non_utf8_line": (NOT_UTF8, _passes_one_fact),
    "deep_walk_line": (TOO_DEEP, _passes_one_fact),
    "deep_facts": (TOO_DEEP, _deep_facts_refused),
}


# --- running the verb --------------------------------------------------------------------------


def run_verb(capsys, root: Path, export: Path, extra: list[str], *flags: str) -> dict[str, Any]:
    """Run ``associate check``; paths under *root* are replaced by ``<ROOT>``."""
    rc = main(["check", str(export), *extra, *flags])
    captured = capsys.readouterr()
    out, err = (s.replace(str(root), ROOT_TOKEN) for s in (captured.out, captured.err))
    return {"rc": rc, "out": out, "err": err}


def observe(capsys, root: Path, name: str) -> dict[str, Any]:
    """What the verb prints for one scenario, in text and in JSON."""
    export, extra = SCENARIOS[name](root)
    text = run_verb(capsys, root, export, extra)
    data = run_verb(capsys, root, export, extra, "--json")
    return {
        "rc": data["rc"],
        "text": text["out"],
        "text_err": text["err"],
        "json": json.loads(data["out"]) if data["out"] else None,
        "error": json.loads(data["err"]) if data["err"] else None,
    }


def _before() -> dict[str, Any]:
    return json.loads(BEFORE_FILE.read_text(encoding="utf-8"))["scenarios"]


@pytest.fixture
def in_root(tmp_path: Path, monkeypatch) -> Path:
    """A fixed working directory: a relative child walk was read from it before."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_every_scenario_was_recorded_before_and_every_change_names_a_scenario():
    assert set(_before()) == set(SCENARIOS)
    assert set(CHANGED) <= set(SCENARIOS)


@pytest.mark.parametrize("name", [n for n in SCENARIOS if n not in CHANGED])
def test_output_is_unchanged(name, in_root, capsys):
    before, after = _before()[name], observe(capsys, in_root, name)
    assert after["rc"] == before["rc"]
    assert after["text"] == before["text"]
    assert after["text_err"] == before["text_err"]
    assert after["error"] == before["error"]
    if before["json"] is None:
        assert after["json"] is None
        return
    key, _item = JSON_KEY_ADDED
    assert after["json"].pop(key, None) == []
    assert after["json"] == before["json"]


@pytest.mark.parametrize("name", sorted(CHANGED))
def test_output_changed_only_as_the_changelog_says(name, in_root, capsys):
    item, check = CHANGED[name]
    assert item, "each change names its changelog item"
    before, after = _before()[name], observe(capsys, in_root, name)
    assert (after["rc"], after["text"], after["error"]) != (
        before["rc"],
        before["text"],
        before["error"],
    ), f"{name} no longer differs; remove it from CHANGED"
    check(after, after["text"])


def test_the_recorded_outputs_hold_no_machine_path():
    text = BEFORE_FILE.read_text(encoding="utf-8")
    assert "/home/" not in text
    assert "/tmp/" not in text
    assert json.loads(text)["_origin"]
