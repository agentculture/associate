"""The committed derived-fact labelled set is well formed."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("derived_set", ROOT / "scripts" / "derived_set.py")
assert _spec is not None and _spec.loader is not None
derived_set = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(derived_set)

DOCUMENT = json.loads(
    (ROOT / "docs" / "accuracy" / "derived-labelled-set.json").read_text(encoding="utf-8")
)
ITEMS = DOCUMENT["items"]


def test_ids_are_unique_and_groups_known():
    ids = [i["id"] for i in ITEMS]
    assert len(ids) == len(set(ids))
    assert {i["group"] for i in ITEMS} <= set(derived_set.GROUPS)
    assert {i["half"] for i in ITEMS} <= {"development", "held_out"}


def test_every_item_has_a_conclusion_and_listed_facts():
    for item in ITEMS:
        assert item["conclusion"].strip()
        assert item["listed"]
        assert all(f["id"] and f["value"].strip() for f in item["listed"])


def test_planted_items_name_real_items_that_exist():
    real = {i["id"] for i in ITEMS if i["group"] == derived_set.REAL}
    for item in ITEMS:
        if item["group"] == derived_set.REAL:
            assert item["source"] and "made_from" not in item
        else:
            assert item["made_from"] and set(item["made_from"]) <= real


def test_no_machine_path_or_key_in_any_text():
    for item in ITEMS:
        texts = [item["conclusion"], item.get("source", "")] + [f["value"] for f in item["listed"]]
        assert all(derived_set.machine_text(t) is None for t in texts), item["id"]


def test_set_copies_the_contract_and_carries_two_raters_and_both_decider_runs():
    contract = json.loads(
        (ROOT / "associate" / "contract" / "accuracy.json").read_text(encoding="utf-8")
    )
    derived = contract["strict"]["derived_question"]
    assert DOCUMENT["question"] == derived["question"] and DOCUMENT["options"] == derived["options"]
    assert DOCUMENT["contract_version"] == contract["version"]
    labels = {"yes", "partly", "no"}
    for item in ITEMS:
        assert set(item["raters"]) == {"a", "b"}
        assert item["raters"]["a"]["label"] in labels
        assert item["raters"]["b"]["label"] in labels
        assert item["decider"]["five_options"]["option"] in derived["options"]
        assert item["decider"]["three_options"]["option"] in labels


def test_shares_are_counted_on_items_both_raters_agree_on():
    shares = derived_set.shares(DOCUMENT)
    real = shares["real"]
    assert sum(row["agreed"] for row in real.values()) <= shares["items"]["real"]
    for row in real.values():
        assert sum(row["five_options"].values()) == row["agreed"]
        assert sum(row["three_options"].values()) == row["agreed"]


def test_counts_cover_every_group():
    assert sum(derived_set.counts(DOCUMENT)["by_group"].values()) == len(ITEMS)
