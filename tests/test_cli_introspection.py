"""Tests for the introspection verbs: overview, cli overview, doctor."""

from __future__ import annotations

import json

import pytest

from associate.cli import main

# --- overview -------------------------------------------------------------


def test_overview_text(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["overview"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "# associate" in out
    assert "Identity" in out


def test_overview_json_shape(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["overview", "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["subject"] == "associate"
    assert isinstance(payload["sections"], list)
    assert payload["sections"]


def test_overview_graceful_on_bad_path(capsys: pytest.CaptureFixture[str]) -> None:
    # Rubric contract: descriptive verbs never hard-fail on a missing target.
    rc = main(["overview", "/no/such/path/here"])
    assert rc == 0
    assert capsys.readouterr().out.strip()


# --- cli overview ---------------------------------------------------------


def test_cli_overview_text(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["cli", "overview"])
    assert rc == 0
    assert "# associate cli" in capsys.readouterr().out


def test_cli_overview_json_shape(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["cli", "overview", "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["subject"] == "associate cli"
    assert isinstance(payload["sections"], list)


def test_cli_noun_bare_is_non_empty(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["cli"])
    assert rc == 0
    assert capsys.readouterr().out.strip()


def test_cli_overview_unknown_flag_structured_error(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # `cli overview` parse errors must route through the structured error
    # contract (error:/hint: + exit 1), not argparse's default stderr/exit 2.
    with pytest.raises(SystemExit) as exc:
        main(["cli", "overview", "--bogus"])
    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert err.startswith("error:")
    assert "hint:" in err


# --- doctor ---------------------------------------------------------------


def test_doctor_text(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["doctor"])
    assert rc in (0, 1)
    assert "associate doctor" in capsys.readouterr().out


def test_doctor_json_shape(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["doctor", "--json"])
    assert rc in (0, 1)
    payload = json.loads(capsys.readouterr().out)
    assert isinstance(payload["healthy"], bool)
    assert isinstance(payload["checks"], list)
    assert payload["checks"]
    for check in payload["checks"]:
        assert {"id", "passed", "severity", "message", "remediation"} <= set(check)


def test_explain_run_mentions_turn_fields(capsys: pytest.CaptureFixture[str]) -> None:
    """`associate explain run` documents the run result's turn fields."""
    rc = main(["explain", "run"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "final_reply" in out
    assert "stop_reason" in out
    assert "lane_error" in out


def test_explain_run_documents_the_accuracy_fields_and_exit_3(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`associate explain run` documents the hand-back result fields and exit code 3."""
    rc = main(["explain", "run"])
    assert rc == 0
    out = capsys.readouterr().out
    for needle in (
        "answer",
        "answer_path",
        "handback_outcome",
        "refused_after_rounds",
        "refused_unresolved",
        "python_recheck_ran",
        "python_recheck_verdict",
        "unchecked_text",
        "--check-mode",
        "check_mode",
        "ASSOCIATE_CHECK_MODE",
        "--support-score",
        "support_score",
        "ASSOCIATE_SUPPORT_SCORE",
        "--finish-reminder",
        "finish_reminder_switch",
        "finish_followed",
        "ASSOCIATE_FINISH_REMINDER",
        "Exit codes",
        "`3`",
    ):
        assert needle in out, needle


def test_doctor_recognizes_declared_backend(capsys: pytest.CaptureFixture[str]) -> None:
    """The repo's own declared backend must be a known one — doctor stays healthy.

    Guards the backend-consistency invariant: a promotion that changes
    ``culture.yaml``'s backend without teaching ``doctor`` the matching prompt
    file would otherwise slip through (the shape tests above tolerate rc==1).
    """
    rc = main(["doctor", "--json"])
    payload = json.loads(capsys.readouterr().out)
    messages = " ".join(str(c["message"]) for c in payload["checks"])
    assert "unknown backend" not in messages
    assert rc == 0
    assert payload["healthy"] is True


def test_learn_names_the_finish_reminder_flag(capsys: pytest.CaptureFixture[str]) -> None:
    """`associate learn` lists --finish-reminder with run's flags, in text and JSON."""
    assert main(["learn"]) == 0
    assert "--finish-reminder" in capsys.readouterr().out
    assert main(["learn", "--json"]) == 0
    assert "--finish-reminder" in capsys.readouterr().out


def test_explain_check_and_measure_document_the_reminder(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`associate explain check` names reminder.json; `explain measure` the arm key and count."""
    assert main(["explain", "check"]) == 0
    assert "reminder.json" in capsys.readouterr().out
    assert main(["explain", "measure"]) == 0
    out = capsys.readouterr().out
    assert '"finish_reminder"' in out
    assert "reminded to finish" in out
