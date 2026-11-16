"""``associate serve``: Access JWTs only on the loopback listener, service tokens on both, and a
real start and SIGTERM stop on ephemeral loopback ports with tokens issued by the CLI.

The in-process half and the process half are adapted from qodo-cli's
tests/server/test_listeners.py @ 9ac0a9c4f1d7a93507ccc15295f565123025e1e1 (cite-don't-import).
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("uvicorn")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from associate.bridge.filetokens import FileTokenStore  # noqa: E402
from associate.bridge.tokens import ServiceTokens  # noqa: E402
from associate.runs.service import RunsConfig  # noqa: E402
from associate.server import serve as srv  # noqa: E402
from associate.server.app import TOKEN_PREFIX  # noqa: E402
from tests.bridge.jwks import AUD, TEAM, jwks, wall_clock_token  # noqa: E402
from tests.test_runs import make_repo  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ACCESS = {
    "ASSOCIATE_ACCESS_LISTEN": "127.0.0.1:9100",
    "ASSOCIATE_ACCESS_TEAM_DOMAIN": TEAM,
    "ASSOCIATE_ACCESS_AUD": AUD,
}


@pytest.fixture
def tokens(tmp_path):
    return ServiceTokens(FileTokenStore(tmp_path / "tokens.json"), prefix=TOKEN_PREFIX)


def bearer(tokens, role):
    return {"Authorization": f"Bearer {tokens.issue('test', name=role, roles=[role]).token}"}


def apps(tokens, env, tmp_path):
    specs = srv.plan_listeners(env)
    config = RunsConfig(state_dir=tmp_path / "state", allowed_roots=())
    built = srv.build_listeners(specs, tokens, env=env, fetch_jwks=jwks, runs_config=config)
    return {lst.name: TestClient(lst.app, raise_server_exceptions=False) for lst in built}


def test_an_access_jwt_works_on_the_loopback_listener_only(tokens, tmp_path):
    served = apps(tokens, {**ACCESS, "ASSOCIATE_LAN_HOST": "0.0.0.0"}, tmp_path)
    assert set(served) == {"loopback", "lan"}
    header = {"Cf-Access-Jwt-Assertion": wall_clock_token()}
    assert served["loopback"].get("/runs", headers=header).status_code == 200  # an SSO viewer
    assert served["lan"].get("/runs", headers=header).status_code == 401


def test_a_bad_access_jwt_is_refused_not_downgraded(tokens, tmp_path):
    served = apps(tokens, ACCESS, tmp_path)
    headers = {**bearer(tokens, "admin"), "Cf-Access-Jwt-Assertion": "garbage"}
    assert served["loopback"].get("/runs", headers=headers).status_code == 401


def test_a_service_token_works_on_both_listeners(tokens, tmp_path):
    served = apps(tokens, {**ACCESS, "ASSOCIATE_LAN_HOST": "0.0.0.0"}, tmp_path)
    headers = bearer(tokens, "viewer")
    for name in ("loopback", "lan"):
        assert served[name].get("/runs", headers=headers).status_code == 200, name


def test_without_access_the_loopback_listener_ignores_the_header(tokens, tmp_path):
    header = {"Cf-Access-Jwt-Assertion": wall_clock_token()}
    assert apps(tokens, {}, tmp_path)["loopback"].get("/runs", headers=header).status_code == 401


# --- a real start and stop -----------------------------------------------------------------------


def free_port() -> int:
    return free_ports(1)[0]


def free_ports(count: int) -> list[int]:
    """Distinct ephemeral ports, picked while all are held so two never coincide."""
    held = [socket.socket() for _ in range(count)]
    try:
        for s in held:
            s.bind(("127.0.0.1", 0))
        return [s.getsockname()[1] for s in held]
    finally:
        for s in held:
            s.close()


def request(method, url, headers=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # nosec B310 - loopback
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"null")


def wait_for(url, deadline=20.0):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        try:
            return request("GET", url)
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            time.sleep(0.1)
    raise AssertionError(f"{url} never answered")


def env_for(tmp_path):
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "ASSOCIATE_SERVER_TOKENS": str(tmp_path / "tokens.json"),
        "ASSOCIATE_RUNS_DIR": str(tmp_path / "runs-state"),
    }
    for name in ("ASSOCIATE_RUNS_ROOTS", "ASSOCIATE_HOST", "ASSOCIATE_PORT", "ASSOCIATE_LAN_HOST"):
        env.pop(name, None)
    return env


def cli(env, *argv):
    return subprocess.run(
        [sys.executable, "-m", "associate", *argv],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=60, check=False,
    )  # fmt: skip


def start(env, *argv):
    return subprocess.Popen(
        [sys.executable, "-m", "associate", "serve", *argv],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )  # fmt: skip


def stop(proc):
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
    try:
        code = proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        code = proc.wait()
    out, err = proc.stdout.read(), proc.stderr.read()
    proc.stdout.close()
    proc.stderr.close()
    return code, out, err


def issue(env, role):
    done = cli(env, "tokens", "issue", "--name", f"{role}-test", "--role", role, "--json")
    assert done.returncode == 0, done.stderr
    payload = json.loads(done.stdout)
    return payload["id"], {"Authorization": f"Bearer {payload['token']}"}


def test_serve_starts_both_listeners_answers_and_stops_on_sigterm(tmp_path):
    loop, lan = free_ports(2)
    env = env_for(tmp_path)
    proc = start(env, "--port", str(loop), "--lan-host", "127.0.0.1", "--lan-port", str(lan))
    try:
        for port in (loop, lan):
            status, body = wait_for(f"http://127.0.0.1:{port}/health")
            assert status == 200  # public, no token
            assert body["service"] == "associate-runs"
            assert request("GET", f"http://127.0.0.1:{port}/runs")[0] == 401
    finally:
        code, out, _ = stop(proc)
    assert code == 0
    assert f"loopback listening on 127.0.0.1:{loop}" in out
    assert f"lan listening on 127.0.0.1:{lan}" in out


def test_serve_does_not_say_listening_when_a_port_is_taken(tmp_path):
    held = socket.socket()
    held.bind(("127.0.0.1", 0))
    held.listen(1)
    taken = held.getsockname()[1]
    try:
        done = cli(env_for(tmp_path), "serve", "--port", str(taken))
    finally:
        held.close()
    assert done.returncode == 2, (done.returncode, done.stderr[-400:])  # an environment error
    assert "Traceback" not in done.stderr
    assert "listening" not in done.stdout
    assert "listening" not in done.stderr


def test_a_cli_issued_token_authorises_a_served_app_until_it_is_revoked(tmp_path):
    port = free_port()
    env = env_for(tmp_path)
    token_id, viewer = issue(env, "viewer")  # issued before the server starts
    proc = start(env, "--port", str(port))
    base = f"http://127.0.0.1:{port}"
    try:
        wait_for(f"{base}/health")
        status, body = request("GET", f"{base}/runs", viewer)
        assert status == 200
        assert body["runs"] == []
        late_id, late = issue(env, "viewer")  # issued while it runs: the same file is read
        assert request("GET", f"{base}/runs", late)[0] == 200
        assert cli(env, "tokens", "revoke", token_id, "--json").returncode == 0
        assert request("GET", f"{base}/runs", viewer)[0] == 401
        assert request("GET", f"{base}/runs", late)[0] == 200  # only the revoked one stops
    finally:
        stop(proc)


def test_a_viewer_token_cannot_start_a_run_over_http(tmp_path):
    port = free_port()
    env = env_for(tmp_path)
    repo = make_repo(tmp_path / "repo")
    _, viewer = issue(env, "viewer")
    proc = start(env, "--port", str(port))
    try:
        wait_for(f"http://127.0.0.1:{port}/health")
        body = {"checkout": str(repo), "model": "worker", "instruction": "x",
                "test_commands": ["true"]}  # fmt: skip
        status, reply = request("POST", f"http://127.0.0.1:{port}/runs", viewer, body)
        assert status == 403, reply
    finally:
        stop(proc)


def test_a_served_app_with_an_empty_allowlist_starts_says_so_and_refuses_every_start(tmp_path):
    port = free_port()
    env = env_for(tmp_path)
    repo = make_repo(tmp_path / "repo")
    _, admin = issue(env, "admin")
    proc = start(env, "--port", str(port))
    try:
        wait_for(f"http://127.0.0.1:{port}/health")
        body = {"checkout": str(repo), "model": "worker", "instruction": "x",
                "test_commands": ["true"]}  # fmt: skip
        status, reply = request("POST", f"http://127.0.0.1:{port}/runs", admin, body)
        assert status == 403, reply  # an admin is refused too: the allowlist is empty
    finally:
        code, out, _ = stop(proc)
    assert code == 0
    assert "allowlist is EMPTY" in out
    assert "ASSOCIATE_RUNS_ROOTS" in out


def test_the_startup_line_names_a_configured_allowlist(tmp_path):
    port = free_port()
    env = {**env_for(tmp_path), "ASSOCIATE_RUNS_ROOTS": str(tmp_path)}
    proc = start(env, "--port", str(port), "--json")
    try:
        wait_for(f"http://127.0.0.1:{port}/health")
    finally:
        code, out, _ = stop(proc)
    assert code == 0
    payload = json.loads(out)  # one document: the access log is not on stdout
    assert payload["allowlist_empty"] is False
    assert payload["runs_roots"] == [str(tmp_path)]
    assert payload["listening"] == [{"name": "loopback", "host": "127.0.0.1", "port": port}]
