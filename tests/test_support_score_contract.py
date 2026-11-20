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
    assert isinstance(section["question"], str)
    assert section["question"].strip()
    assert "cutoff" not in section
    for key in ("timeout_ms", "max_facts", "total_timeout_ms"):
        assert isinstance(section[key], int), key
        assert section[key] > 0, key
    assert section["total_timeout_ms"] >= section["timeout_ms"]
    assert isinstance(section["enabled"], dict)
    assert "tentative" in section["$comment"].lower()


def test_every_setting_is_declared_in_the_schema():
    schema = contract.load_schema("accuracy")
    declared = schema["properties"][SECTION]
    assert declared["additionalProperties"] is False
    settings = {"question", "options", "passes", "timeout_ms", "max_facts", "total_timeout_ms"}
    settings |= {"enabled"}
    assert settings <= set(declared["properties"])
    assert "cutoff" not in declared["properties"]
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
    "key",
    ["question", "options", "passes", "timeout_ms", "max_facts", "total_timeout_ms", "enabled"],
)
def test_the_schema_requires_each_setting_once_the_section_is_there(doc, key):
    del doc[SECTION][key]
    assert _schema_errors(doc)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("question", 7),
        ("cutoff", 0.8),
        ("options", ["all", "none"]),
        ("options", {"all": 1, "none": "x"}),
        ("passes", "all"),
        ("passes", [1]),
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
    """Where *paths* restate the question wording, an option's criterion or the per-fact timeout."""
    found = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        if section["question"] in text:
            found.append(f"{path}: question wording")
        found.extend(
            f"{path}: criterion of {key}"
            for key, criterion in section["options"].items()
            if criterion in text
        )
        for lineno, line, value in _number_tokens(path):
            if value == section["timeout_ms"] and not _is_unrelated(path, line):
                found.append(f"{path}:{lineno}: timeout_ms {section['timeout_ms']!r}")
    return found


def test_no_support_score_setting_is_a_literal_in_associates_python():
    """Spec h13: the wording, the criteria and the timeout live in accuracy.json only."""
    sources = _python_sources()
    assert len(sources) > 20, "fixture assumption: the package is scanned"
    assert find_restated_settings(sources, contract.load_accuracy()[SECTION]) == []


def test_the_literal_scan_catches_a_restated_setting(tmp_path):
    section = contract.load_accuracy()[SECTION]
    planted = tmp_path / "planted.py"
    planted.write_text(
        f"QUESTION = {section['question']!r}\n"
        f"CRITERION = {section['options']['none']!r}\n"
        f"TIMEOUT = {section['timeout_ms']:_}\n",
        encoding="utf-8",
    )
    found = find_restated_settings([planted], section)
    assert len(found) == 3, found
    clean = tmp_path / "clean.py"
    clean.write_text("LIMIT = 7\n", encoding="utf-8")
    assert find_restated_settings([clean], section) == []


# --- the background sent with every pair (operator, 2026-11-19) -----------------------------


def test_the_shipped_section_has_a_background():
    section = contract.load_accuracy()[SECTION]
    assert section["background"].strip()
    assert "background" in contract.load_schema("accuracy")["properties"][SECTION]["properties"]


def test_the_background_is_optional():
    doc = copy.deepcopy(contract.load_accuracy())
    del doc[SECTION]["background"]
    assert validate.validate_accuracy(doc) == []


@pytest.mark.parametrize("value", ["", "   ", 7, None, ["text"]])
def test_a_background_that_is_not_a_non_blank_string_is_refused(value):
    doc = copy.deepcopy(contract.load_accuracy())
    doc[SECTION]["background"] = value
    assert any(f"{SECTION}.background" in e for e in validate.validate_accuracy(doc))


# --- the five-option question (plan deviation d4) -------------------------------------------

#: The options and criteria measured on the labelled set
#: (docs/notes/support-score-calibration.md), in contract order.
MEASURED_OPTIONS = {
    "all": "the quote states or directly shows every claim the value makes",
    "mostly": (
        "the quote shows the main claim of the value; only a minor detail of the value "
        "is not in the quote"
    ),
    "part": (
        "the quote shows some of the value, and the value also makes a real claim the "
        "quote does not show"
    ),
    "little": "the quote is on the same subject but shows little of what the value claims",
    "none": (
        "the quote is about something else, or a number or name in the value differs "
        "from the quote"
    ),
}


def test_the_shipped_question_options_and_passes_are_the_measured_ones():
    section = contract.load_accuracy()[SECTION]
    assert section["question"] == "How much of the value does the quote, on its own, show?"
    assert list(section["options"].items()) == list(MEASURED_OPTIONS.items())
    assert section["passes"] == ["all", "mostly"]


def test_the_comment_describes_the_options_not_a_cut_off():
    comment = contract.load_accuracy()[SECTION]["$comment"]
    assert "support-score-calibration.md" in comment
    assert "cutoff" not in comment
    for word in ("options", "passes", "tentative", "report-only"):
        assert word in comment.lower(), word


def test_the_accuracy_file_is_version_2():
    assert contract.load_accuracy()["version"] == 2


def _validator_errors(doc):
    return [e for e in validate.validate_accuracy(doc) if e.startswith(SECTION)]


@pytest.mark.parametrize(
    "options",
    [
        {"all": "every claim"},
        {},
        {"all": "every claim", "none": "   "},
        {"all": "every claim", " ": "blank key"},
        {"all": "every claim", "none": 3},
        ["all", "none"],
    ],
)
def test_the_validator_refuses_options_that_cannot_be_asked(doc, options):
    doc[SECTION]["options"] = options
    doc[SECTION]["passes"] = ["all"]
    assert any(f"{SECTION}.options" in e for e in _validator_errors(doc))


@pytest.mark.parametrize(
    "passes",
    [
        [],
        "all",
        ["all", "all"],
        ["always"],
        ["all", "mostly", "part", "little", "none"],
        [1],
    ],
)
def test_the_validator_refuses_passes_that_are_not_a_proper_subset_of_the_options(doc, passes):
    doc[SECTION]["passes"] = passes
    assert any(f"{SECTION}.passes" in e for e in _validator_errors(doc))


def test_two_options_and_one_pass_is_a_valid_section(doc):
    doc[SECTION]["options"] = {"yes": "the quote shows it", "no": "it does not"}
    doc[SECTION]["passes"] = ["yes"]
    assert _schema_errors(doc) == []
    assert validate.validate_accuracy(doc) == []


def test_the_report_schema_declares_the_answer_counts_under_their_own_name():
    schema = contract.load_schema("report")
    assert "support_answers" in schema["properties"]
    assert "support_answers" not in schema["required"]
    description = schema["properties"]["support_answers"]["description"].lower()
    assert "accuracy" not in description
    report = _report()
    report["support_answers"] = {"all": 1, "mostly": 0, "part": 0, "little": 0, "none": 2}
    assert validate.validate(report, schema) == []
    report["support_answers"] = {"all": "1"}
    assert validate.validate(report, schema)
