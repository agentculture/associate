"""Deviation d3 (issue #38): a broad run records whether it was reminded to finish.

The run result carries ``finish_reminder`` (``{"sent", "finish_followed"}``)
when the harness that ran it has the finish reminder. A broad record's
``broad`` object gains ``reminded``: true when at least one reminder was sent,
false when none was, null when the result does not say. The broad report says
per run "reminded to finish" when true and counts reminded runs per arm. Grades
do not change. An arm may carry ``finish_reminder`` (on or off), passed to its
runs as ``associate run --finish-reminder``.
"""

from __future__ import annotations

import json

import pytest

from associate.cli import main
from associate.cli._commands import measure as measure_cmd
from associate.cli._errors import CliError
from associate.measure import broad
from associate.measure import runner as runner_mod
from associate.measure import sheet as sheet_mod
from tests.test_measure_broad import runner_task
from tests.test_measure_broad_command import OFF, ON
from tests.test_measure_sheet import some_records

REMINDED_WORDS = "reminded to finish"
COMMIT = "abcdef1"
MODEL = "worker"
FLAG = "--finish-reminder"
ARM_KEY = "finish_reminder"
REMINDED = "reminded"
BROAD = "broad"
RESULT_KEY = "finish_reminder"


def sent(n: int, followed: bool | None = None) -> dict:
    return {RESULT_KEY: {"sent": n, "finish_followed": followed}}


@pytest.mark.parametrize(
    ("result", REMINDED),
    [
        (sent(1, True), True),
        (sent(2, False), True),
        (sent(0), False),
        ({RESULT_KEY: {"sent": None, "finish_followed": None}}, None),
        ({"handback_outcome": "accepted"}, None),
        ({RESULT_KEY: "yes"}, None),
        (None, None),
    ],
)
def test_reminded_is_read_from_the_run_result(result, reminded):
    assert broad.was_reminded(result) is reminded
    fields = runner_mod._broad_fields(result, None, runner_task())
    assert fields[BROAD][REMINDED] is reminded


def test_the_grade_fields_do_not_change_with_a_reminder():
    plain = runner_mod._broad_fields({"final_reply": "hatchling"}, None, runner_task())
    reminded = runner_mod._broad_fields(
        {"final_reply": "hatchling", **sent(1, True)}, None, runner_task()
    )
    for key in ("graded", "grade", "grades", "answer"):
        assert reminded[key] == plain[key], key
    without = {k: v for k, v in reminded[BROAD].items() if k != REMINDED}
    assert without == {k: v for k, v in plain[BROAD].items() if k != REMINDED}


def _records(reminded: list[bool | None]) -> list[dict]:
    records = some_records(tasks=("broad-one",))
    for stored, value in zip(records, reminded):
        stored[BROAD]["finished"] = True
        if value is not None:
            stored[BROAD][REMINDED] = value
    return records


def test_rows_carry_reminded():
    rows = sheet_mod.run_rows(_records([True, False, None, False, False, False]), None)
    assert [row[REMINDED] for row in rows] == [True, False, None, False, False, False]


def test_the_per_run_line_says_reminded_to_finish_only_when_true():
    rows = sheet_mod.run_rows(_records([True, False, None, False, False, False]), None)
    text = sheet_mod.render_rows(rows)
    run_lines = [line for line in text.splitlines() if line.startswith("    r")]
    assert len(run_lines) == 6
    assert sum(REMINDED_WORDS in line for line in run_lines) == 1
    assert run_lines[0].endswith(f"finish accepted; {REMINDED_WORDS}")


def test_the_per_arm_block_counts_reminded_runs():
    rows = sheet_mod.run_rows(_records([True, True, None, False, False, False]), None)
    counts = sheet_mod.reminded_counts(rows)
    assert counts[OFF] == {"runs": 3, REMINDED: 2, "reminder_not_recorded": 1}
    assert counts[ON] == {"runs": 3, REMINDED: 0, "reminder_not_recorded": 0}
    text = sheet_mod.render_rows(rows)
    expected = (
        f"arm {OFF}: 0 of 3 runs ended without finish; 2 of 3 {REMINDED_WORDS} (1 not recorded)"
    )
    assert expected in text
    assert f"arm {ON}: 0 of 3 runs ended without finish; 0 of 3 reminded to finish" in text


# --- the arm setting -------------------------------------------------------------------------


