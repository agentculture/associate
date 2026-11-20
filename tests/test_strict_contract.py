"""Strict facts t1: the facts schema and the accuracy settings for strict facts.

Covers c22, c25, c39 of docs/specs/2026-11-19-associate-strict-facts.md.
"""

import copy

import pytest

from associate import contract
from associate.contract import validate

OLD_FACT = {"id": "f1", "value": "v", "source": "w1", "quote": "a quote long enough"}


def _facts(*facts, **extra):
    return {"facts": list(facts), **extra}


def _schema_errors(payload):
    return validate.validate(payload, contract.load_schema("facts"))


def _all_errors(payload):
    return _schema_errors(payload) + validate.validate_facts(payload)


@pytest.fixture
def acc():
    return copy.deepcopy(contract.load_accuracy())


def test_old_shape_still_validates():
    assert _all_errors(_facts(OLD_FACT)) == []
    assert _all_errors(_facts({**OLD_FACT, "action": True, "tool": "read"})) == []


def test_schema_version_field_is_accepted():
    assert _all_errors(_facts(OLD_FACT, schema_version=2)) == []
    assert _schema_errors(_facts(OLD_FACT, schema_version="2"))


@pytest.mark.parametrize("kind", ["direct", "llm", "derived"])
def test_every_kind_is_accepted(kind):
    fact = {**OLD_FACT, "kind": kind, "based_on": ["f2"]}
    assert _all_errors(_facts(fact)) == []


def test_unknown_kind_is_refused():
    errors = _all_errors(_facts({**OLD_FACT, "kind": "guess"}))
    assert any("kind" in e for e in errors)


def test_at_lines_or_search_replaces_the_quote():
    lines = {"id": "f1", "source": "w1", "at": {"lines": [3, 5]}}
    search = {"id": "f1", "source": "w1", "at": {"search": "version"}}
    assert _all_errors(_facts(lines)) == []
    assert _all_errors(_facts(search)) == []
    # a direct fact may omit value too
    assert _all_errors(_facts({**search, "value": "v"})) == []


@pytest.mark.parametrize(
    "at",
    [
        {},
        {"lines": [1, 2], "search": "x"},
        {"lines": [1]},
        {"lines": [0, 2]},
        {"lines": [5, 2]},
        {"lines": [1.5, 2]},
        {"lines": [True, 2]},
        {"search": "  "},
        {"other": 1},
    ],
)
def test_bad_at_is_refused(at):
    fact = {"id": "f1", "source": "w1", "at": at}
    assert _all_errors(_facts(fact))


def test_fact_needs_at_or_quote():
    fact = {"id": "f1", "source": "w1", "value": "v"}
    assert any("at or quote" in e for e in _all_errors(_facts(fact)))


def test_llm_and_derived_need_a_value():
    for kind in ("llm", "derived"):
        fact = {"id": "f1", "source": "w1", "quote": "q", "kind": kind, "based_on": ["f2"]}
        assert any("value" in e for e in _all_errors(_facts(fact))), kind


def test_derived_needs_non_empty_based_on():
    fact = {**OLD_FACT, "kind": "derived"}
    assert any("based_on" in e for e in _all_errors(_facts(fact)))
    assert any("based_on" in e for e in _all_errors(_facts({**fact, "based_on": []})))
    assert _schema_errors(_facts({**fact, "based_on": ["x1"]}))
    assert _all_errors(_facts({**fact, "based_on": ["f2"]})) == []


def test_accuracy_is_version_2_with_the_strict_block(acc):
    assert acc["version"] == 2
    strict = acc["strict"]
    assert strict["enabled"] == {"worker": True, "cortex": True, "senses": False, "super-vl": False}
    assert strict["keep_marked"] == ["part", "little"]
    assert strict["drop"] == ["none"]
    assert strict["mark_text"] == "evidence shows part of the value"
    assert strict["derived_decides_drops"] is False
    assert strict["derived_question"]["question"].strip()
    assert list(strict["derived_question"]["options"]) == [
        "yes",
        "mostly",
        "partly",
        "little",
        "no",
    ]
    assert strict["derived_passes"] == ["yes", "mostly"]
    assert "Version 2" in acc["$comment"]
    assert validate.validate(acc, contract.load_schema("accuracy")) == []
    assert validate.validate_accuracy(acc) == []


def test_strict_block_has_a_comment(acc):
    assert acc["strict"]["$comment"].strip()


def test_gate_is_untouched():
    assert contract.load_gate()["version"] == 9


def test_strict_rules_refuse_bad_values(acc):
    def errors(mutate):
        doc = copy.deepcopy(acc)
        mutate(doc["strict"])
        return [e for e in validate.validate_accuracy(doc) if e.startswith("strict")]

    assert errors(lambda s: s["enabled"].pop("senses"))
    assert errors(lambda s: s["enabled"].update(ghost=False))
    assert errors(lambda s: s["keep_marked"].append(""))
    assert errors(lambda s: s["keep_marked"].append("part"))
    assert errors(lambda s: s["drop"].append("part"))
    assert errors(lambda s: s.update(mark_text=" "))
    assert errors(lambda s: s["derived_question"].update(options={"yes": "x"}))
    assert errors(lambda s: s["derived_question"].update(question=""))
    assert errors(lambda s: s.update(derived_passes=[]))
    assert errors(lambda s: s.update(derived_passes=["yes", "yes"]))
    assert errors(lambda s: s.update(derived_passes=["all"]))
    assert errors(lambda s: s.pop("derived_passes"))
    assert not errors(lambda s: None)
