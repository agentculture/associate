"""``associate measure`` for the broad tasks: run --broad, sheet, sheet-check, report (t11).

Every run here is plumbing: the stub harness, no model, no key, no network. The
sheet, check and report tests read records written by hand in the shape the
runner stores for a broad run.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from associate.cli import main
from associate.cli._commands import measure as measure_mod
from associate.cli._commands import measure_broad
from associate.measure import broad as broad_lib
from associate.measure.runner import load_records, record_path
from tests.test_measure_broad import CONFIRMED
from tests.test_measure_command import (  # noqa: F401 - fixtures
    FakeRunner,
    arms_file,
    commit_all,
    current_harness,
    error_of,
    fake,
    git,
    run_json,
    write,
)
from tests.test_measure_sheet import record

KEY_TEXT = "ANSWER-KEY-CONTENT-9876"
NOTE_REL = "docs/accuracy/broad-difference-threshold.md"
TASKS = ("broad-one", "broad-two", "broad-three", "broad-four", "broad-five", "broad-six")
OFF, ON = "score-off", "score-on"


def broad_file(tmp_path: Path, commit: str, name: str = "demo") -> Path:
    doc = {
        "version": 1,
        "prompt": "Explain this repository.",
        "tasks": [
            {
                "id": "broad-demo",
                "repo": {"host": "github.com", "owner": "example", "name": name},
                "commit": commit,
                "facts": [
                    {"id": "f1", "question": "q", "answer": "a", "match": [["plumbing"]]},
                    {"id": "f2", "question": "q", "answer": "a", "match": [["never-there"]]},
                ],
            }
        ],
    }
    return write(tmp_path, "broad.json", json.dumps(doc))


@pytest.fixture
def demo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "demo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, "README.md", "a demo\n")
    write(repo, "docs/accuracy/broad-tasks.json", f'{{"key": "{KEY_TEXT}"}}\n')
    return repo, commit_all(repo)


def note_repo(tmp_path: Path, text: str) -> Path:
    repo = tmp_path / "noterepo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, NOTE_REL, text)
    commit_all(repo)
    return repo / NOTE_REL


def run_args(tmp_path, demo, harness_pair, *extra: str, harness: str = "stub") -> list[str]:
    demo_repo, demo_head = demo
    harness_repo, harness_head = harness_pair
    arms = [
        {"name": OFF, "harness_commit": harness_head, "model": "worker", "support_score": "off"},
        {"name": ON, "harness_commit": harness_head, "model": "worker", "support_score": "on"},
    ]
    return [
        "measure",
        "run",
        "--broad",
        "--arms",
        str(arms_file(tmp_path, arms)),
        "--tasks",
        str(broad_file(tmp_path, demo_head)),
        "--output-dir",
        str(tmp_path / "results"),
        "--harness",
        harness,
        "--harness-repo",
        str(harness_repo),
        "--checkout-of",
        f"demo={demo_repo}",
        *extra,
    ]


# --- acceptance 1: measure accepts a broad task and stores each run's answer ----------------


def test_a_stub_broad_run_stores_the_answer_and_the_first_marking(
    tmp_path, demo, current_harness, capsys  # noqa: F811
):
    payload = run_json(capsys, run_args(tmp_path, demo, current_harness, "--json"))
    assert payload["plumbing_only"] is True
    assert payload["stored"] == {"finished": 2, "launch_failed": 0}
    records = load_records(tmp_path / "results")
    assert sorted(r["arm"]["name"] for r in records) == [OFF, ON]
    for rec in records:
        assert rec["status"] == "finished"
        assert rec["task"]["id"] == "broad-demo"
        assert isinstance(rec["answer"]["text"], str)
        assert rec["broad"]["marking"] == "first marking"
        assert rec["broad"]["facts_total"] == 2
        assert [f["id"] for f in rec["broad"]["facts"]] == ["f1", "f2"]
        assert rec["broad"]["answer_source"] in ("answer.md", "final_reply", "none")
        assert rec["broad"]["at_cap"] is False
        assert rec["grade"] is None
        assert rec["support_score"] in ("on", "off")
    manifest = json.loads((tmp_path / "results" / "manifest.json").read_text())
    assert manifest["broad"] is True
    assert manifest["tasks"] == ["broad-demo"]
    clone_files = [
        p for p in (tmp_path / "results" / "work").rglob("*") if p.is_file() and "clones" in p.parts
    ]
    assert any(p.name == "README.md" for p in clone_files)
    assert [p for p in clone_files if p.name == "broad-tasks.json"] == []
    # The report of a broad comparison lists the first marking per run.
    capsys.readouterr()
    assert main(["measure", "report", str(tmp_path / "results")]) == 0
    text = capsys.readouterr().out
    assert "first marking" in text
    assert "of 2" in text
    assert "Plumbing only" in text


def test_the_default_broad_task_file_is_the_committed_one(
    tmp_path, demo, current_harness, fake, capsys  # noqa: F811
):
    args = run_args(tmp_path, demo, current_harness)
    position = args.index("--tasks")
    del args[position : position + 2]
    capsys.readouterr()
    assert main(args) == 0, capsys.readouterr().err
    tasks = fake.calls[0]["tasks"]
    assert [t["id"] for t in tasks] == [t["id"] for t in broad_lib.load_broad_tasks()]
    assert all("facts" in t and "expected" not in t for t in tasks)


def test_a_detached_broad_run_passes_the_switch_to_its_child(
    tmp_path, demo, current_harness, monkeypatch, capsys  # noqa: F811
):
    started = []

    class Child:
        pid = 4242

    def spawn(argv, **_kw):
        started.append(argv)
        return Child()

    monkeypatch.setattr(measure_mod, "Popen", spawn)
    assert main(run_args(tmp_path, demo, current_harness, "--detach", "--json")) == 0
    assert "--broad" in started[0]


def test_a_bad_broad_file_is_a_user_error(tmp_path, demo, current_harness, capsys):  # noqa: F811
    args = run_args(tmp_path, demo, current_harness)
    write(tmp_path, "broad.json", json.dumps({"version": 1, "tasks": []}))
    rc, err = error_of(capsys, args)
    assert rc == 1
    assert "broad" in err
    assert "hint:" in err


# --- acceptance 5: no real run while the rule file is missing, modified or a draft ----------


def pi_args(tmp_path, demo, harness_pair, note: Path | None) -> list[str]:
    extra = ["--difference-note", str(note)] if note is not None else []
    return run_args(tmp_path, demo, harness_pair, *extra, harness="pi")


def test_the_default_rule_file_of_a_broad_run_is_the_broad_one():
    assert measure_broad.BROAD_NOTE.as_posix().endswith(NOTE_REL)
    assert measure_broad.BROAD_NOTE != measure_mod.DIFFERENCE_NOTE


def test_a_real_broad_run_is_refused_without_the_rule_file(
    tmp_path, demo, current_harness, fake, capsys  # noqa: F811
):
    missing = note_repo(tmp_path, CONFIRMED).with_name("no-such-note.md")
    rc, err = error_of(capsys, pi_args(tmp_path, demo, current_harness, missing))
    assert rc == 1
    assert "no-such-note.md" in err
    assert "hint:" in err
    assert fake.calls == []


def test_a_real_broad_run_is_refused_when_the_rule_file_is_modified(
    tmp_path, demo, current_harness, fake, capsys  # noqa: F811
):
    note = note_repo(tmp_path, CONFIRMED)
    note.write_text(CONFIRMED.replace('"repositories_required": 5', '"repositories_required": 1'))
    rc, err = error_of(capsys, pi_args(tmp_path, demo, current_harness, note))
    assert rc == 1
    assert "committed" in err
    assert fake.calls == []


@pytest.mark.parametrize(
    "text",
    [
        CONFIRMED.replace("confirmed", "draft"),
        CONFIRMED + "\nDRAFT wording.\n",
        "# A rule with no parameters\n",
    ],
)
def test_a_real_broad_run_is_refused_while_the_rule_file_is_a_draft(
    tmp_path, demo, current_harness, fake, capsys, text  # noqa: F811
):
    note = note_repo(tmp_path, text)
    rc, err = error_of(capsys, pi_args(tmp_path, demo, current_harness, note))
    assert rc == 1
    assert "broad-difference-threshold.md" in err
    assert "hint:" in err
    assert fake.calls == []


def test_the_committed_rule_file_is_a_confirmed_rule():
    """The operator confirmed it on 2026-11-19; committed and unmodified, a real run may start."""
    text = measure_broad.BROAD_NOTE.read_text(encoding="utf-8")
    assert measure_broad._broad().draft_problem(text) is None


def test_a_real_broad_run_starts_with_a_committed_confirmed_rule_file(
    tmp_path, demo, current_harness, fake, capsys  # noqa: F811
):
    note = note_repo(tmp_path, CONFIRMED)
    capsys.readouterr()
    assert main(pi_args(tmp_path, demo, current_harness, note)) == 0, capsys.readouterr().err
    assert fake.calls[0]["options"].harness == "pi"
    assert [t["id"] for t in fake.calls[0]["tasks"]] == ["broad-demo"]


def test_a_stub_broad_run_needs_no_rule_file(
    tmp_path, demo, current_harness, fake, capsys  # noqa: F811
):
    missing = tmp_path / "no-such-note.md"
    args = run_args(tmp_path, demo, current_harness, "--difference-note", str(missing))
    capsys.readouterr()
    assert main(args) == 0, capsys.readouterr().err
    assert len(fake.calls) == 1


# --- stored broad results, written by hand -------------------------------------------------


def answer(arm: str, repeat: int) -> str:
    return f"It is built with hatchling. Marker {arm} {repeat}.\n\n- It has a CLI.\n- Uses tox.\n"


def store(results: Path, records: list[dict], broad: bool = True) -> Path:
    for rec in records:
        path = record_path(results, rec["task"]["id"], rec["arm"]["name"], rec["repeat"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rec), encoding="utf-8")
    manifest = {"repeats": 3, "plumbing_only": False, "broad": broad}
    (results / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return results


def six_repositories() -> list[dict]:
    """Six tasks, two arms, three repeats; arm ``score-on`` has more facts marked in five."""
    records = []
    for index, task in enumerate(TASKS):
        for arm in (OFF, ON):
            for repeat in (1, 2, 3):
                stated = 2 if (arm == ON and index < 5) else 1
                records.append(record(task, arm, repeat, answer(arm, repeat), stated=stated))
    return records


@pytest.fixture
def results(tmp_path: Path) -> Path:
    return store(tmp_path / "results", six_repositories())


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def fill_sheet(results: Path, false_for: str | None = OFF) -> None:
    """Grade every statement; one false with file and line in each run of *false_for*."""
    sheet_path = results / measure_broad.DEFAULT_SHEET
    sheet, key = read(sheet_path), read(results / measure_broad.DEFAULT_KEY)
    for run in sheet["runs"]:
        for statement in run["statements"]:
            statement["verdict"] = "true"
        if key["runs"][run["id"]]["arm"] == false_for:
            run["statements"][0].update(verdict="false", file="pyproject.toml", line=3)
            run["statements"][2]["verdict"] = "not_checkable"
    sheet_path.write_text(json.dumps(sheet), encoding="utf-8")


# --- acceptance 2: the sheet command -------------------------------------------------------


def test_sheet_writes_a_sheet_without_arms_and_a_separate_key(results, capsys):
    payload = run_json(capsys, ["measure", "sheet", str(results), "--seed", "11", "--json"])
    sheet_path, key_path = Path(payload["sheet"]), Path(payload["key"])
    assert sheet_path == results / measure_broad.DEFAULT_SHEET
    assert key_path == results / measure_broad.DEFAULT_KEY
    assert sheet_path != key_path
    assert payload["runs"] == 36
    assert payload["statements"] == 36 * 4
    sheet, key = read(sheet_path), read(key_path)
    assert key["seed"] == 11
    assert "seed" not in sheet
    assert "seed" not in payload
    assert len(sheet["runs"]) == 36
    shown = json.dumps(sheet) + json.dumps(payload)
    for run in sheet["runs"]:
        entry = key["runs"][run["id"]]
        shown = shown.replace(f"Marker {entry['arm']} {entry['repeat']}.", "")
    assert OFF not in shown
    assert ON not in shown


def test_sheet_text_names_both_files_and_tells_the_grader_to_leave_the_key(results, capsys):
    capsys.readouterr()
    assert main(["measure", "sheet", str(results)]) == 0
    out = capsys.readouterr().out
    assert measure_broad.DEFAULT_SHEET in out
    assert measure_broad.DEFAULT_KEY in out
    assert "must not open" in out
    assert OFF not in out
    assert ON not in out
    assert isinstance(read(results / measure_broad.DEFAULT_KEY)["seed"], int)


def test_sheet_with_the_same_seed_writes_the_same_sheet(results, tmp_path, capsys):
    paths = []
    for name in ("a", "b"):
        sheet, key = tmp_path / f"{name}-sheet.json", tmp_path / f"{name}-key.json"
        argv = ["measure", "sheet", str(results), "--seed", "5"]
        assert main([*argv, "--sheet", str(sheet), "--key", str(key)]) == 0
        paths.append((sheet, key))
    assert read(paths[0][0]) == read(paths[1][0])
    assert read(paths[0][1]) == read(paths[1][1])


def test_sheet_refuses_to_replace_a_sheet_or_a_key(results, capsys):
    assert main(["measure", "sheet", str(results)]) == 0
    before = (results / measure_broad.DEFAULT_SHEET).read_text()
    rc, err = error_of(capsys, ["measure", "sheet", str(results)])
    assert rc == 1
    assert "already exists" in err
    assert "--overwrite" in err
    assert (results / measure_broad.DEFAULT_SHEET).read_text() == before
    assert main(["measure", "sheet", str(results), "--overwrite"]) == 0


def test_sheet_refuses_the_same_file_for_sheet_and_key(results, tmp_path, capsys):
    same = str(tmp_path / "one.json")
    rc, err = error_of(capsys, ["measure", "sheet", str(results), "--sheet", same, "--key", same])
    assert rc == 1
    assert "separate" in err


def test_sheet_refuses_results_that_are_not_broad_runs(tmp_path, capsys):
    short = record("t-one", "arm-a", 1, "text")
    del short["broad"]
    out = store(tmp_path / "short", [short], broad=False)
    rc, err = error_of(capsys, ["measure", "sheet", str(out)])
    assert rc == 1
    assert "broad" in err
    assert "hint:" in err


# --- acceptance 3: the check ---------------------------------------------------------------


def test_sheet_check_fails_on_a_blank_sheet_and_lists_what_is_missing(results, capsys):
    assert main(["measure", "sheet", str(results)]) == 0
    capsys.readouterr()
    rc = main(["measure", "sheet-check", str(results), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert rc == 1
    assert payload["acceptable"] is False
    assert len(payload["problems"]) == 36 * 4
    assert payload["statements"] == 36 * 4
    assert payload["with_verdict"] == 0


def test_sheet_check_passes_a_filled_sheet(results, capsys):
    assert main(["measure", "sheet", str(results)]) == 0
    fill_sheet(results)
    payload = run_json(capsys, ["measure", "sheet-check", str(results), "--json"])
    assert payload["acceptable"] is True
    assert payload["problems"] == []
    assert payload["with_verdict"] == 36 * 4


def test_sheet_check_fails_a_false_without_file_and_line(results, capsys):
    assert main(["measure", "sheet", str(results)]) == 0
    fill_sheet(results)
    path = results / measure_broad.DEFAULT_SHEET
    sheet = read(path)
    sheet["runs"][4]["statements"][1].update(verdict="false", file=None, line=None)
    path.write_text(json.dumps(sheet))
    capsys.readouterr()
    rc = main(["measure", "sheet-check", str(results)])
    out = capsys.readouterr().out
    assert rc == 1
    assert f"{sheet['runs'][4]['id']} statement 2" in out
    assert "not acceptable" in out
    assert OFF not in out
    assert ON not in out


def test_sheet_check_with_a_clone_root_looks_the_file_up(tmp_path, capsys):
    repo = tmp_path / "checkouts" / "one"
    repo.mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    write(repo, "pyproject.toml", "one\ntwo\n")
    pinned = commit_all(repo)
    rec = record("broad-one", OFF, 1, "First. Second.", commit=pinned, name="one")
    out = store(tmp_path / "results", [rec])
    assert main(["measure", "sheet", str(out)]) == 0
    path = out / measure_broad.DEFAULT_SHEET
    sheet = read(path)
    sheet["runs"][0]["statements"][0].update(verdict="false", file="pyproject.toml", line=3)
    sheet["runs"][0]["statements"][1]["verdict"] = "true"
    path.write_text(json.dumps(sheet))
    assert main(["measure", "sheet-check", str(out)]) == 0
    root = str(tmp_path / "checkouts")
    capsys.readouterr()
    assert main(["measure", "sheet-check", str(out), "--clone-root", root]) == 1
    assert "2 lines" in capsys.readouterr().out
    sheet["runs"][0]["statements"][0]["line"] = 2
    path.write_text(json.dumps(sheet))
    assert main(["measure", "sheet-check", str(out), "--clone-root", root]) == 0


def test_sheet_check_without_a_sheet_is_a_user_error(results, capsys):
    rc, err = error_of(capsys, ["measure", "sheet-check", str(results)])
    assert rc == 1
    assert "measure sheet" in err


# --- acceptance 1 and 4: the report --------------------------------------------------------


def test_report_before_any_sheet_lists_the_first_marking_per_run(results, capsys):
    capsys.readouterr()
    assert main(["measure", "report", str(results)]) == 0
    text = capsys.readouterr().out
    assert text.count("(first marking) 2 of 3") == 15
    assert text.count("(first marking) 1 of 3") == 21
    assert "not joined" in text
    assert "%" not in text


def test_report_json_lists_every_run_and_no_pooled_number(results, capsys):
    payload = run_json(capsys, ["measure", "report", str(results), "--json"])
    assert payload["joined"] is False
    assert len(payload["runs"]) == 36
    first = payload["runs"][0]
    assert first["facts_stated"] == 1
    assert first["facts_total"] == 3
    assert first["statements_false"] is None
    assert first["marking"] == "first marking"
    assert set(payload) == {
        "broad",
        "joined",
        "note",
        "plumbing_only",
        "runs",
        "rule",
        "not_finished",
        "without_finish",
        "middle_values",
    }


def test_report_refuses_to_join_while_a_run_is_not_fully_graded(results, capsys):
    assert main(["measure", "sheet", str(results)]) == 0
    rc, err = error_of(capsys, ["measure", "report", str(results)])
    assert rc == 1
    assert "not fully graded" in err
    assert "sheet-check" in err
    assert OFF not in err
    assert ON not in err
    fill_sheet(results)
    path = results / measure_broad.DEFAULT_SHEET
    sheet = read(path)
    sheet["runs"][7]["statements"][3]["verdict"] = None
    path.write_text(json.dumps(sheet))
    capsys.readouterr()
    assert main(["measure", "report", str(results)]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert sheet["runs"][7]["id"] in captured.err


def test_report_refuses_a_false_without_file_and_line(results, capsys):
    assert main(["measure", "sheet", str(results)]) == 0
    fill_sheet(results)
    path = results / measure_broad.DEFAULT_SHEET
    sheet = read(path)
    sheet["runs"][0]["statements"][1].update(verdict="false", file="", line=None)
    path.write_text(json.dumps(sheet))
    rc, err = error_of(capsys, ["measure", "report", str(results)])
    assert rc == 1
    assert "file" in err
    assert "line" in err


def test_report_refuses_a_sheet_without_its_key(results, capsys):
    assert main(["measure", "sheet", str(results)]) == 0
    fill_sheet(results)
    (results / measure_broad.DEFAULT_KEY).unlink()
    rc, err = error_of(capsys, ["measure", "report", str(results)])
    assert rc == 1
    assert "key" in err


def test_report_prints_both_counts_per_run_once_every_run_is_graded(results, capsys):
    assert main(["measure", "sheet", str(results)]) == 0
    fill_sheet(results)
    capsys.readouterr()
    assert main(["measure", "report", str(results)]) == 0
    text = capsys.readouterr().out
    assert text.count("statements counted false 1; not checkable 1; statements 4") == 18
    assert text.count("statements counted false 0; not checkable 0; statements 4") == 18
    assert text.count("(first marking) 2 of 3") == 15
    assert "not joined" not in text
    off_block = text.split("broad-one")[1].split("arm score-on")[0]
    assert off_block.count("statements counted false 1") == 3
    payload = run_json(capsys, ["measure", "report", str(results), "--json"])
    assert payload["joined"] is True
    row = next(r for r in payload["runs"] if r["arm"] == OFF)
    assert row["statements_false"] == 1
    assert row["statements_not_checkable"] == 1
    assert row["statements"] == 4
    assert row["answer_source"] == "answer.md"
    assert row["at_cap"] is False


def test_report_says_the_rule_is_not_applied_while_the_rule_file_is_a_draft(
    results, tmp_path, capsys
):
    note = str(note_repo(tmp_path, CONFIRMED.replace("confirmed", "draft")))
    args = ["measure", "report", str(results), "--difference-note", note]
    payload = run_json(capsys, [*args, "--json"])
    assert payload["rule"]["applied"] is False
    assert payload["rule"]["counts"] == {}
    capsys.readouterr()
    assert main(args) == 0
    assert "rule's verdict is not computed" in capsys.readouterr().out


def test_report_states_the_rule_verdict_per_count(results, tmp_path, capsys):
    note = str(note_repo(tmp_path, CONFIRMED))
    assert main(["measure", "sheet", str(results)]) == 0
    fill_sheet(results)
    argv = ["measure", "report", str(results), "--difference-note", note]
    payload = run_json(capsys, [*argv, "--json"])
    rule = payload["rule"]
    assert rule["applied"] is True
    assert rule["counts"]["facts_stated"]["verdict"] == "a change"
    assert rule["counts"]["facts_stated"]["better_arm"] == ON
    assert rule["counts"]["facts_stated"]["repositories_for"] == {OFF: 0, ON: 5}
    assert rule["counts"]["statements_false"]["verdict"] == "a change"
    assert rule["counts"]["statements_false"]["better_arm"] == ON
    capsys.readouterr()
    assert main(argv) == 0
    text = capsys.readouterr().out
    assert "facts marked as stated: a change" in text
    assert "statements counted false: a change" in text
    assert "5 of 6" in text


def test_report_before_the_join_gives_the_rule_for_the_first_marking_only(
    results, tmp_path, capsys
):
    note = str(note_repo(tmp_path, CONFIRMED))
    argv = ["measure", "report", str(results), "--difference-note", note, "--json"]
    rule = run_json(capsys, argv)["rule"]
    assert set(rule["counts"]) == {"facts_stated"}


def test_report_says_no_difference_shown_when_the_arms_overlap(tmp_path, capsys):
    records = six_repositories()
    for rec in records:
        rec["broad"]["facts_stated"] = 1
    out = store(tmp_path / "flat", records)
    note = str(note_repo(tmp_path, CONFIRMED))
    argv = ["measure", "report", str(out), "--difference-note", note]
    rule = run_json(capsys, [*argv, "--json"])["rule"]
    assert rule["counts"]["facts_stated"]["verdict"] == "no difference shown"
    capsys.readouterr()
    assert main(argv) == 0
    text = capsys.readouterr().out
    assert "facts marked as stated: no difference shown" in text
    assert "no difference." not in text.replace("no difference shown", "")


def test_report_names_runs_that_did_not_finish(tmp_path, capsys):
    records = six_repositories()
    records[0]["status"] = "launch_failed"
    out = store(tmp_path / "partial", records)
    payload = run_json(capsys, ["measure", "report", str(out), "--json"])
    assert payload["not_finished"] == [["broad-one", OFF, 1]]
    assert len(payload["runs"]) == 35


def test_the_short_task_report_is_unchanged_for_short_task_results(tmp_path, capsys):
    short = record("t-one", "arm-a", 1, "text")
    del short["broad"]
    short.update(graded=True, grade={"verdict": "matches"}, grades=[], outcome="ok")
    out = store(tmp_path / "short", [short], broad=False)
    capsys.readouterr()
    assert main(["measure", "report", str(out)]) == 0
    assert "matching" in capsys.readouterr().out


# --- the verbs are described ---------------------------------------------------------------


@pytest.mark.parametrize("verb", ["sheet", "sheet-check"])
def test_the_new_verbs_are_explained_and_listed(verb, capsys):
    assert main(["explain", "measure", verb]) == 0
    assert "sheet-check" in capsys.readouterr().out
    assert main(["learn"]) == 0
    assert f"measure {verb}" in capsys.readouterr().out
    assert main(["measure", "overview"]) == 0
    assert f"measure {verb}" in capsys.readouterr().out
    payload = run_json(capsys, ["learn", "--json"])
    assert ["measure", verb] in [command["path"] for command in payload["commands"]]


def test_run_help_names_the_broad_switch_and_its_rule_file(capsys):
    with pytest.raises(SystemExit):
        main(["measure", "run", "--help"])
    out = "".join(capsys.readouterr().out.split())
    assert "--broad" in out
    assert "broad-difference-threshold.md" in out
