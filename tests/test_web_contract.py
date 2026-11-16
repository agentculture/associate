"""The web client's HTTP contract, bound to the server's.

This app has no pinned OpenAPI file: its HTTP contract is :data:`associate.runs.service.VERBS`
(each verb's method, path and role), which the routes, the CLI and the MCP tools are all built
from (``tests/test_surface_parity.py``). The web client keeps its routes in one JSON table,
``web/src/api/routes.json`` (``client.ts`` builds every request from it), so this test binds
that table to ``VERBS`` and to the real app; and the fixtures the web tests render
(``web/src/fixtures/runs.json``) carry exactly the fields the real ``runs list`` and
``runs show`` return, so a field renamed on the server fails here, not in a browser.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from associate.runs import service
from associate.runs.service import RunsConfig
from tests.test_runs import make_repo, release, start, wait_done
from tests.test_runs_ui_fields import REQUEST, write_run

ROOT = Path(__file__).resolve().parent.parent
ROUTES = json.loads((ROOT / "web" / "src" / "api" / "routes.json").read_text("utf-8"))
FIXTURES = json.loads((ROOT / "web" / "src" / "fixtures" / "runs.json").read_text("utf-8"))
VERB_BY_NAME = {v.name: v for v in service.VERBS}


@pytest.fixture
def cfg(tmp_path: Path) -> RunsConfig:
    """As ``tests/test_runs.py``'s: a state dir and one allowed root, both under tmp."""
    roots = tmp_path / "roots"
    roots.mkdir()
    return RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))


@pytest.fixture
def repo(cfg: RunsConfig) -> Path:
    return make_repo(cfg.allowed_roots[0] / "repo")


def test_every_client_verb_route_is_the_verbs_method_and_path():
    verbs = {name: route for name, route in ROUTES.items() if route["verb"]}
    assert verbs, "the client calls at least one verb"
    for name, route in verbs.items():
        verb = VERB_BY_NAME[route["verb"]]
        assert verb.http == (route["method"], route["path"]), name


def test_the_client_only_reads_with_viewer_routes_and_never_starts_a_run():
    for name, route in ROUTES.items():
        assert route["method"] == "GET", name
        if route["verb"]:
            assert VERB_BY_NAME[route["verb"]].role == "viewer", name
    assert "start" not in {route["verb"] for route in ROUTES.values()}


def test_the_client_routes_are_served_by_the_real_app():
    pytest.importorskip("fastapi")
    from fastapi.routing import APIRoute

    from associate.server.app import build_policy, create_app

    class NoTokens:
        def authenticate(self, token):  # pragma: no cover - never called here
            return None

    app = create_app(tokens=NoTokens(), web_dist=None)
    served = {(m, r.path) for r in app.routes if isinstance(r, APIRoute) for m in r.methods}
    policy = build_policy()
    for name, route in ROUTES.items():
        assert (route["method"], route["path"]) in served, name
    assert policy.required_role("GET", ROUTES["health"]["path"]) is None  # public


# --- the fixtures carry the real reply's fields ------------------------------------------------


def _real_cards_and_details(cfg, repo):
    running = start(cfg, repo, mode="gate")
    try:
        cards = {r["status"]: r for r in service.list_runs(config=cfg)["runs"]}
        details = {"running": service.show(running["run_id"], config=cfg)}
    finally:
        release(cfg, running["run_id"])
        wait_done(cfg, running["run_id"])
    merged = start(cfg, repo, mode="merge")
    wait_done(cfg, merged["run_id"])
    details["finished"] = service.show(merged["run_id"], config=cfg)
    lost = write_run(cfg.state_dir, 1, REQUEST, None)
    failed = write_run(
        cfg.state_dir,
        2,
        REQUEST,
        {"status": "failed-to-start", "finished_at": "2026-11-16T11:00:01+00:00", "error": "x"},
    )
    details["lost"] = service.show(lost, config=cfg)
    details["failed-to-start"] = service.show(failed, config=cfg)
    for card in service.list_runs(config=cfg)["runs"]:
        cards.setdefault(card["status"], card)
    return cards, details


def test_the_fixtures_have_exactly_the_real_fields(cfg, repo):
    cards, details = _real_cards_and_details(cfg, repo)
    assert set(cards) == {"running", "finished", "lost", "failed-to-start"}
    for card in FIXTURES["list"]["runs"]:
        assert set(card) == set(cards[card["status"]]), card["run_id"]
        if card["tests"] is not None:
            assert set(card["tests"]) == set(cards["finished"]["tests"])
    assert set(FIXTURES["list"]) == {"runs", "total"}
    for run_id, shown in FIXTURES["show"].items():
        status = shown["status"]
        real = details["finished" if status == "finished" else status]
        assert set(shown) == set(real), run_id
        if status == "finished" and shown["tests"] is not None:
            assert set(shown["tests"]) == set(real["tests"]), run_id
            for result in shown["tests"]["results"]:
                assert set(result) == set(real["tests"]["results"][0]), run_id


def test_the_clients_page_size_and_run_id_pattern_are_the_servers():
    import re

    from associate.runs import state

    source = (ROOT / "web" / "src" / "api" / "runs.ts").read_text("utf-8")
    limit = re.search(r"export const LIST_LIMIT = (\d+);", source)
    pattern = re.search(r"export const RUN_ID = /\^(.+)\$/;", source)
    assert limit
    assert int(limit.group(1)) == service.LIST_LIMIT
    assert pattern
    assert pattern.group(1) == state.RUN_ID.pattern
