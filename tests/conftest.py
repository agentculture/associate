"""Shared pytest fixtures.

Two concerns live here:

- a ``fake_lane`` fixture that starts the scripted OpenAI-compatible server
  from ``tests/fake_lane.py`` on 127.0.0.1 on an ephemeral port and yields its
  base URL, so tests never need to read ``ASSOCIATE_BASE_URL`` (or any other
  environment variable) to find an endpoint;
- a ``require_pi`` helper that skips pi-dependent tests with a printed reason
  when the ``pi`` binary is not on PATH, rather than failing the job.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator

import pytest

from tests.fake_lane import FakeLaneServer


@pytest.fixture
def fake_lane() -> Iterator[FakeLaneServer]:
    server = FakeLaneServer()
    server.start()
    try:
        yield server
    finally:
        server.stop()


def require_pi() -> None:
    """Skip the calling test, with a printed reason, when pi is absent.

    Call this at the top of a pi-dependent test body (rather than via a
    module-level skipif) so the reason is evaluated fresh at test time.
    """

    if shutil.which("pi") is None:
        pytest.skip(reason="pi not on PATH")
