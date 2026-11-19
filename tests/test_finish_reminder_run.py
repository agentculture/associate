"""Deviation d3 (issue #38): the finish reminder in ``associate run`` and ``associate check``.

``associate run`` sets ``ASSOCIATE_FINISH_REMINDER`` (``on`` or ``off``) for
every run, never inherited from the operator's environment: ``--finish-reminder``
when given, else ``on`` when the contract has a ``finish_reminder`` section.
The extension writes ``reminder.json`` in the export only once it sent a
reminder; the run result always carries ``finish_reminder``
(``{"sent", "finish_followed"}``, ``finish_followed`` null when none was sent)
and ``finish_reminder_switch``. A scripted fake ``pi`` stands in for the
extension. No model runs here.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

import pytest

from associate import contract
from associate.accuracy import reminder
from associate.cli import main
from associate.cli._errors import EXIT_USER_ERROR
from associate.harness.base import HarnessError
from associate.harness.pi import FINISH_REMINDER_ENV, PiHarness, default_finish_reminder

ENV_SEEN = "env-seen.json"
SWITCH = "finish_reminder_switch"
RESULT = "finish_reminder"
FOLLOWED = "finish_followed"
UTF8 = "utf-8"
CHECKOUT = "checkout"
EXPORTS = "exports"
EXPORT = "export"
JSON_FLAG = "--json"
CHECK_VERB = "check"


def rec(sent: int | None, followed: bool | None) -> dict[str, Any]:
    """A reminder record as the result and reminder.json carry it."""
    return {"sent": sent, FOLLOWED: followed}


NONE_SENT = rec(0, None)
NOT_KNOWN = rec(None, None)
SECTION = "finish_reminder"

_FAKE_PI = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

FILES = {files!r}
argv = sys.argv[1:]
if "--version" in argv:
    print("1.5.2")
    raise SystemExit(0)
root = Path(os.environ["ASSOCIATE_EXPORT_ROOT"])
export = root / os.environ["ASSOCIATE_SESSION_ID"] / "export"
export.mkdir(parents=True, exist_ok=True)
(root / "env-seen.json").write_text(
    json.dumps({{"reminder": os.environ.get("ASSOCIATE_FINISH_REMINDER")}}), encoding="utf-8"
)
ready = {{
    "ok": True, "extension_version": "0.1.0", "contract_version": 1,
    "tools": ["associate_ready", "finish"], "active_tools": ["associate_ready", "finish"],
    "writer_tools_active": [], "session": {{"id": "x", "export_dir": str(export)}},
}}
(export / "ready.json").write_text(json.dumps(ready), encoding="utf-8")
if any(a.endswith("preflight.ts") for a in argv):
    raise SystemExit(0)
walk = [
    {{"format": {{"name": "associate-walk", "version": 2}}}},
    {{"run": {{"duration_ms": 1, "tool_calls": 0, "outcome": "ok", "truncated": False}}}},
]
(export / "walk.jsonl").write_text("".join(json.dumps(x) + "\\n" for x in walk), encoding="utf-8")
(export / "statements.md").write_text("# s\\n", encoding="utf-8")
for name, content in FILES.items():
    (export / name).write_text(content, encoding="utf-8")
print(json.dumps({{"type": "agent_end", "messages": []}}))
"""


def _task(tmp_path: Path) -> dict[str, str]:
    return {
        "id": "t-1",
        "prompt": "find it",
        CHECKOUT: str(tmp_path / CHECKOUT),
        "session_id": "s1",
        "export_dir": str(tmp_path / EXPORTS),
    }


