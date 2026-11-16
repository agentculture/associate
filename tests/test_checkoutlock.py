"""The one-run-per-checkout lock a delegated ``associate run`` holds (review of d18).

A kernel ``flock`` on ``<state>/locks/<sha256 of the checkout's real path>.lock``,
taken by the run itself (``associate run --checkout-lock``) and dropped by the
kernel when that process ends, however it ends. No test here starts pi or a
model: the runs use the stub adapter, and the "other run" is a small Python
process that takes the same lock.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from associate.cli import main
from associate.harness import checkoutlock

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="flock is POSIX")

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "state"
    monkeypatch.setenv(checkoutlock.STATE_DIR_ENV, str(directory))
    return directory


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    root.mkdir()
    (root / "README.md").write_text("# fixture\n", encoding="utf-8")
    return root


def _holder(checkout: Path, run_id: str, state: Path) -> subprocess.Popen[str]:
    """Another process that takes the lock, says so, and then sleeps."""
    code = (
        "import sys, time\n"
        "from associate.harness import checkoutlock\n"
        "checkoutlock.acquire(sys.argv[1], sys.argv[2])\n"
        "print('held', flush=True)\n"
        "time.sleep(120)\n"
    )
    proc = subprocess.Popen(  # nosec B603 - test helper, fixed argv
        [sys.executable, "-c", code, str(checkout), run_id],
        cwd=str(REPO_ROOT),
        env={**os.environ, checkoutlock.STATE_DIR_ENV: str(state)},
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    assert proc.stdout.readline().strip() == "held"
    return proc


def test_the_lock_file_is_keyed_by_the_checkouts_real_path(state: Path, checkout: Path):
    digest = hashlib.sha256(str(checkout.resolve()).encode()).hexdigest()
    assert checkoutlock.lock_path(checkout) == state.resolve() / "locks" / f"{digest}.lock"
    link = checkout.parent / "link"
    link.symlink_to(checkout)
    assert checkoutlock.lock_path(link) == checkoutlock.lock_path(checkout)


def test_the_state_directory_defaults_to_xdg_state_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv(checkoutlock.STATE_DIR_ENV, raising=False)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "xdg"))
    assert checkoutlock.state_dir() == (tmp_path / "xdg" / "associate" / "runs").resolve()
    monkeypatch.setenv("XDG_STATE_HOME", "relative/is/ignored")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    expected = tmp_path / "home" / ".local" / "state" / "associate" / "runs"
    assert checkoutlock.state_dir() == expected.resolve()


def test_a_second_holder_is_refused_and_told_who_holds_it(state: Path, checkout: Path):
    fd = checkoutlock.acquire(checkout, "dlg-20261116T000000Z-0000aaaa")
    try:
        with pytest.raises(checkoutlock.CheckoutBusy) as busy:
            checkoutlock.acquire(checkout, "dlg-20261116T000000Z-0000bbbb")
        assert busy.value.holder == "dlg-20261116T000000Z-0000aaaa"
        assert checkoutlock.probe(checkout) == {
            "held": True,
            "holder": "dlg-20261116T000000Z-0000aaaa",
            "path": str(checkoutlock.lock_path(checkout)),
        }
    finally:
        os.close(fd)
    # Released: the file stays, the lock is gone, and the next holder's id replaces the old one.
    assert checkoutlock.probe(checkout)["held"] is False
    again = checkoutlock.acquire(checkout, "dlg-20261116T000000Z-0000bbbb")
    try:
        assert checkoutlock.probe(checkout)["holder"] == "dlg-20261116T000000Z-0000bbbb"
    finally:
        os.close(again)


def test_a_probe_of_a_checkout_never_locked_creates_nothing(state: Path, checkout: Path):
    assert checkoutlock.probe(checkout) == {
        "held": False,
        "holder": None,
        "path": str(checkoutlock.lock_path(checkout)),
    }
    assert not state.exists()


def test_the_lock_outlives_nothing_a_killed_holder_frees_the_checkout(state: Path, checkout: Path):
    """Cross-process, and crash-safe: the kernel drops it with the process."""
    other = _holder(checkout, "dlg-20261116T000000Z-0000cccc", state)
    try:
        assert checkoutlock.probe(checkout)["held"] is True
        with pytest.raises(checkoutlock.CheckoutBusy):
            checkoutlock.acquire(checkout, "dlg-20261116T000000Z-0000dddd")
        other.send_signal(signal.SIGKILL)
        other.wait(timeout=10)
        deadline = time.monotonic() + 5
        while checkoutlock.probe(checkout)["held"] and time.monotonic() < deadline:
            time.sleep(0.05)
        assert checkoutlock.probe(checkout)["held"] is False
        os.close(checkoutlock.acquire(checkout, "dlg-20261116T000000Z-0000dddd"))
    finally:
        other.kill()
        other.wait(timeout=10)


def test_the_module_prints_the_probe_as_json(state: Path, checkout: Path):
    fd = checkoutlock.acquire(checkout, "dlg-20261116T000000Z-0000eeee")
    try:
        completed = subprocess.run(  # nosec B603 - test helper, fixed argv
            [sys.executable, "-m", "associate.harness.checkoutlock", str(checkout)],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        os.close(fd)
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == {
        "held": True,
        "holder": "dlg-20261116T000000Z-0000eeee",
        "path": str(checkoutlock.lock_path(checkout)),
    }


def _run(checkout: Path, tmp_path: Path, *extra: str) -> int:
    return main(
        [
            "run",
            "--harness",
            "stub",
            "--checkout",
            str(checkout),
            "--export-root",
            str(tmp_path / "runs"),
            "--json",
            *extra,
        ]
    )


def test_run_with_checkout_lock_holds_it_for_the_whole_run_and_releases_it(
    state: Path, checkout: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    from associate.cli._commands import run as run_command

    seen: dict[str, object] = {}
    drive = run_command._drive
    finish_tests = run_command._run_tests

    def probing_drive(*args, **kwargs):
        seen["during_model"] = checkoutlock.probe(checkout)
        return drive(*args, **kwargs)

    def probing_tests(*args, **kwargs):
        seen["during_tests"] = checkoutlock.probe(checkout)["held"]
        return finish_tests(*args, **kwargs)

    monkeypatch.setattr(run_command, "_drive", probing_drive)
    monkeypatch.setattr(run_command, "_run_tests", probing_tests)
    assert _run(checkout, tmp_path, "--checkout-lock", "--session-id", "dlg-lock-1") == 0
    assert seen["during_model"] == {
        "held": True,
        "holder": "dlg-lock-1",
        "path": str(checkoutlock.lock_path(checkout)),
    }
    assert seen["during_tests"] is True
    assert checkoutlock.probe(checkout)["held"] is False
    # The same process can run again: nothing was left held.
    capsys.readouterr()
    assert _run(checkout, tmp_path, "--checkout-lock", "--session-id", "dlg-lock-2") == 0


def test_run_with_checkout_lock_is_refused_while_another_run_holds_it(
    state: Path, checkout: Path, tmp_path: Path, capsys
):
    other = _holder(checkout, "dlg-20261116T000000Z-0000ffff", state)
    try:
        code = _run(checkout, tmp_path, "--checkout-lock", "--session-id", "dlg-lock-3")
        captured = capsys.readouterr()
        assert code == 2
        assert captured.out == ""
        error = json.loads(captured.err)
        assert "dlg-20261116T000000Z-0000ffff" in error["message"]
        assert "one run per checkout" in error["message"]
        # Nothing ran: no session directory was made for the refused run.
        assert not (tmp_path / "runs" / "dlg-lock-3").exists()
    finally:
        other.kill()
        other.wait(timeout=10)


def test_run_without_the_flag_takes_no_lock(state: Path, checkout: Path, tmp_path: Path):
    """The bridge holds this lock itself for the runs it starts; they must not take it again."""
    fd = checkoutlock.acquire(checkout, "run-" + "0" * 32)
    try:
        assert _run(checkout, tmp_path, "--session-id", "plain") == 0
    finally:
        os.close(fd)


def test_a_state_directory_inside_the_checkout_is_refused(
    checkout: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    monkeypatch.setenv(checkoutlock.STATE_DIR_ENV, str(checkout / ".state"))
    assert _run(checkout, tmp_path, "--checkout-lock") == 2
    assert "inside the checkout" in json.loads(capsys.readouterr().err)["message"]
    assert not (checkout / ".state").exists()
