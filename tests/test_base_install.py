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


def _serve_and_get(command, env, port, paths):
    """Start ``associate serve``, fetch each (path, headers), stop it; return the replies.
    Adapted from qodo-cli tests/test_base_install.py @ ee73d5682a02952a76567887995b4f2e3aca5ea2."""
    proc = subprocess.Popen(
        [str(command), "serve", "--port", str(port)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )  # fmt: skip
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                replies = [_get(f"http://127.0.0.1:{port}{p}", h) for p, h in paths]
                break
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                if proc.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError(f"serve did not answer: {proc.stderr.read()[-800:]}")
                time.sleep(0.2)
        proc.terminate()
        assert proc.wait(timeout=15) == 0
        return replies
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
        proc.stderr.close()


def _skip(reason: str):
    """Skip on a developer's machine; in CI (``CI`` set) the same condition is a failure, so a
    broken build or build hook can never pass as a skip."""
    if os.environ.get("CI"):
        pytest.fail(reason)
    pytest.skip(reason)


def _run(*argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, check=False, **kw)


def _install_wheel(tmp_path, *, with_ui: bool):
    """Build the wheel (without the UI unless ``with_ui``), install it with the ``server`` extra
    into a new environment and issue a viewer token there. Returns the command, the environment's
    python, the env for running it (a PATH holding no ``node``) and the bearer header."""
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is not installed")
    build_env = {
        **os.environ,
        "ASSOCIATE_REQUIRE_WEB": "",
        "ASSOCIATE_SKIP_WEB": "" if with_ui else "1",
    }
    # with the UI: the release path, a source distribution and then the wheel built from it
    how = [] if with_ui else ["--wheel"]
    built = _run(uv, "build", *how, "--out-dir", str(tmp_path / "dist"), str(ROOT),
                 env=build_env)  # fmt: skip
    if built.returncode != 0:
        _skip(f"the build failed (it needs the network): {built.stderr.strip()[-400:]}")
    wheel = next((tmp_path / "dist").glob("associate-*.whl"))
    venv = tmp_path / "venv"
    python = venv / "bin" / "python"
    assert _run(uv, "venv", "-q", str(venv)).returncode == 0
    installed = _run(uv, "pip", "install", "-q", "--python", str(python), f"{wheel}[server]")
    if installed.returncode != 0:
        _skip(f"the extra's packages need the network: {installed.stderr.strip()[-200:]}")

    # nothing but the new environment's own bin on PATH: no node, no npm
    path = str(venv / "bin")
    assert shutil.which("node", path=path) is None
    env = {
        "PATH": path,
        "HOME": str(tmp_path / "home"),
        "ASSOCIATE_SERVER_TOKENS": str(tmp_path / "tokens.json"),
        "ASSOCIATE_RUNS_DIR": str(tmp_path / "runs-state"),
    }
    os.makedirs(env["HOME"])
    command = venv / "bin" / "associate"
    issued = _run(str(command), "tokens", "issue", "--name", "t", "--role", "viewer", "--json",
                  env=env)  # fmt: skip
    assert issued.returncode == 0, issued.stderr
    bearer = {"Authorization": f"Bearer {json.loads(issued.stdout)['token']}"}
    return command, python, env, bearer


def _package_dir(python, cwd) -> Path:
    site = _run(
        str(python), "-I", "-c",
        "import associate, pathlib; print(pathlib.Path(associate.__file__).parent)",
        cwd=cwd,
    )  # fmt: skip
    assert "site-packages" in site.stdout, site.stdout
    return Path(site.stdout.strip())


def _built_ui() -> Path | None:
    """``web/dist``, built now when it is absent and npm is available (None: neither)."""
    dist = ROOT / "web" / "dist"
    if (dist / "index.html").is_file():
        return dist
    npm = shutil.which("npm")
    if npm is None:
        return None
    web = ROOT / "web"
    steps = [] if (web / "node_modules").is_dir() else [[npm, "ci"]]
    for argv in [*steps, [npm, "run", "build"]]:
        if _run(*argv, cwd=web).returncode != 0:
            return None  # no network, or a broken toolchain: the caller skips and says so
    return dist if (dist / "index.html").is_file() else None


def test_the_api_only_wheel_serves_health_and_a_token_opens_runs_with_no_node(tmp_path):
    """Build the wheel without the UI, install it with the ``server`` extra into a new
    environment and run ``associate serve`` from there, on a PATH that holds no ``node``:
    ``/health`` answers, ``/runs`` needs the token, ``/`` is a JSON 404 (API only), and a UI
    build placed in the installed package is then served. Adapted from qodo-cli's wheel tests
    @ ee73d5682a02952a76567887995b4f2e3aca5ea2."""
    command, python, env, bearer = _install_wheel(tmp_path, with_ui=False)
    assert not (_package_dir(python, tmp_path) / "web_dist").exists()

    health, anonymous, runs, root = _serve_and_get(
        command, env, _free_port(),
        [("/health", None), ("/runs", None), ("/runs", bearer), ("/", bearer)],
    )  # fmt: skip
    assert health[0] == 200 and json.loads(health[1])["service"] == "associate-runs"
    assert anonymous[0] == 401
    assert runs[0] == 200 and json.loads(runs[1])["runs"] == []
    assert root[0] == 404 and json.loads(root[1])["code"] == "not_found"

    dist = _package_dir(python, tmp_path) / "web_dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>ui</title>", encoding="utf-8")
    (page,) = _serve_and_get(command, env, _free_port(), [("/", {**bearer, "Accept": "text/html"})])
    assert page[0] == 200 and "<title>ui</title>" in page[1]