def _pi(
    tmp_path: Path,
    *,
    files: dict[str, str] | None = None,
    env: dict[str, str] | None = None,
    **kwargs: Any,
) -> tuple[dict[str, Any], Path]:
    script = tmp_path / "bin" / "pi"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(_FAKE_PI.format(files=files or {}), encoding=UTF8)
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    base = {k: v for k, v in os.environ.items() if k != FINISH_REMINDER_ENV}
    harness = PiHarness(executable=str(script), env={**base, **(env or {})}, **kwargs)
    root = tmp_path / EXPORTS
    (tmp_path / CHECKOUT).mkdir(exist_ok=True)
    harness.start(
        checkout=tmp_path / CHECKOUT,
        contract_dir=contract.contract_dir(),
        session_id="s1",
        export_dir=root,
    )
    harness.submit(_task(tmp_path))
    return harness.collect(), root


def _seen(root: Path) -> Any:
    return json.loads((root / ENV_SEEN).read_text(encoding=UTF8))["reminder"]


def _without_section(monkeypatch: pytest.MonkeyPatch) -> None:
    doc = {k: v for k, v in contract.load_accuracy().items() if k != SECTION}
    monkeypatch.setattr(contract, "load_accuracy", lambda: doc)


# ----------------------------------------------------------------- the switch


def test_the_variable_is_associate_finish_reminder():
    assert FINISH_REMINDER_ENV == "ASSOCIATE_FINISH_REMINDER"


def test_the_default_is_on_when_the_contract_has_the_section():
    assert default_finish_reminder() == "on"


def test_the_default_is_off_without_the_section(monkeypatch: pytest.MonkeyPatch):
    _without_section(monkeypatch)
    assert default_finish_reminder() == "off"


def test_without_the_flag_the_run_is_switched_on_by_the_contract(tmp_path: Path):
    result, root = _pi(tmp_path)
    assert _seen(root) == "on"
    assert result[SWITCH] == "on"


def test_without_the_flag_or_the_section_the_run_is_switched_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _without_section(monkeypatch)
    result, root = _pi(tmp_path)
    assert _seen(root) == "off"
    assert result[SWITCH] == "off"


@pytest.mark.parametrize("setting", ["on", "off"])
def test_the_flag_reaches_the_extension(tmp_path: Path, setting: str):
    result, root = _pi(tmp_path, finish_reminder=setting)
    assert _seen(root) == setting
    assert result[SWITCH] == setting


@pytest.mark.parametrize(("ambient", "flag", "seen"), [("off", None, "on"), ("on", "off", "off")])
def test_an_operators_ambient_value_is_never_inherited(
    tmp_path: Path, ambient: str, flag: str | None, seen: str
):
    _, root = _pi(tmp_path, env={FINISH_REMINDER_ENV: ambient}, finish_reminder=flag)
    assert _seen(root) == seen


def test_the_pi_adapter_refuses_any_other_value():
    with pytest.raises(HarnessError, match="finish-reminder"):
        PiHarness(finish_reminder="maybe")


# ----------------------------------------------------------------- the result


def test_a_run_with_no_reminder_sent_says_so(tmp_path: Path):
    result, root = _pi(tmp_path)
    assert result[RESULT] == NONE_SENT
    assert not (root / "s1" / EXPORT / reminder.REMINDER_FILE).exists()


@pytest.mark.parametrize("followed", [True, False])
def test_a_reminder_the_extension_sent_is_copied_into_the_result(tmp_path: Path, followed: bool):
    record = json.dumps(rec(1, followed))
    result, _ = _pi(tmp_path, files={reminder.REMINDER_FILE: record})
    assert result[RESULT] == rec(1, followed)


# ----------------------------------------------------------------- reading the file


def _export(tmp_path: Path, text: str | None) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    if text is not None:
        (tmp_path / reminder.REMINDER_FILE).write_text(text, encoding=UTF8)
    return tmp_path


def test_no_file_is_none_sent(tmp_path: Path):
    assert reminder.run_field(_export(tmp_path, None)) == NONE_SENT
    assert reminder.read_reminder(tmp_path) is None


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        "[]",
        json.dumps(rec(0, False)),
        json.dumps({"sent": "1", FOLLOWED: False}),
        json.dumps({"sent": True, FOLLOWED: False}),
        json.dumps({"sent": 1, FOLLOWED: "yes"}),
        json.dumps({"sent": 1}),
    ],
)
def test_a_malformed_file_is_not_known_rather_than_none_sent(tmp_path: Path, text: str):
    assert reminder.run_field(_export(tmp_path, text)) == NOT_KNOWN


