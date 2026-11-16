"""The web UI on the runs API: mounted from the package's ``web_dist`` through the cited
``associate.bridge.static``, behind the same authentication, with the same-origin ``/api``
prefix reaching the same routes at the same roles. Shape adapted from qodo-cli
``tests/server/test_app.py`` (the static UI section) @ ee73d5682a02952a76567887995b4f2e3aca5ea2.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from associate.bridge.caching import NO_STORE, SHELL  # noqa: E402
from associate.bridge.filetokens import FileTokenStore  # noqa: E402
from associate.bridge.tokens import ServiceTokens  # noqa: E402
from associate.runs.service import RunsConfig  # noqa: E402
from associate.server import app as app_module  # noqa: E402
from associate.server.app import TOKEN_PREFIX, build_policy, create_app  # noqa: E402
from tests.test_runs import fake, make_repo  # noqa: E402

HTML = {"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}
INDEX = "<!doctype html><title>associate ui</title>"


@pytest.fixture
def tokens(tmp_path: Path) -> ServiceTokens:
    return ServiceTokens(FileTokenStore(tmp_path / "tokens.json"), prefix=TOKEN_PREFIX)


@pytest.fixture
def auth(tokens: ServiceTokens) -> dict[str, dict[str, str]]:
    out = {}
    for role in ("viewer", "editor", "admin"):
        token = tokens.issue("test", name=role, roles=[role]).token
        out[role] = {"Authorization": f"Bearer {token}"}
    return out


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    d = tmp_path / "web_dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text(INDEX, encoding="utf-8")
    (d / "assets" / "app-1234.js").write_text("console.log(1)", encoding="utf-8")
    return d


@pytest.fixture
def config(tmp_path: Path) -> RunsConfig:
    roots = tmp_path / "roots"
    roots.mkdir()
    make_repo(roots / "repo")
    return RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))


def client_for(tokens, config, web_dist) -> TestClient:
    app = create_app(
        tokens=tokens, runs_config=config, child_command=fake("plain"), web_dist=web_dist
    )
    return TestClient(app, raise_server_exceptions=False)


# --- without a build: API only -----------------------------------------------------------------


def test_without_a_built_ui_the_root_is_a_json_404_for_a_viewer(tokens, auth, config):
    client = client_for(tokens, config, None)
    assert client.app.state.web_ui is False
    r = client.get("/", headers={**auth["viewer"], **HTML})
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["code"] == "not_found"
    assert "no web UI" in r.json()["message"]
    assert client.get("/").status_code == 401  # still behind the credential


def test_without_a_built_ui_an_unlisted_get_still_needs_admin(tokens, auth, config):
    client = client_for(tokens, config, None)
    assert client.get("/elsewhere", headers=auth["viewer"]).status_code == 403
    assert build_policy().required_role("GET", "/elsewhere") == "admin"


def test_a_directory_without_index_html_is_no_ui(tokens, auth, config, tmp_path):
    empty = tmp_path / "empty_dist"
    empty.mkdir()
    client = client_for(tokens, config, empty)
    assert client.app.state.web_ui is False
    assert client.get("/", headers=auth["viewer"]).status_code == 404


def test_the_default_ui_directory_is_the_packages_web_dist(tokens, config, monkeypatch, dist):
    import associate

    assert app_module.default_web_dist() == Path(associate.__file__).resolve().parent / "web_dist"
    monkeypatch.setattr(app_module, "default_web_dist", lambda: dist)
    app = create_app(tokens=tokens, runs_config=config)
    assert app.state.web_ui is True


def test_a_missing_default_ui_directory_does_not_stop_the_app(
    tokens, config, monkeypatch, tmp_path
):
    monkeypatch.setattr(app_module, "default_web_dist", lambda: tmp_path / "absent")
    client = TestClient(create_app(tokens=tokens, runs_config=config))
    assert client.app.state.web_ui is False
    assert client.get("/health").status_code == 200


# --- with a build ------------------------------------------------------------------------------


def test_a_built_ui_is_served_behind_the_same_authentication(tokens, auth, config, dist):
    client = client_for(tokens, config, dist)
    assert client.app.state.web_ui is True
    assert client.get("/", headers=HTML).status_code == 401
    page = client.get("/", headers={**auth["viewer"], **HTML})
    assert page.status_code == 200 and page.text == INDEX
    assert page.headers["cache-control"] == SHELL


@pytest.mark.parametrize("path", ["/runs", "/runs/run-" + "0" * 32, "/runs/not-an-id"])
def test_a_browser_navigation_to_a_client_side_route_gets_the_shell(
    tokens, auth, config, dist, path
):
    client = client_for(tokens, config, dist)
    page = client.get(path, headers={**auth["viewer"], **HTML})
    assert page.status_code == 200 and page.text == INDEX


def test_an_api_client_keeps_the_api_on_the_same_paths(tokens, auth, config, dist):
    client = client_for(tokens, config, dist)
    listed = client.get("/runs", headers=auth["viewer"])
    assert listed.status_code == 200 and listed.json()["runs"] == []
    assert client.get("/runs/run-" + "0" * 32, headers=auth["viewer"]).status_code == 404


def test_the_api_prefix_reaches_the_same_routes_with_the_same_roles(tokens, auth, config, dist):
    client = client_for(tokens, config, dist)
    assert client.get("/api/runs").status_code == 401
    assert client.get("/api/runs").json()["code"] == "no_credentials"
    for role in ("viewer", "editor", "admin"):
        r = client.get("/api/runs", headers=auth[role])
        assert r.status_code == 200, (role, r.text)
        assert r.json() == client.get("/runs", headers=auth[role]).json()
    assert client.get("/api/runs/run-" + "0" * 32, headers=auth["viewer"]).status_code == 404
    assert client.get("/api/runs/run-zz", headers=auth["viewer"]).status_code == 400
    # a start still needs admin through the prefix
    assert client.post("/api/runs", json={}).status_code == 401
    assert client.post("/api/runs", json={}, headers=auth["viewer"]).status_code == 403
    assert client.post("/api/runs", json={}, headers=auth["editor"]).status_code == 403
    assert client.post("/api/runs", json={}, headers=auth["admin"]).status_code == 400
    # health stays public through the prefix
    assert client.get("/api/health").json()["service"] == "associate-runs"


def test_an_unknown_api_path_under_the_prefix_is_a_json_404(tokens, auth, config, dist):
    client = client_for(tokens, config, dist)
    r = client.get("/api/nothing-here", headers={**auth["viewer"], **HTML})
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")


def test_get_everywhere_is_viewer_readable_only_with_a_build(tokens, auth, config, dist):
    with_ui = client_for(tokens, config, dist)
    assert with_ui.get("/assets/app-1234.js", headers=auth["viewer"]).text == "console.log(1)"
    assert with_ui.get("/assets/app-1234.js").status_code == 401
    without = client_for(tokens, config, None)
    assert without.get("/assets/app-1234.js", headers=auth["viewer"]).status_code == 403


def test_api_answers_say_no_store_and_the_ui_files_keep_their_own_policy(
    tokens, auth, config, dist
):
    client = client_for(tokens, config, dist)
    assert client.get("/api/runs", headers=auth["viewer"]).headers["cache-control"] == NO_STORE
    assert client.get("/api/runs").headers["cache-control"] == NO_STORE  # the 401 too
    assert client.get("/health").headers["cache-control"] == NO_STORE
    page = client.get("/runs", headers={**auth["viewer"], **HTML})
    assert page.headers["cache-control"] == SHELL


def test_serve_builds_listeners_that_mount_the_given_ui(tokens, config, dist):
    pytest.importorskip("uvicorn")
    from associate.server import serve

    specs = serve.plan_listeners({})
    built = serve.build_listeners(specs, tokens, env={}, runs_config=config, web_dist=dist)
    assert all(listener.app.state.web_ui is True for listener in built)
    bare = serve.build_listeners(specs, tokens, env={}, runs_config=config, web_dist=None)
    assert all(listener.app.state.web_ui is False for listener in bare)
