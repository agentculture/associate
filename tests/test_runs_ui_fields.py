"""The fields the web UI needs from ``runs list`` and ``runs show``, and their bounds.

The cards need a title, the merge word, the finish time and an outcome line per run; the run
page needs the instruction and each test command's own result. Everything comes from the run's
stored ``request.json`` and ``result.json`` (never a command's output, never an environment
value), every free-text value is cut, and both replies stay under 64 KiB however large or
non-ASCII the stored values are.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from associate.runs import service
from associate.runs.service import REPLY_LIMIT_BYTES, RunsConfig
from tests.test_runs import make_repo, release, start, wait_done

BIG = "€" * 20_000  # 3 bytes as UTF-8, six as an ASCII escape; longer than any cut


@pytest.fixture
def cfg(tmp_path: Path) -> RunsConfig:
    """As ``tests/test_runs.py``'s: a state dir and one allowed root, both under tmp."""
    roots = tmp_path / "roots"
    roots.mkdir()
    return RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))


@pytest.fixture
def repo(cfg: RunsConfig) -> Path:
    return make_repo(cfg.allowed_roots[0] / "repo")


def size(reply) -> int:
    return max(len(json.dumps(reply).encode()), len(json.dumps(reply, ensure_ascii=False).encode()))


def write_run(state_dir: Path, n: int, request: dict, result: dict | None) -> str:
    run_id = f"run-{n:032x}"
    run = state_dir / "runs" / run_id
    run.mkdir(parents=True)
    (run / "request.json").write_text(json.dumps({"run_id": run_id, **request}), "utf-8")
    if result is not None:
        (run / "result.json").write_text(json.dumps(result), "utf-8")
    return run_id


def finished(**run_result) -> dict:
    return {
        "status": "finished",
        "finished_at": "2026-11-16T10:09:00+00:00",
        "exit_code": 0,
        "signal": None,
        "run_result": run_result,
        "base_commit": "a" * 40,
        "changed_paths": [],
        "changed_paths_total": 0,
    }


REQUEST = {
    "checkout": "/srv/checkouts/culture-rules",
    "model": "cortex",
    "instruction": "\n  Add a guideline\nwith a second line",
    "test_commands": ["uv run pytest -q", "markdownlint-cli2 REVIEW.md"],
    "started_at": "2026-11-16T10:00:00+00:00",
    "base_commit": "b" * 40,
}


# --- runs list ---------------------------------------------------------------------------------


def test_list_gives_each_card_its_title_merge_finish_and_outcome(cfg, repo):
    started = start(cfg, repo, mode="merge", instruction="\n\n  Raise inline comments  \nmore")
    wait_done(cfg, started["run_id"])
    (row,) = service.list_runs(config=cfg)["runs"]
    assert row["title"] == "Raise inline comments"
    assert row["merge"] == "merged"
    assert row["ok"] is True
    assert row["finished_at"] and row["started_at"]
    assert row["outcome"] == "ok"
    assert row["exit_code"] == 0
    assert row["tests"] == {"passed": True, "commands": 1, "failed": 0}
    assert row["changed_paths_total"] == 1
    assert row["test_command_count"] == 1


def test_list_tells_failing_tests_from_a_refused_merge(cfg, tmp_path):
    state = cfg.state_dir
    bad_tests = {
        "passed": False,
        "commands": [
            {"argv": ["true"], "exit_code": 0, "timed_out": False},
            {"argv": ["false"], "exit_code": 1, "timed_out": False},
        ],
    }
    good_tests = {"passed": True, "commands": [{"argv": ["true"], "exit_code": 0}]}
    write_run(state, 1, REQUEST, finished(outcome="ok", merge="kept", tests=bad_tests))
    write_run(
        state,
        2,
        {**REQUEST, "started_at": "2026-11-16T11:00:00+00:00"},
        finished(outcome="ok", merge="kept", tests=good_tests, merge_reason="main is dirty"),
    )
    rows = {r["run_id"]: r for r in service.list_runs(config=cfg)["runs"]}
    failing, refused = rows[f"run-{1:032x}"], rows[f"run-{2:032x}"]
    assert failing["merge"] == "not_attempted"
    assert failing["tests"] == {"passed": False, "commands": 2, "failed": 1}
    assert refused["merge"] == "refused"
    assert refused["tests"] == {"passed": True, "commands": 1, "failed": 0}
    assert failing["ok"] is refused["ok"] is False