def test_a_linked_file_is_not_read(tmp_path: Path):
    real = tmp_path / "elsewhere.json"
    real.write_text(json.dumps(rec(1, True)), encoding=UTF8)
    export = tmp_path / EXPORT
    export.mkdir()
    (export / reminder.REMINDER_FILE).symlink_to(real)
    assert reminder.run_field(export) == NOT_KNOWN


@pytest.mark.parametrize(
    ("record", "words"),
    [
        (NONE_SENT, "none sent"),
        (rec(1, True), "sent 1; finish followed"),
        (rec(2, False), "sent 2; finish did not follow"),
        (NOT_KNOWN, "not readable"),
    ],
)
def test_describe(record: dict[str, Any], words: str):
    assert words in reminder.describe(record)


# ----------------------------------------------------------------- the CLI


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    path = tmp_path / CHECKOUT
    path.mkdir()
    return path


def _cli(checkout: Path, tmp_path: Path, *extra: str, json_mode: bool = True) -> int:
    argv = ["run", "--harness", "stub", "--checkout", str(checkout)]
    argv += ["--export-root", str(tmp_path / EXPORTS), "--model", "senses", *extra]
    return main([*argv, JSON_FLAG] if json_mode else argv)


def test_the_stub_run_records_the_contract_default(checkout: Path, tmp_path: Path, capsys):
    assert _cli(checkout, tmp_path) == 0
    assert json.loads(capsys.readouterr().out)[SWITCH] == "on"


@pytest.mark.parametrize("setting", ["on", "off"])
def test_the_flag_is_recorded_in_the_result(checkout: Path, tmp_path: Path, capsys, setting: str):
    assert _cli(checkout, tmp_path, "--finish-reminder", setting) == 0
    assert json.loads(capsys.readouterr().out)[SWITCH] == setting


@pytest.mark.parametrize("value", ["yes", "ON", ""])
def test_a_bad_flag_value_exits_1(checkout: Path, tmp_path: Path, value: str):
    with pytest.raises(SystemExit) as raised:
        _cli(checkout, tmp_path, "--finish-reminder", value)
    assert raised.value.code == EXIT_USER_ERROR


def test_the_text_form_prints_one_reminder_line():
    from associate.cli._commands.run import _render

    text = _render({"outcome": "ok", RESULT: rec(1, True)})
    assert "finish_reminder=sent 1; finish followed" in text.splitlines()


# ----------------------------------------------------------------- associate check


def _check_export(tmp_path: Path) -> Path:
    export = tmp_path / EXPORT
    (export / "results").mkdir(parents=True)
    lines = [
        {"format": {"name": "associate-walk", "version": 2}},
        {"run": {"duration_ms": 1, "tool_calls": 0, "outcome": "ok", "truncated": False}},
    ]
    (export / "walk.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines), UTF8)
    return export


def test_check_prints_the_reminder_an_export_holds(tmp_path: Path, capsys):
    export = _check_export(tmp_path)
    record = rec(1, False)
    (export / reminder.REMINDER_FILE).write_text(json.dumps(record), encoding=UTF8)
    assert main([CHECK_VERB, str(export), JSON_FLAG]) == 0
    assert json.loads(capsys.readouterr().out)[RESULT] == record
    assert main([CHECK_VERB, str(export)]) == 0
    assert "Finish reminder: sent 1; finish did not follow" in capsys.readouterr().out


def test_check_says_nothing_of_a_reminder_for_an_export_without_one(tmp_path: Path, capsys):
    export = _check_export(tmp_path)
    assert main([CHECK_VERB, str(export), JSON_FLAG]) == 0
    assert RESULT not in json.loads(capsys.readouterr().out)
    assert main([CHECK_VERB, str(export)]) == 0
    assert "Finish reminder" not in capsys.readouterr().out
