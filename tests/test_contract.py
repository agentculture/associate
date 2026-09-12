"""Acceptance tests for the portable contract (t16).

Covers c46/c47: ``associate/contract/`` holds role.json, policy.json and the
task/walk/statements JSON schemas — and *no* runtime prompt (the prompt is
Pi-and-model-tailored and lives in AGENTS.md, t13).
"""

import json
from pathlib import Path

import pytest

from associate import contract
from associate.contract import validate

REPO_ROOT = Path(__file__).resolve().parent.parent

# lobes/roles.py ROLE_FORBIDDEN["associate"], copied (never imported).
LOBES_FORBIDDEN = ["final_decision", "security_decision", "code_authoring", "repo_action"]
# lobes/roles.py ROLE_RESPONSIBILITIES["associate"].
LOBES_ALLOWED = [
    "execution",
    "ground_work",
    "bulk_transform",
    "drafting",
    "repo_inspection",
    "run_authorized_commands",
    "tool_use",
]


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------


def test_contract_dir_holds_the_expected_files():
    root = contract.contract_dir()
    assert root.is_dir()
    assert (root / "role.json").is_file()
    assert (root / "policy.json").is_file()
    for name in ("task", "walk", "statements"):
        assert (root / "schemas" / f"{name}.schema.json").is_file()


def test_contract_dir_carries_no_prompt_file():
    # c46: the runtime prompt is Pi-tailored and lives in AGENTS.md, never here.
    root = contract.contract_dir()
    names = {p.name.lower() for p in root.rglob("*") if p.is_file()}
    for forbidden in ("prompt.md", "agents.md", "claude.md", "system.md"):
        assert forbidden not in names
    assert not any(n.endswith(".md") for n in names)