def test_list_of_a_running_run_names_its_test_commands_and_no_finish(cfg, repo):
    started = start(cfg, repo, mode="gate", test_commands=["true", "true --again"])
    try:
        (row,) = service.list_runs(config=cfg)["runs"]
        assert row["status"] == "running"
        assert row["test_command_count"] == 2
        assert row["finished_at"] is None
        assert row["merge"] is None
        assert row["tests"] is None
    finally:
        release(cfg, started["run_id"])
        wait_done(cfg, started["run_id"])


def test_list_of_lost_and_failed_to_start_runs(cfg):
    state = cfg.state_dir
    lost = write_run(state, 1, REQUEST, None)  # no supervisor alive, no result
    failed = write_run(
        state,
        2,
        {**REQUEST, "started_at": "2026-11-16T11:00:00+00:00"},
        {"status": "failed-to-start", "finished_at": "2026-11-16T11:00:01+00:00", "error": "x"},
    )
    rows = {r["run_id"]: r for r in service.list_runs(config=cfg)["runs"]}
    assert rows[lost]["status"] == "lost" and rows[lost]["title"] == "Add a guideline"
    assert rows[failed]["status"] == "failed-to-start"
    assert rows[failed]["finished_at"] == "2026-11-16T11:00:01+00:00"


def test_a_title_is_one_line_cut_short(cfg):
    write_run(cfg.state_dir, 1, {**REQUEST, "instruction": "x" * 5000 + "\nsecond"}, None)
    (row,) = service.list_runs(config=cfg)["runs"]
    assert len(row["title"]) <= service.LIST_TITLE_CHARS + 1
    assert row["title"].endswith("…")
    assert "\n" not in row["title"]


def test_a_title_of_an_instruction_that_is_not_text_is_none(cfg):
    write_run(cfg.state_dir, 1, {**REQUEST, "instruction": ["not", "text"]}, None)
    (row,) = service.list_runs(config=cfg)["runs"]
    assert row["title"] is None


def test_list_of_a_hundred_hostile_runs_stays_under_64_kib(tmp_path):
    cfg = RunsConfig(state_dir=tmp_path / "state")
    huge_tests = {
        "passed": False,
        "commands": [{"argv": [BIG], "exit_code": 1, "output_tail": BIG}] * 20,
    }
    for n in range(service.LIST_LIMIT + 5):
        write_run(
            cfg.state_dir,
            n,
            {
                "checkout": "/" + BIG,
                "model": BIG,
                "instruction": BIG,
                "test_commands": [BIG] * 20,
                "started_at": f"2026-11-16T10:{n % 60:02d}:00+00:00{BIG[:n]}",
                "base_commit": BIG,
            },
            {
                **finished(outcome=BIG, merge=BIG, merge_reason=BIG, final_reply=BIG),
                "status": "finished",
                "finished_at": BIG,
                "exit_code": BIG,
                "changed_paths_total": BIG,
                "run_result": {
                    "outcome": BIG,
                    "merge": "kept",
                    "final_reply": BIG,
                    "tests": huge_tests,
                },
            },
        )
    reply = service.list_runs(config=cfg, limit=service.LIST_LIMIT)
    assert size(reply) < REPLY_LIMIT_BYTES
    assert reply["total"] == service.LIST_LIMIT + 5
    assert reply["runs"], "the bound keeps runs, it cuts their text first"
    for run in reply["runs"]:
        assert run["exit_code"] is None  # not an int in the stored result
        for value in run.values():
            assert not isinstance(value, str) or len(value) <= 257


def test_list_carries_no_command_output_and_no_test_command_text(cfg, repo):
    write_run(
        cfg.state_dir,
        1,
        {**REQUEST, "test_commands": ["env SECRET_TOKEN=abc123 pytest"]},
        finished(
            outcome="ok",
            merge="merged",
            tests={
                "passed": True,
                "commands": [{"argv": ["pytest"], "exit_code": 0, "output_tail": "TAILTEXT"}],
            },
        ),
    )
    text = json.dumps(service.list_runs(config=cfg))
    assert "TAILTEXT" not in text and "abc123" not in text


# --- runs show ---------------------------------------------------------------------------------


def test_show_gives_the_instruction_and_each_test_commands_result(cfg):
    tests = {
        "passed": False,
        "commands": [
            {"argv": ["qodo-cli", "config", "validate"], "exit_code": 0, "timed_out": False},
            {"argv": ["markdownlint-cli2", "RE VIEW.md"], "exit_code": 1, "timed_out": False},
            {"argv": ["slow"], "exit_code": None, "timed_out": True},
        ],
    }
    run_id = write_run(cfg.state_dir, 1, REQUEST, finished(outcome="ok", merge="kept", tests=tests))
    shown = service.show(run_id, config=cfg)
    assert shown["instruction"] == REQUEST["instruction"]
    assert shown["instruction_truncated"] is False
    assert shown["test_command_count"] == 2
    assert shown["tests"]["results"] == [
        {"command": "qodo-cli config validate", "exit_code": 0, "timed_out": False},
        {"command": "markdownlint-cli2 'RE VIEW.md'", "exit_code": 1, "timed_out": False},
        {"command": "slow", "exit_code": None, "timed_out": True},
    ]
    assert shown["tests"]["commands"] == 3 and shown["tests"]["failed"] == 2


