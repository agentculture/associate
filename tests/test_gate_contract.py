"""t5: the safety-gate question set (gate.json) and the walk's gate/child lines.

Covers c32 (gate question set, CLEF then Super then read-only) and h19 (a gate
decision and a child-walk link are observable in the walk).
"""

import copy

import pytest

from associate import contract
from associate.contract import validate


@pytest.fixture
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


def test_super_tier_names_its_model_by_registry_key(doc):
    """t10: the gate library locates Super through a models.json key, not a literal."""
    key = doc["super"]["model"]
    assert key in contract.load_models()["models"]


def test_super_model_must_be_a_registry_key(doc):
    doc["super"]["model"] = "no-such-model"
    assert any("no-such-model" in e for e in validate.validate_gate(doc))


def test_super_model_is_required(doc):
    doc["super"].pop("model")
    assert validate.validate_gate(doc)


# ------------------------------------------- d8: the isolation state field


def test_the_decider_state_says_where_a_call_lands(doc):
    """d8: CLEF is told whether a call runs in a disposable run worktree."""
    assert doc["version"] >= 2
    assert "isolation" in doc["state_fields"]
    describe = doc["isolation"]["describe"]
    assert set(describe) == {"worktree", "in-place"}
    assert all(isinstance(text, str) and text.strip() for text in describe.values())


@pytest.mark.parametrize("mode", ["worktree", "in-place"])
def test_an_isolation_mode_without_a_description_is_rejected(doc, mode):
    del doc["isolation"]["describe"][mode]
    assert validate.validate_gate(doc)


def test_the_isolation_section_is_required_when_the_state_names_it(doc):
    del doc["isolation"]
    assert validate.validate_gate(doc)


# ------------------------------------------- d9: tentative thresholds (#13)

#: docs/notes/gate-calibration.md, v2 `worktree` state: the lowest score of a
#: legitimate edit/write and the highest score of a harmful one, per question.
MEASURED_BAND = {
    "safe_unattended": (0.146, 0.714),
    "matches_task": (0.043, 0.701),
}


@pytest.mark.parametrize("question", sorted(MEASURED_BAND))
def test_clef_thresholds_sit_inside_the_measured_band(doc, question):
    """d9: a `>=` threshold must refuse every measured harmful probe and admit
    every measured legitimate one. Re-measure (issue #13) before moving it out."""
    harmful_max, legitimate_min = MEASURED_BAND[question]
    (rule,) = [r for r in doc["clef"]["allow_when"] if r["question"] == question]
    assert rule["op"] == ">="
    assert harmful_max < rule["value"] <= legitimate_min


def test_the_thresholds_are_marked_tentative_and_point_at_the_benchmark(doc):
    assert doc["version"] >= 3
    assert "#13" in doc["clef"]["$comment"]


# ------------------------------------- d10: the state says what a tool does


def _gate_reachable_tools() -> set[str]:
    models = contract.load_models()
    return set(models["mutating_tools"]) | set(models["gated_tools"])


def test_every_tool_that_can_reach_the_gate_has_an_effect(doc):
    """d10: CLEF is told what the tool does, not only its name."""
    assert doc["version"] >= 4
    assert "effect" in doc["state_fields"]
    effects = {tool: text for tool, text in doc["effects"].items() if tool != "$comment"}
    assert set(effects) == _gate_reachable_tools()
    assert all(text.strip() for text in effects.values())


def test_a_gate_reachable_tool_without_an_effect_is_rejected(doc):
    del doc["effects"]["ledger_append"]
    errors = validate.validate_gate(doc, contract.load_models())
    assert any("ledger_append" in e for e in errors)


def test_an_effect_for_a_tool_the_gate_never_sees_is_rejected(doc):
    doc["effects"]["read"] = "reads a file"
    errors = validate.validate_gate(doc, contract.load_models())
    assert any("read" in e for e in errors)


def test_the_isolation_line_is_only_sent_for_tools_that_write_into_the_checkout(doc):
    """d10: ledger/memory/web calls write elsewhere or off the machine, so the
    worktree line says nothing true about them and is left out."""
    assert set(doc["isolation"]["applies_to"]) == {"write", "edit", "bash", "run_tests"}
    assert set(doc["isolation"]["applies_to"]) <= _gate_reachable_tools()


def test_the_isolation_line_only_speaks_about_the_checkout(doc):
    """d10: true for every tool, including ones that write outside the checkout."""
    for text in doc["isolation"]["describe"].values():
        assert "checkout" in text
        assert not text.lower().startswith("this action runs")


# ----------------------- d11: matches_task covers prompt-mandated duties


def test_matches_task_counts_the_duties_the_runtime_prompt_assigns(doc):
    """d11: CLEF never sees the runtime prompt, so the question names the
    evidence-logging, memory and research duties it assigns to every run."""
    assert doc["version"] >= 5
    wording = doc["questions"]["matches_task"]["instructions"]
    for duty in ("evidence-logging", "memory", "research", "runtime prompt"):
        assert duty in wording
    assert "nothing beyond" in wording


# ----------------------- d12: run_tests runs the operator's test commands


def test_run_tests_has_a_truthful_effect_and_the_isolation_line(doc):
    """d12: run_tests executes the checkout's own code in the checkout, so the
    decider is told so, and the run's isolation line is sent with it."""
    assert doc["version"] >= 6
    effect = doc["effects"]["run_tests"]
    for fact in ("operator", "checkout", "reverted", "lane key"):
        assert fact in effect, fact
    assert "run_tests" in doc["isolation"]["applies_to"]
    assert "d12" in doc["effects"]["$comment"]
