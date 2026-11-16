"""A write cannot be forged from another site (review finding 1).

On the loopback listener behind Cloudflare Access a browser's cookie is the credential, so a
page on another site could otherwise ``fetch(bridge + '/api/runs', {method: 'POST', mode:
'no-cors', credentials: 'include', body})`` as ``text/plain`` (a "simple" request, no preflight).
Every method other than GET, HEAD and OPTIONS therefore needs a JSON body (415 otherwise), and
is refused (403) when ``Sec-Fetch-Site`` says ``cross-site`` or an ``Origin`` header names
another origin; both checks run before authentication, so the answer is the same with or without
a credential. Requests with neither header (curl, a rules engine, the CLI) are unaffected.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from associate.bridge import origin  # noqa: E402
from associate.bridge.filetokens import FileTokenStore  # noqa: E402
from associate.bridge.tokens import ServiceTokens  # noqa: E402
from associate.runs.service import RunsConfig  # noqa: E402
from associate.server.app import TOKEN_PREFIX, create_app  # noqa: E402
from tests.test_runs import fake, make_repo  # noqa: E402

JSON = {"Content-Type": "application/json"}


@pytest.fixture
def setup(tmp_path: Path):
    roots = tmp_path / "roots"
    roots.mkdir()
    cfg = RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))
    repo = make_repo(roots / "repo")
    tokens = ServiceTokens(FileTokenStore(tmp_path / "tokens.json"), prefix=TOKEN_PREFIX)
    admin = tokens.issue("test", name="ops", roles=["admin"]).token
    dist = tmp_path / "web_dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>ui</title>", encoding="utf-8")
    app = create_app(tokens=tokens, runs_config=cfg, child_command=fake("plain"), web_dist=dist)
    return TestClient(app), cfg, repo, {"Authorization": f"Bearer {admin}"}


def payload(repo) -> bytes:
    body = {"checkout": str(repo), "model": "worker", "instruction": "x", "test_commands": ["true"]}
    return json.dumps(body).encode()


def started(cfg: RunsConfig) -> list[Path]:
    runs = cfg.state_dir / "runs"
    return sorted(runs.iterdir()) if runs.is_dir() else []


# --- (a) the body is JSON or nothing is read --------------------------------------------------


def test_a_text_plain_body_is_415_and_starts_nothing(setup):
    client, cfg, repo, admin = setup
    res = client.post(
        "/api/runs", content=payload(repo), headers={**admin, "Content-Type": "text/plain"}
    )
    assert res.status_code == 415, res.text
    assert res.json()["code"] == "unsupported_media_type"
    assert started(cfg) == []


def test_a_body_without_a_content_type_is_415(setup):
    client, cfg, repo, admin = setup
    res = client.post("/runs", content=payload(repo), headers=admin)
    assert res.status_code == 415
    assert started(cfg) == []


@pytest.mark.parametrize(
    "media",
    ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/json"],
)
def test_every_simple_or_non_json_media_type_is_415(setup, media):
    client, cfg, repo, admin = setup
    res = client.post("/runs", content=payload(repo), headers={**admin, "Content-Type": media})
    assert res.status_code == 415
    assert started(cfg) == []


def test_json_with_a_charset_parameter_is_accepted(setup):
    client, cfg, repo, admin = setup
    headers = {**admin, "Content-Type": "Application/JSON; charset=utf-8"}
    res = client.post("/runs", content=payload(repo), headers=headers)
    assert res.status_code == 202, res.text


# --- (b) Sec-Fetch-Site and Origin -----------------------------------------------------------


@pytest.mark.parametrize("with_credential", [True, False])
def test_sec_fetch_site_cross_site_is_403_and_starts_nothing(setup, with_credential):
    client, cfg, repo, admin = setup
    headers = {**JSON, "Sec-Fetch-Site": "cross-site", **(admin if with_credential else {})}
    res = client.post("/api/runs", content=payload(repo), headers=headers)
    assert res.status_code == 403, res.text
    assert res.json()["code"] == "cross_site_request"
    assert started(cfg) == []


def test_the_cross_site_answer_does_not_depend_on_the_credential(setup):
    client, _cfg, repo, admin = setup
    headers = {**JSON, "Sec-Fetch-Site": "cross-site"}
    answers = [
        client.post("/runs", content=payload(repo), headers={**headers, **extra}).json()
        for extra in (admin, {"Authorization": "Bearer asc_bad.token"}, {})
    ]
    assert answers[0] == answers[1] == answers[2]


@pytest.mark.parametrize(
    "foreign",
    ["https://evil.example", "http://testserver.evil.example", "https://testserver", "null"],
)
def test_a_foreign_origin_is_403_and_starts_nothing(setup, foreign):
    client, cfg, repo, admin = setup
    headers = {**admin, **JSON, "Origin": foreign}
    res = client.post("/runs", content=payload(repo), headers=headers)
    assert res.status_code == 403, res.text
    assert res.json()["code"] == "cross_origin_request"
    assert started(cfg) == []


def test_a_foreign_origin_without_a_credential_is_403_not_401(setup):
    client, _cfg, repo, _admin = setup
    headers = {**JSON, "Origin": "https://evil.example"}
    assert client.post("/runs", content=payload(repo), headers=headers).status_code == 403


def test_a_same_origin_post_is_accepted(setup):
    client, _cfg, repo, admin = setup
    headers = {**admin, **JSON, "Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}
    res = client.post("/api/runs", content=payload(repo), headers=headers)
    assert res.status_code == 202, res.text


def test_a_same_origin_post_with_an_explicit_default_port_is_accepted(setup):
    client, _cfg, repo, admin = setup
    headers = {**admin, **JSON, "Origin": "http://testserver:80"}
    assert client.post("/runs", content=payload(repo), headers=headers).status_code == 202


def test_sec_fetch_site_same_origin_alone_is_accepted(setup):
    client, _cfg, repo, admin = setup
    headers = {**admin, **JSON, "Sec-Fetch-Site": "same-origin"}
    assert client.post("/runs", content=payload(repo), headers=headers).status_code == 202


def test_a_bearer_token_without_browser_headers_works_as_before(setup):
    client, _cfg, repo, admin = setup
    res = client.post("/runs", content=payload(repo), headers={**admin, **JSON})
    assert res.status_code == 202, res.text
    assert client.post("/runs", content=payload(repo), headers=JSON).status_code == 401


# --- reads are untouched; no CORS grant anywhere ---------------------------------------------


def test_the_web_uis_own_reads_are_unaffected(setup):
    client, _cfg, _repo, admin = setup
    headers = {**admin, "Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}
    assert client.get("/api/runs", headers=headers).status_code == 200
    assert (
        client.get("/api/runs", headers={**admin, "Sec-Fetch-Site": "cross-site"}).status_code
        == 200
    )
    assert client.get("/runs", headers={**admin, "Accept": "text/html"}).status_code == 200


def test_a_preflight_grants_nothing(setup):
    client, _cfg, _repo, admin = setup
    preflight = {
        "Origin": "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    }
    for extra in ({}, admin):
        res = client.options("/api/runs", headers={**preflight, **extra})
        assert res.status_code >= 400, res.status_code
        assert not [h for h in res.headers if h.lower().startswith("access-control-")]


def test_no_reply_carries_a_cors_header(setup):
    client, _cfg, repo, admin = setup
    headers = {**admin, "Origin": "https://evil.example"}
    replies = [
        client.get("/api/runs", headers=headers),
        client.get("/health", headers=headers),
        client.post("/runs", content=payload(repo), headers={**headers, **JSON}),
    ]
    for res in replies:
        assert not [h for h in res.headers if h.lower().startswith("access-control-")]


# --- the generic check (associate.bridge.origin) ---------------------------------------------


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_safe_methods_are_never_refused(method):
    headers = {"sec-fetch-site": "cross-site", "origin": "https://evil.example"}
    assert origin.check_write(method, headers, "http") is None


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "FROB"])
def test_every_other_method_is_checked(method):
    refusal = origin.check_write(method, {"host": "h"}, "http")
    assert refusal is not None
    assert refusal.status == 415


def test_the_origin_must_match_scheme_and_host():
    headers = {"host": "bridge.example", "content-type": "application/json"}
    assert (
        origin.check_write("POST", {**headers, "origin": "https://bridge.example"}, "https") is None
    )
    for other in ("http://bridge.example", "https://bridge.example:8443", "https://x.example"):
        refusal = origin.check_write("POST", {**headers, "origin": other}, "https")
        assert refusal is not None, other
        assert refusal.status == 403


def test_an_origin_without_a_host_header_is_refused():
    headers = {"content-type": "application/json", "origin": "https://bridge.example"}
    refusal = origin.check_write("POST", headers, "https")
    assert refusal is not None
    assert refusal.status == 403
