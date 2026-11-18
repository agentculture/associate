"""The recorded 2026-11-17 failures kept as fixtures (issue #20, plan t19).

The fixtures in ``tests/fixtures/accuracy/`` are trimmed copies of the pre-change
exports of the runs scope20-cortex-t1, scope20-worker-t2, scope20-worker-t3 and
scope20-worker-t5; the senses case (t20 run A2) has no recorded walk and its
fixture is rebuilt from ``docs/notes/t20-live-acceptance.md`` and says so. The
node side replays all six through the extension entry points
(``.pi/extensions/associate/tests/replays.test.ts``). The four Python replays
through the re-check moved with it to evidence-cli (its ``tests/test_replays.py``);
``tests/test_accuracy_check_outputs.py`` still runs ``associate check`` over
exports built from these fixtures. This file holds the portability scan for
every fixture.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from associate.contract import contract_dir

FIXTURES = Path(__file__).parent / "fixtures" / "accuracy"


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
