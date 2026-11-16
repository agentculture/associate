"""The base install has zero third-party runtime dependencies; extras hold the rest."""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
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
    ["runs", "overview"],
    ["runs", "list"],
    ["runs", "start", "--help"],
    ["runs", "show", "--help"],
    ["explain", "runs", "start"],
    ["explain", "mcp"],
    ["mcp", "--help"],
    ["serve", "--help"],
    ["tokens", "overview"],
    ["explain", "serve"],
    ["explain", "tokens", "issue"],
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
    for verb in ("run --help", "bench --help", "runs start --help", "runs show --help"):
        assert results[verb] == 0, (verb, results)
    for verb in ("runs overview", "runs list", "explain runs start", "explain mcp", "mcp --help"):
        assert results[verb] == 0, (verb, results)
    for verb in ("serve --help", "tokens overview", "explain serve"):
        assert results[verb] == 0, (verb, results)
    assert results["explain tokens issue"] == 0
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


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _get(url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=3) as resp:  # nosec B310 - loopback only
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()


def test_the_wheel_with_the_server_extra_serves_health_and_a_token_opens_runs(tmp_path):
    """Build the wheel, install it with the ``server`` extra into a new environment, issue a
    token and run ``associate serve`` from there: ``/health`` answers, ``/runs`` needs the
    token. Adapted from qodo-cli's wheel test @ 9ac0a9c4f1d7a93507ccc15295f565123025e1e1."""
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is not installed")

    def run(*argv, **kw):
        return subprocess.run(argv, capture_output=True, text=True, check=False, **kw)

    built = run(uv, "build", "--wheel", "--out-dir", str(tmp_path / "dist"), str(ROOT))
    if built.returncode != 0:
        pytest.skip(f"the build needs the network: {built.stderr.strip()[-200:]}")
    wheel = next((tmp_path / "dist").glob("associate-*.whl"))
    venv = tmp_path / "venv"
    python = venv / "bin" / "python"
    assert run(uv, "venv", "-q", str(venv)).returncode == 0
    installed = run(uv, "pip", "install", "-q", "--python", str(python), f"{wheel}[server]")
    if installed.returncode != 0:
        pytest.skip(f"the extra's packages need the network: {installed.stderr.strip()[-200:]}")

    env = {
        "PATH": str(venv / "bin"),
        "HOME": str(tmp_path / "home"),
        "ASSOCIATE_SERVER_TOKENS": str(tmp_path / "tokens.json"),
        "ASSOCIATE_RUNS_DIR": str(tmp_path / "runs-state"),
    }
    os.makedirs(env["HOME"])
    command = venv / "bin" / "associate"
    issued = run(str(command), "tokens", "issue", "--name", "t", "--role", "viewer", "--json",
                 env=env)  # fmt: skip
    assert issued.returncode == 0, issued.stderr
    bearer = {"Authorization": f"Bearer {json.loads(issued.stdout)['token']}"}

    port = _free_port()
    proc = subprocess.Popen(
        [str(command), "serve", "--port", str(port)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )  # fmt: skip
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                health = _get(f"http://127.0.0.1:{port}/health")
                break
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                if proc.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError(f"serve did not answer: {proc.stderr.read()[-800:]}")
                time.sleep(0.2)
        assert health[0] == 200 and json.loads(health[1])["service"] == "associate-runs"
        assert _get(f"http://127.0.0.1:{port}/runs")[0] == 401
        assert _get(f"http://127.0.0.1:{port}/runs", bearer)[0] == 200
        proc.terminate()
        assert proc.wait(timeout=15) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
        proc.stderr.close()
