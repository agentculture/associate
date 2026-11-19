"""The comparison runner (plan task t9).

Every run here is plumbing: the current harness runs with ``--harness stub``
(no pi, no model, no key, no network), and the older harness is either a
fixture package written below or the real pre-#27 commit's own stub. A stub
grade says the wiring works and nothing about any model.

Harness repositories are temporary one-commit copies, so the worktrees the
runner makes land beside them under the temporary directory, never beside this
repository.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from associate.measure import runner as runner_mod
from associate.measure.clone import make_clone
from associate.measure.runner import (
    READING_ANSWER,
    READING_WITH_HANDBACK,
    STATUS_FINISHED,
    STATUS_LAUNCH_FAILED,
    Arm,
    Completed,
    Launch,
    LaunchTimeout,
    RunnerError,
    RunOptions,
    load_records,
    record_path,
    run_comparison,
    subprocess_launcher,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
PRE_PR27 = "a9182d70962ce13ec997ca9fa6d61dc5c55dd206"
MAGIC = "MAGIC-VALUE-1234"
FAKE_KEY = "sk-not-a-real-key-7f3a9c"
GIT_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}
EXPECTED = {
    "schema_version": 1,
    "must_appear": [{"text": MAGIC, "kind": "text"}],
    "must_not_appear": [],
    "one_of": [],
}


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **GIT_ENV},
    ).stdout.strip()


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def commit_all(repo: Path) -> str:
    git(repo, "add", "-A")
    git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture")
    return git(repo, "rev-parse", "HEAD")


def task(task_id: str, commit: str, prompt: str = "What is the magic value?") -> dict:
    return {
        "id": task_id,
        "kind": "find",
        "repository": {"host": "github.com", "owner": "example", "name": "demo"},
        "commit": commit,
        "prompt": prompt,
        "answer": MAGIC,
        "expected": EXPECTED,
    }


def real_launch(launch: Launch) -> Completed:
    done = subprocess.run(
        launch.argv,
        cwd=launch.cwd,
        env=launch.env,
        capture_output=True,
        text=True,
        timeout=launch.timeout_s,
        check=False,
    )
    return Completed(done.returncode, done.stdout, done.stderr)


class Recorder:
    """A fake launcher: runs the launch for real and records every one."""

    def __init__(self, fail_on_run: int | None = None) -> None:
        self.launches: list[Launch] = []
        self.fail_on_run = fail_on_run

    @property
    def runs(self) -> list[Launch]:
        return [launch for launch in self.launches if _is_run(launch)]

    def __call__(self, launch: Launch) -> Completed:
        self.launches.append(launch)
        if _is_run(launch) and self.fail_on_run == len(self.runs):
            raise KeyboardInterrupt  # the runner is killed while this run is going
        return real_launch(launch)


def _is_run(launch: Launch) -> bool:
    return "run" in launch.argv and "--help" not in launch.argv


def _session_key(launch: Launch) -> str:
    """The run's session id without its attempt number: one per task, arm and repeat."""
    session = launch.argv[launch.argv.index("--session-id") + 1]
    return session.rsplit("-a", 1)[0]


@pytest.fixture(scope="session")
def current_harness(tmp_path_factory) -> tuple[Path, str]:
    """A one-commit copy of this repository's HEAD: the 'current' harness."""
    made = make_clone(REPO_ROOT, "HEAD", [], tmp_path_factory.mktemp("current-harness"))
    return made.path, made.head


@pytest.fixture
def demo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "demo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, "README.md", f"{MAGIC}\n")
    write(repo, "docs/accuracy/tasks.json", f'{{"answer": "{MAGIC}"}}\n')
    return repo, commit_all(repo)


OLD_MAIN = """
import argparse, json, sys
from pathlib import Path


def main():
    p = argparse.ArgumentParser(prog="associate")
    sub = p.add_subparsers(dest="verb", required=True)
    r = sub.add_parser("run")
    r.add_argument("prompt", nargs="?")
    r.add_argument("--harness", default="pi")
    r.add_argument("--checkout")
    r.add_argument("--export-root")
    r.add_argument("--session-id")
    r.add_argument("--task-id")
    r.add_argument("--timeout", type=float, default=900.0)
    r.add_argument("--model")
    r.add_argument("--untrusted-checkout", action="store_true")
    r.add_argument("--json", action="store_true")
    a = p.parse_args()
    export = Path(a.export_root) / a.session_id / "export"
    export.mkdir(parents=True)
    entry = {"id": "w1", "ts": "t", "tool": "read", "args": {"path": "README.md"},
             "result": {"content": "x"}, "truncated": False}
    (export / "walk.jsonl").write_text(json.dumps(entry) + "\\n")
    if a.prompt and "TIMEOUT" in a.prompt:
        err = {"code": 2, "message": f"pi did not finish within {a.timeout:g}s",
               "remediation": "raise --timeout"}
        sys.stderr.write(json.dumps(err) + "\\n")
        return 2
    readme = (Path(a.checkout) / "README.md").read_text().strip()
    print(json.dumps({"walk_path": str(export / "walk.jsonl"), "export_dir": str(export),
                      "outcome": "ok", "session_id": a.session_id,
                      "final_reply": "The value is " + readme}))
    return 0


sys.exit(main())
"""


