"""The quote matcher against the shared vectors (issue #20, t5)."""

import json
from pathlib import Path

import pytest

from associate.accuracy.matcher import check_quote

VECTORS = json.loads(
    (Path(__file__).resolve().parent.parent / "associate/contract/matcher_vectors.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_vector(case):
    got = check_quote(case["quote"], case["literal"], case["saved_text"], case["min_quote_length"])
    assert got == case["expect"]


def test_vectors_cover_every_verdict_and_reason():
    expects = [c["expect"] for c in VECTORS["cases"]]
    assert {e["verdict"] for e in expects} == set(VECTORS["verdicts"])
    assert {e["reason"] for e in expects if e["reason"]} == set(VECTORS["reasons"])


def test_pure_same_inputs_same_verdict():
    args = ("brown fox leaps", None, "The quick brown fox jumps", 8)
    assert check_quote(*args) == check_quote(*args)


def test_large_text_is_cheap():
    text = "a" * 2_000_000
    got = check_quote("a" * 50 + "b", None, text, 8)
    assert got["nearest"]["matched"] == 50
    assert got["nearest"]["offset"] == 0
