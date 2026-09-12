"""The ``associate`` provider, observed through the real ``pi`` binary.

Three things the TypeScript unit tests cannot show on their own:

* **c14 / h22** — with ``ASSOCIATE_BASE_URL`` / ``ASSOCIATE_API_KEY`` /
  ``ASSOCIATE_MODEL`` set, ``pi --list-models`` lists a provider named
  ``associate``; with them unset, it does not, and the extension prints a hint
  naming the three variables. The endpoint is therefore configuration, not code.
* **c28 / h8** — reasoning-off is verified *on the wire*: a real request pi
  sends is captured by the stdlib fake lane and the reasoning-off field the
  ``before_provider_request`` hook injects is asserted on the captured body,
  not inferred from the model's compat flags.

The live-lane half of h8 (does the served Nemotron lane actually *honour* the
field?) is out of scope here — the lane was 503 through the gateway when this
landed — and is recorded by the verification task. ``ASSOCIATE_REASONING_OFF``
selects which field is sent so that check needs no code edit.

The fake lane answers plain JSON while pi's ``openai-completions`` path expects
an SSE stream, so pi never finishes the turn. That is fine and deliberate: the
request body is captured the moment pi sends it, so these tests poll for the
capture and then kill pi rather than waiting for a completion the fake server
was never built to produce.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest

from tests.conftest import require_pi
from tests.fake_lane import FakeLaneServer

REPO_ROOT = Path(__file__).resolve().parent.parent

PROVIDER_ID = "associate"
DUMMY_KEY = "dummy-test-key"  # nosec B105 - not a credential; the fake lane ignores it

#: Environment keys this module always controls explicitly, so an operator's
#: own lane configuration can never decide whether a test passes.
_CONTROLLED = (
    "ASSOCIATE_BASE_URL",
    "ASSOCIATE_API_KEY",
    "ASSOCIATE_MODEL",
    "ASSOCIATE_REASONING_OFF",
)


def _pi_env(**overrides: str) -> dict[str, str]:
    env = dict(os.environ)
    for key in _CONTROLLED:
        env.pop(key, None)
    env["PI_OFFLINE"] = "1"
    env.update(overrides)
    return env


def _provider_rows(list_models_stdout: str) -> list[str]:
    """Rows of ``pi --list-models`` output whose provider column is ours.

    A fuzzy ``--list-models associate`` search also matches any *model* named
    ``associate`` under some other provider, so match the first column.
    """

    rows = []
    for line in list_models_stdout.splitlines():
        parts = line.split()
        if parts and parts[0] == PROVIDER_ID:
            rows.append(line)
    return rows


def _run_pi(args: list[str], env: dict[str, str], timeout: int = 120):
    return subprocess.run(  # nosec B603 - fixed argv, no shell
        ["pi", *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )


def test_list_models_shows_the_provider_when_the_env_is_set(fake_lane: FakeLaneServer):
    require_pi()

    result = _run_pi(
        ["--approve", "--list-models", PROVIDER_ID],
        _pi_env(
            ASSOCIATE_BASE_URL=f"{fake_lane.base_url}/v1",
            ASSOCIATE_API_KEY=DUMMY_KEY,
            ASSOCIATE_MODEL="associate",
        ),
    )

    assert result.returncode == 0, result.stderr
    rows = _provider_rows(result.stdout)
    assert rows, f"no row for provider {PROVIDER_ID!r} in:\n{result.stdout}"
    assert any("associate" in row.split()[1] for row in rows)


def test_no_provider_and_a_hint_when_the_env_is_unset():
    require_pi()

    result = _run_pi(["--approve", "--list-models", PROVIDER_ID], _pi_env())

    assert result.returncode == 0, result.stderr
    assert not _provider_rows(result.stdout), (
        "the provider must not register without ASSOCIATE_API_KEY:\n" + result.stdout
    )

    combined = result.stdout + result.stderr
    for name in ("ASSOCIATE_BASE_URL", "ASSOCIATE_API_KEY", "ASSOCIATE_MODEL"):
        assert name in combined, f"the hint must name {name}:\n{combined}"


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        (None, {"chat_template_kwargs": {"enable_thinking": False}}),
        ("reasoning_effort", {"reasoning_effort": "none"}),
        (
            "both",
            {
                "chat_template_kwargs": {"enable_thinking": False},
                "reasoning_effort": "none",
            },
        ),
    ],
)
def test_reasoning_off_reaches_the_wire(
    fake_lane: FakeLaneServer, mode: str | None, expected: dict[str, object]
):
    require_pi()

    overrides = {
        "ASSOCIATE_BASE_URL": f"{fake_lane.base_url}/v1",
        "ASSOCIATE_API_KEY": DUMMY_KEY,
        "ASSOCIATE_MODEL": "associate",
    }
    if mode is not None:
        overrides["ASSOCIATE_REASONING_OFF"] = mode

    process = subprocess.Popen(  # nosec B603 - fixed argv, no shell
        [
            "pi",
            "-p",
            "--no-session",
            "--approve",
            "--no-tools",
            "--no-context-files",
            "--provider",
            PROVIDER_ID,
            "--model",
            "associate",
            "pong",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        env=_pi_env(**overrides),
        cwd=REPO_ROOT,
    )
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and not fake_lane.requests.chat_completions:
            time.sleep(0.2)
    finally:
        process.kill()
        process.communicate(timeout=60)

    captured = fake_lane.requests.chat_completions
    assert captured, "pi sent no /v1/chat/completions request to the fake lane"

    body = captured[0]
    assert body["model"] == "associate"
    for field, value in expected.items():
        assert body.get(field) == value, f"{field} missing or wrong on the wire: {body!r}"

    # The complement: only what the selected mode asks for is sent.
    if "reasoning_effort" not in expected:
        assert "reasoning_effort" not in body
    if "chat_template_kwargs" not in expected:
        assert "chat_template_kwargs" not in body
