"""Per-run memory and ledger isolation for measured runs (plan task t5)."""

import json
import os
import stat
import subprocess
import sys

import pytest

from associate.measure.isolation import isolate_run

_FAKE_EIDETIC = """#!{python}
import json, os, sys
store = os.path.join(os.environ["EIDETIC_DATA_DIR"], "records.jsonl")
verb = sys.argv[1]
if verb == "remember":
    with open(store, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({{"text": sys.argv[2]}}) + "\\n")
    print(json.dumps({{"ok": True}}))
else:
    items = []
    if os.path.exists(store):
        with open(store, encoding="utf-8") as fh:
            items = [json.loads(line) for line in fh if line.strip()]
    print(json.dumps({{"query": sys.argv[2], "items": items}}))
"""


@pytest.fixture
def fake_eidetic(tmp_path):
    path = tmp_path / "bin" / "eidetic"
    path.parent.mkdir()
    path.write_text(_FAKE_EIDETIC.format(python=sys.executable), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


def _run(binary, env, *args):
    full_env = dict(os.environ)
    full_env["EIDETIC_DATA_DIR"] = env["ASSOCIATE_EIDETIC_DIR"]
    out = subprocess.run(  # nosec B603
        [binary, *args], env=full_env, capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout)


def test_two_runs_get_different_empty_locations(tmp_path):
    first = isolate_run(tmp_path / "run-1")
    second = isolate_run(tmp_path / "run-2")
    for key in ("ASSOCIATE_EIDETIC_DIR", "ASSOCIATE_LEDGER_PATH"):
        assert first[key] != second[key]
        assert os.path.isabs(first[key])
    for env in (first, second):
        assert os.listdir(env["ASSOCIATE_EIDETIC_DIR"]) == []
        assert not os.path.exists(env["ASSOCIATE_LEDGER_PATH"])
        assert os.path.isdir(os.path.dirname(env["ASSOCIATE_LEDGER_PATH"]))


def test_locations_sit_under_the_run_directory(tmp_path):
    run_dir = tmp_path / "run-1"
    env = isolate_run(run_dir)
    for key in ("ASSOCIATE_EIDETIC_DIR", "ASSOCIATE_LEDGER_PATH"):
        assert os.path.commonpath([str(run_dir.resolve()), env[key]]) == str(run_dir.resolve())


def test_record_from_first_run_is_not_recalled_in_second(tmp_path, fake_eidetic):
    first = isolate_run(tmp_path / "run-1")
    second = isolate_run(tmp_path / "run-2")
    _run(fake_eidetic, first, "remember", "the key is 42")
    assert len(_run(fake_eidetic, first, "recall", "key")["items"]) == 1
    assert _run(fake_eidetic, second, "recall", "key")["items"] == []


def test_reusing_a_populated_run_directory_is_refused(tmp_path):
    env = isolate_run(tmp_path / "run-1")
    with open(os.path.join(env["ASSOCIATE_EIDETIC_DIR"], "records.jsonl"), "w") as fh:
        fh.write("{}\n")
    with pytest.raises(ValueError, match="not empty"):
        isolate_run(tmp_path / "run-1")


def test_reusing_a_run_directory_with_a_ledger_is_refused(tmp_path):
    env = isolate_run(tmp_path / "run-1")
    with open(env["ASSOCIATE_LEDGER_PATH"], "w") as fh:
        fh.write("{}\n")
    with pytest.raises(ValueError, match="already exists"):
        isolate_run(tmp_path / "run-1")
