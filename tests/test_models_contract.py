"""t4: the per-model registry (models.json) and its validation.

Covers c3 (per-model tool surface), h4 (senses cannot mutate; only cortex
spawns) and c10 (no text_only claim in role.json).
"""

import copy

import pytest

from associate import contract
from associate.contract import validate


@pytest.fixture()
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
        assert "/" not in m["lobes_role"] and "NVIDIA" not in m["lobes_role"]


def test_reasoning_never_reintroduces_nemotron_switch():
    text = (contract.contract_dir() / "models.json").read_text(encoding="utf-8")
    assert "enable_thinking" not in text and "nemotron" not in text.lower()


def test_role_json_no_longer_claims_text_only():
    role = contract.load_role()
    assert "text_only" not in role["notes"]
    assert "vision tower" not in str(role)


def test_policy_shell_allows_eidetic_and_ledger_argv():
    allow = {e["command"]: e["subcommands"] for e in contract.load_policy()["shell"]["allowlist"]}
    assert allow["eidetic"] == ["recall", "remember"]
    assert allow["ledger"] == ["append", "list"]
    assert allow["rg"] == [] and "git" in allow


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
