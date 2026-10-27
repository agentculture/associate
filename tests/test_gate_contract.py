"""t5: the safety-gate question set (gate.json) and the walk's gate/child lines.

Covers c32 (gate question set, CLEF then Super then read-only) and h19 (a gate
decision and a child-walk link are observable in the walk).
"""

import copy

import pytest

from associate import contract
from associate.contract import validate


@pytest.fixture()
def doc():
    return copy.deepcopy(contract.load_gate())


def test_shipped_gate_json_is_valid():
    assert validate.validate_gate(contract.load_gate()) == []
    assert validate.validate(contract.load_gate(), contract.load_schema("gate")) == []


def test_gate_names_the_decider_endpoint(doc):
    assert doc["decider"]["path"] == "/v1/systemone"
    assert doc["decider"]["domain"] == "general"


def test_gate_reuses_policy_redaction_instead_of_copying_patterns(doc):
    assert doc["redaction"]["policy_ref"] == "policy.json#/redaction"
    assert "patterns" not in doc["redaction"]


def test_unknown_top_level_field_rejected(doc):
    doc["surprise"] = 1
    assert validate.validate_gate(doc)


def test_threshold_out_of_range_rejected(doc):
    doc["clef"]["allow_when"][0]["value"] = 1.5
    assert any("[0, 1]" in e for e in validate.validate_gate(doc))


def test_rule_naming_unknown_question_rejected(doc):
    doc["clef"]["allow_when"][0]["question"] = "nope"
    assert any("nope" in e for e in validate.validate_gate(doc))


def test_rule_on_choice_needs_a_real_option(doc):
    rule = next(r for r in doc["clef"]["allow_when"] if "option" in r)
    rule["option"] = "bogus"
    assert any("bogus" in e for e in validate.validate_gate(doc))


def test_rule_on_noul_must_not_name_an_option(doc):
    doc["clef"]["allow_when"][0]["option"] = "x"
    assert validate.validate_gate(doc)


def test_choice_question_needs_criteria(doc):
    doc["questions"]["reversibility"].pop("criteria")
    assert validate.validate_gate(doc)


def test_super_rule_must_cover_known_questions_with_right_types(doc):
    doc["super"]["allow_when"]["ghost"] = True
    assert any("ghost" in e for e in validate.validate_gate(doc))
    doc = copy.deepcopy(contract.load_gate())
    doc["super"]["allow_when"]["safe_unattended"] = "yes"
    assert validate.validate_gate(doc)
    doc = copy.deepcopy(contract.load_gate())
    doc["super"]["allow_when"]["reversibility"] = ["nonsense"]
    assert validate.validate_gate(doc)


def test_every_question_is_ruled_on_by_both_tiers(doc):
    doc["super"]["allow_when"].pop("matches_task")
    assert any("matches_task" in e for e in validate.validate_gate(doc))


# --- walk lines ---------------------------------------------------------------

CLEF_GATE = {
    "id": "g1",
    "ts": "2026-10-27T10:00:00+00:00",
    "tier": "clef",
    "question_set_version": 1,
    "gated_tool": "write",
    "gated_id": "w3",
    "probabilities": {"safe_unattended": 0.93, "reversibility": {"reversible": 0.8}},
    "decision": "allow",
}
SUPER_GATE = {
    "id": "g2",
    "ts": "2026-10-27T10:00:01+00:00",
    "tier": "super",
    "question_set_version": 1,
    "gated_tool": "edit",
    "verdict": {"safe_unattended": True, "reversibility": "recoverable"},
    "decision": "refuse",
}
READONLY_GATE = {
    "id": "g3",
    "ts": "2026-10-27T10:00:02+00:00",
    "tier": "readonly",
    "question_set_version": 1,
    "gated_tool": "shell",
    "decision": "refuse",
}
CHILD = {
    "id": "c1",
    "ts": "2026-10-27T10:00:03+00:00",
    "child_model": "senses",
    "child_walk": "/x/exports/s-1/walk.jsonl",
    "child_session_id": "s-1",
}


def test_gate_lines_validate():
    schema = contract.walk_gate_schema()
    for line in (CLEF_GATE, SUPER_GATE, READONLY_GATE):
        assert validate.validate_walk_gate(line) == [], line
        assert validate.validate(line, schema) == [], line


def test_gate_line_missing_tier_rejected():
    line = {k: v for k, v in CLEF_GATE.items() if k != "tier"}
    assert validate.validate(line, contract.walk_gate_schema())
    assert validate.validate_walk_gate(line)


def test_gate_line_bad_tier_or_decision_rejected():
    assert validate.validate_walk_gate({**CLEF_GATE, "tier": "oracle"})
    assert validate.validate_walk_gate({**CLEF_GATE, "decision": "maybe"})


def test_clef_gate_needs_probabilities_super_needs_verdict():
    no_probs = {k: v for k, v in CLEF_GATE.items() if k != "probabilities"}
    assert validate.validate_walk_gate(no_probs)
    no_verdict = {k: v for k, v in SUPER_GATE.items() if k != "verdict"}
    assert validate.validate_walk_gate(no_verdict)
    assert validate.validate_walk_gate({**CLEF_GATE, "verdict": {"a": True}})


def test_child_link_validates_and_rejects_missing_fields():
    schema = contract.walk_child_schema()
    assert validate.validate(CHILD, schema) == []
    for key in ("child_model", "child_walk", "child_session_id"):
        assert validate.validate({k: v for k, v in CHILD.items() if k != key}, schema), key


def test_existing_entry_lines_stay_valid():
    entry = {
        "id": "w1",
        "ts": "2026-10-27T10:00:00+00:00",
        "tool": "read",
        "args": {},
        "result": {"content": "x"},
        "truncated": False,
    }
    assert validate.validate(entry, contract.walk_entry_schema()) == []


def test_walk_document_accepts_gates_and_children():
    document = {
        "entries": [],
        "gates": [CLEF_GATE],
        "children": [CHILD],
        "run": {"duration_ms": 1, "tool_calls": 0, "outcome": "ok", "truncated": False},
    }
    assert validate.validate(document, contract.load_schema("walk")) == []
