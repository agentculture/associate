"""The runs HTTP API: a token on every runs route, roles per route, a public health check."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from associate.bridge.filetokens import FileTokenStore  # noqa: E402
from associate.bridge.tokens import ServiceTokens  # noqa: E402
from associate.runs import service  # noqa: E402
from associate.runs.service import RunsConfig  # noqa: E402
from associate.server.app import TOKEN_PREFIX, create_app  # noqa: E402
from tests.test_runs import HOSTILE, fake, make_repo  # noqa: E402


@pytest.fixture
def setup(tmp_path: Path):
    roots = tmp_path / "roots"
    roots.mkdir()
    cfg = RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))
    repo = make_repo(roots / "repo")
    store = FileTokenStore(tmp_path / "tokens.json")
    tokens = ServiceTokens(store, prefix=TOKEN_PREFIX)
    admin = tokens.issue("test", name="ops", roles=["admin"]).token
    viewer = tokens.issue("test", name="watcher", roles=["viewer"]).token
    app = create_app(tokens=tokens, runs_config=cfg, child_command=fake("merge"))
    return TestClient(app), cfg, repo, admin, viewer


def body(repo, **kw):
    return {
        "checkout": str(repo),
        "model": "worker",
        "instruction": HOSTILE,
        "test_commands": ["true"],
        **kw,
    }


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_health_is_public_and_holds_no_secret(setup):
    client, _cfg, _repo, admin, _viewer = setup
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
    assert admin.split(".")[1] not in res.text


def test_runs_routes_need_a_token(setup):
    client, _cfg, repo, _admin, _viewer = setup
    assert client.post("/runs", json=body(repo)).status_code == 401
    assert client.get("/runs/run-" + "0" * 32).status_code == 401
    assert client.get("/runs").status_code == 401
    bad = client.get("/runs", headers=auth(TOKEN_PREFIX + "abc.def"))
    assert bad.status_code == 401
    assert bad.json()["code"] == "bad_token"


def test_a_viewer_may_read_but_not_start(setup):
    client, _cfg, repo, _admin, viewer = setup
    res = client.post("/runs", json=body(repo), headers=auth(viewer))
    assert res.status_code == 403
    assert client.get("/runs", headers=auth(viewer)).status_code == 200


def test_an_admin_starts_a_run_and_reads_its_result(setup):
    client, cfg, repo, admin, viewer = setup
    res = client.post("/runs", json=body(repo), headers=auth(admin))
    assert res.status_code == 202, res.text
    run_id = res.json()["run_id"]
    deadline = time.monotonic() + 60
    shown = client.get(f"/runs/{run_id}", headers=auth(viewer)).json()
    while shown["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
        shown = client.get(f"/runs/{run_id}", headers=auth(viewer)).json()
    assert shown["status"] == "finished"
    assert shown["ok"] is True
    assert shown["merge"] == "merged"
    argv = json.loads((cfg.state_dir / "runs" / run_id / "export" / "argv.json").read_text())
    assert argv[-1] == HOSTILE


def test_errors_map_to_status_codes(setup, tmp_path):
    client, _cfg, repo, admin, _viewer = setup
    h = auth(admin)
    outside = make_repo(tmp_path / "outside")
    assert client.post("/runs", json=body(outside), headers=h).status_code == 403
    assert client.post("/runs", json=body(repo, model="../x"), headers=h).status_code == 400
    assert client.post("/runs", json=body(repo, extra=1), headers=h).status_code == 400
    assert client.post("/runs", content=b"not json", headers=h).status_code == 400
    assert client.post("/runs", json=[1], headers=h).status_code == 400
    assert client.get("/runs/run-zz", headers=h).status_code == 400
    assert client.get("/runs/run-" + "0" * 32, headers=h).status_code == 404


def test_a_second_start_on_the_same_checkout_is_409(setup):
    client, cfg, repo, admin, _viewer = setup
    client.app.state.child_command = fake("gate")
    first = client.post("/runs", json=body(repo), headers=auth(admin))
    assert first.status_code == 202
    second = client.post("/runs", json=body(repo), headers=auth(admin))
    assert second.status_code == 409
    assert second.json()["code"] == "busy"
    run_id = first.json()["run_id"]
    (cfg.state_dir / "runs" / run_id / "release").write_text("")
    deadline = time.monotonic() + 60
    while service.show(run_id, config=cfg)["status"] == "running":
        assert time.monotonic() < deadline
        time.sleep(0.05)


def test_an_empty_allowlist_refuses_every_start_over_http(tmp_path):
    repo = make_repo(tmp_path / "repo")
    tokens = ServiceTokens(FileTokenStore(tmp_path / "t.json"), prefix=TOKEN_PREFIX)
    admin = tokens.issue("test", name="ops", roles=["admin"]).token
    cfg = RunsConfig(state_dir=tmp_path / "state", allowed_roots=())
    client = TestClient(create_app(tokens=tokens, runs_config=cfg, child_command=fake("plain")))
    res = client.post("/runs", json=body(repo), headers=auth(admin))
    assert res.status_code == 403


def test_the_file_token_store_persists_and_revokes(tmp_path):
    path = tmp_path / "tokens.json"
    issued = ServiceTokens(FileTokenStore(path), prefix=TOKEN_PREFIX).issue(
        "test", name="ops", roles=["editor"]
    )
    again = ServiceTokens(FileTokenStore(path), prefix=TOKEN_PREFIX)
    assert again.authenticate(issued.token).identity == "ops"
    assert issued.token.split(".")[1] not in path.read_text()
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    again.revoke(issued.id, "test")
    assert (
        ServiceTokens(FileTokenStore(path), prefix=TOKEN_PREFIX).authenticate(issued.token) is None
    )
