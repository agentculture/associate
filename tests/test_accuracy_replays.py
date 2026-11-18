"""Replays of the recorded 2026-11-17 failures through the Python re-check (issue #20, plan t19).

The fixtures in ``tests/fixtures/accuracy/`` are trimmed copies of the pre-change
exports of the runs scope20-cortex-t1, scope20-worker-t2, scope20-worker-t3 and
scope20-worker-t5; the senses case (t20 run A2) has no recorded walk and its
fixture is rebuilt from ``docs/notes/t20-live-acceptance.md`` and says so. The
node side replays all six through the extension entry points
(``.pi/extensions/associate/tests/replays.test.ts``); this file replays the four
that reach the checker through ``associate.accuracy.check``, and holds the
portability scan for every fixture.

Against commit 33141ff (run on 2026-11-18 from a temporary checkout of it, with
this file and the fixtures copied in) the file fails at collection:
``ModuleNotFoundError: No module named 'associate.accuracy'``, so every test in
it fails there by import error.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from associate.accuracy.check import check_handback
from associate.contract import contract_dir, load_accuracy

ACCURACY = load_accuracy()
FIXTURES = Path(__file__).parent / "fixtures" / "accuracy"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def run_data(entries: list[dict]) -> dict:
    """Entries as the checker reads them; the saved text of each is its inline content."""
    return {
        "entries": [{**e, "ts": "2026-11-17T00:00:00Z", "truncated": False} for e in entries],
        "results": {e["id"]: e["result"]["content"] for e in entries},
    }


def verdicts(got: dict) -> dict:
    return {f["id"]: f for f in got["facts"]}


def test_replay_quote_absent_on_w3_and_w7():
    fx = fixture("quote_absent_example_markers.json")
    got = check_handback(
        {"payload": {"facts": [*fx["facts"], fx["control_fact"]]}, **run_data(fx["entries"])},
        ACCURACY,
    )
    by_id = verdicts(got)
    for fact_id in ("f1", "f2"):
        assert by_id[fact_id]["verdict"] == "refused"
        assert by_id[fact_id]["reason"] == "quote_absent"
        assert by_id[fact_id]["nearest"] is not None
    assert by_id["f3"]["verdict"] == "passed"
    assert got["accepted"] is False


def test_replay_prior_run_id_cited_bare_in_a_continued_run():
    fx = fixture("prior_run_ids.json")
    current = run_data(fx["current_entries"])
    prior = {"prior": run_data(fx["prior_entries"])}
    bare = check_handback(
        {"payload": {"facts": [fx["fact"]]}, **current, "prior_runs": prior}, ACCURACY
    )
    assert bare["facts"][0]["verdict"] == "refused"
    assert bare["facts"][0]["reason"] == "quote_absent"
    assert any(
        "ambiguous_reference" in flag["detail"] and flag.get("ref") == "w10"
        for flag in bare["report"]["flags"]
    ), bare["report"]["flags"]
    labelled = check_handback(
        {
            "payload": {"facts": [{**fx["fact"], "source": "prior:w10"}]},
            **current,
            "prior_runs": prior,
        },
        ACCURACY,
    )
    assert labelled["facts"][0]["verdict"] == "passed"
    assert labelled["facts"][0]["run"] == "prior"


def test_replay_pyproject_sentence_as_a_fact_is_refused():
    fx = fixture("finish_summary_pyproject.json")
    assert fx["pyproject_sentence"] in fx["summary"]
    got = check_handback(
        {"payload": {"summary": fx["summary"], "facts": [fx["fact"]]}, **run_data(fx["entries"])},
        ACCURACY,
    )
    assert got["facts"][0]["verdict"] == "refused"
    assert got["facts"][0]["reason"] == "quote_absent"


def test_replay_senses_remember_success_without_the_call():
    fx = fixture("senses_remember_success.json")
    assert fx["kind"] == "rebuilt-from-note"
    assert fx["_origin"].startswith("REBUILT FROM A NOTE")
    assert not any(e["tool"] == "eidetic_remember" for e in fx["entries"])
    got = check_handback({"payload": {"facts": fx["facts"]}, **run_data(fx["entries"])}, ACCURACY)
    wrong_tool, unknown = got["facts"]
    assert (wrong_tool["verdict"], wrong_tool["reason"]) == ("refused", "action_wrong_tool")
    assert (unknown["verdict"], unknown["reason"]) == ("refused", "source_unknown")
    assert got["accepted"] is False


def test_every_fixture_is_free_of_home_and_temp_paths_and_secrets():
    policy = json.loads((contract_dir() / "policy.json").read_text(encoding="utf-8"))
    patterns = [re.compile(p) for p in policy["redaction"]["patterns"]]
    names = sorted(p.name for p in FIXTURES.glob("*.json"))
    assert len(names) >= 6, names
    for name in names:
        text = (FIXTURES / name).read_text(encoding="utf-8")
        assert "/home/" not in text, f"{name} holds /home/"
        assert "/tmp/" not in text, f"{name} holds /tmp/"
        for pattern in patterns:
            assert not pattern.search(text), f"{name} matches redaction pattern {pattern.pattern}"
        doc = json.loads(text)
        assert doc["kind"] in ("recorded", "rebuilt-from-note"), name
        assert doc["_origin"], name


def test_the_rebuilt_fixture_is_the_only_one_not_from_a_recorded_run():
    kinds = {
        p.name: json.loads(p.read_text(encoding="utf-8"))["kind"] for p in FIXTURES.glob("*.json")
    }
    assert [n for n, k in kinds.items() if k != "recorded"] == ["senses_remember_success.json"]
