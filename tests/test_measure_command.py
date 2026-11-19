"""``associate measure`` (plan task t11): run, status, report and sample.

Every run here is plumbing: the arms use the stub harness (no pi, no model, no key,
no network). The harness commits come from a one-commit copy of this repository's
HEAD, so the worktrees the runner makes land beside that copy under a temporary
directory and never beside this repository. A stub grade says the wiring works and
nothing about any model.
"""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from associate.cli import main
from associate.cli._commands import measure as measure_mod
from associate.measure import report as report_module
from associate.measure.clone import make_clone
from associate.measure.runner import LOCK_FILE, RunnerError, Summary, load_records, record_path

REPO_ROOT = Path(__file__).resolve().parents[1]
MAGIC = "MAGIC-VALUE-1234"
KEY_TEXT = "ANSWER-KEY-CONTENT-9876"
NOTE_REL = "docs/accuracy/difference-threshold.md"
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


def write(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def commit_all(repo: Path) -> str:
    git(repo, "add", "-A")
    git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture")
    return git(repo, "rev-parse", "HEAD")


def task(task_id: str, commit: str, repo_name: str = "demo") -> dict:
    return {
        "id": task_id,
        "kind": "find",
        "repository": {"host": "github.com", "owner": "example", "name": repo_name},
        "commit": commit,
        "prompt": "What is the magic value?",
        "answer": MAGIC,
        "expected": EXPECTED,
    }


def tasks_file(tmp_path: Path, tasks: list[dict], name: str = "tasks.json") -> Path:
    doc = {"format_version": 1, "tasks": tasks}
    return write(tmp_path, name, json.dumps(doc))


def arms_file(tmp_path: Path, arms: list | dict, name: str = "arms.json") -> Path:
    return write(tmp_path, name, json.dumps(arms))


@pytest.fixture(scope="session")
def current_harness(tmp_path_factory) -> tuple[Path, str]:
    """A one-commit copy of this repository's HEAD: the harness the arms name."""
    made = make_clone(REPO_ROOT, "HEAD", [], tmp_path_factory.mktemp("measure-harness"))
    return made.path, made.head


@pytest.fixture
def demo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "demo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, "README.md", f"{MAGIC}\n")
    write(repo, "docs/accuracy/tasks.json", f'{{"key": "{KEY_TEXT}"}}\n')
    return repo, commit_all(repo)


@pytest.fixture
def note_repo(tmp_path: Path) -> Path:
    """A temporary git repository holding the difference note, committed."""
    repo = tmp_path / "noterepo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, NOTE_REL, "A difference of five graded runs is called a change.\n")
    commit_all(repo)
    return repo


def two_arms(harness_head: str) -> list[dict]:
    return [
        {"name": "arm-a", "harness_commit": harness_head, "model": "worker"},
        {
            "name": "arm-b",
            "harness_commit": harness_head,
            "model": "cortex",
            "check_mode": "report",
            "reasoning": "off",
        },
    ]


class Setup:
    """The files and flags one comparison needs."""

    def __init__(self, tmp_path, demo, current_harness, repeats=2):
        self.tmp = tmp_path
        self.demo_repo, self.demo_head = demo
        self.harness_repo, self.harness_head = current_harness
        self.tasks = tasks_file(
            tmp_path, [task("t-one", self.demo_head), task("t-two", self.demo_head)]
        )
        self.arms = arms_file(tmp_path, two_arms(self.harness_head))
        self.out = tmp_path / "results"
        self.repeats = repeats

    def run_args(self, *extra: str, harness: str = "stub") -> list[str]:
        return [
            "measure",
            "run",
            "--arms",
            str(self.arms),
            "--tasks",
            str(self.tasks),
            "--repeats",
            str(self.repeats),
            "--output-dir",
            str(self.out),
            "--harness",
            harness,
            "--harness-repo",
            str(self.harness_repo),
            "--checkout-of",
            f"demo={self.demo_repo}",
            *extra,
        ]


@pytest.fixture
def setup(tmp_path, demo, current_harness) -> Setup:
    return Setup(tmp_path, demo, current_harness)


@pytest.fixture(scope="module")
def stored(tmp_path_factory, current_harness) -> Setup:
    """One finished stub comparison: two tasks, two arms, two repeats (eight runs)."""
    tmp = tmp_path_factory.mktemp("stored")
    repo = tmp / "demo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, "README.md", f"{MAGIC}\n")
    write(repo, "docs/accuracy/tasks.json", f'{{"key": "{KEY_TEXT}"}}\n')
    made = Setup(tmp, (repo, commit_all(repo)), current_harness)
    assert main(made.run_args("--json")) == 0
    return made


def run_json(capsys, argv: list[str]) -> dict:
    capsys.readouterr()
    rc = main(argv)
    out = capsys.readouterr()
    assert rc == 0, out.err
    return json.loads(out.out)


def error_of(capsys, argv: list[str]) -> tuple[int, str]:
    """The exit code and stderr of a command that is expected to refuse."""
    capsys.readouterr()
    rc = main(argv)
    return rc, capsys.readouterr().err


class FakeRunner:
    """Stands in for run_comparison; records what the command passed it."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, arms, tasks, repeats, results_dir, checkouts, **kw):
        self.calls.append(
            {
                "arms": list(arms),
                "tasks": list(tasks),
                "repeats": repeats,
                "results_dir": Path(results_dir),
                "checkouts": dict(checkouts),
                **kw,
            }
        )
        return Summary()


@pytest.fixture
def fake(monkeypatch) -> FakeRunner:
    runner = FakeRunner()
    monkeypatch.setattr(measure_mod, "run_comparison", runner)
    return runner


# --- acceptance 1: one graded result per task, arm and repeat, from clones with no key --------


def test_stub_run_stores_one_graded_result_per_task_arm_and_repeat(stored, capsys):
    records = load_records(stored.out)
    keys = sorted((r["task"]["id"], r["arm"]["name"], r["repeat"]) for r in records)
    expected = sorted(
        (t, a, r) for t in ("t-one", "t-two") for a in ("arm-a", "arm-b") for r in (1, 2)
    )
    assert keys == expected
    assert len(keys) == 8
    for rec in records:
        assert rec["status"] == "finished"
        assert rec["graded"] is True
        assert rec["grade"]["verdict"] in ("matches", "does_not_match", "cannot_tell")


def test_clones_of_a_stub_run_hold_no_answer_key(stored):
    clone_files = [
        p for p in (stored.out / "work").rglob("*") if p.is_file() and "clones" in p.parts
    ]
    assert clone_files, "the test found no clone files, so it could not show anything"
    assert [p for p in clone_files if "accuracy" in p.parts] == []
    holding_key = [p for p in clone_files if KEY_TEXT in p.read_text(errors="replace")]
    assert holding_key == []
    assert any(p.name == "README.md" for p in clone_files)


def test_stub_run_output_is_labelled_plumbing_only(setup, capsys):
    payload = run_json(capsys, setup.run_args("--json"))
    assert payload["plumbing_only"] is True
    assert payload["expected_runs"] == 8
    assert payload["stored"] == {"finished": 8, "launch_failed": 0}


def test_stub_run_text_says_plumbing_only(setup, capsys):
    capsys.readouterr()
    rc = main(setup.run_args())
    out = capsys.readouterr()
    assert rc == 0, out.err
    assert "plumbing only" in (out.out + out.err).lower()


# --- acceptance 2: no run without the committed difference note ---------------------------------


def pi_args(setup, note: Path | None) -> list[str]:
    extra = ["--difference-note", str(note)] if note is not None else []
    return setup.run_args(*extra, harness="pi")


def test_default_note_path_is_the_one_the_plan_names():
    assert measure_mod.DIFFERENCE_NOTE.as_posix().endswith(NOTE_REL)


def test_run_refuses_without_the_note_and_names_its_path(setup, fake, note_repo, capsys):
    missing = note_repo / "docs" / "accuracy" / "no-such-note.md"
    rc, err = error_of(capsys, pi_args(setup, missing))
    assert rc == 1
    assert "no-such-note.md" in err
    assert "hint:" in err
    assert fake.calls == []


def test_run_refuses_a_note_that_is_not_tracked_by_git(setup, fake, note_repo, capsys):
    loose = write(note_repo, "docs/accuracy/loose-note.md", "not added\n")
    rc, err = error_of(capsys, pi_args(setup, loose))
    assert rc == 1
    assert "loose-note.md" in err
    assert "committed" in err
    assert fake.calls == []


def test_run_refuses_a_note_with_uncommitted_changes(setup, fake, note_repo, capsys):
    note = write(note_repo, NOTE_REL, "edited after the commit\n")
    rc, err = error_of(capsys, pi_args(setup, note))
    assert rc == 1
    assert "difference-threshold.md" in err
    assert "committed" in err
    assert fake.calls == []


def test_run_accepts_the_committed_unmodified_note(setup, fake, note_repo, capsys):
    capsys.readouterr()
    rc = main(pi_args(setup, note_repo / NOTE_REL))
    assert rc == 0, capsys.readouterr().err
    assert len(fake.calls) == 1
    assert fake.calls[0]["options"].harness == "pi"


def test_stub_run_needs_no_note(setup, fake, note_repo, capsys):
    missing = note_repo / "docs" / "accuracy" / "no-such-note.md"
    capsys.readouterr()
    rc = main(setup.run_args("--difference-note", str(missing)))
    assert rc == 0, capsys.readouterr().err
    assert fake.calls[0]["options"].harness == "stub"


def test_refusal_to_run_is_checked_before_a_detached_child_is_started(
    setup, note_repo, monkeypatch, capsys
):
    started = []
    monkeypatch.setattr(measure_mod, "Popen", lambda *a, **k: started.append(a))
    missing = note_repo / "docs" / "accuracy" / "no-such-note.md"
    rc, err = error_of(capsys, [*pi_args(setup, missing), "--detach"])
    assert rc == 1
    assert "no-such-note.md" in err
    assert started == []


# --- acceptance 3: report -------------------------------------------------------------------


def hand_counts(records: list[dict], arm: str) -> dict[str, int]:
    """What the test knows it stored, counted by hand from the stored verdicts."""
    mine = [r for r in records if r["arm"]["name"] == arm]
    counts = {"runs": len(mine), "matches": 0, "does_not_match": 0, "cannot_tell": 0}
    for rec in mine:
        counts[rec["grade"]["verdict"]] += 1
    return counts


def test_report_json_counts_match_what_was_stored(stored, capsys):
    records = load_records(stored.out)
    payload = run_json(capsys, ["measure", "report", str(stored.out), "--json"])
    assert payload["plumbing_only"] is True
    assert payload["reading"] == "answer_text"
    assert sorted(payload["arms"]) == ["arm-a", "arm-b"]
    for arm in ("arm-a", "arm-b"):
        want = hand_counts(records, arm)
        got = payload["arms"][arm]["total"]
        assert got["runs"] == want["runs"] == 4
        assert got["matching"] == want["matches"]
        assert got["not_matching"] == want["does_not_match"]
        assert got["cannot_tell"] == want["cannot_tell"]
        assert sorted(payload["arms"][arm]["tasks"]) == ["t-one", "t-two"]
        assert payload["arms"][arm]["tasks"]["t-one"]["runs"] == 2


def test_report_text_prints_the_table_for_stored_results(stored, capsys):
    capsys.readouterr()
    rc = main(["measure", "report", str(stored.out)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Comparison of stored runs" in out
    assert "Reading shown: answer_text" in out
    assert "Task: t-one" in out
    assert "Task: t-two" in out
    assert "arm-a" in out
    assert "arm-b" in out
    assert "plumbing only" in out.lower()
    assert "accuracy" not in out.lower()


def test_report_reading_option_chooses_the_second_reading(stored, capsys):
    reading = "answer_text_plus_handback_values"
    capsys.readouterr()
    main(["measure", "report", str(stored.out), "--reading", reading])
    assert f"Reading shown: {reading}" in capsys.readouterr().out
    payload = run_json(
        capsys, ["measure", "report", str(stored.out), "--reading", reading, "--json"]
    )
    assert payload["reading"] == reading


def test_report_refuses_an_unknown_reading(stored, capsys):
    capsys.readouterr()
    with pytest.raises(SystemExit) as exc:
        main(["measure", "report", str(stored.out), "--reading", "bogus"])
    assert exc.value.code == 1
    assert "bogus" in capsys.readouterr().err


def test_report_without_stored_results_is_a_user_error(tmp_path, capsys):
    rc, err = error_of(capsys, ["measure", "report", str(tmp_path / "nothing-here")])
    assert rc == 1
    assert "no stored results" in err
    assert "hint:" in err


# --- sample ---------------------------------------------------------------------------------


def test_sample_writes_a_blank_sheet_for_the_stored_runs(stored, tmp_path, capsys):
    sheet = tmp_path / "sheet.json"
    payload = run_json(
        capsys, ["measure", "sample", str(stored.out), "--sheet", str(sheet), "--json"]
    )
    doc = json.loads(sheet.read_text(encoding="utf-8"))
    assert len(doc["entries"]) == 8
    assert {e["hand_grade"] for e in doc["entries"]} == {None}
    assert "grade" not in doc["entries"][0]
    assert payload["sheet"] == str(sheet)
    assert payload["drawn"] == 8
    assert payload["short"] is True
    assert "short" in payload["message"]


def test_sample_text_says_where_the_sheet_is(stored, tmp_path, capsys):
    sheet = tmp_path / "sheet-text.json"
    capsys.readouterr()
    rc = main(["measure", "sample", str(stored.out), "--sheet", str(sheet), "--size", "3"])
    out = capsys.readouterr().out
    assert rc == 0
    assert str(sheet) in out
    assert len(json.loads(sheet.read_text(encoding="utf-8"))["entries"]) == 3


def test_sample_refuses_to_overwrite_a_sheet_that_may_hold_hand_grades(stored, tmp_path, capsys):
    sheet = write(tmp_path, "graded.json", '{"entries": []}')
    rc, err = error_of(capsys, ["measure", "sample", str(stored.out), "--sheet", str(sheet)])
    assert rc == 1
    assert "graded.json" in err
    assert sheet.read_text(encoding="utf-8") == '{"entries": []}'
    capsys.readouterr()
    assert main(["measure", "sample", str(stored.out), "--sheet", str(sheet), "--overwrite"]) == 0


def test_sample_reading_option_is_passed_on(stored, tmp_path, capsys):
    sheet = tmp_path / "sheet-reading.json"
    reading = "answer_text_plus_handback_values"
    capsys.readouterr()
    assert (
        main(["measure", "sample", str(stored.out), "--sheet", str(sheet), "--reading", reading])
        == 0
    )
    assert json.loads(sheet.read_text(encoding="utf-8"))["reading"] == reading


# --- agreement ------------------------------------------------------------------------------

OTHER_VERDICT = {"matches": "does_not_match", "does_not_match": "matches", "cannot_tell": "matches"}


def synthetic_records(count: int) -> list[dict]:
    """Finished, graded stored runs t000.., one arm, repeats 0-2, alternating verdicts."""
    return [
        {
            "task": {"id": f"t{i:03d}"},
            "arm": {"name": "a"},
            "repeat": i % 3,
            "status": "finished",
            "graded": True,
            "grade": {"verdict": "matches" if i % 2 else "does_not_match"},
            "answer": {"text": f"answer {i}"},
        }
        for i in range(count)
    ]


def draw_filled_sheet(
    tmp_path: Path, records: list[dict], flips: int = 0, blanks: int = 0, size: int = 48
) -> tuple[Path, list[report_module.SampledRun]]:
    """Write a sheet for ``records`` with every hand grade equal to the grader's, then change
    the first ``flips`` of them and clear the next ``blanks``."""
    sample = report_module.draw_sample(records, 7, size)
    sheet = tmp_path / "filled.json"
    report_module.write_blank_sheet(sample, sheet)
    doc = json.loads(sheet.read_text(encoding="utf-8"))
    for index, (entry, run) in enumerate(zip(doc["entries"], sample.runs, strict=True)):
        if index < flips:
            entry["hand_grade"] = OTHER_VERDICT[run.grade]
        elif index < flips + blanks:
            entry["hand_grade"] = None
        else:
            entry["hand_grade"] = run.grade
    sheet.write_text(json.dumps(doc), encoding="utf-8")
    return sheet, sample.runs


@pytest.fixture
def synthetic(monkeypatch):
    """Serve synthetic stored records to the measure verbs (the directory is not read)."""

    def serve(records: list[dict]) -> None:
        monkeypatch.setattr(measure_mod, "_stored_records", lambda results: (records, None))

    return serve


def agreement(capsys, tmp_path: Path, sheet: Path) -> dict:
    return run_json(
        capsys, ["measure", "agreement", str(tmp_path), "--sheet", str(sheet), "--json"]
    )


def test_agreement_equals_a_hand_count_of_a_filled_sheet(synthetic, tmp_path, capsys):
    records = synthetic_records(60)
    synthetic(records)
    sheet, runs = draw_filled_sheet(tmp_path, records, flips=3, size=20)
    # hand count: 20 sampled, the first 3 changed by hand, so 17 agree and 3 disagree
    payload = agreement(capsys, tmp_path, sheet)
    assert payload["sampled"] == 20
    assert payload["hand_graded"] == 20
    assert payload["agreed"] == 17
    assert payload["disagreed"] == 3
    assert payload["disagreements"] == [list(run.key) for run in runs[:3]]
    assert payload["share"] == pytest.approx(17 / 20)
    assert payload["missing"] == []
    assert payload["invalid"] == []
    assert payload["extra"] == []


def test_agreement_json_has_the_documented_keys(synthetic, tmp_path, capsys):
    records = synthetic_records(60)
    synthetic(records)
    sheet, _ = draw_filled_sheet(tmp_path, records, size=10)
    payload = agreement(capsys, tmp_path, sheet)
    assert set(payload) == {
        "sheet",
        "seed",
        "reading",
        "sampled",
        "hand_graded",
        "agreed",
        "disagreed",
        "missing",
        "invalid",
        "extra",
        "disagreements",
        "share",
        "conditions",
        "note",
    }
    assert set(payload["conditions"]) == {"enough_hand_graded", "enough_agreement"}
    assert payload["seed"] == 7


def test_agreement_counts_a_missing_hand_grade_as_neither_agreed_nor_graded(
    synthetic, tmp_path, capsys
):
    records = synthetic_records(60)
    synthetic(records)
    sheet, runs = draw_filled_sheet(tmp_path, records, blanks=2, size=10)
    payload = agreement(capsys, tmp_path, sheet)
    assert payload["hand_graded"] == 8
    assert payload["agreed"] == 8
    assert payload["missing"] == [list(run.key) for run in runs[:2]]
    assert payload["share"] == 1.0


def test_agreement_share_is_null_when_nothing_is_hand_graded(synthetic, tmp_path, capsys):
    records = synthetic_records(60)
    synthetic(records)
    sheet, _ = draw_filled_sheet(tmp_path, records, blanks=5, size=5)
    payload = agreement(capsys, tmp_path, sheet)
    assert payload["hand_graded"] == 0
    assert payload["share"] is None
    assert payload["conditions"]["enough_agreement"]["met"] is False


def test_agreement_refuses_when_the_stored_results_changed_since_the_draw(
    synthetic, tmp_path, capsys
):
    records = synthetic_records(48)
    synthetic(records)
    sheet, _ = draw_filled_sheet(tmp_path, records, size=48)
    before = sheet.read_text(encoding="utf-8")
    changed = synthetic_records(48)
    changed[-1]["task"]["id"] = "t999"
    synthetic(changed)
    rc, err = error_of(
        capsys, ["measure", "agreement", str(tmp_path), "--sheet", str(sheet), "--json"]
    )
    assert rc == 1
    assert "changed" in err
    assert "remediation" in err
    assert sheet.read_text(encoding="utf-8") == before


def test_agreement_refuses_a_missing_sheet(synthetic, tmp_path, capsys):
    synthetic(synthetic_records(5))
    rc, err = error_of(
        capsys, ["measure", "agreement", str(tmp_path), "--sheet", str(tmp_path / "none.json")]
    )
    assert rc == 1
    assert "none.json" in err
    assert "hint:" in err


@pytest.mark.parametrize(
    "text",
    ["not json", "[1, 2]", '{"seed": 1, "reading": "answer_text"}', '{"entries": []}'],
)
def test_agreement_refuses_a_sheet_that_is_not_a_sheet(synthetic, tmp_path, capsys, text):
    synthetic(synthetic_records(5))
    sheet = write(tmp_path, "bad.json", text)
    rc, err = error_of(capsys, ["measure", "agreement", str(tmp_path), "--sheet", str(sheet)])
    assert rc == 1
    assert "bad.json" in err


def conditions_for(synthetic, tmp_path, capsys, count: int, flips: int) -> dict:
    records = synthetic_records(count)
    synthetic(records)
    sheet, _ = draw_filled_sheet(tmp_path, records, flips=flips, size=count)
    return agreement(capsys, tmp_path, sheet)["conditions"]


def test_both_conditions_are_met_at_48_runs_and_95_percent(synthetic, tmp_path, capsys):
    # 60 graded, 48 sampled; 2 disagree: 46 of 48 is 95.83 percent
    found = conditions_for(synthetic, tmp_path, capsys, 48, flips=2)
    assert found["enough_hand_graded"] == {"required": 48, "actual": 48, "met": True}
    assert found["enough_agreement"]["met"] is True
    assert found["enough_agreement"]["agreed"] == 46
    assert found["enough_agreement"]["hand_graded"] == 48
    assert found["enough_agreement"]["required_percent"] == 95


def test_a_share_just_under_95_percent_is_not_met(synthetic, tmp_path, capsys):
    # 94 of 100 agree is 94 percent; 95 of 100 is the line itself
    under = conditions_for(synthetic, tmp_path, capsys, 100, flips=6)
    assert under["enough_hand_graded"]["met"] is True
    assert under["enough_agreement"]["met"] is False
    assert under["enough_agreement"]["agreed"] == 94


def test_exactly_95_percent_is_met(synthetic, tmp_path, capsys):
    found = conditions_for(synthetic, tmp_path, capsys, 100, flips=5)
    assert found["enough_agreement"]["met"] is True


def test_fewer_than_48_hand_graded_runs_is_not_met_however_high_the_share(
    synthetic, tmp_path, capsys
):
    found = conditions_for(synthetic, tmp_path, capsys, 47, flips=0)
    assert found["enough_hand_graded"] == {"required": 48, "actual": 47, "met": False}
    assert found["enough_agreement"]["met"] is True


def test_agreement_text_states_each_condition_and_never_rounds_up(synthetic, tmp_path, capsys):
    records = synthetic_records(1000)
    synthetic(records)
    # 1000 runs sampled, 51 changed: 949 of 1000 agree, 94.9 percent
    sheet, _ = draw_filled_sheet(tmp_path, records, flips=51, size=1000)
    capsys.readouterr()
    rc = main(["measure", "agreement", str(tmp_path), "--sheet", str(sheet)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "agree: 949 of 1000 hand-graded runs" in out
    assert "at least 48 hand-graded runs: met (1000)" in out
    assert "agreement on at least 95%: not met (949 of 1000, 94.9%)" in out
    assert "95.0%" not in out
    assert "accuracy" not in out.lower()


def test_agreement_reads_only(synthetic, tmp_path, capsys):
    records = synthetic_records(60)
    synthetic(records)
    sheet, _ = draw_filled_sheet(tmp_path, records, flips=1, size=10)
    before = tree_state(tmp_path)
    agreement(capsys, tmp_path, sheet)
    assert tree_state(tmp_path) == before


def test_agreement_on_real_stored_results_with_a_sheet_from_sample(stored, tmp_path, capsys):
    sheet = tmp_path / "real.json"
    assert main(["measure", "sample", str(stored.out), "--sheet", str(sheet)]) == 0
    payload = run_json(
        capsys, ["measure", "agreement", str(stored.out), "--sheet", str(sheet), "--json"]
    )
    assert payload["sampled"] == 8
    assert len(payload["missing"]) == 8
    assert payload["hand_graded"] == 0


# --- the arms file and the task filter ---------------------------------------------------------


def run_with_arms(setup, capsys, arms) -> tuple[int, str]:
    setup.arms = arms_file(setup.tmp, arms)
    return error_of(capsys, setup.run_args())


def test_arms_file_with_an_unknown_key_is_refused_with_the_reason(setup, fake, capsys):
    arms = two_arms(setup.harness_head)
    arms[0]["colour"] = "red"
    rc, err = run_with_arms(setup, capsys, arms)
    assert rc == 1
    assert "colour" in err
    assert "arm-a" in err
    assert fake.calls == []


def test_arms_file_with_a_duplicate_name_is_refused(setup, fake, capsys):
    arms = two_arms(setup.harness_head)
    arms[1]["name"] = "arm-a"
    rc, err = run_with_arms(setup, capsys, arms)
    assert rc == 1
    assert "duplicate" in err
    assert "arm-a" in err
    assert fake.calls == []


@pytest.mark.parametrize("commit", ["main", "HEAD", "-x", "abc123", "z" * 40])
def test_arms_file_with_a_commit_that_is_not_a_hexadecimal_id_is_refused(
    setup, fake, capsys, commit
):
    arms = two_arms(setup.harness_head)
    arms[0]["harness_commit"] = commit
    rc, err = run_with_arms(setup, capsys, arms)
    assert rc == 1
    assert "harness_commit" in err
    assert "arm-a" in err
    assert "hexadecimal" in err
    assert fake.calls == []


def test_arms_file_missing_a_required_key_is_refused(setup, fake, capsys):
    arms = two_arms(setup.harness_head)
    del arms[0]["model"]
    rc, err = run_with_arms(setup, capsys, arms)
    assert rc == 1
    assert "model" in err


def test_arms_file_that_is_not_a_list_is_refused(setup, fake, capsys):
    rc, err = run_with_arms(setup, capsys, {"arms": []})
    assert rc == 1
    assert "list" in err


def test_arms_file_that_is_not_json_is_refused(setup, fake, capsys):
    write(setup.tmp, "arms.json", "{not json")
    rc, err = error_of(capsys, setup.run_args())
    assert rc == 1
    assert "arms.json" in err


def test_arms_file_values_reach_the_runner(setup, fake, capsys):
    capsys.readouterr()
    assert main(setup.run_args()) == 0
    arms = fake.calls[0]["arms"]
    assert [a.name for a in arms] == ["arm-a", "arm-b"]
    assert arms[1].check_mode == "report"
    assert arms[1].reasoning == "off"
    assert arms[0].check_mode is None
    assert fake.calls[0]["repeats"] == 2


def test_tasks_filter_runs_only_the_named_tasks(setup, fake, capsys):
    capsys.readouterr()
    assert main(setup.run_args("--tasks-filter", "t-two")) == 0
    assert [t["id"] for t in fake.calls[0]["tasks"]] == ["t-two"]


def test_tasks_filter_naming_an_unknown_task_is_refused(setup, fake, capsys):
    rc, err = error_of(capsys, setup.run_args("--tasks-filter", "t-none"))
    assert rc == 1
    assert "t-none" in err
    assert fake.calls == []


def test_repeats_below_one_are_refused(setup, fake, capsys):
    setup.repeats = 0
    rc, err = error_of(capsys, setup.run_args())
    assert rc == 1
    assert "repeats" in err


def test_repeats_above_the_limit_are_refused(setup, fake, capsys):
    setup.repeats = measure_mod.MAX_REPEATS + 1
    rc, err = error_of(capsys, setup.run_args())
    assert rc == 1
    assert "repeats" in err
    assert str(measure_mod.MAX_REPEATS) in err
    assert fake.calls == []


def test_repeats_at_the_limit_are_accepted(setup, fake, capsys):
    setup.repeats = measure_mod.MAX_REPEATS
    capsys.readouterr()
    assert main(setup.run_args()) == 0
    assert fake.calls[0]["repeats"] == measure_mod.MAX_REPEATS


# --- timeout ----------------------------------------------------------------------------


def test_timeout_defaults_to_3600_seconds(setup, fake, capsys):
    capsys.readouterr()
    assert main(setup.run_args()) == 0
    assert fake.calls[0]["options"].timeout_s == 3600


def test_timeout_option_is_passed_to_the_runner(setup, fake, capsys):
    capsys.readouterr()
    assert main(setup.run_args("--timeout", "90")) == 0
    assert fake.calls[0]["options"].timeout_s == 90


@pytest.mark.parametrize("value", ["0", "-5", "nan"])
def test_timeout_of_zero_or_less_is_a_user_error(setup, fake, capsys, value):
    rc, err = error_of(capsys, setup.run_args(f"--timeout={value}"))
    assert rc == 1
    assert "timeout" in err
    assert fake.calls == []


# --- checkouts --------------------------------------------------------------------------


def test_explicit_checkout_flags_are_passed_to_the_runner(setup, fake, tmp_path, capsys):
    other = tmp_path / "elsewhere"
    other.mkdir()
    capsys.readouterr()
    assert main(setup.run_args("--checkout-of", f"other={other}")) == 0
    assert fake.calls[0]["checkouts"]["demo"] == setup.demo_repo
    assert fake.calls[0]["checkouts"]["other"] == other


@pytest.mark.parametrize("value", ["no-equals-sign", "=path", "name="])
def test_malformed_checkout_flag_is_refused(setup, fake, capsys, value):
    rc, err = error_of(capsys, setup.run_args("--checkout-of", value))
    assert rc == 1
    assert "--checkout-of" in err


def test_checkout_flag_for_a_missing_directory_is_refused(setup, fake, tmp_path, capsys):
    rc, err = error_of(capsys, setup.run_args("--checkout-of", f"x={tmp_path / 'nope'}"))
    assert rc == 1
    assert "nope" in err


def test_resolve_checkouts_defaults_beside_the_main_checkout_and_to_this_repository(tmp_path):
    main_repo = tmp_path / "associate"
    main_repo.mkdir()
    (tmp_path / "workledger-cli").mkdir()
    found, missing = measure_mod.resolve_checkouts(
        ["associate", "workledger-cli", "coherence-cli"],
        {},
        this_repo=main_repo,
        beside=tmp_path,
    )
    assert found == {"associate": main_repo, "workledger-cli": tmp_path / "workledger-cli"}
    assert missing == ["coherence-cli"]


def test_resolve_checkouts_prefers_the_explicit_mapping(tmp_path):
    explicit = tmp_path / "mine"
    explicit.mkdir()
    (tmp_path / "workledger-cli").mkdir()
    found, missing = measure_mod.resolve_checkouts(
        ["workledger-cli"],
        {"workledger-cli": explicit},
        this_repo=tmp_path / "associate",
        beside=tmp_path,
    )
    assert found == {"workledger-cli": explicit}
    assert missing == []


def test_main_checkout_of_a_worktree_is_the_repository_it_belongs_to(tmp_path):
    repo = tmp_path / "primary"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, "a.txt", "a\n")
    commit_all(repo)
    linked = tmp_path / "linked-worktree"
    git(repo, "worktree", "add", "-q", str(linked), "-b", "side")
    assert measure_mod.main_checkout(linked) == repo.resolve()
    assert measure_mod.main_checkout(repo) == repo.resolve()


def test_a_repository_with_no_checkout_is_stored_as_failed_launches_not_refused(
    setup, tmp_path, capsys
):
    commit = setup.demo_head
    setup.tasks = tasks_file(tmp_path, [task("t-ghost", commit, repo_name="ghost-repo-xyz")])
    argv = [a for a in setup.run_args("--json") if not a.startswith("demo=")]
    argv.remove("--checkout-of")
    capsys.readouterr()
    rc = main(argv)
    out = capsys.readouterr()
    assert rc == 0, out.err
    payload = json.loads(out.out)
    assert payload["missing_checkouts"] == ["ghost-repo-xyz"]
    assert payload["stored"] == {"finished": 0, "launch_failed": 4}
    assert "ghost-repo-xyz" in out.err
    assert "failed launch" in out.err
    records = load_records(setup.out)
    assert len(records) == 4
    assert {r["status"] for r in records} == {"launch_failed"}
    assert all("checkout" in r["reason"] for r in records)


# --- status -----------------------------------------------------------------------------


def tree_state(root: Path) -> list[tuple[str, int, float]]:
    return sorted(
        (str(p.relative_to(root)), p.stat().st_size, p.stat().st_mtime)
        for p in root.rglob("*")
        if p.is_file()
    )


def test_status_counts_what_is_stored_and_reads_only(stored, capsys):
    before = tree_state(stored.out)
    payload = run_json(capsys, ["measure", "status", str(stored.out), "--json"])
    assert tree_state(stored.out) == before
    assert payload["expected_runs"] == 8
    assert payload["finished"] == 8
    assert payload["launch_failed"] == 0
    assert payload["not_stored"] == 0
    assert payload["lock"] == {"held": False, "pid": None, "alive": None}
    assert payload["plumbing_only"] is True
    assert payload["log"] is None


def test_status_text_names_each_count(stored, capsys):
    capsys.readouterr()
    rc = main(["measure", "status", str(stored.out)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "8 of 8" in out
    assert "finished: 8" in out
    assert "failed launches: 0" in out
    assert "not yet stored: 0" in out
    assert "no runner holds the lock" in out


def test_status_counts_runs_not_yet_stored(setup, capsys):
    run_json(capsys, setup.run_args("--json"))
    record_path(setup.out, "t-two", "arm-b", 2).unlink()
    record_path(setup.out, "t-one", "arm-a", 1).unlink()
    payload = run_json(capsys, ["measure", "status", str(setup.out), "--json"])
    assert payload["finished"] == 6
    assert payload["not_stored"] == 2
    assert payload["expected_runs"] == 8


def test_status_refuses_a_manifest_whose_repeats_are_above_the_limit(setup, capsys):
    run_json(capsys, setup.run_args("--json"))
    manifest_path = setup.out / measure_mod.MANIFEST_FILE
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["repeats"] = 10**12
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    rc, err = error_of(capsys, ["measure", "status", str(setup.out)])
    assert rc == 1
    assert "repeats" in err
    assert str(measure_mod.MAX_REPEATS) in err
    assert "hint:" in err


def test_status_reports_a_held_lock_and_a_live_process(setup, capsys):
    run_json(capsys, setup.run_args("--json"))
    manifest_path = setup.out / measure_mod.MANIFEST_FILE
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["pid"] = os.getpid()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    fd = os.open(setup.out / LOCK_FILE, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        payload = run_json(capsys, ["measure", "status", str(setup.out), "--json"])
        capsys.readouterr()
        main(["measure", "status", str(setup.out)])
        text = capsys.readouterr().out
    finally:
        os.close(fd)
    assert payload["lock"] == {"held": True, "pid": os.getpid(), "alive": True}
    assert "a runner holds the lock" in text
    assert f"process {os.getpid()} is alive" in text


def test_status_reports_a_held_lock_with_a_dead_process(setup, capsys):
    run_json(capsys, setup.run_args("--json"))
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    manifest_path = setup.out / measure_mod.MANIFEST_FILE
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["pid"] = dead.pid
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    fd = os.open(setup.out / LOCK_FILE, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        payload = run_json(capsys, ["measure", "status", str(setup.out), "--json"])
    finally:
        os.close(fd)
    assert payload["lock"] == {"held": True, "pid": dead.pid, "alive": False}


def test_status_without_a_manifest_is_a_user_error(tmp_path, capsys):
    (tmp_path / "empty").mkdir()
    rc, err = error_of(capsys, ["measure", "status", str(tmp_path / "empty")])
    assert rc == 1
    assert "manifest" in err
    assert "hint:" in err


def test_run_writes_a_manifest_naming_tasks_arms_and_repeats(setup, fake, capsys):
    capsys.readouterr()
    assert main(setup.run_args("--tasks-filter", "t-one")) == 0
    manifest = json.loads((setup.out / measure_mod.MANIFEST_FILE).read_text(encoding="utf-8"))
    assert manifest["tasks"] == ["t-one"]
    assert manifest["arms"] == ["arm-a", "arm-b"]
    assert manifest["repeats"] == 2
    assert manifest["expected_runs"] == 4
    assert manifest["harness"] == "stub"


# --- the lock and --detach --------------------------------------------------------------


def test_a_second_runner_on_the_same_directory_is_refused_with_a_remediation(setup, fake, capsys):
    setup.out.mkdir()
    fd = os.open(setup.out / LOCK_FILE, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        rc, err = error_of(capsys, setup.run_args())
    finally:
        os.close(fd)
    assert rc == 1
    assert "lock" in err
    assert "hint:" in err
    assert fake.calls == []


def test_a_runner_refused_by_the_lock_inside_the_runner_is_a_cli_error(setup, monkeypatch, capsys):
    def refuse(*args, **kwargs):
        raise RunnerError("another runner holds the lock on X; one runner per dir")

    monkeypatch.setattr(measure_mod, "run_comparison", refuse)
    rc, err = error_of(capsys, setup.run_args())
    assert rc == 1
    assert "another runner holds the lock" in err
    assert "hint:" in err


def test_detach_starts_a_detached_child_and_returns_at_once(setup, monkeypatch, capsys):
    seen = {}

    class FakeProc:
        pid = 424242

    def fake_popen(argv, **kwargs):
        seen["argv"] = argv
        seen["kwargs"] = kwargs
        return FakeProc()

    monkeypatch.setattr(measure_mod, "Popen", fake_popen)
    payload = run_json(capsys, setup.run_args("--detach", "--timeout", "120", "--json"))
    argv = seen["argv"]
    assert argv[:5] == [sys.executable, "-m", "associate", "measure", "run"]
    assert "--detach" not in argv
    assert float(argv[argv.index("--timeout") + 1]) == 120
    assert argv[argv.index("--harness") + 1] == "stub"
    kwargs = seen["kwargs"]
    assert kwargs["start_new_session"] is True
    assert kwargs["stdin"] == subprocess.DEVNULL
    assert kwargs["stdout"] is kwargs["stderr"] or kwargs["stderr"] == subprocess.STDOUT
    assert payload["detached"] is True
    assert payload["pid"] == 424242
    assert payload["results"] == str(setup.out)
    assert payload["log"] == str(setup.out / measure_mod.LOG_FILE)
    assert (setup.out / measure_mod.LOG_FILE).exists()


def test_detach_text_says_where_the_results_and_the_log_are(setup, monkeypatch, capsys):
    class FakeProc:
        pid = 777

    monkeypatch.setattr(measure_mod, "Popen", lambda *a, **k: FakeProc())
    capsys.readouterr()
    rc = main(setup.run_args("--detach"))
    out = capsys.readouterr().out
    assert rc == 0
    assert str(setup.out) in out
    assert str(setup.out / measure_mod.LOG_FILE) in out
    assert "777" in out
    assert "measure status" in out


def test_detach_is_refused_while_another_runner_holds_the_lock(setup, monkeypatch, capsys):
    monkeypatch.setattr(measure_mod, "Popen", lambda *a, **k: pytest.fail("started"))
    setup.out.mkdir()
    fd = os.open(setup.out / LOCK_FILE, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        rc, err = error_of(capsys, setup.run_args("--detach"))
    finally:
        os.close(fd)
    assert rc == 1
    assert "lock" in err
    assert "hint:" in err


def test_a_really_detached_comparison_finishes_and_status_follows_it(
    tmp_path, demo, current_harness, capsys
):
    setup = Setup(tmp_path, demo, current_harness, repeats=1)
    setup.tasks = tasks_file(tmp_path, [task("t-one", setup.demo_head)])
    payload = run_json(capsys, setup.run_args("--detach", "--json"))
    pid = payload["pid"]
    deadline = time.monotonic() + 240
    status = {}
    while time.monotonic() < deadline:
        status = run_json(capsys, ["measure", "status", str(setup.out), "--json"])
        if status["not_stored"] == 0 and status["lock"]["held"] is False:
            break
        time.sleep(1)
    assert status["expected_runs"] == 2
    assert status["finished"] == 2
    assert status["lock"]["held"] is False
    log = Path(payload["log"])
    assert log.is_file()
    assert "plumbing only" in log.read_text(encoding="utf-8").lower()
    assert isinstance(pid, int)


# --- registered in the four places --------------------------------------------------------


def test_measure_with_no_verb_prints_the_overview(capsys):
    capsys.readouterr()
    assert main(["measure"]) == 0
    out = capsys.readouterr().out
    assert "measure run" in out
    assert "measure status" in out
    assert "measure agreement" in out


def test_measure_overview_json(capsys):
    payload = run_json(capsys, ["measure", "overview", "--json"])
    assert payload["subject"] == "associate measure"


def test_explain_describes_the_verb_and_each_sub_verb(capsys):
    for path in (
        ["measure"],
        ["measure", "run"],
        ["measure", "status"],
        ["measure", "report"],
        ["measure", "sample"],
        ["measure", "agreement"],
    ):
        capsys.readouterr()
        assert main(["explain", *path]) == 0, path
        out = capsys.readouterr().out
        assert "measure" in out
    capsys.readouterr()
    main(["explain", "measure", "run"])
    out = capsys.readouterr().out
    assert "difference-threshold.md" in out
    assert "--detach" in out
    assert "plumbing only" in out.lower()


def test_learn_lists_the_measure_verbs_in_text_and_json(capsys):
    capsys.readouterr()
    main(["learn"])
    text = capsys.readouterr().out
    assert "associate measure run" in text
    payload = run_json(capsys, ["learn", "--json"])
    paths = [tuple(c["path"]) for c in payload["commands"]]
    assert "associate measure agreement" in text
    for verb in ("run", "status", "report", "sample", "agreement", "overview"):
        assert ("measure", verb) in paths


def test_run_help_states_that_a_stub_comparison_is_plumbing_only(capsys):
    capsys.readouterr()
    with pytest.raises(SystemExit) as exc:
        main(["measure", "run", "--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "plumbing only" in " ".join(out.lower().split())
    assert "--detach" in out


def test_parser_constants_match_the_report_module():
    assert measure_mod.READING_ANSWER == report_module.READING_ANSWER
    assert measure_mod.READING_WITH_HANDBACK == report_module.READING_WITH_HANDBACK
    assert measure_mod.SAMPLE_SIZE == report_module.SAMPLE_SIZE
