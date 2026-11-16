"""The role check sees exactly the path the router matches, so ``/health%3F/..`` is not public.

A ``?`` or ``#`` that arrives percent-encoded inside the path is part of the decoded path the
router matches; ``request.url.path`` would cut the path there (``/health``, the public rule).
Shape adapted from qodo-cli ``tests/server/test_raw_paths.py`` @
ef231828f72da019f1f6904a31ea168582cdf3e8.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from associate.bridge.filetokens import FileTokenStore  # noqa: E402
from associate.bridge.tokens import ServiceTokens  # noqa: E402
from associate.runs.service import RunsConfig  # noqa: E402
from associate.server.app import TOKEN_PREFIX, create_app  # noqa: E402
from tests.rawasgi import raw_get, raw_request  # noqa: E402

ESCAPES = ("/health%3F/../assets/a.js", "/health%23/../index.html")
SECRET = "SECRET-OUTSIDE-THE-UI"


@pytest.fixture
def tokens(tmp_path: Path) -> ServiceTokens:
    return ServiceTokens(FileTokenStore(tmp_path / "tokens.json"), prefix=TOKEN_PREFIX)


@pytest.fixture
def auth(tokens):
    out = {}
    for role in ("viewer", "editor", "admin"):
        token = tokens.issue("test", name=role, roles=[role]).token
        out[role] = {"Authorization": f"Bearer {token}"}
    return out


@pytest.fixture
def ui_app(tokens, tmp_path):
    dist = tmp_path / "web_dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>ui</title>", encoding="utf-8")
    (dist / "assets" / "a.js").write_text("console.log('ui')", encoding="utf-8")
    (tmp_path / "secret.txt").write_text(SECRET, encoding="utf-8")
    (tmp_path / "health").write_text(SECRET, encoding="utf-8")
    config = RunsConfig(state_dir=tmp_path / "state", allowed_roots=())
    return create_app(tokens=tokens, runs_config=config, web_dist=dist)


@pytest.mark.parametrize("raw", ESCAPES)
def test_an_encoded_query_or_fragment_in_the_path_needs_a_credential(ui_app, raw):
    r = raw_get(ui_app, raw)
    assert r.status_code == 401, r.text
    assert "console.log" not in r.text
    assert "<title>ui</title>" not in r.text


@pytest.mark.parametrize("raw", ESCAPES)
def test_an_encoded_query_or_fragment_in_the_path_is_401_for_a_browser_too(ui_app, raw):
    assert raw_get(ui_app, raw, {"Accept": "text/html"}).status_code == 401


@pytest.mark.parametrize(
    "raw",
    ESCAPES
    + (
        "/assets%3F/../../secret.txt",
        "/assets/..%2f..%2fsecret.txt",
        "/x%23/../../health",
        "/assets/%2e%2e/%2e%2e/secret.txt",
        "/assets%5c..%5c..%5csecret.txt",
    ),
)
def test_with_a_viewer_token_nothing_escapes_or_is_resolved(ui_app, auth, raw):
    for accept in ("*/*", "text/html"):
        r = raw_get(ui_app, raw, {**auth["viewer"], "Accept": accept})
        assert SECRET not in r.text
        assert "console.log" not in r.text, (raw, accept)
        assert r.status_code == 404, (raw, accept, r.status_code)


def test_ui_files_and_the_spa_fallback_still_work_with_a_token(ui_app, auth):
    asset = raw_get(ui_app, "/assets/a.js", auth["viewer"])
    assert asset.status_code == 200
    assert "console.log('ui')" in asset.text
    assert raw_get(ui_app, "/assets/a.js").status_code == 401
    page = raw_get(ui_app, "/runs/x", {**auth["viewer"], "Accept": "text/html"})
    assert page.status_code == 200
    assert "<title>ui</title>" in page.text
    root = raw_get(ui_app, "/", {**auth["viewer"], "Accept": "text/html"})
    assert root.status_code == 200
    assert "<title>ui</title>" in root.text


def test_health_is_still_public(ui_app):
    r = raw_get(ui_app, "/health")
    assert r.status_code == 200
    assert "associate-runs" in r.text
    assert raw_get(ui_app, "/api/health").status_code == 200


def test_the_api_prefix_is_checked_on_the_stripped_path(ui_app, auth):
    assert raw_get(ui_app, "/api/runs").status_code == 401
    assert raw_get(ui_app, "/api/runs", auth["viewer"]).status_code == 200
    assert raw_get(ui_app, "/api/health%3F/../runs").status_code == 401


def test_the_role_check_is_given_the_decoded_path_the_router_matches(ui_app, monkeypatch):
    # pinned whatever the installed Starlette does to request.url (older releases cut the path
    # at a decoded "?" or "#"; newer ones re-escape it): the policy sees scope["path"] itself
    from associate.bridge.policy import RoutePolicy

    seen: list[str] = []
    real = RoutePolicy.required_role

    def spy(self, method, path):
        seen.append(path)
        return real(self, method, path)

    monkeypatch.setattr(RoutePolicy, "required_role", spy)
    raw_get(ui_app, "/health%3F/../assets/a.js")
    raw_get(ui_app, "/api/health%23/x")
    assert list(dict.fromkeys(seen)) == ["/health?/../assets/a.js", "/health#/x"]


def test_a_content_length_of_superscript_digits_is_a_400_not_a_crash(ui_app, auth):
    r = raw_request(
        ui_app,
        "POST",
        "/runs",
        {**auth["admin"], "Content-Length": "\u00b2", "Content-Type": "application/json"},
        b"{}",
    )
    assert r.status_code == 400, r.text
