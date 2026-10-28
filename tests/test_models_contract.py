"""t4: the per-model registry (models.json) and its validation.

Covers c3 (per-model tool surface), h4 (senses cannot mutate; only cortex
spawns) and c10 (no text_only claim in role.json).
"""

import copy

import pytest

from associate import contract
from associate.contract import validate


@pytest.fixture
def doc():
    return copy.deepcopy(contract.load_models())


def test_shipped_models_json_is_valid():
    assert validate.validate_models(contract.load_models()) == []


def test_models_schema_is_self_identified():
    schema = contract.load_schema("models")
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$id"].endswith("models.schema.json")
    assert validate.validate(contract.load_models(), schema) == []


def test_unknown_field_on_a_model_is_rejected(doc):
    doc["models"]["worker"]["surprise"] = 1
    assert any("surprise" in e for e in validate.validate_models(doc))
    assert validate.validate(doc, contract.load_schema("models"))


def test_tool_not_in_the_registered_set_is_rejected(doc):
    doc["models"]["senses"]["tools"].append("teleport")
    errors = validate.validate_models(doc)
    assert any("teleport" in e for e in errors)


def test_flags_and_spawn_per_model():
    models = contract.load_models()["models"]
    assert models["senses"]["may_mutate"] is False
    assert models["worker"]["may_mutate"] is True
    assert models["cortex"]["may_mutate"] is True
    assert models["cortex"]["may_spawn"] == ["worker", "senses"]
    for name in ("worker", "senses"):
        assert models[name]["may_spawn"] == []
    assert models["super-vl"]["status"] == "pending"
    assert all(models[n]["status"] == "active" for n in ("worker", "senses", "cortex"))


def test_senses_has_no_writer_tools():
    senses = set(contract.load_models()["models"]["senses"]["tools"])
    assert senses.isdisjoint({"write", "edit", "bash", "ledger_append", "ledger_list"})
    assert "spawn_subagent" not in senses


def test_only_spawners_hold_spawn_subagent():
    for name, m in contract.load_models()["models"].items():
        assert ("spawn_subagent" in m["tools"]) == bool(m["may_spawn"]), name


def test_non_mutating_model_with_a_writer_tool_is_rejected(doc):
    doc["models"]["senses"]["tools"].append("write")
    assert any("may_mutate" in e for e in validate.validate_models(doc))


def test_exactly_one_default_and_it_is_worker(doc):
    assert doc["default"] == "worker"
    doc["default"] = "ghost"
    assert validate.validate_models(doc)


def test_pending_model_cannot_be_the_default(doc):
    doc["default"] = "super-vl"
    assert any("pending" in e for e in validate.validate_models(doc))


def test_unknown_model_in_may_spawn_is_rejected(doc):
    doc["models"]["cortex"]["may_spawn"].append("nobody")
    assert any("nobody" in e for e in validate.validate_models(doc))


def test_prompt_file_shape_is_checked_but_existence_is_not(doc):
    doc["models"]["worker"]["prompt_file"] = "../escape.md"
    assert validate.validate_models(doc)
    doc = copy.deepcopy(contract.load_models())
    doc["models"]["worker"]["prompt_file"] = "/abs/worker.md"
    assert validate.validate_models(doc)
    doc = copy.deepcopy(contract.load_models())
    doc["models"]["worker"]["prompt_file"] = ".pi/extensions/associate/prompts/worker.txt"
    assert validate.validate_models(doc)


def test_lobes_role_is_never_a_checkpoint_id(doc):
    for m in doc["models"].values():
        assert "/" not in m["lobes_role"]
        assert "NVIDIA" not in m["lobes_role"]


def test_reasoning_never_reintroduces_nemotron_switch():
    text = (contract.contract_dir() / "models.json").read_text(encoding="utf-8")
    assert "enable_thinking" not in text
    assert "nemotron" not in text.lower()


def test_role_json_no_longer_claims_text_only():
    role = contract.load_role()
    assert "text_only" not in role["notes"]
    assert "vision tower" not in str(role)


def test_policy_shell_allows_eidetic_and_ledger_argv():
    allow = {e["command"]: e["subcommands"] for e in contract.load_policy()["shell"]["allowlist"]}
    assert allow["eidetic"] == ["recall", "remember"]
    assert allow["ledger"] == ["append", "list"]
    assert allow["rg"] == []
    assert "git" in allow


def test_endpoint_default_is_declared_and_required(doc):
    assert doc["endpoint"]["default_base_url"].startswith("http")
    del doc["endpoint"]
    assert validate.validate_models(doc)


def test_policy_shell_read_only_subset_excludes_the_writing_subcommands():
    """Risk r9 (plan t12): the allowlist is a permission list; read_only is the classification."""
    shell = contract.load_policy()["shell"]
    allow = {e["command"]: e["subcommands"] for e in shell["allowlist"]}
    read_only = {e["command"]: e["subcommands"] for e in shell["read_only"]["commands"]}
    assert read_only["eidetic"] == ["recall"]
    assert read_only["ledger"] == ["list"]
    for command, subcommands in read_only.items():
        assert command in allow, f"{command} is read-only but not allowlisted"
        assert set(subcommands) <= set(allow[command]), command


