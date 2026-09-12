"""Placeholder for tests that require the ``pi`` binary on PATH.

Covers t4 acceptance criterion 1: pi-dependent tests skip with a printed
reason ("pi not on PATH") when pi is absent, rather than failing the job.

Add further pi-dependent tests alongside this one, each starting with a call
to ``require_pi()``.
"""

from __future__ import annotations

import shutil
import subprocess

from tests.conftest import require_pi


def test_pi_version_runs_when_pi_is_present():
    require_pi()

    pi_path = shutil.which("pi")
    result = subprocess.run(
        [pi_path, "--version"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
