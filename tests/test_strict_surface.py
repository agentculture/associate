"""The strict-facts surface of the Python side (strict plan t7).

* ``associate run --strict on|off`` sets ``ASSOCIATE_STRICT`` for the run and
  clears it when the flag is absent; the result records ``strict_switch``.
* A strict export is not re-checked by evidence-cli (it reads only the quote
  shape): the re-check is reported as not run, and the extension's counts are
  printed under their own label.
* The model's last message is ``unchecked_final_reply``; the old ``final_reply``
  key is absent from the run result, not duplicated.

``tests/fixtures/strict_export`` is a real export: the extension's strict flow,
driven through three ``finish`` calls (a direct fact that passes, an llm fact the
decider answers ``none`` for, dropped), copied out of the extension's test
harness.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

import pytest

from associate import contract
from associate.accuracy.strict import STRICT_REASON
from associate.cli import main
from associate.harness.pi import PiHarness
from tests.test_run_accuracy import _FAKE_PI, _cli, _json, _task

FIXTURES = Path(__file__).parent / "fixtures"
STRICT_EXPORT = FIXTURES / "strict_export"
OLD_EXPORT = FIXTURES / "measure" / "answer" / "older" / "export"


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    root.mkdir()
    (root / "README.md").write_text("# fixture\n", encoding="utf-8")
    return root


def _files(directory: Path) -> dict[str, str]:
    return {
        str(p.relative_to(directory)): p.read_text(encoding="utf-8")
        for p in sorted(directory.rglob("*"))
        if p.is_file()
    }


# ---------------------------------------------------------------- --strict


def test_the_strict_flag_is_null_in_the_result_without_it(checkout, tmp_path, capsys):
    assert _cli(checkout, tmp_path, "stub") == 0
    assert _json(capsys)["strict_switch"] is None


@pytest.mark.parametrize("setting", ["on", "off"])
def test_the_strict_flag_is_recorded_in_the_result(checkout, tmp_path, capsys, setting):
    assert _cli(checkout, tmp_path, "stub", "--strict", setting) == 0
    assert _json(capsys)["strict_switch"] == setting


@pytest.mark.parametrize("value", ["yes", "ON", "true", ""])
def test_a_bad_strict_value_exits_1(checkout, tmp_path, value):
    with pytest.raises(SystemExit) as raised:
        _cli(checkout, tmp_path, "stub", "--strict", value)
    assert raised.value.code == 1


def _fake_pi_run(tmp_path: Path, files: dict[str, str], env=None, **kwargs: Any):
    script = tmp_path / "bin" / "pi"
    script.parent.mkdir(parents=True, exist_ok=True)
    source = _FAKE_PI.format(scenario={"files": files}).replace(
        '"support": os.environ.get("ASSOCIATE_SUPPORT_SCORE")',
        '"support": os.environ.get("ASSOCIATE_SUPPORT_SCORE"),'
        ' "strict": os.environ.get("ASSOCIATE_STRICT")',
    )
    script.write_text(source, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    harness = PiHarness(executable=str(script), env={**os.environ, **(env or {})}, **kwargs)
    root = tmp_path / "exports"
    (tmp_path / "checkout").mkdir(exist_ok=True)
    harness.start(
        checkout=tmp_path / "checkout",
        contract_dir=contract.contract_dir(),
        session_id="s1",
        export_dir=root,
    )
    harness.submit(_task(tmp_path))
    return harness.collect(), root


def _seen(root: Path) -> dict[str, Any]:
    return json.loads((root / "env-seen.json").read_text())


@pytest.mark.parametrize("setting", ["on", "off"])
def test_strict_reaches_the_extension_as_an_environment_variable(tmp_path, setting):
    result, root = _fake_pi_run(tmp_path, _files(STRICT_EXPORT), strict=setting)
    assert _seen(root)["strict"] == setting
    assert result["strict_switch"] == setting


@pytest.mark.parametrize("ambient", ["on", "off"])
def test_an_ambient_strict_value_is_not_inherited(tmp_path, ambient):
    result, root = _fake_pi_run(tmp_path, _files(STRICT_EXPORT), env={"ASSOCIATE_STRICT": ambient})
    assert _seen(root)["strict"] is None
    assert result["strict_switch"] is None


def test_the_run_flag_wins_over_an_ambient_strict_value(tmp_path):
    _, root = _fake_pi_run(
        tmp_path, _files(STRICT_EXPORT), env={"ASSOCIATE_STRICT": "on"}, strict="off"
    )
    assert _seen(root)["strict"] == "off"


def test_the_pi_adapter_refuses_any_other_strict_value():
    from associate.harness.base import HarnessError

    with pytest.raises(HarnessError, match="strict"):
        PiHarness(strict="maybe")


# ------------------------------------------------------- the run result


def test_a_strict_run_result_carries_the_extensions_counts_and_says_the_recheck_did_not_run(
    tmp_path,
):
    result, _ = _fake_pi_run(tmp_path, _files(STRICT_EXPORT), strict="on")
    strict = result["strict"]
    assert strict["source"] == "extension"
    assert strict["rounds_used"] == 2
    assert strict["retry_rounds"] == 2
    assert strict["counts"] == {
        "pass": 1,
        "keep_marked": 0,
        "returned": 0,
        "dropped": 1,
        "not_judged": 0,
    }
    assert strict["dropped"] == {"total": 1, "by_reason": {"decider_drop": 1}}
    assert strict["returned"] == 0
    assert strict["not_judged"] == 0
    assert strict["report"]["dropped"]["by_reason"] == {"decider_drop": 1}
    assert strict["recheck"] == {"ran": False, "reason": STRICT_REASON}
    accuracy = result["accuracy"]
    assert accuracy["python_recheck_ran"] is False
    assert accuracy["python_recheck_verdict"] is None
    assert accuracy["not_applicable_reason"] == STRICT_REASON
    assert accuracy["report"] is None
    assert accuracy["check_mode_used"] == "strict"
    assert "dropped" in result["answer"]


def test_a_strict_run_result_is_never_refused_by_the_old_shape(tmp_path):
    result, _ = _fake_pi_run(tmp_path, _files(STRICT_EXPORT))
    assert "quote_short" not in json.dumps(result)
    assert result["handback_outcome"] == "accepted"


def test_the_text_form_labels_the_counts_as_the_extensions(tmp_path):
    from associate.cli._commands.run import _render

    result, _ = _fake_pi_run(tmp_path, _files(STRICT_EXPORT), strict="on")
    text = _render(result)
    assert "strict_switch=on" in text
    assert "counted by the extension, not re-checked here" in text
    assert "dropped by reason decider_drop 1" in text
    assert "python re-check did not run (strict export" in text


def test_a_run_that_is_not_strict_has_no_strict_key(tmp_path):
    from tests.test_run_accuracy import _scenario

    result, _ = _fake_pi_run(tmp_path, _scenario(refused=False)["files"])
    assert "strict" not in result
    assert result["accuracy"]["python_recheck_ran"] is True


# ---------------------------------------------------- the rename


def test_run_json_names_the_unchecked_reply_and_has_no_final_reply(checkout, tmp_path, capsys):
    assert _cli(checkout, tmp_path, "stub") == 0
    out = _json(capsys)
    assert "final_reply" not in out
    assert "answer" in out


def test_a_result_with_the_unchecked_reply_does_not_carry_the_old_key(tmp_path):
    from associate.harness.pi import final_turn

    events = [
        {
            "type": "message_end",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
        }
    ]
    turn = final_turn(events)
    assert turn["unchecked_final_reply"] == "done"
    assert "final_reply" not in turn


def test_the_runs_service_reads_both_keys():
    from associate.runs.service import _reply_of

    assert _reply_of({"unchecked_final_reply": "new"}) == "new"
    assert _reply_of({"final_reply": "old"}) == "old"
    assert _reply_of({"unchecked_final_reply": "new", "final_reply": "old"}) == "new"


def test_the_measure_reader_reads_both_keys():
    from associate.measure.answer import model_answer, result_reply

    assert result_reply({"unchecked_final_reply": "new"}) == "new"
    assert result_reply({"final_reply": "old"}) == "old"
    assert model_answer({"unchecked_final_reply": "the model said so"}).text == "the model said so"
    assert model_answer({"final_reply": "an older harness"}).text == "an older harness"


# ------------------------------------------------------- associate check


def test_check_on_a_strict_export_says_the_recheck_did_not_run_and_prints_the_counts(capsys):
    assert main(["check", str(STRICT_EXPORT)]) == 0
    out = capsys.readouterr().out
    assert "not applicable: " + STRICT_REASON in out
    assert "quote_short" not in out
    assert "refused" not in out.split("Strict (")[0].split("Facts")[1]
    assert "Strict (counted by the extension, copied from the export; not a second check)" in out
    assert "rounds used 2 of 2" in out
    assert "dropped 1: decider_drop 1" in out
    assert "w1  read  ok" in out


def test_check_json_on_a_strict_export(capsys):
    assert main(["check", str(STRICT_EXPORT), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["applicable"] is False
    assert out["python_recheck_ran"] is False
    assert out["not_applicable_reason"] == STRICT_REASON
    assert out["facts"] == [] and out["verdicts"] == []
    assert "report" not in out
    assert out["strict"]["source"] == "extension"
    assert out["strict"]["dropped"] == {"total": 1, "by_reason": {"decider_drop": 1}}
    assert [c["id"] for c in out["calls"]][0] == "w1"


def test_check_still_loads_an_export_written_before_strict(capsys):
    assert main(["check", str(OLD_EXPORT)]) == 0
    out = capsys.readouterr().out
    assert "Strict (" not in out
    assert "not applicable" in out or "Each fact" in out


def test_check_loads_a_quote_shaped_export_from_the_pre_strict_extension(tmp_path, capsys):
    from tests.test_run_accuracy import _scenario

    export = tmp_path / "old"
    for name, content in _scenario(refused=False)["files"].items():
        (export / name).parent.mkdir(parents=True, exist_ok=True)
        (export / name).write_text(content, encoding="utf-8")
    assert main(["check", str(export), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert "strict" not in out
    assert out["applicable"] is True
    assert out["report"]["facts"]["passed"] == 1
    assert main(["check", str(export)]) == 0


def test_check_json_on_an_old_export_has_no_strict_key(capsys):
    assert main(["check", str(OLD_EXPORT), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert "strict" not in out


def test_a_damaged_strict_export_does_not_traceback(tmp_path, capsys):
    import shutil

    broken = tmp_path / "e"
    shutil.copytree(STRICT_EXPORT, broken)
    (broken / "report.json").write_text("{not json", encoding="utf-8")
    (broken / "check.json").write_text(json.dumps({"mode": "strict", "strict": []}))
    assert main(["check", str(broken), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["python_recheck_ran"] is False
    assert out["strict"]["counts"] is None
    assert out["strict"]["report"] is None
    assert main(["check", str(broken)]) == 0
    assert "Strict (" in capsys.readouterr().out