def _arms_file(tmp_path, **extra) -> str:
    arm = {"name": "a", "harness_commit": COMMIT, "model": MODEL, **extra}
    path = tmp_path / "arms.json"
    path.write_text(json.dumps([arm]), encoding="utf-8")
    return path


@pytest.mark.parametrize("setting", ["on", "off"])
def test_an_arm_may_carry_finish_reminder(tmp_path, setting):
    (arm,) = measure_cmd.load_arms(_arms_file(tmp_path, finish_reminder=setting))
    assert arm.finish_reminder == setting


def test_an_arm_without_it_passes_nothing(tmp_path):
    (arm,) = measure_cmd.load_arms(_arms_file(tmp_path))
    assert arm.finish_reminder is None


def test_an_arm_with_another_value_is_refused(tmp_path):
    path = _arms_file(tmp_path, finish_reminder="yes")
    with pytest.raises(CliError, match="finish_reminder must be one of on, off"):
        measure_cmd.load_arms(path)


def test_the_flag_reaches_the_runs_of_the_arm():
    arm = runner_mod.Arm(name="a", harness_commit=COMMIT, model=MODEL, finish_reminder="off")
    harness = runner_mod._Harness(commit="a" * 40, flags=frozenset({FLAG}))
    args, settings, _ = runner_mod._settings(_ctx(), arm, harness)
    assert args[-2:] == [FLAG, "off"]
    assert settings["requested"][ARM_KEY] == "off"
    assert settings["applied"][ARM_KEY] == FLAG


def test_an_arm_without_it_adds_no_flag():
    arm = runner_mod.Arm(name="a", harness_commit=COMMIT, model=MODEL)
    harness = runner_mod._Harness(commit="a" * 40, flags=frozenset({FLAG}))
    args, _, _ = runner_mod._settings(_ctx(), arm, harness)
    assert FLAG not in args


def test_the_record_and_the_identity_name_the_setting():
    arm = runner_mod.Arm(name="a", harness_commit=COMMIT, model=MODEL, finish_reminder="on")
    harness = runner_mod._Harness(commit="a" * 40, flags=frozenset())
    identity = runner_mod._arm_identity(arm, harness)
    assert identity[ARM_KEY] == "on"
    base = runner_mod._base_record(("t", "a", 1), identity, {"id": "t"}, 1, [])
    assert base[ARM_KEY] == "on"


def test_an_arm_without_it_keeps_its_old_identity():
    arm = runner_mod.Arm(name="a", harness_commit=COMMIT, model=MODEL)
    harness = runner_mod._Harness(commit="a" * 40, flags=frozenset())
    assert ARM_KEY not in runner_mod._arm_identity(arm, harness)
    base = runner_mod._base_record(
        ("t", "a", 1), runner_mod._arm_identity(arm, harness), {"id": "t"}, 1, []
    )
    assert base[ARM_KEY] == runner_mod.SUPPORT_CONTRACT_DEFAULT


def test_a_commit_without_the_flag_is_refused_for_an_arm_that_sets_it():
    arm = runner_mod.Arm(name="a", harness_commit=COMMIT, model=MODEL, finish_reminder="on")
    prepared = {"full": runner_mod._Harness(commit="f" * 40, flags=frozenset({"--support-score"}))}
    problems = runner_mod._flag_problems([arm], {COMMIT: "full"}, prepared)
    assert len(problems) == 1
    assert FLAG in problems[0]


def _ctx():
    return runner_mod._Context(**_CTX_FIELDS)


_CTX_FIELDS: dict = {}


@pytest.fixture(autouse=True)
def _context_fields(tmp_path):
    _CTX_FIELDS.clear()
    _CTX_FIELDS.update(
        results=tmp_path,
        harness_root=tmp_path,
        checkouts={},
        python="python3",
        timeout_s=1.0,
        grace_s=1.0,
        excluded=[],
        retry_failed=False,
        untrusted_checkout=False,
        harness="pi",
        launcher=lambda launch: None,
        pi_on_path=None,
        progress=lambda message: None,
    )


def test_the_report_text_carries_the_counts(tmp_path, capsys):
    from tests.test_measure_broad_command import store

    results = store(tmp_path / "results", _records([True, False, False, False, False, False]))
    assert main(["measure", "report", str(results)]) == 0
    assert f"arm {OFF}: 0 of 3 runs ended without finish; 1 of 3 reminded to finish" in (
        capsys.readouterr().out
    )
