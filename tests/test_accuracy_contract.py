"""t2: the accuracy contract (accuracy.json, facts and report schemas).

Covers c14, h12, c20, h17.
"""

import copy
import tomllib
from pathlib import Path

import pytest

from associate import contract
from associate.contract import validate

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def doc():
    return copy.deepcopy(contract.load_accuracy())


def test_shipped_accuracy_json_is_valid():
    assert validate.validate_accuracy(contract.load_accuracy()) == []
    assert validate.validate(contract.load_accuracy(), contract.load_schema("accuracy")) == []


def test_schema_names_cover_the_new_schemas():
    for name in ("accuracy", "facts", "report"):
        assert name in contract.SCHEMA_NAMES
        assert contract.load_schema(name)["$id"].endswith(f"{name}.schema.json")


def test_settings_shape():
    acc = contract.load_accuracy()
    assert acc["version"] >= 1
    assert set(acc["mode"]) == set(contract.load_models()["models"])
    assert set(acc["mode"].values()) == {"report"}
    assert acc["purpose_exempt_tools"] == ["finish", "associate_ready"]
    assert set(acc["source_kinds"]) == set(contract.load_models()["tool_names"])
    assert set(acc["source_kinds"].values()) <= {
        "file",
        "tool",
        "web",
        "memory",
        "agent",
        "harness",
    }


def test_a_check_without_motivating_failure_fails(doc):
    del doc["checks"][0]["motivating_failure"]
    assert validate.validate(doc, contract.load_schema("accuracy"))
    assert validate.validate_accuracy(doc)


def test_a_blank_motivating_failure_fails(doc):
    doc["checks"][0]["motivating_failure"] = "  "
    assert validate.validate_accuracy(doc)


def test_cross_field_rules(doc):
    bad = copy.deepcopy(doc)
    bad["mode"]["ghost"] = "report"
    assert any("ghost" in e for e in validate.validate_accuracy(bad))
    bad = copy.deepcopy(doc)
    del bad["source_kinds"]["read"]
    assert any("read" in e for e in validate.validate_accuracy(bad))
    bad = copy.deepcopy(doc)
    bad["purpose_exempt_tools"].append("teleport")
    assert any("teleport" in e for e in validate.validate_accuracy(bad))
    bad = copy.deepcopy(doc)
    bad["checks"].append(copy.deepcopy(bad["checks"][0]))
    assert any("duplicate" in e for e in validate.validate_accuracy(bad))
    bad = copy.deepcopy(doc)
    bad["mode"]["worker"] = "strict"
    assert validate.validate(bad, contract.load_schema("accuracy"))


FACT = {"id": "f1", "value": "v", "source": "w3", "quote": "some quote"}


@pytest.mark.parametrize("source", ["w1", "run-1:w12", "a_b:w7"])
def test_fact_source_accepts_a_label_and_a_walk_id(source):
    facts = {"facts": [{**FACT, "source": source, "action": True}]}
    assert validate.validate(facts, contract.load_schema("facts")) == []


@pytest.mark.parametrize(
    "source", ["/etc/passwd", "../w1", "a/b:w1", "w0", "run:", "x", "run\\1:w1", "w1.txt", ""]
)
def test_fact_source_rejects_path_characters(source):
    facts = {"facts": [{**FACT, "source": source}]}
    assert validate.validate(facts, contract.load_schema("facts"))


def test_fact_requires_its_fields_and_action_is_optional():
    schema = contract.load_schema("facts")
    assert validate.validate({"facts": [FACT]}, schema) == []
    for key in ("id", "value", "source", "quote"):
        broken = {k: v for k, v in FACT.items() if k != key}
        assert validate.validate({"facts": [broken]}, schema)
    assert validate.validate({"facts": [{**FACT, "action": "yes"}]}, schema)


def _counts(n=0):
    return dict(made=n, checked=n, passed=n, refused=n, unchecked=n)


def _report():
    return {
        "facts": _counts(),
        "conclusions": dict(made=0, supported=0, refuted=0, open=0),
        "statements": dict(made=0, without_fact=0),
        "by_source_kind": {
            k: _counts() for k in ("file", "tool", "web", "memory", "agent", "harness")
        },
        "flags": [{"check": "unknown_source", "detail": "x", "ref": "w2"}],
        "python_recheck_ran": False,
    }


def test_report_schema_accepts_a_full_report_and_requires_the_recheck_field():
    schema = contract.load_schema("report")
    assert validate.validate(_report(), schema) == []
    broken = _report()
    del broken["python_recheck_ran"]
    assert validate.validate(broken, schema)
    broken = _report()
    del broken["by_source_kind"]["web"]
    assert validate.validate(broken, schema)
    broken = _report()
    broken["flags"][0]["ref"] = "/tmp/x"
    assert validate.validate(broken, schema)


def test_no_runtime_dependency_is_declared():
    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["dependencies"] == []
    import json

    package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    assert "dependencies" not in package
    assert "devDependencies" not in package


def test_refusal_checks_name_only_listed_checks(doc):
    assert doc["refusal_checks"], "the mapping from checker reasons to check ids ships"
    ids = {check["id"] for check in doc["checks"]}
    assert set(doc["refusal_checks"].values()) <= ids
    bad = copy.deepcopy(doc)
    bad["refusal_checks"]["quote_absent"] = "no_such_check"
    assert any("no_such_check" in e for e in validate.validate_accuracy(bad))
    bad = copy.deepcopy(doc)
    del bad["refusal_checks"]
    assert validate.validate(bad, contract.load_schema("accuracy"))


T10_CHECKS = (
    "literal_outside_quote",
    "source_is_path",
    "action_without_call",
    "conclusion_without_fact",
    "open_item_undecided",
    "closing_conclusion_second_hand",
)


def test_the_checker_checks_name_a_recorded_run_or_document():
    by_id = {check["id"]: check for check in contract.load_accuracy()["checks"]}
    for cid in T10_CHECKS:
        text = by_id[cid]["motivating_failure"]
        assert "scope20-" in text or "docs/" in text, cid


def test_facts_schema_carries_alternatives_verdicts_and_open_items():
    schema = contract.load_schema("facts")
    payload = {
        "summary": "free text",
        "facts": [{**FACT, "action": True, "tool": "eidetic_remember"}],
        "alternatives": [{"id": "a1", "text": "t", "predicts": "p", "refuted_by": "r"}],
        "verdicts": [
            {
                "id": "v1",
                "text": "t",
                "verdict": "cannot_tell",
                "basis": ["f1"],
                "alternative": "a1",
                "unread": ["x.py"],
                "check": "read x.py",
                "closing": True,
            }
        ],
        "open_items": [{"id": "o1", "text": "t", "check": "grep y", "basis": []}],
    }
    assert validate.validate(payload, schema) == []
    bad = copy.deepcopy(payload)
    bad["verdicts"][0]["verdict"] = "maybe"
    assert validate.validate(bad, schema)
    bad = copy.deepcopy(payload)
    bad["verdicts"][0]["basis"] = ["w1"]
    assert validate.validate(bad, schema)
    bad = copy.deepcopy(payload)
    del bad["alternatives"][0]["refuted_by"]
    assert validate.validate(bad, schema)


def test_report_schema_lists_child_runs():
    schema = contract.load_schema("report")
    report = _report()
    report["children"] = [{"label": "c1", "report": _report()}]
    assert validate.validate(report, schema) == []
    assert validate.validate(report["children"][0]["report"], schema) == []
    report["children"][0]["label"] = "../x"
    assert validate.validate(report, schema)