@pytest.fixture
def old_harness(tmp_path: Path) -> tuple[Path, str]:
    """A fixture harness commit shaped like the one before PR #27."""
    repo = tmp_path / "oldharness"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, "associate/__init__.py", "")
    write(repo, "associate/__main__.py", OLD_MAIN)
    write(
        repo,
        "associate/contract/models.json",
        json.dumps({"default": "worker", "models": {"worker": {"reasoning": "on"}}}),
    )
    write(repo, "associate/harness/pi.py", 'PINNED_PI_VERSION = "1.1.0"\n')
    write(repo, ".pi/extensions/associate/index.ts", "// fixture\n")
    return repo, commit_all(repo)


def run(arms, tasks, repeats, results, demo_repo, harness_repo, launcher, **kw):
    """run_comparison on the stub harness with short clocks; **kw are RunOptions fields."""
    pi_version = kw.pop("pi_version", lambda: "1.5.2")
    options = RunOptions(**{"harness": "stub", "timeout_s": 60.0, "grace_s": 60.0, **kw})
    return run_comparison(
        arms,
        tasks,
        repeats,
        results,
        {"demo": demo_repo} if demo_repo else {},
        harness_repo=harness_repo,
        options=options,
        launcher=launcher,
        pi_version=pi_version,
    )


def only(records):
    assert len(records) == 1, f"expected one stored result, found {len(records)}"
    return records[0]


def keys(records):
    return sorted((r["task"]["id"], r["arm"]["name"], r["repeat"]) for r in records)


# --- acceptance 1: one stored result per task, arm and repeat --------------------------


def test_every_task_arm_and_repeat_is_stored_once_naming_its_settings(
    tmp_path, demo, current_harness
):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    arms = [
        Arm("w-off", harness_head, "worker", check_mode="report", reasoning="off"),
        Arm("c-reg", harness_head, "cortex"),
    ]
    tasks = [task("t-one", demo_head), task("t-two", demo_head)]
    launcher = Recorder()
    run(arms, tasks, 2, tmp_path / "results", demo_repo, harness_repo, launcher)

    records = load_records(tmp_path / "results")
    expected_keys = sorted((t["id"], a.name, r) for t in tasks for a in arms for r in (1, 2))
    assert keys(records) == expected_keys
    assert len(launcher.runs) == 8
    for rec in records:
        assert rec["status"] == STATUS_FINISHED
        assert rec["graded"] is True
        assert rec["harness_commit"] == harness_head
        assert rec["model"] == {"w-off": "worker", "c-reg": "cortex"}[rec["arm"]["name"]]
        assert rec["grade"]["verdict"] in ("matches", "does_not_match", "cannot_tell")
        assert rec["clone_head"] == rec["clone"]["head"]
        assert rec["clone"]["removed"] == ["docs/accuracy"]
    by_arm = {r["arm"]["name"]: r for r in records}
    assert by_arm["w-off"]["reasoning"]["requested"] == "off"
    assert by_arm["w-off"]["reasoning"]["effective"] == "off"
    assert by_arm["c-reg"]["reasoning"]["requested"] is None
    assert by_arm["c-reg"]["reasoning"]["source"] == "registry"


