"""The bridge's checkout lock and a delegated run's lock are one lock."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from associate.harness import checkoutlock
from associate.runs import state


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    state_dir, checkout = tmp_path / "state", tmp_path / "checkout"
    checkout.mkdir()
    monkeypatch.setenv(checkoutlock.STATE_DIR_ENV, str(state_dir))
    return state_dir.resolve(), checkout.resolve()


def test_a_delegated_run_holding_the_checkout_makes_the_bridge_read_it_busy(dirs):
    state_dir, checkout = dirs
    fd = checkoutlock.acquire(checkout, "delegated-1")
    try:
        with pytest.raises(state.CheckoutBusy) as busy:
            state.acquire_checkout_lock(state_dir, checkout, "run-" + "0" * 32)
        # busy, but not named: the bridge names only run ids of its own shape
        assert busy.value.holder is None
    finally:
        os.close(fd)


def test_a_bridge_run_holding_the_checkout_refuses_a_delegated_run(dirs):
    state_dir, checkout = dirs
    fd = state.acquire_checkout_lock(state_dir, checkout, "run-" + "1" * 32)
    try:
        assert checkoutlock.probe(checkout)["held"] is True
        with pytest.raises(checkoutlock.CheckoutBusy):
            checkoutlock.acquire(checkout, "delegated-2")
    finally:
        os.close(fd)
