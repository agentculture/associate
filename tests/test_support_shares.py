"""scripts/support_shares.py: the two shares, per group, from labels and answers.

Every pair in the fixtures here is CONSTRUCTED.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "support_shares.py"

_spec = importlib.util.spec_from_file_location("support_shares", SCRIPT)
shares = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules["support_shares"] = shares
_spec.loader.exec_module(shares)

YES, NO = "supported", "unsupported"
OPTIONS = ["all", "mostly", "part", "none"]
PASSES = ["all", "mostly"]


def pair(group: str, first: str, second: str, answer: str | None, half: str = "held_out") -> dict:
    found = {"pid": "p", "group": group, "half": half, "labels": {"a": first, "b": second}}
    return found if answer is None else {**found, "answer": answer}


PAIRS = [
    pair("real", YES, YES, "all"),
    pair("real", YES, YES, "mostly", half="development"),
    pair("real", YES, YES, "part"),
    pair("real", NO, NO, "mostly"),
    pair("real", NO, NO, "none"),
    pair("real", YES, NO, "all"),
    pair("real", YES, YES, None),
    pair("planted", NO, NO, "part"),
]


def document(**changes) -> dict:
    return {"options": OPTIONS, "passes": PASSES, "pairs": PAIRS, **changes}


def write(tmp_path: Path, **changes) -> str:
    path = tmp_path / "set.json"
    path.write_text(json.dumps(document(**changes)), encoding="utf-8")
    return str(path)


def test_each_share_is_of_the_pairs_both_raters_agree_on():
    real = shares.group_shares(PAIRS, OPTIONS, PASSES)["real"]
    assert real[YES] == {"pairs": 3, "passed": 2, "share_passed": 0.6667}
    assert real[NO] == {"pairs": 2, "passed": 1, "share_passed": 0.5}


def test_a_disagreement_and_a_pair_without_an_answer_are_counted_and_left_out():
    real = shares.group_shares(PAIRS, OPTIONS, PASSES)["real"]
    assert (real["pairs"], real["raters_disagree"], real["not_answered"]) == (7, 1, 1)


def test_groups_are_reported_apart_and_never_added():
    found = shares.group_shares(PAIRS, OPTIONS, PASSES)
    assert sorted(found) == ["planted", "real"]
    assert found["planted"][NO] == {"pairs": 1, "passed": 0, "share_passed": 0.0}
    assert found["planted"][YES]["share_passed"] is None


def test_the_answers_are_counted_by_what_the_raters_said():
    answers = shares.group_shares(PAIRS, OPTIONS, PASSES)["real"]["answers"]
    assert answers[YES] == {"all": 1, "mostly": 1, "part": 1, "none": 0}
    assert answers[NO] == {"all": 0, "mostly": 1, "part": 0, "none": 1}
    assert answers["raters_disagree"] == {"all": 1, "mostly": 0, "part": 0, "none": 0}


def test_another_pass_rule_changes_what_is_passed():
    real = shares.group_shares(PAIRS, OPTIONS, ["all"])["real"]
    assert (real[YES]["passed"], real[NO]["passed"]) == (1, 0)


@pytest.mark.parametrize(
    "bad",
    [
        [],
        document(pairs=[]),
        document(options=[]),
        document(passes=[]),
        document(passes=OPTIONS),
        document(passes=["yes"]),
        document(pairs=[{"group": "real", "labels": {"a": YES}}]),
        document(pairs=[{"group": "real", "labels": {"a": YES, "b": "maybe"}}]),
        document(pairs=[{"labels": {"a": YES, "b": NO}}]),
        document(pairs=[{"group": "real", "labels": {"a": YES, "b": NO}, "answer": "perhaps"}]),
    ],
)
def test_a_set_of_another_shape_is_refused(bad):
    with pytest.raises(shares.SetError):
        shares.load_set(bad)


def test_the_command_prints_both_shares_and_no_word_accuracy(tmp_path, capsys):
    assert shares.main(["--set", write(tmp_path)]) == 0
    text = capsys.readouterr().out
    assert "both raters say supported: 2 of 3 passed (66.7%)" in text
    assert "both raters say unsupported: 1 of 2 passed (50.0%)" in text
    assert "answers, raters disagree: all 1, mostly 0, part 0, none 0" in text
    assert "accuracy" not in text.lower()


def test_one_half_can_be_reported_alone(tmp_path, capsys):
    assert shares.main(["--set", write(tmp_path), "--half", "development", "--json"]) == 0
    found = json.loads(capsys.readouterr().out)
    assert found["pairs"] == 1
    assert found["groups"]["real"][YES]["passed"] == 1


def test_the_pass_rule_can_be_given_on_the_command_line(tmp_path, capsys):
    assert shares.main(["--set", write(tmp_path), "--passes", "all", "--json"]) == 0
    found = json.loads(capsys.readouterr().out)
    assert found["passes"] == ["all"]
    assert found["groups"]["real"][NO]["passed"] == 0


def test_an_unreadable_set_is_one_error_line_and_exit_1(tmp_path, capsys):
    assert shares.main(["--set", str(tmp_path / "missing.json")]) == 1
    assert capsys.readouterr().err.startswith("error: ")


# --- the committed set ------------------------------------------------------------------------


def committed() -> dict:
    return json.loads(shares.DEFAULT_SET.read_text(encoding="utf-8"))


def test_the_committed_set_has_at_least_300_real_pairs_with_two_labels_each():
    pairs, _options, _passes = shares.load_set(committed())
    real = [found for found in pairs if found["group"] == "real"]
    assert len(real) >= 300
    assert all(sorted(found["labels"]) == ["a", "b"] for found in pairs)
    assert len({found["pid"] for found in pairs}) == len(pairs)
    assert all("answer" in found for found in pairs)


def test_the_committed_set_reports_planted_and_scorer_addressed_pairs_apart():
    groups = shares.group_shares(*shares.load_set(committed()))
    assert sorted(groups) == ["addressed_to_scorer", "planted_wrong_value", "real"]
    assert all(found["pairs"] >= 40 for found in groups.values())


def test_the_committed_set_names_its_raters_its_halves_and_its_guideline():
    found = committed()
    assert sorted(found["raters"]) == ["a", "b"]
    assert {entry["half"] for entry in found["pairs"]} == {"development", "held_out"}
    assert (REPO_ROOT / found["guideline"]).is_file()
