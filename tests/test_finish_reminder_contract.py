"""Deviation d3 (issue #38): the contract settings for the finish reminder.

When a task run is about to settle and no ``finish`` was accepted, the
extension reminds the model once to call ``finish``. Its settings live in
``accuracy.json`` as the optional ``finish_reminder`` section: ``max`` (how many
reminders per run) and ``text`` (what the model is sent). A file without the
section means no reminder.
"""

import copy

import pytest

from associate import contract
from associate.contract import validate

SECTION = "finish_reminder"
TEXT = "text"
MAX = "max"


@pytest.fixture
def doc():
    return copy.deepcopy(contract.load_accuracy())


def _schema_errors(doc):
    return validate.validate(doc, contract.load_schema("accuracy"))


def test_the_shipped_file_holds_the_finish_reminder_settings():
    section = contract.load_accuracy()[SECTION]
    assert section[MAX] == 1
    assert isinstance(section[TEXT], str)
    assert "finish" in section[TEXT]
    assert "not measured" in section["$comment"].lower()


def test_the_shipped_file_is_valid_with_the_section():
    shipped = contract.load_accuracy()
    assert _schema_errors(shipped) == []
    assert validate.validate_accuracy(shipped) == []


def test_the_accuracy_file_stays_version_1():
    assert contract.load_accuracy()["version"] == 1


def test_every_setting_is_declared_in_the_schema():
    declared = contract.load_schema("accuracy")["properties"][SECTION]
    assert declared["additionalProperties"] is False
    assert {MAX, TEXT} <= set(declared["required"])
    assert set(contract.load_accuracy()[SECTION]) <= set(declared["properties"])


def test_the_section_is_optional(doc):
    del doc[SECTION]
    assert _schema_errors(doc) == []
    assert validate.validate_accuracy(doc) == []


@pytest.mark.parametrize("key", [MAX, TEXT])
def test_the_schema_requires_each_setting_once_the_section_is_there(doc, key):
    del doc[SECTION][key]
    assert _schema_errors(doc)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        (MAX, "1"),
        (MAX, 1.5),
        (MAX, True),
        (TEXT, 7),
        (TEXT, None),
        ("surprise", 1),
    ],
)
def test_the_schema_refuses_a_wrong_type_or_an_unknown_key(doc, key, value):
    doc[SECTION][key] = value
    assert _schema_errors(doc)


def test_the_schema_refuses_a_section_that_is_not_an_object(doc):
    doc[SECTION] = ["max", 1]
    assert _schema_errors(doc)


@pytest.mark.parametrize(
    ("key", "value"),
    [(MAX, 0), (MAX, -1), (MAX, True), (MAX, 2.5), (TEXT, "   "), (TEXT, 3)],
)
def test_the_validator_refuses_a_value_out_of_range(doc, key, value):
    doc[SECTION][key] = value
    errors = validate.validate_accuracy(doc)
    assert any(f"{SECTION}.{key}" in e for e in errors), errors


def test_the_validator_refuses_a_section_that_is_not_an_object(doc):
    doc[SECTION] = "on"
    errors = validate.validate_accuracy(doc)
    assert any(SECTION in e for e in errors), errors


def test_more_than_one_reminder_is_a_valid_file(doc):
    doc[SECTION][MAX] = 3
    assert _schema_errors(doc) == []
    assert validate.validate_accuracy(doc) == []


def test_the_reminder_wording_is_not_a_literal_in_associates_python():
    """The wording lives in accuracy.json only."""
    wording = contract.load_accuracy()[SECTION][TEXT]
    package = contract.contract_dir().parent
    sources = sorted(p for p in package.rglob("*.py") if "__pycache__" not in p.parts)
    assert len(sources) > 20, "fixture assumption: the package is scanned"
    restating = [str(p) for p in sources if wording in p.read_text(encoding="utf-8")]
    assert restating == []


REMINDER_LINE = {"id": "r1", "ts": "2026-11-19T10:00:00.000Z", "max": 1}


def test_a_reminder_walk_line_validates():
    assert validate.validate(REMINDER_LINE, contract.walk_reminder_schema()) == []


@pytest.mark.parametrize("key", ["id", "ts", "max"])
def test_a_reminder_walk_line_needs_each_field(key):
    line = {k: v for k, v in REMINDER_LINE.items() if k != key}
    assert validate.validate(line, contract.walk_reminder_schema())


@pytest.mark.parametrize(("key", "value"), [("id", "w1"), ("id", "r0"), ("max", "1")])
def test_a_reminder_walk_line_refuses_a_wrong_value(key, value):
    line = {**REMINDER_LINE, key: value}
    assert validate.validate(line, contract.walk_reminder_schema())


def test_the_walk_document_lists_reminder_lines():
    walk = contract.load_schema("walk")
    assert walk["properties"]["reminders"]["items"] == {"$ref": "#/$defs/reminder"}
    assert "reminder" in walk["description"]
