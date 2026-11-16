"""Body-dependent authorisation: a field only an admin may change."""

from __future__ import annotations

import pytest

from associate.bridge.guards import ChangeGuard, GuardDenied, save_check
from associate.bridge.principal import Forbidden, Principal

ADMIN = Principal("root", "sso", frozenset({"admin"}))
EDITOR = Principal("ed", "sso", frozenset({"editor"}))

COMMANDS = ChangeGuard(
    code="commands_admin_only",
    label="a runner's commands",
    extract=lambda doc: (doc.get("params") or {}).get("commands"),
    applies=lambda doc: doc.get("kind") == "runner",
)


def doc(commands=None, kind="runner", id="r1"):
    return {"id": id, "kind": kind, "params": {"commands": commands} if commands else {}}


def test_an_admin_may_change_anything():
    COMMANDS.check(ADMIN, doc(), doc({"x": ["ls"]}))


def test_an_editor_may_save_an_unchanged_value():
    COMMANDS.check(EDITOR, doc({"x": ["ls"]}), doc({"x": ["ls"]}))
    COMMANDS.check(EDITOR, None, doc())


def test_an_editor_adding_changing_or_removing_is_denied():
    for before, after in [
        (doc(), doc({"x": ["ls"]})),
        (None, doc({"x": ["ls"]})),
        (doc({"x": ["ls"]}), doc({"x": ["rm"]})),
        (doc({"x": ["ls"]}), doc()),
    ]:
        with pytest.raises(GuardDenied) as ei:
            COMMANDS.check(EDITOR, before, after)
        assert ei.value.code == "commands_admin_only"
        assert ei.value.status == 403
        assert isinstance(ei.value, Forbidden)
        assert "ed" in ei.value.message and "r1" in ei.value.message


def test_values_compare_json_normalised():
    COMMANDS.check(EDITOR, doc({"x": ("ls",)}), doc({"x": ["ls"]}))


def test_false_zero_and_empty_are_values_not_absence():
    def with_value(value):
        return {"id": "r1", "kind": "runner", "params": {"commands": value}}

    for value in (False, 0, {}, [], ""):
        with pytest.raises(GuardDenied):
            COMMANDS.check(EDITOR, doc(), with_value(value))
        with pytest.raises(GuardDenied):
            COMMANDS.check(EDITOR, with_value(value), doc())
        COMMANDS.check(EDITOR, with_value(value), with_value(value))
    with pytest.raises(GuardDenied):
        COMMANDS.check(EDITOR, with_value(True), with_value(False))


def test_a_guard_that_does_not_apply_is_inert():
    COMMANDS.check(EDITOR, doc({"x": ["ls"]}, kind="agent"), doc({"x": ["rm"]}, kind="agent"))


def test_save_check_runs_every_guard_for_the_kind():
    check = save_check(EDITOR, {"actors": [COMMANDS]})
    check("machines", None, doc({"x": ["rm"]}))  # no guard for this kind
    with pytest.raises(GuardDenied):
        check("actors", None, doc({"x": ["rm"]}))