def test_gated_tools_gate_memory_and_web_without_making_them_mutations():
    """Deviations d6 (r17), d7 and d18: memory writes, web egress and a delegated
    run are gated for every model."""
    doc = contract.load_models()
    assert doc["gated_tools"] == ["eidetic_remember", "web_search", "web_page", "delegate_run"]
    assert doc["mutating_tools"] == ["write", "edit", "bash", "ledger_append", "run_tests"]
    for tool in doc["gated_tools"]:
        assert tool not in doc["mutating_tools"]
        assert tool in doc["models"]["senses"]["tools"], f"senses keeps {tool}"


def test_gated_tools_is_required(doc):
    del doc["gated_tools"]
    assert any("gated_tools" in e for e in validate.validate_models(doc))


def test_gated_tool_not_in_tool_names_is_rejected(doc):
    doc["gated_tools"].append("teleport")
    errors = validate.validate_models(doc)
    assert any("gated_tools" in e and "teleport" in e for e in errors)


def test_gated_tool_also_mutating_is_rejected(doc):
    doc["gated_tools"].append("write")
    errors = validate.validate_models(doc)
    assert any("gated_tools" in e and "'write'" in e and "disjoint" in e for e in errors)


def test_gated_tools_duplicate_is_rejected(doc):
    doc["gated_tools"].append("eidetic_remember")
    assert any("duplicate" in e for e in validate.validate_models(doc))


def test_run_tests_is_a_mutation_held_only_by_models_that_may_change_code():
    """Deviation d12: run_tests executes repository code, so it is a mutation
    (gated by CLEF) and senses never holds it."""
    doc = contract.load_models()
    assert "run_tests" in doc["tool_names"]
    assert "run_tests" in doc["mutating_tools"]
    assert "run_tests" not in doc["gated_tools"]
    holders = {name for name, m in doc["models"].items() if "run_tests" in m["tools"]}
    assert {"worker", "cortex", "super-vl"} <= holders  # super-vl: d15
    assert "senses" not in holders
    for name in holders:
        assert doc["models"][name]["may_mutate"] is True, name


# ------------------------------- d18: the resident hands writes to a run


def test_senses_delegates_only_to_worker_and_nobody_else_delegates():
    """d18: the read-only resident hands writing tasks to a worker run; no
    other model holds the delegation pair (worker and cortex write themselves)."""
    models = contract.load_models()["models"]
    assert models["senses"]["may_delegate"] == ["worker"]
    for name in ("worker", "cortex", "super-vl"):
        assert models[name]["may_delegate"] == [], name
    for name, m in models.items():
        for tool in ("delegate_run", "delegate_status"):
            assert (tool in m["tools"]) == bool(m["may_delegate"]), (name, tool)
    assert models["senses"]["may_mutate"] is False


def test_delegate_run_is_gated_and_delegate_status_is_a_read():
    doc = contract.load_models()
    assert "delegate_run" in doc["gated_tools"]
    for tool in ("delegate_run", "delegate_status"):
        assert tool in doc["tool_names"]
        assert tool not in doc["mutating_tools"]
    assert "delegate_status" not in doc["gated_tools"]


def test_may_delegate_is_required(doc):
    del doc["models"]["worker"]["may_delegate"]
    assert any("may_delegate" in e for e in validate.validate_models(doc))


@pytest.mark.parametrize(
    ("target", "fragment"),
    [("nobody", "unknown"), ("senses", "itself"), ("super-vl", None)],
)
def test_bad_delegate_targets_are_rejected(doc, target, fragment):
    doc["models"]["senses"]["may_delegate"] = [target]
    errors = validate.validate_models(doc)
    if fragment is None:
        # super-vl may mutate and does not delegate: a valid (if pending) target.
        assert errors == []
    else:
        assert any("may_delegate" in e and fragment in e for e in errors), errors


def test_a_delegate_target_that_may_not_mutate_is_rejected(doc):
    doc["models"]["cortex"]["may_delegate"] = ["senses"]
    doc["models"]["cortex"]["tools"] += ["delegate_run", "delegate_status"]
    errors = validate.validate_models(doc)
    assert any("'senses', which may not mutate" in e for e in errors), errors


def test_a_delegate_target_that_delegates_is_rejected(doc):
    doc["models"]["worker"]["may_delegate"] = ["cortex"]
    doc["models"]["worker"]["tools"] += ["delegate_run", "delegate_status"]
    errors = validate.validate_models(doc)
    assert any("'worker', which delegates" in e for e in errors), errors


def test_delegation_tools_and_may_delegate_go_together(doc):
    doc["models"]["senses"]["tools"].remove("delegate_status")
    errors = validate.validate_models(doc)
    assert any("delegate_status and may_delegate" in e for e in errors), errors


def test_delegate_run_must_stay_gated_and_never_mutating(doc):
    doc["gated_tools"].remove("delegate_run")
    assert any("delegate_run must be gated" in e for e in validate.validate_models(doc))
    doc = copy.deepcopy(contract.load_models())
    doc["mutating_tools"].append("delegate_status")
    assert any("must not be a mutating tool" in e for e in validate.validate_models(doc))
