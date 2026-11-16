"""A run that is starting is never reported lost; a list reads only what it shows.

Review finding 3: ``_launch`` writes ``request.json``, starts the supervisor, then writes
``supervisor.json``; a reader between those writes must see ``running`` (the start window maps
to ``running``, no new status word), while a run whose supervisor never started is reported
``failed-to-start`` once the start grace has passed, and its checkout is free.

Review finding 4: ``runs list`` orders the run directories without opening every run's
``request.json`` and reads only as many as the limit needs.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from associate.runs import service, state
from associate.runs.service import RunsConfig
from tests.test_runs import make_repo, start, wait_done


@pytest.fixture
def cfg(tmp_path: Path) -> RunsConfig:
    roots = tmp_path / "roots"
    roots.mkdir()
    return RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))


@pytest.fixture
def repo(cfg: RunsConfig) -> Path:
    return make_repo(cfg.allowed_roots[0] / "repo")


def _seen(cfg: RunsConfig) -> list[str]:
    """Every status a reader sees right now, through ``show`` and ``list_runs``."""
    statuses = [card["status"] for card in service.list_runs(config=cfg)["runs"]]
    runs = cfg.state_dir / "runs"
    for run in runs.iterdir() if runs.is_dir() else ():
        try:
            statuses.append(service.show(run.name, config=cfg)["status"])
        except service.RunsError as err:  # before request.json exists the run is not yet one
            assert err.kind == "not_found"
    return statuses


# --- finding 3: the start window --------------------------------------------------------------


def test_a_reader_between_any_two_writes_of_a_start_never_sees_lost(cfg, repo, monkeypatch):
    seen: list[str] = []
    real_write = state.atomic_write_json
    real_popen = service.subprocess.Popen

    def write(path, data):
        seen.extend(_seen(cfg))
        real_write(path, data)
        seen.extend(_seen(cfg))

    def popen(*args, **kwargs):
        seen.extend(_seen(cfg))
        proc = real_popen(*args, **kwargs)
        seen.extend(_seen(cfg))
        return proc

    monkeypatch.setattr(state, "atomic_write_json", write)
    monkeypatch.setattr(service.subprocess, "Popen", popen)
    started = start(cfg, repo, mode="plain")
    monkeypatch.undo()
    assert seen, "the reader ran"
    assert "lost" not in seen
    assert set(seen) <= {"running", "finished"}
    assert wait_done(cfg, started["run_id"])["status"] == "finished"


class _Died(BaseException):
    """The starting process dying between ``request.json`` and the supervisor."""


def _start_that_dies(cfg, repo, monkeypatch) -> str:
    real_popen = service.subprocess.Popen

    def popen(argv, *args, **kwargs):
        if "associate.runs.supervisor" in argv:  # git (the checkout checks) still runs
            raise _Died()
        return real_popen(argv, *args, **kwargs)

    monkeypatch.setattr(service.subprocess, "Popen", popen)
    with pytest.raises(_Died):
        start(cfg, repo, mode="plain")
    monkeypatch.undo()
    (run,) = (cfg.state_dir / "runs").iterdir()
    return run.name


def test_within_the_start_grace_a_run_without_a_supervisor_reads_running(cfg, repo, monkeypatch):
    run_id = _start_that_dies(cfg, repo, monkeypatch)
    assert service.show(run_id, config=cfg)["status"] == "running"
    (card,) = service.list_runs(config=cfg)["runs"]
    assert card["status"] == "running"


def test_a_run_whose_supervisor_never_started_is_failed_and_frees_its_checkout(
    cfg, repo, monkeypatch
):
    monkeypatch.setattr(service, "START_GRACE_SECONDS", 0.0)
    run_id = _start_that_dies(cfg, repo, monkeypatch)
    monkeypatch.setattr(service, "START_GRACE_SECONDS", 0.0)
    shown = service.show(run_id, config=cfg)
    assert shown["status"] == "failed-to-start"
    assert shown["ok"] is False
    assert "supervisor" in shown["error"]
    assert "finished_at" in shown
    # the checkout's lock went with the starter: a new start goes ahead
    wait_done(cfg, start(cfg, repo, mode="plain")["run_id"])


def test_a_request_without_a_start_deadline_keeps_the_old_reading(cfg):
    # a run directory with only request.json and no start deadline (written by hand, or by a
    # build before the deadline existed) reads lost, as the crashed-run test expects
    run = cfg.state_dir / "runs" / f"run-{1:032x}"
    run.mkdir(parents=True)
    (run / "request.json").write_text(json.dumps({"run_id": run.name}), "utf-8")
    assert service.show(run.name, config=cfg)["status"] == "lost"


@pytest.mark.parametrize("record", ["supervisor.json", "child.json"])
def test_a_recorded_process_that_is_gone_reads_lost_inside_the_start_grace(cfg, record):
    # the grace covers only a run with no record at all: once a supervisor or child was
    # recorded and is no longer alive, a deadline still in the future does not hide the loss
    run = cfg.state_dir / "runs" / f"run-{3:032x}"
    run.mkdir(parents=True)
    request = {"run_id": run.name, "start_deadline": time.time() + 3600}
    (run / "request.json").write_text(json.dumps(request), "utf-8")
    (run / record).write_text(json.dumps({"pid": 2**22 + 12345}), "utf-8")
    assert service.show(run.name, config=cfg)["status"] == "lost"


@pytest.mark.parametrize("deadline", ["soon", True, None, [1]])
def test_a_start_deadline_that_is_not_a_number_is_ignored(cfg, deadline):
    run = cfg.state_dir / "runs" / f"run-{2:032x}"
    run.mkdir(parents=True)
    request = {"run_id": run.name, "start_deadline": deadline}
    (run / "request.json").write_text(json.dumps(request), "utf-8")
    assert service.show(run.name, config=cfg)["status"] == "lost"


# --- finding 4: the list reads only what it shows ---------------------------------------------


def _write_runs(cfg: RunsConfig, count: int) -> list[str]:
    ids = []
    for n in range(count):
        run_id = f"run-{n:032x}"
        run = cfg.state_dir / "runs" / run_id
        run.mkdir(parents=True)
        request = run / "request.json"
        request.write_text(json.dumps({"run_id": run_id, "instruction": f"task {n}"}), "utf-8")
        result = {"status": "failed-to-start", "finished_at": "x", "error": "x"}
        (run / "result.json").write_text(json.dumps(result), "utf-8")
        stamp = 1_700_000_000 + n  # started one second apart, oldest first
        os.utime(request, (stamp, stamp))
        ids.append(run_id)
    return ids


def test_a_list_of_300_runs_with_limit_20_opens_few_request_files(cfg, monkeypatch):
    ids = _write_runs(cfg, 300)
    opened: list[str] = []
    real_read = state.read_json

    def read(path):
        if Path(path).name == "request.json":
            opened.append(Path(path).parent.name)
        return real_read(path)

    monkeypatch.setattr(state, "read_json", read)
    listed = service.list_runs(config=cfg, limit=20)
    assert len(opened) <= 25, len(opened)
    assert listed["total"] == 300
    assert [r["run_id"] for r in listed["runs"]] == ids[::-1][:20]  # newest first


def test_a_run_whose_request_cannot_be_read_is_skipped_not_shown(cfg):
    ids = _write_runs(cfg, 3)
    (cfg.state_dir / "runs" / ids[2] / "request.json").write_text("{not json", "utf-8")
    listed = service.list_runs(config=cfg, limit=2)
    assert [r["run_id"] for r in listed["runs"]] == [ids[1], ids[0]]


@pytest.mark.parametrize(
    "name", ["runs/not-a-run", "elsewhere/run-" + "0" * 32, "runs/run-" + "0" * 32]
)
def test_the_supervisor_refuses_anything_that_is_not_a_run_directory(tmp_path, name):
    from associate.runs import supervisor

    target = tmp_path / name
    if "elsewhere" in name or "not-a-run" in name:
        target.mkdir(parents=True)  # exists, but is not laid out as a run; the third is missing
    assert supervisor.main([str(target), "-"]) == 2
    assert not (target / "result.json").exists()
