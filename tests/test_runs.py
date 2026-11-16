"""The runs module: start a detached ``associate run``, read its result (task t14, claim c41).

Every child here is ``tests/runs_fake_child.py``: no model, no gateway. The real worktree
commit + merge code is exercised by the fake's ``merge`` mode.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from associate.cli import main
from associate.runs import service
from associate.runs.service import REPLY_LIMIT_BYTES, RunsConfig, RunsError

FAKE = Path(__file__).resolve().parent / "runs_fake_child.py"
HOSTILE = 'it\'s "quoted"; rm -rf / $(touch pwned) `id`\nsecond line\t--json -- --model x'


def fake(mode: str) -> list[str]:
    return [sys.executable, str(FAKE), mode]


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def make_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "t")
    git(path, "config", "user.email", "t@example.com")
    git(path, "config", "commit.gpgsign", "false")
    (path / "README").write_text("hi\n", encoding="utf-8")
    git(path, "add", "README")
    git(path, "commit", "-q", "-m", "init")
    # a mutating run's checkout must not be main itself for the fake to merge into a clean main;
    # main checked out here, clean, is what worktree.finish merges into.
    return path


@pytest.fixture
def cfg(tmp_path: Path) -> RunsConfig:
    roots = tmp_path / "roots"
    roots.mkdir()
    return RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))


@pytest.fixture
def repo(cfg: RunsConfig) -> Path:
    return make_repo(cfg.allowed_roots[0] / "repo")


def start(cfg, checkout, mode="plain", instruction="do the thing", **kw):
    return service.start(
        checkout=str(checkout),
        model="worker",
        instruction=instruction,
        test_commands=kw.pop("test_commands", ["true"]),
        config=cfg,
        child_command=kw.pop("child_command", fake(mode)),
        **kw,
    )


def wait_done(cfg, run_id, timeout=60.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        reply = service.show(run_id, config=cfg)
        if reply["status"] != "running":
            return reply
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} still running after {timeout}s")


def release(cfg, run_id):
    (cfg.state_dir / "runs" / run_id / "release").write_text("", encoding="utf-8")


# --- criterion 1: start returns a run id at once; show reports status and the result ---------


def test_start_returns_at_once_while_the_child_runs_then_show_reports_finished(cfg, repo):
    t0 = time.monotonic()
    started = start(cfg, repo, mode="gate")
    assert time.monotonic() - t0 < 10
    assert service.RUN_ID.fullmatch(started["run_id"])
    assert started["status"] == "running"
    running = service.show(started["run_id"], config=cfg)
    assert running["status"] == "running"
    assert running["ok"] is False
    assert running["model"] == "worker"
    release(cfg, started["run_id"])
    done = wait_done(cfg, started["run_id"])
    assert done["status"] == "finished"
    assert done["exit_code"] == 0
    assert done["outcome"] == "ok"
    assert done["merge"] == "not_attempted"
    assert done["ok"] is False  # nothing was merged
    assert done["pushed"] is False


def test_a_merged_run_is_ok_and_reports_base_commit_and_changed_paths(cfg, repo):
    base = git(repo, "rev-parse", "HEAD")
    started = start(cfg, repo, mode="merge")
    done = wait_done(cfg, started["run_id"])
    assert done["status"] == "finished", done
    assert done["outcome"] == "ok"
    assert done["merge"] == "merged"
    assert done["tests"]["passed"] is True
    assert done["base_commit"] == base
    assert done["changed_paths"] == ["added.txt"]
    assert done["changed_paths_truncated"] is False
    assert done["ok"] is True
    assert (repo / "added.txt").is_file()  # merged into the checkout's main
    assert len(json.dumps(done).encode()) < REPLY_LIMIT_BYTES


def test_the_state_lives_outside_the_checkout(cfg, repo):
    started = start(cfg, repo, mode="plain")
    wait_done(cfg, started["run_id"])
    run_dir = cfg.state_dir / "runs" / started["run_id"]
    for name in ("request.json", "supervisor.json", "result.json", "stdout.json", "stderr.log"):
        assert (run_dir / name).is_file(), name
    assert git(repo, "status", "--porcelain") == ""


def test_the_reply_stays_under_64_kib_with_many_changed_paths(cfg, repo):
    started = start(cfg, repo, mode="plain")
    wait_done(cfg, started["run_id"])
    result_path = cfg.state_dir / "runs" / started["run_id"] / "result.json"
    result = json.loads(result_path.read_text())
    result["run_result"].update(merge="merged")
    result["changed_paths"] = [f"dir/{'x' * 400}/{i}é\n.txt" for i in range(20000)]
    result["changed_paths_total"] = 20000
    result["run_result"]["merge_reason"] = "r" * 500000
    result_path.write_text(json.dumps(result))
    reply = service.show(started["run_id"], config=cfg)
    assert len(json.dumps(reply).encode()) < REPLY_LIMIT_BYTES
    assert len(json.dumps(reply, ensure_ascii=False).encode()) < REPLY_LIMIT_BYTES
    assert reply["changed_paths_truncated"] is True
    assert reply["changed_paths_total"] == 20000
    assert 0 < len(reply["changed_paths"]) < 20000


# --- criterion 2: one run per checkout; exit 0 with a refused merge or failing tests fails ----


def test_a_second_start_for_the_same_checkout_is_refused_also_through_a_symlink(cfg, repo):
    first = start(cfg, repo, mode="gate")
    with pytest.raises(RunsError) as err:
        start(cfg, repo, mode="plain")
    assert err.value.kind == "busy"
    assert first["run_id"] in err.value.message
    link = cfg.allowed_roots[0] / "link"
    link.symlink_to(repo)
    with pytest.raises(RunsError) as err:
        start(cfg, link, mode="plain")
    assert err.value.kind == "busy"
    release(cfg, first["run_id"])
    wait_done(cfg, first["run_id"])
    # finished: the lock is free again
    again = start(cfg, link, mode="plain")
    wait_done(cfg, again["run_id"])


def test_a_start_for_a_different_checkout_is_allowed_meanwhile(cfg, repo):
    other = make_repo(cfg.allowed_roots[0] / "other")
    first = start(cfg, repo, mode="gate")
    second = start(cfg, other, mode="plain")
    assert wait_done(cfg, second["run_id"])["status"] == "finished"
    release(cfg, first["run_id"])
    wait_done(cfg, first["run_id"])


def test_exit_0_with_a_refused_merge_is_not_ok(cfg, repo):
    done = wait_done(cfg, start(cfg, repo, mode="refused")["run_id"])
    assert done["status"] == "finished"
    assert done["exit_code"] == 0
    assert done["outcome"] == "ok"
    assert done["tests"]["passed"] is True
    assert done["merge"] == "refused"
    assert "uncommitted" in done["merge_reason"]
    assert done["ok"] is False
    assert done["changed_paths"] == ["added.txt"]
    assert done["base_commit"] == git(repo, "rev-parse", "HEAD")


def test_exit_0_with_failing_tests_is_not_ok(cfg, repo):
    done = wait_done(cfg, start(cfg, repo, mode="tests-fail")["run_id"])
    assert done["status"] == "finished"
    assert done["exit_code"] == 0
    assert done["tests"]["passed"] is False
    assert done["merge"] == "not_attempted"
    assert done["ok"] is False
    assert not (repo / "added.txt").exists()


def test_a_non_zero_exit_is_finished_not_ok_with_the_cli_error(cfg, repo):
    done = wait_done(cfg, start(cfg, repo, mode="exit2")["run_id"])
    assert done["status"] == "finished"
    assert done["exit_code"] == 2
    assert done["ok"] is False
    assert done["outcome"] is None
    assert "pi is not on PATH" in done["error"]


def test_a_child_that_cannot_be_executed_is_failed_to_start(cfg, repo):
    started = start(cfg, repo, child_command=[str(cfg.state_dir / "no-such-program")])
    done = wait_done(cfg, started["run_id"])
    assert done["status"] == "failed-to-start"
    assert done["ok"] is False
    # the lock was released: the next start goes ahead
    wait_done(cfg, start(cfg, repo, mode="plain")["run_id"])


def test_a_crashed_run_reads_lost_and_frees_its_checkout(cfg, repo):
    started = start(cfg, repo, mode="gate")
    run_dir = cfg.state_dir / "runs" / started["run_id"]
    pid = json.loads((run_dir / "supervisor.json").read_text())["pid"]
    deadline = time.monotonic() + 10
    while not (run_dir / "child.json").exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    os.killpg(pid, signal.SIGKILL)  # the supervisor and its child share a new session
    deadline = time.monotonic() + 10
    reply = service.show(started["run_id"], config=cfg)
    while reply["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
        reply = service.show(started["run_id"], config=cfg)
    assert reply["status"] == "lost"
    assert reply["ok"] is False
    # the kernel dropped the dead holders' lock: a new start is accepted
    wait_done(cfg, start(cfg, repo, mode="plain")["run_id"])


def test_the_run_survives_the_starting_process_exiting(cfg, repo):
    code = (
        "import json, sys\n"
        "from pathlib import Path\n"
        "from associate.runs import service\n"
        "cfg = service.RunsConfig(state_dir=Path(sys.argv[1]),\n"
        "    allowed_roots=(Path(sys.argv[2]),))\n"
        "r = service.start(checkout=sys.argv[3], model='worker', instruction='x',\n"
        "    test_commands=['true'], config=cfg,\n"
        "    child_command=[sys.executable, sys.argv[4], 'gate'])\n"
        "print(r['run_id'])\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code, str(cfg.state_dir), str(cfg.allowed_roots[0]), str(repo)]
        + [str(FAKE)],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    run_id = done.stdout.strip()
    assert service.show(run_id, config=cfg)["status"] == "running"
    release(cfg, run_id)
    assert wait_done(cfg, run_id)["status"] == "finished"


# --- untrusted input: argv only, validated checkout, model and run id ------------------------


def test_a_hostile_instruction_reaches_the_child_byte_for_byte_as_one_argument(cfg, repo):
    started = start(cfg, repo, mode="plain", instruction=HOSTILE, test_commands=["pytest -q"])
    wait_done(cfg, started["run_id"])
    argv = json.loads(
        (cfg.state_dir / "runs" / started["run_id"] / "export" / "argv.json").read_text()
    )
    assert argv[-2:] == ["--", HOSTILE]
    assert argv[argv.index("--test-command") + 1] == "pytest -q"
    assert "--untrusted-checkout" in argv
    assert argv[argv.index("--session-id") + 1] == started["run_id"]
    assert not (repo / "pwned").exists()


def test_a_checkout_outside_the_allowlist_is_refused(cfg, tmp_path):
    outside = make_repo(tmp_path / "outside")
    with pytest.raises(RunsError) as err:
        start(cfg, outside)
    assert err.value.kind == "forbidden"


def test_a_symlink_inside_the_allowlist_to_a_checkout_outside_is_refused(cfg, tmp_path):
    outside = make_repo(tmp_path / "outside")
    (cfg.allowed_roots[0] / "sneaky").symlink_to(outside)
    with pytest.raises(RunsError) as err:
        start(cfg, cfg.allowed_roots[0] / "sneaky")
    assert err.value.kind == "forbidden"


def test_an_empty_allowlist_refuses_when_required_and_allows_the_cli_otherwise(tmp_path):
    repo = make_repo(tmp_path / "r")
    cfg = RunsConfig(state_dir=tmp_path / "state", allowed_roots=())
    with pytest.raises(RunsError) as err:
        start(cfg, repo, require_allowlist=True)
    assert err.value.kind == "forbidden"
    wait_done(cfg, start(cfg, repo, mode="plain")["run_id"])


def test_a_directory_that_is_not_a_git_work_tree_is_refused(cfg):
    plain = cfg.allowed_roots[0] / "plain"
    plain.mkdir()
    with pytest.raises(RunsError) as err:
        start(cfg, plain)
    assert err.value.kind == "invalid"


@pytest.mark.parametrize("model", ["", "../x", "worker; id", "Worker", "nope", "super-vl"])
def test_a_bad_model_is_refused(cfg, repo, model):
    checkout, child_command = str(repo), fake("plain")
    with pytest.raises(RunsError) as err:
        service.start(
            checkout=checkout,
            model=model,
            instruction="x",
            test_commands=["true"],
            config=cfg,
            child_command=child_command,
        )
    assert err.value.kind == "invalid"


@pytest.mark.parametrize(
    "kw",
    [
        {"instruction": ""},
        {"instruction": "a\x00b"},
        {"test_commands": []},
        {"test_commands": ["'unclosed"]},
        {"test_commands": [""]},
        {"timeout": 0},
    ],
)
def test_bad_instruction_tests_or_timeout_are_refused(cfg, repo, kw):
    with pytest.raises(RunsError) as err:
        start(cfg, repo, **kw)
    assert err.value.kind == "invalid"
    assert not (cfg.state_dir / "runs").exists() or not any((cfg.state_dir / "runs").iterdir())


@pytest.mark.parametrize("run_id", ["../x", "run-zz", "run-" + "a" * 31, "", "run-A" + "a" * 31])
def test_show_refuses_a_malformed_run_id(cfg, run_id):
    with pytest.raises(RunsError) as err:
        service.show(run_id, config=cfg)
    assert err.value.kind == "invalid"


def test_show_of_an_unknown_run_is_not_found(cfg):
    with pytest.raises(RunsError) as err:
        service.show("run-" + "0" * 32, config=cfg)
    assert err.value.kind == "not_found"


def test_list_names_the_runs(cfg, repo):
    started = start(cfg, repo, mode="plain")
    wait_done(cfg, started["run_id"])
    listed = service.list_runs(config=cfg)
    assert [r["run_id"] for r in listed["runs"]] == [started["run_id"]]
    assert listed["runs"][0]["status"] == "finished"


def test_the_verbs_registry_names_start_show_and_list():
    names = [v.name for v in service.VERBS]
    assert names == ["start", "show", "list"]
    start_verb = service.VERBS[0]
    assert start_verb.http == ("POST", "/runs")
    assert set(start_verb.params["required"]) == {
        "checkout",
        "model",
        "instruction",
        "test_commands",
    }


def test_config_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("ASSOCIATE_RUNS_DIR", str(tmp_path / "s"))
    monkeypatch.setenv("ASSOCIATE_RUNS_ROOTS", f"{tmp_path / 'a'}{os.pathsep}{tmp_path / 'b'}")
    cfg = RunsConfig.from_env()
    assert cfg.state_dir == tmp_path / "s"
    assert cfg.allowed_roots == (tmp_path / "a", tmp_path / "b")
    monkeypatch.delenv("ASSOCIATE_RUNS_DIR")
    monkeypatch.delenv("ASSOCIATE_RUNS_ROOTS")
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "xdg"))
    cfg = RunsConfig.from_env()
    assert cfg.state_dir == tmp_path / "xdg" / "associate" / "runs"
    assert cfg.allowed_roots == ()

    from associate.server.tokenstore import default_token_path

    assert default_token_path() == tmp_path / "xdg" / "associate" / "service_tokens.json"
    monkeypatch.setenv("ASSOCIATE_SERVER_TOKENS", str(tmp_path / "t.json"))
    assert default_token_path() == tmp_path / "t.json"


def test_a_run_does_not_inherit_the_runs_or_server_settings(cfg, repo, monkeypatch):
    monkeypatch.setenv("ASSOCIATE_SERVER_TOKENS", "/secret/path")
    monkeypatch.setenv("ASSOCIATE_SESSION_ID", "leak")
    env = service._child_env(Path("/tree"))
    assert "ASSOCIATE_SERVER_TOKENS" not in env
    assert "ASSOCIATE_SESSION_ID" not in env
    assert env["PYTHONPATH"] == "/tree"


# --- the CLI verbs over the same functions ---------------------------------------------------


@pytest.fixture
def cli_env(cfg, monkeypatch):
    monkeypatch.setenv("ASSOCIATE_RUNS_DIR", str(cfg.state_dir))
    monkeypatch.setenv("ASSOCIATE_RUNS_ROOTS", str(cfg.allowed_roots[0]))
    monkeypatch.setattr(service, "default_child_command", lambda: fake("merge"))
    return cfg


def test_cli_runs_start_and_show(cli_env, repo, capsys):
    rc = main(
        ["runs", "start", "--checkout", str(repo), "--model", "worker"]
        + ["--test-command", "true", "--json", "--", HOSTILE]
    )
    assert rc == 0
    started = json.loads(capsys.readouterr().out)
    assert started["status"] == "running"
    wait_done(cli_env, started["run_id"])
    assert main(["runs", "show", started["run_id"], "--json"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["ok"] is True
    assert shown["merge"] == "merged"
    assert main(["runs", "show", started["run_id"]]) == 0
    assert "ok=True" in capsys.readouterr().out
    assert main(["runs", "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["runs"][0]["run_id"] == started["run_id"]


def test_cli_busy_and_bad_input_exit_1_with_a_structured_error(cli_env, repo, capsys, monkeypatch):
    monkeypatch.setattr(service, "default_child_command", lambda: fake("gate"))
    argv = ["runs", "start", "--checkout", str(repo), "--model", "worker", "--test-command"]
    assert main(argv + ["true", "--json", "go"]) == 0
    run_id = json.loads(capsys.readouterr().out)["run_id"]
    assert main(argv + ["true", "--json", "go"]) == 1
    err = json.loads(capsys.readouterr().err)
    assert run_id in err["message"]
    assert err["remediation"]
    assert main(["runs", "show", "../etc", "--json"]) == 1
    capsys.readouterr()
    assert main(["runs", "show", "run-" + "0" * 32, "--json"]) == 1
    capsys.readouterr()
    release(cli_env, run_id)
    wait_done(cli_env, run_id)


def test_cli_runs_overview_and_explain(capsys):
    assert main(["runs", "overview", "--json"]) == 0
    assert "runs" in capsys.readouterr().out
    for path in (["runs"], ["runs", "start"], ["runs", "show"], ["runs", "list"]):
        assert main(["explain", *path]) == 0
        assert "runs" in capsys.readouterr().out
    assert main(["learn", "--json"]) == 0
    paths = [c["path"] for c in json.loads(capsys.readouterr().out)["commands"]]
    assert ["runs", "start"] in paths
    assert ["runs", "show"] in paths


# --- review fixes -----------------------------------------------------------------------


def test_a_subdirectory_of_a_work_tree_is_refused(cfg, repo):
    sub = repo / "sub"
    sub.mkdir()
    with pytest.raises(RunsError) as err:
        start(cfg, sub)
    assert err.value.kind == "invalid"
    assert "root" in str(err.value)


def test_an_instruction_is_limited_in_bytes_not_characters(cfg, repo):
    wide = "\u20ac" * (service.MAX_INSTRUCTION_BYTES // 3 + 1)  # 3 bytes each
    assert len(wide) < service.MAX_INSTRUCTION_BYTES
    with pytest.raises(RunsError) as err:
        start(cfg, repo, instruction=wide)
    assert err.value.kind == "invalid"


def test_a_clean_run_with_nothing_to_merge_is_ok():
    reply = {}
    service._finished(
        reply,
        {
            "exit_code": 0,
            "run_result": {
                "outcome": "ok",
                "merge": "nothing_to_merge",
                "tests": {"passed": True, "commands": []},
            },
        },
    )
    assert reply["ok"] is True
    assert reply["merge"] == "nothing_to_merge"
    assert reply["changed_paths"] == []


def test_the_reply_is_bounded_even_when_every_text_field_is_huge_and_non_ascii():
    big = "\u20ac" * 500_000
    reply = {}
    service._finished(
        reply,
        {
            "exit_code": 1,
            "error": big,
            "changed_paths_error": big,
            "changed_paths": [big] * 500,
            "run_result": {
                "outcome": big,
                "merge": "kept",
                "merge_reason": big,
                "worktree": big,
                "run_branch": big,
                "final_reply": big,
                "tests": {"passed": False, "commands": [], "error": big},
            },
        },
    )
    assert service._size(reply) < service.REPLY_LIMIT_BYTES