def test_the_wheel_ships_the_built_ui_and_serve_returns_it_with_no_node(tmp_path):
    """With ``web/dist`` built, the release path (an sdist, then the wheel built from it)
    carries it as ``associate/web_dist``, and the installed ``associate serve`` (no Node on the
    PATH) answers ``/`` and the client-side routes with the real ``index.html``, serves one of
    its hashed assets, and keeps the API under ``/api`` behind the same credential."""
    dist = _built_ui()
    if dist is None:
        _skip("web/dist is absent and npm is unavailable (or cannot build): "
              "run `npm ci && npm run build` in web/ first")  # fmt: skip
    command, python, env, bearer = _install_wheel(tmp_path, with_ui=True)
    packaged = _package_dir(python, tmp_path) / "web_dist"
    assert (packaged / "index.html").read_bytes() == (dist / "index.html").read_bytes()

    index = (dist / "index.html").read_text(encoding="utf-8")
    asset = re.search(r'(?:src|href)="(/assets/[^"]+\.js)"', index)
    assert asset, index
    html = {**bearer, "Accept": "text/html"}
    root, route, run_page, script, api, anonymous, health = _serve_and_get(
        command, env, _free_port(),
        [("/", html), ("/runs", html), ("/runs/run-" + "0" * 32, html), (asset.group(1), bearer),
         ("/api/runs", bearer), ("/api/runs", None), ("/health", None)],
    )  # fmt: skip
    assert root[0] == 200 and root[1] == index
    assert route[0] == 200 and route[1] == index  # a client-side route falls back to the shell
    assert run_page[0] == 200 and run_page[1] == index
    assert script[0] == 200 and script[1] == (dist / asset.group(1).lstrip("/")).read_text(
        encoding="utf-8"
    )
    assert api[0] == 200 and json.loads(api[1])["runs"] == []
    assert anonymous[0] == 401
    assert health[0] == 200 and json.loads(health[1])["service"] == "associate-runs"


def test_a_required_ui_build_that_is_missing_fails_the_build(tmp_path):
    """``ASSOCIATE_REQUIRE_WEB=1`` (release CI) with no ``web/dist`` fails ``uv build`` rather
    than shipping a wheel without the UI. Run on a copy of the tree without ``web/dist``."""
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is not installed")
    tree = tmp_path / "tree"
    tree.mkdir()
    for name in ("pyproject.toml", "hatch_build.py", "README.md", "LICENSE"):
        shutil.copy2(ROOT / name, tree / name)
    shutil.copytree(
        ROOT / "associate",
        tree / "associate",
        ignore=shutil.ignore_patterns("__pycache__", "web_dist"),
    )
    env = {**os.environ, "ASSOCIATE_REQUIRE_WEB": "1", "ASSOCIATE_SKIP_WEB": ""}
    built = _run(uv, "build", "--wheel", "--out-dir", str(tmp_path / "dist"), str(tree), env=env)
    if built.returncode != 0 and "web/dist/index.html is missing" not in built.stderr:
        _skip(f"the build failed for another reason (network?): {built.stderr.strip()[-400:]}")
    assert built.returncode != 0
    assert "ASSOCIATE_REQUIRE_WEB" in built.stderr
    assert not list((tmp_path / "dist").glob("*.whl"))