def test_current_harness_run_stores_two_labelled_readings(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    arm = Arm("cur", harness_head, "worker", check_mode="report", reasoning="off")
    run([arm], [task("t", demo_head)], 1, tmp_path / "res", demo_repo, harness_repo, Recorder())
    rec = only(load_records(tmp_path / "res"))
    readings = {g["reading"]: g for g in rec["grades"]}
    assert set(readings) == {READING_ANSWER, READING_WITH_HANDBACK}
    assert rec["grade"] == readings[READING_ANSWER]["grade"]
    plus = readings[READING_WITH_HANDBACK]
    # the stub's facts.json values and its verdict text, the model's own strings
    assert plus["handback_strings"] == ["fixture", "_resolve", "validate.py defines _resolve"]
    assert "fixture" in plus["text"]
    assert rec["counts"]["source"] == "result"
    assert rec["counts"]["value"]["report"]["facts"]["made"] == 2


def test_launched_run_comes_from_the_arm_worktree_with_its_own_memory(
    tmp_path, demo, current_harness, monkeypatch
):
    monkeypatch.setenv("ASSOCIATE_API_KEY", FAKE_KEY)
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    launcher = Recorder()
    arm = Arm("cur", harness_head, "worker")
    run([arm], [task("t", demo_head)], 1, tmp_path / "res", demo_repo, harness_repo, launcher)
    launch = only(launcher.runs)
    wt_root = harness_repo.parent / f".worktrees.{harness_repo.name}"
    assert launch.cwd.parent == wt_root
    assert git(launch.cwd, "rev-parse", "HEAD") == harness_head
    assert launch.env["PYTHONPATH"] == str(launch.cwd)
    assert launch.env["ASSOCIATE_EXTENSION_PATH"] == str(
        launch.cwd / ".pi/extensions/associate/index.ts"
    )
    assert launch.env["ASSOCIATE_API_KEY"] == FAKE_KEY  # passed through, never read
    results = tmp_path / "res"
    for name in ("ASSOCIATE_EIDETIC_DIR", "ASSOCIATE_LEDGER_PATH"):
        assert Path(launch.env[name]).is_relative_to(results)
    assert launch.argv[:3] == [sys.executable, "-m", "associate"]
    stored = "".join(p.read_text() for p in (results / "records").rglob("*.json"))
    assert FAKE_KEY not in stored
    assert "env" not in json.loads(stored)["launch"]


def test_the_arm_worktree_is_made_once_and_reused(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    arm = Arm("cur", harness_head, "worker")
    first, second = Recorder(), Recorder()
    run([arm], [task("t", demo_head)], 1, tmp_path / "a", demo_repo, harness_repo, first)
    run([arm], [task("t", demo_head)], 1, tmp_path / "b", demo_repo, harness_repo, second)
    assert len(first.runs) == len(second.runs) == 1
    assert first.runs[0].cwd == second.runs[0].cwd
    listed = git(harness_repo, "worktree", "list", "--porcelain")
    assert listed.count(str(first.runs[0].cwd)) == 1


# --- acceptance 2: a killed runner, restarted ------------------------------------------


def test_a_killed_runner_restarted_stores_one_result_per_key_and_reruns_nothing_finished(
    tmp_path, demo, current_harness
):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    arms = [Arm("a", harness_head, "worker"), Arm("b", harness_head, "worker")]
    tasks = [task("t-one", demo_head), task("t-two", demo_head)]
    results = tmp_path / "results"
    first = Recorder(fail_on_run=3)
    with pytest.raises(KeyboardInterrupt):
        run(arms, tasks, 1, results, demo_repo, harness_repo, first)
    assert len(load_records(results)) == 2
    # a half-written temporary file left by a kill is never read as a result
    stale = record_path(results, "t-two", "b", 1).parent
    stale.mkdir(parents=True, exist_ok=True)
    (stale / ".r1.json.123.tmp").write_text('{"half": ')

    second = Recorder()
    run(arms, tasks, 1, results, demo_repo, harness_repo, second)
    records = load_records(results)
    assert keys(records) == [
        ("t-one", "a", 1),
        ("t-one", "b", 1),
        ("t-two", "a", 1),
        ("t-two", "b", 1),
    ]
    finished_first = {_session_key(x) for x in first.runs[:2]}
    started_second = {_session_key(x) for x in second.runs}
    assert finished_first.isdisjoint(started_second)
    assert len(second.runs) == 2
    interrupted = next(r for r in records if (r["task"]["id"], r["arm"]["name"]) == ("t-two", "a"))
    assert [h["status"] for h in interrupted["history"]] == ["interrupted"]
    assert interrupted["attempt"] == 2


def test_a_run_that_ended_before_the_kill_is_stored_from_its_attempt_not_rerun(
    tmp_path, demo, current_harness, monkeypatch
):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    arm = Arm("a", harness_head, "worker")
    results = tmp_path / "results"
    real_store = runner_mod._store_record

    def killed_while_storing(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(runner_mod, "_store_record", killed_while_storing)
    first = Recorder()
    tasks = [task("t", demo_head)]
    with pytest.raises(KeyboardInterrupt):
        run([arm], tasks, 1, results, demo_repo, harness_repo, first)
    assert len(first.runs) == 1
    assert load_records(results) == []

    monkeypatch.setattr(runner_mod, "_store_record", real_store)
    second = Recorder()
    summary = run([arm], [task("t", demo_head)], 1, results, demo_repo, harness_repo, second)
    assert second.runs == []
    rec = only(load_records(results))
    assert rec["status"] == STATUS_FINISHED
    assert summary.recovered == [("t", "a", 1)]


def test_a_stored_key_with_a_different_arm_definition_is_refused(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    results = tmp_path / "results"
    run(
        [Arm("a", harness_head, "worker")],
        [task("t", demo_head)],
        1,
        results,
        demo_repo,
        harness_repo,
        Recorder(),
    )
    other_arm = [Arm("a", harness_head, "cortex")]
    tasks = [task("t", demo_head)]
    launcher = Recorder()
    with pytest.raises(RunnerError, match="arm"):
        run(other_arm, tasks, 1, results, demo_repo, harness_repo, launcher)


# --- the support-score setting as a measurement arm (decider-score t7) ----------------


def test_an_arm_passes_its_support_score_and_every_record_names_the_setting(
    tmp_path, demo, current_harness
):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    arms = [
        Arm("s-on", harness_head, "worker", reasoning="off", support_score="on"),
        Arm("s-off", harness_head, "worker", reasoning="off", support_score="off"),
        Arm("s-default", harness_head, "worker", reasoning="off"),
    ]
    launcher = Recorder()
    run(arms, [task("t", demo_head)], 2, tmp_path / "res", demo_repo, harness_repo, launcher)

    passed = {}
    for launch in launcher.runs:
        arm_name = _session_key(launch).split("-", 2)[2].rsplit("-r", 1)[0]
        argv = launch.argv
        value = argv[argv.index("--support-score") + 1] if "--support-score" in argv else None
        passed.setdefault(arm_name, set()).add(value)
        assert "ASSOCIATE_SUPPORT_SCORE" not in launch.env
    assert passed == {"s-on": {"on"}, "s-off": {"off"}, "s-default": {None}}

    records = load_records(tmp_path / "res")
    assert len(records) == 6
    named = {"s-on": "on", "s-off": "off", "s-default": "contract default"}
    for rec in records:
        arm_name = rec["arm"]["name"]
        assert rec["status"] == STATUS_FINISHED, rec.get("reason")
        assert rec["support_score"] == named[arm_name]
        requested = rec["settings"]["requested"]["support_score"]
        assert requested == (None if arm_name == "s-default" else named[arm_name])
        assert rec["settings"]["not_applied"] == []
        assert rec["run_result"]["support_score"] == requested
        if arm_name == "s-default":
            assert "support_score" not in rec["arm"]
            assert "support_score" not in rec["settings"]["applied"]
        else:
            assert rec["arm"]["support_score"] == named[arm_name]
            assert rec["settings"]["applied"]["support_score"] == "--support-score"
    # the arms that differ only in the setting ran the same tasks and repeats
    ran = {
        name: sorted((r["task"]["id"], r["repeat"]) for r in records if r["arm"]["name"] == name)
        for name in named
    }
    assert ran["s-on"] == ran["s-off"] == ran["s-default"] == [("t", 1), ("t", 2)]


def _refused_before_any_launch(tmp_path, demo, harness_pair, arms, match, **kw):
    demo_repo, demo_head = demo
    harness_repo, _head = harness_pair
    launcher = Recorder()
    with pytest.raises(RunnerError, match=match) as raised:
        run(
            arms,
            [task("t", demo_head)],
            1,
            tmp_path / "res",
            demo_repo,
            harness_repo,
            launcher,
            **kw,
        )
    assert launcher.runs == []
    assert load_records(tmp_path / "res") == []
    return launcher, str(raised.value)


@pytest.mark.parametrize(
    ("other", "differs"),
    [
        ({"model": "cortex"}, "model"),
        ({"reasoning": "on"}, "reasoning"),
        ({"check_mode": "enforce"}, "check_mode"),
    ],
)
def test_arms_that_differ_in_the_support_score_and_something_else_are_refused(
    tmp_path, demo, current_harness, other, differs
):
    head = current_harness[1]
    base = {"model": "worker", "reasoning": "off", "check_mode": "report"}
    arms = [
        Arm("s-on", head, support_score="on", **base),
        Arm("s-off", head, support_score="off", **{**base, **other}),
    ]
    launcher, message = _refused_before_any_launch(
        tmp_path, demo, current_harness, arms, "support_score"
    )
    assert launcher.launches == [], "refused before a worktree or a probe"
    assert f"arm s-off (off) differs in {differs} " in message
    assert "arm s-on sets support_score to on" in message
    assert "arm s-off sets support_score to off" in message


def test_an_unset_arm_counts_as_a_setting_when_pairing(tmp_path, demo, current_harness):
    head = current_harness[1]
    arms = [Arm("s-on", head, "worker", support_score="on"), Arm("plain", head, "cortex")]
    _launcher, message = _refused_before_any_launch(
        tmp_path, demo, current_harness, arms, "support_score"
    )
    assert "arm plain (contract default) differs in model ('worker', 'cortex')" in message
    assert "arm plain sets" not in message


def test_support_score_arms_on_two_harness_commits_are_refused(
    tmp_path, demo, current_harness, old_harness
):
    """The pairing is on the resolved commit; the two commits here are in two repositories,
    so the problems are computed directly."""
    arms = [
        Arm("s-on", "a" * 40, "worker", support_score="on"),
        Arm("s-off", "b" * 40, "worker", support_score="off"),
    ]
    commits = {"a" * 40: "a" * 40, "b" * 40: "b" * 40}
    problems = runner_mod.support_score_problems(arms, commits, ["t"], 1)
    assert len(problems) == 2
    assert "differs in harness_commit" in problems[0]
    # an abbreviated id and the full one resolve to the same commit: no problem
    arms = [
        Arm("s-on", "a" * 12, "worker", support_score="on"),
        Arm("s-off", "a" * 40, "worker", support_score="off"),
    ]
    commits = {"a" * 12: "a" * 40, "a" * 40: "a" * 40}
    assert runner_mod.support_score_problems(arms, commits, ["t"], 1) == []


def test_pairs_in_several_groups_and_arms_with_one_setting_are_accepted():
    head = "c" * 40
    commits = {head: head}
    four = [
        Arm("w-on", head, "worker", support_score="on"),
        Arm("w-off", head, "worker", support_score="off"),
        Arm("c-on", head, "cortex", support_score="on"),
        Arm("c-default", head, "cortex"),
    ]
    assert runner_mod.support_score_problems(four, commits, ["t1", "t2"], 3) == []
    same = [
        Arm("w", head, "worker", support_score="on"),
        Arm("c", head, "cortex", support_score="on"),
    ]
    assert runner_mod.support_score_problems(same, commits, ["t"], 1) == []
    none = [Arm("w", head, "worker"), Arm("c", head, "cortex", reasoning="on")]
    assert runner_mod.support_score_problems(none, commits, ["t"], 1) == []
    lone = four[:2] + [four[2]]
    problems = runner_mod.support_score_problems(lone, commits, ["t"], 1)
    assert len(problems) == 1
    assert problems[0].startswith("arm c-on sets support_score to on")


def test_an_arm_with_another_support_score_value_is_refused(tmp_path, demo, current_harness):
    arms = [Arm("a", current_harness[1], "worker", support_score="maybe")]
    launcher, message = _refused_before_any_launch(
        tmp_path, demo, current_harness, arms, "support_score must be one of"
    )
    assert launcher.launches == []
    assert "maybe" not in message


def test_a_support_score_arm_on_a_commit_without_the_flag_is_refused(tmp_path, demo, old_harness):
    head = old_harness[1]
    for name, arms in (
        ("lone", [Arm("old-on", head, "worker", support_score="on")]),
        (
            "pair",
            [
                Arm("old-on", head, "worker", support_score="on"),
                Arm("old-off", head, "worker", support_score="off"),
            ],
        ),
    ):
        launcher, message = _refused_before_any_launch(
            tmp_path / name, demo, old_harness, arms, "has no --support-score", harness="pi"
        )
        assert f"harness commit {head[:12]}" in message
        assert all("--support-score" not in launch.argv for launch in launcher.launches)
    # the same commit runs when the arm does not set it, and the record says so
    demo_repo, demo_head = demo
    run(
        [Arm("old", head, "worker")],
        [task("t", demo_head)],
        1,
        tmp_path / "ok",
        demo_repo,
        old_harness[0],
        Recorder(),
        harness="pi",
    )
    rec = only(load_records(tmp_path / "ok"))
    assert rec["status"] == STATUS_FINISHED
    assert rec["support_score"] == "contract default"


def test_a_stored_key_is_refused_when_the_arms_support_score_changed(
    tmp_path, demo, current_harness
):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    results, tasks = tmp_path / "res", [task("t", demo_head)]
    run([Arm("a", harness_head, "worker")], tasks, 1, results, demo_repo, harness_repo, Recorder())
    stored = only(load_records(results))
    assert "support_score" not in stored["arm"], "an unset arm keeps the earlier identity"
    launcher = Recorder()
    with pytest.raises(RunnerError, match="arm"):
        run(
            [Arm("a", harness_head, "worker", support_score="on")],
            tasks,
            1,
            results,
            demo_repo,
            harness_repo,
            launcher,
        )
    assert launcher.runs == []
    # the unchanged arm is skipped, not refused
    summary = run(
        [Arm("a", harness_head, "worker")], tasks, 1, results, demo_repo, harness_repo, Recorder()
    )
    assert summary.skipped == [("t", "a", 1)]


# --- acceptance 3: an older harness commit --------------------------------------------


def test_an_older_harness_commit_run_is_stored_and_graded(tmp_path, demo, old_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = old_harness
    arm = Arm("old", harness_head, "worker", check_mode="report", reasoning="off")
    launcher = Recorder()
    run(
        [arm],
        [task("t", demo_head)],
        1,
        tmp_path / "res",
        demo_repo,
        harness_repo,
        launcher,
        harness="pi",
    )
    rec = only(load_records(tmp_path / "res"))
    launch = only(launcher.runs)
    assert "--reasoning" not in launch.argv
    assert "--check-mode" not in launch.argv
    assert rec["status"] == STATUS_FINISHED
    assert rec["graded"] is True
    assert rec["grade"]["verdict"] == "matches"
    assert [g["reading"] for g in rec["grades"]] == [READING_ANSWER]
    assert rec["harness_commit"] == harness_head
    not_applied = {n["setting"]: n for n in rec["settings"]["not_applied"]}
    assert set(not_applied) == {"reasoning", "check_mode", "pi_version"}
    assert not_applied["reasoning"]["requested"] == "off"
    assert not_applied["reasoning"]["effective"] == "on"  # models.json at that commit
    assert not_applied["pi_version"]["effective"] == "1.5.2"
    assert not_applied["pi_version"]["requested"] == "1.1.0"
    assert rec["reasoning"] == {
        "requested": "off",
        "effective": "on",
        "source": "registry_at_harness_commit",
    }
    assert rec["contamination"]["checked"] is True


def test_an_older_harness_timeout_with_no_stdout_is_stored_with_its_reason(
    tmp_path, demo, old_harness
):
    demo_repo, demo_head = demo
    harness_repo, harness_head = old_harness
    arm = Arm("old", harness_head, "worker")
    run(
        [arm],
        [task("t", demo_head, prompt="TIMEOUT please")],
        1,
        tmp_path / "res",
        demo_repo,
        harness_repo,
        Recorder(),
        harness="pi",
    )
    rec = only(load_records(tmp_path / "res"))
    assert rec["status"] == STATUS_FINISHED
    assert rec["outcome"] == "timeout"
    assert rec["result_source"] == "none"
    assert "no result" in rec["reason"]
    assert rec["grade"]["verdict"] == "cannot_tell"
    assert rec["launch"]["exit_code"] == 2


def test_the_real_pre_pr27_commit_runs_through_the_runner(tmp_path, demo):
    try:
        git(REPO_ROOT, "cat-file", "-e", f"{PRE_PR27}^{{commit}}")
    except subprocess.CalledProcessError:
        pytest.skip(f"commit {PRE_PR27} is not in this clone's object store")
    made = make_clone(REPO_ROOT, PRE_PR27, [], tmp_path / "old-real")
    demo_repo, demo_head = demo
    launcher = Recorder()
    arm = Arm("old", made.head, "worker", check_mode="report", reasoning="off")
    run([arm], [task("t", demo_head)], 1, tmp_path / "res", demo_repo, made.path, launcher)
    rec = only(load_records(tmp_path / "res"))
    launch = only(launcher.runs)
    assert "--reasoning" not in launch.argv
    assert "--check-mode" not in launch.argv
    assert rec["status"] == STATUS_FINISHED, rec.get("reason")
    assert rec["graded"] is True
    assert rec["reasoning"]["effective"] == "on"
    assert {n["setting"] for n in rec["settings"]["not_applied"]} >= {"reasoning", "check_mode"}


# --- acceptance 4: failed launches and the contract ------------------------------------


def test_a_failed_launch_is_stored_with_its_reason_and_not_graded(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    other = task("t-other", demo_head)
    other["repository"] = {"host": "github.com", "owner": "example", "name": "absent"}
    missing_commit = task("t-nocommit", "0" * 40)
    launcher = Recorder()
    summary = run(
        [Arm("a", harness_head, "worker")],
        [other, missing_commit],
        1,
        tmp_path / "res",
        demo_repo,
        harness_repo,
        launcher,
    )
    records = {r["task"]["id"]: r for r in load_records(tmp_path / "res")}
    assert launcher.runs == []
    assert len(summary.failed) == 2
    for rec in records.values():
        assert rec["status"] == STATUS_LAUNCH_FAILED
        assert rec["graded"] is False
        assert rec["grade"] is None
    assert "absent" in records["t-other"]["reason"]
    assert "clone" in records["t-nocommit"]["reason"]


def test_a_launch_past_the_wall_clock_is_a_failed_launch(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness

    def hangs(launch: Launch) -> Completed:
        if _is_run(launch):
            raise LaunchTimeout("killed after 1s")
        return real_launch(launch)

    run(
        [Arm("a", harness_head, "worker")],
        [task("t", demo_head)],
        1,
        tmp_path / "res",
        demo_repo,
        harness_repo,
        hangs,
    )
    rec = only(load_records(tmp_path / "res"))
    assert rec["status"] == STATUS_LAUNCH_FAILED
    assert "wall clock" in rec["reason"]


def test_failed_launches_are_retried_with_history_by_default(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    results = tmp_path / "res"
    arm = Arm("a", harness_head, "worker")
    run([arm], [task("t", demo_head)], 1, results, None, harness_repo, Recorder())
    failed = only(load_records(results))
    assert failed["status"] == STATUS_LAUNCH_FAILED

    retry = Recorder()
    run([arm], [task("t", demo_head)], 1, results, demo_repo, harness_repo, retry)
    rec = only(load_records(results))
    assert len(retry.runs) == 1
    assert rec["status"] == STATUS_FINISHED
    assert [h["status"] for h in rec["history"]] == [STATUS_LAUNCH_FAILED]
    assert rec["history"][0]["reason"] == failed["reason"]


def test_failed_launches_are_kept_when_retry_is_off(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    results = tmp_path / "res"
    arm = Arm("a", harness_head, "worker")
    run([arm], [task("t", demo_head)], 1, results, None, harness_repo, Recorder())
    again = Recorder()
    summary = run(
        [arm],
        [task("t", demo_head)],
        1,
        results,
        demo_repo,
        harness_repo,
        again,
        retry_failed=False,
    )
    assert again.runs == []
    assert summary.skipped == [("t", "a", 1)]
    rec = only(load_records(results))
    assert rec["status"] == STATUS_LAUNCH_FAILED


def _contract_state(repo: Path) -> tuple[str, dict[str, bytes]]:
    status = git(repo, "status", "--porcelain", "--", "associate/contract")
    files = {
        str(p.relative_to(repo)): p.read_bytes()
        for p in sorted((repo / "associate/contract").rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }
    return status, files


def test_no_contract_file_changes_in_a_full_fake_comparison(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    before_repo = _contract_state(REPO_ROOT)
    arms = [
        Arm("w", harness_head, "worker", check_mode="report", reasoning="off"),
        Arm("c", harness_head, "cortex", check_mode="enforce", reasoning="on"),
    ]
    launcher = Recorder()
    run(
        arms,
        [task("t1", demo_head), task("t2", demo_head)],
        2,
        tmp_path / "res",
        demo_repo,
        harness_repo,
        launcher,
    )
    assert len(launcher.runs) == 8
    worktree = launcher.runs[0].cwd
    assert git(worktree, "status", "--porcelain", "--", "associate/contract") == ""
    assert _contract_state(REPO_ROOT) == before_repo
    records = load_records(tmp_path / "res")
    assert len(records) == 8
    assert all(r["harness_tree"]["contract_unchanged"] for r in records)


def test_a_changed_contract_file_in_the_harness_tree_stops_the_comparison(tmp_path, demo):
    demo_repo, demo_head = demo
    # its own harness copy: this test changes a file in the arm's worktree
    made = make_clone(REPO_ROOT, "HEAD", [], tmp_path / "own-harness")
    harness_repo, harness_head = made.path, made.head
    results = tmp_path / "res"

    def edits_contract(launch: Launch) -> Completed:
        done = real_launch(launch)
        if _is_run(launch):
            (launch.cwd / "associate/contract/role.json").write_text("{}\n")
        return done

    arms = [Arm("x", harness_head, "worker")]
    tasks = [task("t1", demo_head), task("t2", demo_head)]
    with pytest.raises(RunnerError, match="contract"):
        run(arms, tasks, 1, results, demo_repo, harness_repo, edits_contract)
    rec = only(load_records(results))
    assert rec["harness_tree"]["contract_unchanged"] is False
    assert "associate/contract/role.json" in rec["harness_tree"]["changed"]


# --- the default launcher --------------------------------------------------------------


def test_subprocess_launcher_returns_output_and_kills_at_its_wall_clock(tmp_path):
    done = subprocess_launcher(
        Launch([sys.executable, "-c", "print('hi')"], tmp_path, dict(os.environ), 30.0)
    )
    assert (done.returncode, done.stdout.strip()) == (0, "hi")
    slow = Launch(
        [sys.executable, "-c", "import time; time.sleep(30)"], tmp_path, dict(os.environ), 0.5
    )
    with pytest.raises(LaunchTimeout):
        subprocess_launcher(slow)


def test_a_second_runner_on_the_same_results_is_refused(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    results = tmp_path / "res"
    arm = Arm("a", harness_head, "worker")
    nested: list[Exception] = []

    def launch_inner(launch: Launch) -> Completed:
        if _is_run(launch) and not nested:
            try:
                run([arm], [task("t", demo_head)], 1, results, demo_repo, harness_repo, real_launch)
            except RunnerError as err:
                nested.append(err)
        return real_launch(launch)

    run([arm], [task("t", demo_head)], 1, results, demo_repo, harness_repo, launch_inner)
    assert nested
    assert "another runner" in str(nested[0])


def _hold_lock(results: Path, kind: int, seconds: float):
    """Hold a flock of *kind* on the runner's lock file from a thread for *seconds*."""
    import fcntl
    import threading

    results.mkdir(parents=True, exist_ok=True)
    fd = os.open(results / runner_mod.LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o644)
    fcntl.flock(fd, kind | fcntl.LOCK_NB)
    timer = threading.Timer(seconds, os.close, [fd])
    timer.start()
    return timer


def test_a_status_probe_holding_a_shared_lock_does_not_fail_a_starting_runner(tmp_path):
    import fcntl

    # What `measure status` did while it looked: a shared lock, held for a moment.
    probe = _hold_lock(tmp_path / "res", fcntl.LOCK_SH, 0.2)
    try:
        with runner_mod._locked(tmp_path / "res"):
            entered = True
    finally:
        probe.join()
    assert entered is True


def test_a_lock_another_runner_keeps_is_still_refused(tmp_path, monkeypatch):
    import fcntl

    monkeypatch.setattr(runner_mod, "LOCK_WAIT_S", 0.3)
    other = _hold_lock(tmp_path / "res", fcntl.LOCK_EX, 1.5)
    waiting = runner_mod._locked(tmp_path / "res")
    try:
        with pytest.raises(RunnerError, match="another runner holds the lock"):
            waiting.__enter__()
    finally:
        other.join()


# --- guards on values read from files ---------------------------------------------------


@pytest.mark.parametrize("commit", ["main", "HEAD", "--upload-pack=x", "abc123", "g" * 40, ""])
def test_an_arm_commit_that_is_not_a_hexadecimal_commit_id_is_refused(
    tmp_path, demo, current_harness, commit
):
    demo_repo, demo_head = demo
    harness_repo, _head = current_harness
    launcher = Recorder()
    arms = [Arm("a", commit, "worker")]
    tasks = [task("t", demo_head)]
    with pytest.raises(RunnerError, match="commit id"):
        run(arms, tasks, 1, tmp_path / "res", demo_repo, harness_repo, launcher)
    assert launcher.launches == []


def test_an_abbreviated_arm_commit_is_resolved_to_the_full_one(tmp_path, demo, current_harness):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    arm = Arm("a", harness_head[:12], "worker")
    run([arm], [task("t", demo_head)], 1, tmp_path / "res", demo_repo, harness_repo, Recorder())
    rec = only(load_records(tmp_path / "res"))
    assert rec["harness_commit"] == harness_head


def _ended_but_not_stored(results, demo, current_harness, monkeypatch):
    """One attempt with plan.json and launch.json and no stored record; returns the rerun."""
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    arm = Arm("a", harness_head, "worker")
    real_store = runner_mod._store_record

    def killed_while_storing(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(runner_mod, "_store_record", killed_while_storing)
    tasks = [task("t", demo_head)]
    launcher = Recorder()
    with pytest.raises(KeyboardInterrupt):
        run([arm], tasks, 1, results, demo_repo, harness_repo, launcher)
    monkeypatch.setattr(runner_mod, "_store_record", real_store)

    def rerun(launcher):
        return run([arm], [task("t", demo_head)], 1, results, demo_repo, harness_repo, launcher)

    return rerun


def _edit_plan(results: Path, **changes) -> None:
    path = results / "work" / "t" / "a" / "r1" / "a1" / "plan.json"
    plan = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps({**plan, **changes}), encoding="utf-8")


def test_a_stored_plan_naming_a_directory_outside_the_harness_worktrees_is_refused(
    tmp_path, demo, current_harness, monkeypatch
):
    results = tmp_path / "results"
    rerun = _ended_but_not_stored(results, demo, current_harness, monkeypatch)
    _edit_plan(results, cwd=str(demo[0]))
    launcher = Recorder()
    with pytest.raises(RunnerError, match="plan.json"):
        rerun(launcher)
    assert load_records(results) == []
    assert launcher.runs == []


def test_a_stored_plan_naming_an_export_root_outside_its_attempt_is_refused(
    tmp_path, demo, current_harness, monkeypatch
):
    results = tmp_path / "results"
    rerun = _ended_but_not_stored(results, demo, current_harness, monkeypatch)
    _edit_plan(results, export_root=str(tmp_path / "elsewhere"))
    launcher = Recorder()
    with pytest.raises(RunnerError, match="plan.json"):
        rerun(launcher)
    assert load_records(results) == []


@pytest.mark.parametrize("session", ["../../../elsewhere", ".hidden", "a/b", ""])
def test_a_stored_plan_with_an_unsafe_session_id_is_refused(
    tmp_path, demo, current_harness, monkeypatch, session
):
    results = tmp_path / "results"
    rerun = _ended_but_not_stored(results, demo, current_harness, monkeypatch)
    _edit_plan(results, session_id=session)
    launcher = Recorder()
    with pytest.raises(RunnerError, match="plan.json"):
        rerun(launcher)
    assert load_records(results) == []


# --- an attempt that ended, restarted under another arm or task -------------------------


def _killed_while_storing(results, demo, current_harness, monkeypatch):
    """One attempt of arm ``a`` (worker) on task ``t`` that ended and was not stored."""
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    real_store = runner_mod._store_record

    def killed_while_storing(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(runner_mod, "_store_record", killed_while_storing)
    arms, tasks = [Arm("a", harness_head, "worker")], [task("t", demo_head)]
    recorder = Recorder()
    with pytest.raises(KeyboardInterrupt):
        run(arms, tasks, 1, results, demo_repo, harness_repo, recorder)
    monkeypatch.setattr(runner_mod, "_store_record", real_store)

    def rerun(arm, the_task, launcher):
        return run([arm], [the_task], 1, results, demo_repo, harness_repo, launcher)

    return rerun


def test_an_ended_attempt_is_not_stored_under_an_arm_edited_since(
    tmp_path, demo, current_harness, monkeypatch
):
    results = tmp_path / "results"
    rerun = _killed_while_storing(results, demo, current_harness, monkeypatch)
    edited, same_task = Arm("a", current_harness[1], "cortex", reasoning="off"), task("t", demo[1])
    launcher = Recorder()
    with pytest.raises(RunnerError, match="plan.json was stored for arm"):
        rerun(edited, same_task, launcher)
    assert load_records(results) == []
    assert launcher.runs == []


def test_an_ended_attempt_is_not_stored_under_a_task_prompt_edited_since(
    tmp_path, demo, current_harness, monkeypatch
):
    results = tmp_path / "results"
    rerun = _killed_while_storing(results, demo, current_harness, monkeypatch)
    same_arm = Arm("a", current_harness[1], "worker")
    edited = task("t", demo[1], prompt="Another question entirely?")
    launcher = Recorder()
    with pytest.raises(RunnerError, match="prompt_sha256 differs"):
        rerun(same_arm, edited, launcher)
    assert load_records(results) == []
    assert launcher.runs == []


def test_an_ended_attempt_whose_plan_carries_no_identity_is_refused_not_stored(
    tmp_path, demo, current_harness, monkeypatch
):
    results = tmp_path / "results"
    rerun = _killed_while_storing(results, demo, current_harness, monkeypatch)
    path = results / "work" / "t" / "a" / "r1" / "a1" / "plan.json"
    plan = json.loads(path.read_text(encoding="utf-8"))
    del plan["identity"]  # a plan written before the identity was kept in it
    path.write_text(json.dumps(plan), encoding="utf-8")
    same_arm, same_task = Arm("a", current_harness[1], "worker"), task("t", demo[1])
    launcher = Recorder()
    with pytest.raises(RunnerError, match="does not say which arm and task"):
        rerun(same_arm, same_task, launcher)
    assert load_records(results) == []
    assert launcher.runs == []


def test_a_result_naming_an_export_outside_the_run_is_a_failed_launch_and_is_not_read(
    tmp_path, demo, current_harness
):
    demo_repo, demo_head = demo
    harness_repo, harness_head = current_harness
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    heading = "## Unchecked: the model's own words, not checked by the harness"
    (elsewhere / "answer.md").write_text(f"{heading}\n\n> {MAGIC}\n", encoding="utf-8")

    def points_elsewhere(launch: Launch) -> Completed:
        done = real_launch(launch)
        if not _is_run(launch):
            return done
        result = {**json.loads(done.stdout), "export_dir": str(elsewhere), "final_reply": ""}
        result.pop("walk_path", None)
        return Completed(done.returncode, json.dumps(result), done.stderr)

    arm = Arm("a", harness_head, "worker")
    results = tmp_path / "res"
    run([arm], [task("t", demo_head)], 1, results, demo_repo, harness_repo, points_elsewhere)
    rec = only(load_records(results))
    assert rec["status"] == STATUS_LAUNCH_FAILED
    assert str(elsewhere) in rec["reason"]
    assert "outside" in rec["reason"]
    assert rec["grade"] is None
    assert rec["graded"] is False