def test_show_never_carries_a_commands_output_or_environment(cfg, monkeypatch):
    monkeypatch.setenv("ASSOCIATE_API_KEY", "sk-very-secret-value")
    tests = {
        "passed": True,
        "commands": [
            {
                "argv": ["pytest"],
                "exit_code": 0,
                "timed_out": False,
                "duration_ms": 5,
                "output_tail": "OUTPUT-TAIL sk-very-secret-value",
                "env": {"ASSOCIATE_API_KEY": "sk-very-secret-value"},
            }
        ],
    }
    run_id = write_run(
        cfg.state_dir, 1, REQUEST, finished(outcome="ok", merge="merged", tests=tests)
    )
    shown = service.show(run_id, config=cfg)
    text = json.dumps(shown)
    assert "OUTPUT-TAIL" not in text and "sk-very-secret-value" not in text
    assert set(shown["tests"]["results"][0]) == {"command", "exit_code", "timed_out"}


def test_show_skips_a_stored_command_that_is_not_an_argv_list(cfg):
    tests = {
        "passed": False,
        "commands": [
            "nonsense",
            {"argv": "a string", "exit_code": 1},
            {"argv": [1, 2], "exit_code": 1},
            {"argv": ["ok"], "exit_code": "zero", "timed_out": "yes"},
        ],
    }
    run_id = write_run(cfg.state_dir, 1, REQUEST, finished(outcome="ok", merge="kept", tests=tests))
    results = service.show(run_id, config=cfg)["tests"]["results"]
    assert results == [{"command": "ok", "exit_code": None, "timed_out": False}]


def test_show_caps_the_number_and_length_of_test_results(cfg):
    tests = {
        "passed": False,
        "commands": [{"argv": ["x" * 5000], "exit_code": 1}] * (service.SHOWN_TEST_RESULTS + 9),
    }
    run_id = write_run(cfg.state_dir, 1, REQUEST, finished(outcome="ok", merge="kept", tests=tests))
    shown = service.show(run_id, config=cfg)
    results = shown["tests"]["results"]
    assert len(results) == service.SHOWN_TEST_RESULTS
    assert all(len(r["command"]) <= service.SHOWN_TEST_COMMAND_CHARS + 1 for r in results)
    assert shown["tests"]["results_truncated"] is True
    assert shown["tests"]["commands"] == service.SHOWN_TEST_RESULTS + 9


def test_show_of_a_long_instruction_says_it_is_cut(cfg):
    run_id = write_run(cfg.state_dir, 1, {**REQUEST, "instruction": "y" * 50_000}, None)
    shown = service.show(run_id, config=cfg)
    assert shown["status"] == "lost"
    assert shown["instruction_truncated"] is True
    assert len(shown["instruction"]) == service.SHOWN_INSTRUCTION_CHARS + 1


def test_show_of_a_running_run_has_the_instruction_and_no_results(cfg, repo):
    started = start(cfg, repo, mode="gate", instruction="Tell the reviewer\nabout codes")
    try:
        shown = service.show(started["run_id"], config=cfg)
        assert shown["status"] == "running"
        assert shown["instruction"] == "Tell the reviewer\nabout codes"
        assert shown["test_command_count"] == 1
        assert "tests" not in shown
    finally:
        release(cfg, started["run_id"])
        wait_done(cfg, started["run_id"])


def test_show_stays_under_64_kib_when_every_new_field_is_huge_too(cfg):
    tests = {
        "passed": False,
        "commands": [{"argv": [BIG, BIG], "exit_code": 1, "timed_out": False}] * 40,
        "error": BIG,
    }
    result = finished(
        outcome=BIG,
        merge="kept",
        merge_reason=BIG,
        worktree=BIG,
        run_branch=BIG,
        final_reply=BIG,
        tests=tests,
    )
    result.update(error=BIG, changed_paths_error=BIG, changed_paths=[BIG] * 100)
    run_id = write_run(cfg.state_dir, 1, {**REQUEST, "instruction": BIG, "checkout": BIG}, result)
    shown = service.show(run_id, config=cfg)
    assert size(shown) < REPLY_LIMIT_BYTES
    assert shown["instruction"]  # cut, never dropped
