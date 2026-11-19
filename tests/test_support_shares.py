"""scripts/support_shares.py: the two shares, per group, from labels and scores.

Every pair here is CONSTRUCTED.
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


def pair(group: str, first: str, second: str, score: float | None) -> dict:
    found = {"pid": "p", "group": group, "labels": {"a": first, "b": second}}
    return found if score is None else {**found, "score": score}


PAIRS = [
    pair("real", YES, YES, 0.9),
    pair("real", YES, YES, 0.5),
    pair("real", YES, YES, 0.2),
    pair("real", NO, NO, 0.7),
    pair("real", NO, NO, 0.1),
    pair("real", YES, NO, 0.9),
    pair("real", YES, YES, None),
    pair("planted", NO, NO, 0.4),
]


def test_each_share_is_of_the_pairs_both_raters_agree_on():
    real = shares.group_shares(PAIRS, 0.5)["real"]
    assert real[YES] == {"pairs": 3, "passed": 2, "share_passed": 0.6667}
    assert real[NO] == {"pairs": 2, "passed": 1, "share_passed": 0.5}


def test_a_disagreement_and_a_pair_without_a_score_are_counted_and_left_out():
    real = shares.group_shares(PAIRS, 0.5)["real"]
    assert (real["pairs"], real["raters_disagree"], real["not_scored"]) == (7, 1, 1)


def test_groups_are_reported_apart_and_never_added():
    found = shares.group_shares(PAIRS, 0.5)
    assert sorted(found) == ["planted", "real"]
    assert found["planted"][NO] == {"pairs": 1, "passed": 0, "share_passed": 0.0}
    assert found["planted"][YES]["share_passed"] is None


def test_a_score_equal_to_the_cut_off_is_passed():
    assert shares.group_shares(PAIRS, 0.9)["real"][YES]["passed"] == 1
    assert shares.group_shares(PAIRS, 0.91)["real"][YES]["passed"] == 0


@pytest.mark.parametrize(
    "document",
    [
        {},
        {"pairs": []},
        {"pairs": [{"group": "real", "labels": {"a": YES}}]},
        {"pairs": [{"group": "real", "labels": {"a": YES, "b": "maybe"}}]},
        {"pairs": [{"labels": {"a": YES, "b": NO}}]},
        {"pairs": [{"group": "real", "labels": {"a": YES, "b": NO}, "score": "high"}]},
    ],
)
def test_a_set_of_another_shape_is_refused(document):
    with pytest.raises(shares.SetError):
        shares.load_pairs(document)


def test_the_default_cut_off_is_the_contract_s():
    contract = json.loads((REPO_ROOT / "associate/contract/accuracy.json").read_text("utf-8"))
    assert shares.contract_cutoff() == contract["support_score"]["cutoff"]


def test_the_command_prints_both_shares_and_no_word_accuracy(tmp_path, capsys):
    path = tmp_path / "set.json"
    path.write_text(json.dumps({"pairs": PAIRS}), encoding="utf-8")
    assert shares.main(["--set", str(path), "--cutoff", "0.5"]) == 0
    text = capsys.readouterr().out
    assert "both raters say supported: 2 of 3 passed (66.7%)" in text
    assert "both raters say unsupported: 1 of 2 passed (50.0%)" in text
    assert "accuracy" not in text.lower()


def test_the_sweep_reports_nine_cut_offs_as_json(tmp_path, capsys):
    path = tmp_path / "set.json"
    path.write_text(json.dumps({"pairs": PAIRS}), encoding="utf-8")
    assert shares.main(["--set", str(path), "--sweep", "--json"]) == 0
    found = json.loads(capsys.readouterr().out)
    assert [result["cutoff"] for result in found["results"]] == list(shares.SWEEP)
    assert found["pairs"] == len(PAIRS)


def test_an_unreadable_set_is_one_error_line_and_exit_1(tmp_path, capsys):
    assert shares.main(["--set", str(tmp_path / "missing.json")]) == 1
    assert capsys.readouterr().err.startswith("error: ")
