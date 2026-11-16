"""Static serving: a built SPA at /, the /api prefix shim and a JSON 404 for API clients."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from associate.bridge import static  # noqa: E402
from associate.bridge.caching import ASSET, SHELL  # noqa: E402

HTML = {"Accept": "text/html,*/*;q=0.8"}


@pytest.fixture
def dist(tmp_path):
    d = tmp_path / "web_dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>spa</title>", encoding="utf-8")
    (d / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("nope", encoding="utf-8")
    return d


def build(dist) -> TestClient:
    app = FastAPI()

    @app.get("/whoami")
    def whoami():
        return {"identity": "alice"}

    @app.get("/things")
    def things():
        return {"items": []}

    mounted = static.install(app, dist)
    return TestClient(app), mounted


@pytest.fixture
def web(dist):
    client, mounted = build(dist)
    assert mounted is True
    return client


def test_root_and_assets_are_served_with_their_cache_policy(web):
    r = web.get("/")
    assert r.status_code == 200
    assert "<title>spa</title>" in r.text
    assert r.headers["cache-control"] == SHELL
    a = web.get("/assets/app.js")
    assert a.text == "console.log(1)"
    assert a.headers["cache-control"] == ASSET


def test_spa_fallback_for_browser_navigations_even_on_api_paths(web):
    for path in ("/", "/things", "/things/x", "/anything/else"):
        r = web.get(path, headers=HTML)
        assert r.status_code == 200, path
        assert "<title>spa</title>" in r.text, path


def test_api_is_reachable_bare_and_under_the_api_prefix(web):
    assert web.get("/whoami").json() == web.get("/api/whoami").json() == {"identity": "alice"}
    assert web.get("/things").json() == {"items": []}  # no browser Accept: stays the API


def test_unknown_api_path_is_a_json_404_not_the_spa(web):
    r = web.get("/api/no-such-thing")
    assert r.status_code == 404
    assert "spa" not in r.text
    assert json.loads(r.text)["error"]["code"] == "not_found"


def test_unknown_unprefixed_path_for_a_non_browser_client_is_a_json_404(web):
    for accept in ("application/json", "*/*"):
        r = web.get("/nope/x", headers={"Accept": accept})
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("application/json")
    assert "spa" in web.get("/nope/x", headers=HTML).text


def test_no_path_traversal_out_of_the_dist(web):
    assert "nope" not in web.get("/..%2fsecret.txt").text
    assert "nope" not in web.get("/assets/../../secret.txt").text


def test_without_a_build_nothing_is_mounted(tmp_path):
    client, mounted = build(tmp_path / "missing")
    assert mounted is False
    assert client.get("/").status_code == 404
    assert client.get("/api/whoami").status_code == 404  # no prefix shim without a UI
    assert client.get("/whoami").status_code == 200


def test_no_web_dist_means_nothing_is_mounted():
    app = FastAPI()
    assert static.install(app, None) is False


def test_openapi_is_unchanged_by_serving_the_web(dist):
    plain = FastAPI()
    served = FastAPI()
    for a in (plain, served):
        a.get("/whoami")(lambda: {})
    static.install(served, dist)
    assert served.openapi() == plain.openapi()
