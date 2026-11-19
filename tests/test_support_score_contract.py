"""Decider-score t1: the contract settings for the support score.

Covers c4, h13, c9, h18 of docs/specs/2026-11-18-associate-decider-fact-score.md.
The support score is a report-only signal: for a fact whose quote was found,
the decider is asked whether the quote, on its own, states or directly shows
the value. This task ships only the settings and their readers.
"""

import ast
import copy
import io
import tokenize
from pathlib import Path

import pytest

from associate import contract
from associate.contract import validate

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGE = REPO_ROOT / "associate"
SECTION = "support_score"

#: A numeric literal equal to a support-score setting that is known to be
#: something else. Each entry is (path relative to the repo, text the line must
#: contain); anything not listed here fails the literal scan.
UNRELATED_NUMBERS = (("associate/bench/walkstats.py", "percentile(self.durations, 0.50)"),)


@pytest.fixture
def doc():
    return copy.deepcopy(contract.load_accuracy())


def _schema_errors(doc):
    return validate.validate(doc, contract.load_schema("accuracy"))


def test_the_shipped_file_holds_every_support_score_setting():
    section = contract.load_accuracy()[SECTION]
    assert isinstance(section["question"], str) and section["question"].strip()
    assert isinstance(section["cutoff"], (int, float)) and 0 <= section["cutoff"] <= 1
    for key in ("timeout_ms", "max_facts", "total_timeout_ms"):
        assert isinstance(section[key], int) and section[key] > 0, key
    assert section["total_timeout_ms"] >= section["timeout_ms"]
    assert isinstance(section["enabled"], dict)
    assert "tentative" in section["$comment"].lower()


def test_every_setting_is_declared_in_the_schema():
    schema = contract.load_schema("accuracy")
    declared = schema["properties"][SECTION]
    assert declared["additionalProperties"] is False
    settings = {"question", "cutoff", "timeout_ms", "max_facts", "total_timeout_ms", "enabled"}
    assert settings <= set(declared["properties"])
    assert settings <= set(declared["required"])
    shipped = set(contract.load_accuracy()[SECTION])
    assert shipped <= set(declared["properties"])
    assert _schema_errors(contract.load_accuracy()) == []
    assert validate.validate_accuracy(contract.load_accuracy()) == []


def test_the_switch_is_off_for_every_model_and_every_model_reports():
    acc = contract.load_accuracy()
    registry = set(contract.load_models()["models"])
    assert set(acc[SECTION]["enabled"]) == registry
    assert set(acc[SECTION]["enabled"].values()) == {False}
    assert set(acc["mode"]) == registry
    assert set(acc["mode"].values()) == {"report"}


def test_a_file_without_the_section_is_still_valid(doc):
    """The section is optional, so an older accuracy.json loads: the score is off."""
    del doc[SECTION]
    assert _schema_errors(doc) == []
    assert validate.validate_accuracy(doc) == []


@pytest.mark.parametrize(
    "key", ["question", "cutoff", "timeout_ms", "max_facts", "total_timeout_ms", "enabled"]
)
def test_the_schema_requires_each_setting_once_the_section_is_there(doc, key):
    del doc[SECTION][key]
    assert _schema_errors(doc)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("question", 7),
        ("cutoff", "0.5"),
        ("cutoff", True),
        ("timeout_ms", 1.5),
        ("max_facts", "40"),
        ("total_timeout_ms", None),
        ("enabled", ["worker"]),
        ("surprise", 1),
    ],
)
def test_the_schema_refuses_a_wrong_type_or_an_unknown_key(doc, key, value):
    doc[SECTION][key] = value
    assert _schema_errors(doc)


def test_the_switch_is_a_boolean_per_model(doc):
    doc[SECTION]["enabled"]["worker"] = "yes"
    assert _schema_errors(doc)


@pytest.mark.parametrize(
    ("key", "value", "word"),
    [
        ("question", "   ", "question"),
        ("cutoff", 1.2, "cutoff"),
        ("cutoff", -0.1, "cutoff"),
        ("timeout_ms", 0, "timeout_ms"),
        ("max_facts", 0, "max_facts"),
        ("total_timeout_ms", 1, "total_timeout_ms"),
    ],
)
def test_the_validator_refuses_a_value_out_of_range(doc, key, value, word):
    doc[SECTION][key] = value
    assert any(f"{SECTION}.{word}" in e for e in validate.validate_accuracy(doc))


