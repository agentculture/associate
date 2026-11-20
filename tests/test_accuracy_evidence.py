"""The re-check comes from evidence-cli: the shared vectors, and what happens without it.

``associate check`` and ``associate run`` import the re-check from the
first-party package evidence-cli (import name ``evidence``). With it missing or
older than the floor, both exit 2 (environment error) with one
``{code, message, remediation}`` error naming the package and the install
command, and no traceback.
"""

from __future__ import annotations

import json
import subprocess
import sys
from importlib import resources
from pathlib import Path

import pytest

from associate.contract import contract_dir

ROOT = Path(__file__).resolve().parent.parent
INSTALL = 'pip install "evidence-cli>=0.9.0"'

#: Runs associate's CLI in a fresh process with evidence-cli made unimportable.
MISSING = """
import sys
sys.modules["evidence"] = None
from associate.cli import main
sys.exit(main(sys.argv[1:]))
"""

#: The same with evidence-cli importable but reporting an older version.
TOO_OLD = """
import importlib.metadata as md, sys
real = md.version
md.version = lambda name: "0.6.1" if name == "evidence-cli" else real(name)
from associate.cli import main
sys.exit(main(sys.argv[1:]))
"""


def test_the_vector_file_equals_the_copy_in_the_installed_evidence_package():
    ours = (contract_dir() / "matcher_vectors.json").read_bytes()
    theirs = resources.files("evidence").joinpath("data/matcher_vectors.json").read_bytes()
    assert ours == theirs, (
        "associate/contract/matcher_vectors.json differs from the copy evidence-cli ships; "
        "the TypeScript matcher and the Python re-check are no longer tested on the same cases"
    )


def _export(tmp_path: Path) -> Path:
    export = tmp_path / "export"
    (export / "results").mkdir(parents=True)
    (export / "walk.jsonl").write_text(
        json.dumps({"format": {"name": "associate-walk", "version": 2}}) + "\n", encoding="utf-8"
    )
    return export


def _cli(program: str, *argv: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", program, *argv],
        capture_output=True,
        text=True,
        cwd=cwd,
        check=False,
    )


def _argv(name: str, tmp_path: Path) -> list[str]:
    if name == "check":
        return ["check", str(_export(tmp_path))]
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    return [
        "run",
        "--harness",
        "stub",
        "--model",
        "senses",
        "--checkout",
        str(checkout),
        "--export-root",
        str(tmp_path / "runs"),
    ]


@pytest.mark.parametrize("program", [MISSING, TOO_OLD], ids=["missing", "too_old"])
@pytest.mark.parametrize("verb", ["check", "run"])
def test_without_a_usable_evidence_cli_the_verb_exits_2_naming_the_install(verb, program, tmp_path):
    done = _cli(program, *_argv(verb, tmp_path), "--json", cwd=ROOT)
    assert "Traceback" not in done.stderr, done.stderr
    assert done.returncode == 2, (done.returncode, done.stdout, done.stderr)
    assert done.stdout == ""
    error = json.loads(done.stderr)
    assert set(error) == {"code", "message", "remediation"}
    assert error["code"] == 2
    assert "evidence-cli" in error["message"]
    assert INSTALL in error["remediation"]


@pytest.mark.parametrize("verb", ["check", "run"])
def test_the_text_form_names_the_install_on_a_hint_line(verb, tmp_path):
    done = _cli(MISSING, *_argv(verb, tmp_path), cwd=ROOT)
    assert "Traceback" not in done.stderr, done.stderr
    assert done.returncode == 2
    lines = done.stderr.splitlines()
    assert lines[0].startswith("error:")
    assert "evidence-cli" in lines[0]
    assert any(line.startswith("hint:") and INSTALL in line for line in lines[1:]), lines
