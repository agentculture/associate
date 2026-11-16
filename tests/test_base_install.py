"""The base install has zero third-party runtime dependencies; extras hold the rest."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

# every distribution the extras may pull in, plus what they bring along
THIRD_PARTY = ("fastapi", "starlette", "pydantic", "uvicorn", "mcp", "httpx", "anyio", "h11")

VERBS = [
    ["whoami"],
    ["learn"],
    ["overview"],
    ["doctor"],
    ["cli", "overview"],
    ["explain", "whoami"],
    ["run", "--help"],
    ["bench", "--help"],
]


def test_runtime_dependencies_are_empty_and_extras_exist():
    project = PYPROJECT["project"]
    assert project["dependencies"] == []
    extras = project["optional-dependencies"]
    assert any(d.startswith("fastapi") for d in extras["server"])
    assert any(d.startswith("mcp") for d in extras["mcp"])


def test_every_existing_verb_works_with_no_third_party_package_importable():
    """Block every extra's packages at import time, then run each verb in a fresh process."""
    code = f"""
import json, sys
for m in {THIRD_PARTY!r}:
    sys.modules[m] = None
from associate.cli import main
results = {{}}
for argv in {VERBS!r}:
    try:
        code = main(argv + ['--json'] if '--help' not in argv else argv)
    except SystemExit as exc:
        code = exc.code
    results[' '.join(argv)] = code
loaded = sorted(m for m in sys.modules if m.split('.')[0] in {THIRD_PARTY!r}
                and sys.modules[m] is not None)
print(json.dumps({{'results': results, 'loaded': loaded}}))
"""
    done = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT, check=False
    )
    assert "Traceback" not in done.stderr, done.stderr
    payload = json.loads(done.stdout.strip().splitlines()[-1])
    assert payload["loaded"] == []
    results = payload["results"]
    for verb in ("whoami", "learn", "overview", "cli overview", "explain whoami"):
        assert results[verb] == 0, (verb, results)
    for verb in ("run --help", "bench --help"):
        assert results[verb] == 0, (verb, results)
    assert results["doctor"] in (0, 1), results  # a health verdict, not a crash


def test_no_third_party_import_in_the_base_package():
    """Nothing under associate/ imports a third-party package at module level."""
    pattern = re.compile(
        r"^(?:from|import)\s+(fastapi|starlette|pydantic|uvicorn|mcp|httpx)\b", re.M
    )
    for path in (ROOT / "associate").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert not pattern.search(text), f"{path} imports a third-party package at module level"


def test_a_clean_base_install_holds_no_third_party_package(tmp_path):
    """Install the project alone into a new environment: it is the only distribution there,
    and every existing verb runs from that environment's own command."""
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is not installed")
    venv = tmp_path / "venv"
    python = venv / "bin" / "python"

    def run(*argv, **kw):
        return subprocess.run(argv, capture_output=True, text=True, check=False, **kw)

    assert run(uv, "venv", "-q", str(venv)).returncode == 0
    installed = run(uv, "pip", "install", "-q", "--python", str(python), str(ROOT))
    if installed.returncode != 0:
        pytest.skip(f"the build needs the network: {installed.stderr.strip()[-200:]}")
    listed = run(uv, "pip", "list", "--python", str(python), "--format", "json")
    assert [d["name"] for d in json.loads(listed.stdout)] == [PYPROJECT["project"]["name"]]
    command = venv / "bin" / "associate"
    for verb in VERBS:
        argv = verb if "--help" in verb else [*verb, "--json"]
        done = run(str(command), *argv, cwd=ROOT)
        allowed = (0, 1) if verb == ["doctor"] else (0,)
        assert done.returncode in allowed, (verb, done.stderr)
        assert "Traceback" not in done.stderr, (verb, done.stderr)