def test_the_switch_covers_exactly_the_registry(doc):
    bad = copy.deepcopy(doc)
    bad[SECTION]["enabled"]["ghost"] = False
    assert any("ghost" in e for e in validate.validate_accuracy(bad))
    bad = copy.deepcopy(doc)
    del bad[SECTION]["enabled"]["senses"]
    assert any("senses" in e for e in validate.validate_accuracy(bad))


def test_switching_the_score_on_for_a_model_is_a_valid_file(doc):
    """The validator checks shape; the shipped-file test above pins the switch off."""
    doc[SECTION]["enabled"]["worker"] = True
    assert _schema_errors(doc) == []
    assert validate.validate_accuracy(doc) == []


def _counts(n=0):
    return dict(made=n, checked=n, passed=n, refused=n, unchecked=n)


def _report():
    kinds = ("file", "tool", "web", "memory", "agent", "harness")
    return {
        "facts": _counts(),
        "conclusions": dict(made=0, supported=0, refuted=0, open=0),
        "statements": dict(made=0, without_fact=0),
        "by_source_kind": {k: _counts() for k in kinds},
        "flags": [],
        "python_recheck_ran": False,
    }


def test_the_report_schema_declares_the_scored_count_under_its_own_name():
    schema = contract.load_schema("report")
    assert "support_scored" in schema["properties"]
    assert "support_scored" not in schema["required"]
    assert "support_scored" not in schema["$defs"]["fact_counts"]["properties"]
    description = schema["properties"]["support_scored"]["description"].lower()
    assert "accuracy" not in description
    assert validate.validate(_report(), schema) == [], "valid with the score off (key absent)"
    report = _report()
    report["support_scored"] = 3
    assert validate.validate(report, schema) == []
    report["support_scored"] = "3"
    assert validate.validate(report, schema)


def _python_sources():
    return sorted(p for p in PACKAGE.rglob("*.py") if "__pycache__" not in p.parts)


def _number_tokens(path):
    """(line number, line text, value) for every numeric literal in *path*."""
    text = path.read_text(encoding="utf-8")
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type != tokenize.NUMBER:
            continue
        try:
            value = ast.literal_eval(token.string)
        except (ValueError, SyntaxError):
            continue
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            yield token.start[0], token.line, value


def _is_unrelated(path, line):
    if not path.is_relative_to(REPO_ROOT):
        return False
    relative = path.relative_to(REPO_ROOT).as_posix()
    return any(relative == name and text in line for name, text in UNRELATED_NUMBERS)


def find_restated_settings(paths, section):
    """Where *paths* restate the question wording, the cut-off or the per-fact timeout."""
    found = []
    for path in paths:
        if section["question"] in path.read_text(encoding="utf-8"):
            found.append(f"{path}: question wording")
        for lineno, line, value in _number_tokens(path):
            for key in ("cutoff", "timeout_ms"):
                if value == section[key] and not _is_unrelated(path, line):
                    found.append(f"{path}:{lineno}: {key} {section[key]!r}")
    return found


def test_no_support_score_setting_is_a_literal_in_associates_python():
    """Spec h13: the wording, the cut-off and the timeout live in accuracy.json only."""
    sources = _python_sources()
    assert len(sources) > 20, "fixture assumption: the package is scanned"
    assert find_restated_settings(sources, contract.load_accuracy()[SECTION]) == []


def test_the_literal_scan_catches_a_restated_setting(tmp_path):
    section = contract.load_accuracy()[SECTION]
    planted = tmp_path / "planted.py"
    planted.write_text(
        f"QUESTION = {section['question']!r}\n"
        f"CUTOFF = {float(section['cutoff'])!r}\n"
        f"TIMEOUT = {section['timeout_ms']:_}\n",
        encoding="utf-8",
    )
    found = find_restated_settings([planted], section)
    assert len(found) == 3, found
    clean = tmp_path / "clean.py"
    clean.write_text("LIMIT = 7\n", encoding="utf-8")
    assert find_restated_settings([clean], section) == []