def test_contract_files_are_tracked_in_git():
    import subprocess  # noqa: PLC0415 - test-local

    listed = subprocess.run(
        ["git", "ls-files", "associate/contract"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    for wanted in (
        "associate/contract/role.json",
        "associate/contract/policy.json",
        "associate/contract/schemas/task.schema.json",
        "associate/contract/schemas/walk.schema.json",
        "associate/contract/schemas/statements.schema.json",
    ):
        assert wanted in listed


# ---------------------------------------------------------------------------
# role.json
# ---------------------------------------------------------------------------


def test_role_forbidden_equals_lobes_exactly():
    role = contract.load_role()
    assert role["role"] == "associate"
    assert role["forbidden"] == LOBES_FORBIDDEN


def test_role_allowed_equals_lobes_exactly():
    role = contract.load_role()
    assert role["capabilities"] == LOBES_ALLOWED


def test_role_does_not_name_a_checkpoint():
    # The lane is addressed by role; a checkpoint id here would re-hardcode it.
    raw = (contract.contract_dir() / "role.json").read_text(encoding="utf-8")
    assert "nvidia/" not in raw.lower()


# ---------------------------------------------------------------------------
# policy.json
# ---------------------------------------------------------------------------


def test_policy_carries_the_containment_values():
    policy = contract.load_policy()

    denylist = policy["read"]["denylist"]
    joined = " ".join(denylist)
    for shape in (".env", "*.pem", "id_rsa*"):
        assert shape in denylist, f"{shape} missing from read denylist"
    assert "token" in joined.lower()
    assert "key" in joined.lower()

    shell = policy["shell"]["allowlist"]
    names = {entry["command"] for entry in shell}
    assert {"rg", "fd", "ls", "cat", "head", "tail", "wc", "git"} <= names
    assert {"code-lens", "webglass"} <= names
    git = next(e for e in shell if e["command"] == "git")
    assert set(git["subcommands"]) == {"log", "diff", "show", "status", "blame"}
    webglass = next(e for e in shell if e["command"] == "webglass")
    assert set(webglass["subcommands"]) == {"search", "page"}

    # colleague readpage.py defaults / search_tools.py DEFAULT_MAX_RESULTS /
    # web.py _MAX_RAW_CHARS.
    assert policy["budgets"]["read"]["max_lines"] == 1000
    assert policy["budgets"]["read"]["max_output_chars"] == 25_000
    assert policy["budgets"]["read"]["max_bytes"] > 0
    assert policy["caps"]["max_results"] == 200
    assert policy["caps"]["max_raw_chars"] == 2_000_000
    assert policy["caps"]["max_fetches_per_run"] > 0

    assert policy["redaction"]["patterns"], "walk export needs redaction patterns"


def test_policy_shell_allowlist_has_no_mutating_command():
    policy = contract.load_policy()
    names = {entry["command"] for entry in policy["shell"]["allowlist"]}
    assert names.isdisjoint({"rm", "mv", "cp", "tee", "sed", "sh", "bash"})
    git = next(e for e in policy["shell"]["allowlist"] if e["command"] == "git")
    assert set(git["subcommands"]).isdisjoint({"commit", "push", "add", "checkout"})


def test_policy_redaction_patterns_compile_and_match_a_bearer():
    import re  # noqa: PLC0415 - test-local

    policy = contract.load_policy()
    sample = "Authorization: Bearer sk-abcdef0123456789abcdef0123456789"
    assert any(re.search(p, sample) for p in policy["redaction"]["patterns"])


# ---------------------------------------------------------------------------
# The stdlib validator
# ---------------------------------------------------------------------------


def test_validator_accepts_and_rejects_each_supported_keyword():
    schema = {
        "type": "object",
        "required": ["a"],
        "properties": {
            "a": {"type": "string", "pattern": "^w[1-9][0-9]*$"},
            "b": {"type": "integer"},
            "c": {"enum": ["x", "y"]},
            "d": {"type": "array", "items": {"type": "boolean"}},
        },
    }
    assert validate.validate({"a": "w1", "b": 2, "c": "x", "d": [True]}, schema) == []

    assert validate.validate({}, schema)  # missing required
    assert validate.validate({"a": "nope"}, schema)  # pattern
    assert validate.validate({"a": "w1", "b": "2"}, schema)  # type
    assert validate.validate({"a": "w1", "c": "z"}, schema)  # enum
    assert validate.validate({"a": "w1", "d": [1]}, schema)  # items
    assert validate.validate([], schema)  # top-level type


def test_validator_booleans_are_not_integers():
    assert validate.validate(True, {"type": "integer"})


def test_validator_resolves_local_refs():
    schema = {
        "type": "object",
        "required": ["e"],
        "properties": {"e": {"$ref": "#/$defs/leaf"}},
        "$defs": {"leaf": {"type": "string"}},
    }
    assert validate.validate({"e": "ok"}, schema) == []
    assert validate.validate({"e": 1}, schema)


def test_validator_error_messages_name_the_path():
    schema = {"type": "object", "properties": {"a": {"type": "string"}}}
    errors = validate.validate({"a": 1}, schema)
    assert errors and "$.a" in errors[0]


def test_assert_valid_raises_on_a_bad_instance():
    with pytest.raises(validate.ValidationError):
        validate.assert_valid({"a": 1}, {"type": "object", "properties": {"a": {"type": "string"}}})
    validate.assert_valid({"a": "x"}, {"type": "object", "properties": {"a": {"type": "string"}}})


# ---------------------------------------------------------------------------
# Schemas validate real samples
# ---------------------------------------------------------------------------


SAMPLE_WALK_JSONL = """\
{"id": "w1", "ts": "2026-09-12T10:00:00+00:00", "tool": "read", \
"args": {"path": "a.py"}, "result": {"sha256": "%s", "bytes": 12}, "truncated": false}
{"id": "w2", "ts": "2026-09-12T10:00:01+00:00", "tool": "shell", \
"args": {"argv": ["rg", "def"]}, "result": {"content": "a.py:1:def f():"}, "truncated": true}
{"id": "w3", "ts": "2026-09-12T10:00:02+00:00", "tool": "read", \
"args": {"path": "nope"}, "result": {}, "truncated": false, "error": "path not found"}
""" % ("0" * 64,)

SAMPLE_RUN = {
    "duration_ms": 1234,
    "tool_calls": 3,
    "outcome": "ok",
    "truncated": True,
}

SAMPLE_STATEMENTS = {
    "statements": [
        {"text": "f is defined in a.py", "evidence": ["w1", "w2"], "status": "referenced"},
        {"text": "the module is small", "evidence": [], "status": "unreferenced"},
    ],
    "citations": [
        {"path": "a.py", "line": 1, "check": "encountered"},
        {"path": "b.py", "line": 9, "check": "unverifiable"},
    ],
    "not_fully_read": True,
}


def test_sample_walk_jsonl_validates():
    entry_schema = contract.walk_entry_schema()
    run_schema = contract.walk_run_schema()
    ids = []
    for line in SAMPLE_WALK_JSONL.splitlines():
        entry = json.loads(line)
        assert validate.validate(entry, entry_schema) == [], entry
        ids.append(entry["id"])
    assert ids == ["w1", "w2", "w3"]
    assert validate.validate(SAMPLE_RUN, run_schema) == []


def test_walk_document_schema_validates_the_whole_walk():
    document = {
        "entries": [json.loads(line) for line in SAMPLE_WALK_JSONL.splitlines()],
        "run": SAMPLE_RUN,
    }
    assert validate.validate(document, contract.load_schema("walk")) == []


def test_walk_entry_rejects_a_non_monotonic_id_shape_and_a_missing_field():
    entry_schema = contract.walk_entry_schema()
    assert validate.validate(
        {**json.loads(SAMPLE_WALK_JSONL.splitlines()[0]), "id": "1"}, entry_schema
    )
    broken = json.loads(SAMPLE_WALK_JSONL.splitlines()[0])
    del broken["truncated"]
    assert validate.validate(broken, entry_schema)


def test_sample_statements_validates_and_a_bad_status_is_rejected():
    schema = contract.load_schema("statements")
    assert validate.validate(SAMPLE_STATEMENTS, schema) == []

    bad = json.loads(json.dumps(SAMPLE_STATEMENTS))
    bad["statements"][0]["status"] = "maybe"
    assert validate.validate(bad, schema)

    missing = json.loads(json.dumps(SAMPLE_STATEMENTS))
    del missing["not_fully_read"]
    assert validate.validate(missing, schema)

    bad_check = json.loads(json.dumps(SAMPLE_STATEMENTS))
    bad_check["citations"][0]["check"] = "supported"
    assert validate.validate(bad_check, schema)


def test_task_schema_requires_the_inputs_and_leaves_continue_from_optional():
    schema = contract.load_schema("task")
    task = {
        "id": "t-1",
        "prompt": "map the package",
        "checkout": "/x/checkout",
        "session_id": "s-1",
        "export_dir": "/x/exports/s-1",
    }
    assert validate.validate(task, schema) == []
    assert validate.validate({**task, "continue_from": "/x/exports/s-0"}, schema) == []
    for key in ("id", "prompt", "checkout", "session_id", "export_dir"):
        partial = {k: v for k, v in task.items() if k != key}
        assert validate.validate(partial, schema), f"{key} should be required"


def test_every_schema_is_draft_2020_12_and_self_identified():
    for name in ("task", "walk", "statements"):
        schema = contract.load_schema(name)
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert schema["$id"].endswith(f"{name}.schema.json")


def test_load_schema_rejects_an_unknown_name():
    with pytest.raises(KeyError):
        contract.load_schema("bogus")
