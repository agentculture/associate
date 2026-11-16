"""Surface parity: every runs verb is a CLI command, an MCP tool and an HTTP operation.

Cited from culture-rules tests/test_surface_parity.py @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac
(cite-don't-import: this repo owns its copy). Adapted: the registry is
``associate.runs.service.VERBS`` (a verb carries its JSON-schema params and its HTTP route, so
no handler recording is needed); each surface is introspected for the *params* it accepts as
well as its existence; an operation on a surface that no verb declares is a failure too; the
mutation checks monkeypatch the real surfaces.

The test is data-driven from ``VERBS``: a new verb needs no edit here, only a new surface
lacking it fails.

* CLI: the argparse tree built by ``_build_parser()``: each ``runs <verb>`` parser's actions
  give the accepted names (``dest``) and the required ones (``required``).
* MCP: a real in-memory client session's ``list_tools()``: each tool's ``inputSchema``.
* HTTP: the real FastAPI app's routes (method, path); path and query parameters come from the
  route's dependant. ``POST /runs`` reads its body by hand, so its accepted fields are probed:
  one request per declared field and per omitted field against the real app, and an
  undeclared field must be refused.

The web UI adds no verb. Its routes are classified explicitly, never by loosening the check:
an API-only app has exactly one route that is not a verb besides ``/health``, the JSON 404 at
``GET /`` (:data:`NO_UI_HTTP`); an app serving a built UI has exactly the routes
``associate.bridge.static.install`` adds (:data:`UI_HTTP`, checked against a bare app), and the
same-origin ``/api`` prefix is an ASGI shim, not a route, so it cannot add an operation. Every
check runs against both apps.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("mcp")

from fastapi.routing import APIRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from associate.bridge import mcpserver, static  # noqa: E402
from associate.bridge.filetokens import FileTokenStore  # noqa: E402
from associate.bridge.tokens import ServiceTokens  # noqa: E402
from associate.cli import _build_parser  # noqa: E402
from associate.runs import mcp_tools, service  # noqa: E402
from associate.runs.service import RunsConfig, Verb  # noqa: E402
from associate.server.app import TOKEN_PREFIX, create_app  # noqa: E402
from tests.test_runs import HOSTILE, fake, make_repo  # noqa: E402

NOUN = mcp_tools.NOUN

#: CLI commands under the noun that are not registry verbs (self-description only).
LOCAL_ONLY_CLI = frozenset({"overview"})
#: HTTP operations that are not registry verbs, on every app.
LOCAL_ONLY_HTTP = frozenset({"GET /health"})
#: The one more non-verb operation of an app with no built UI: the JSON 404 at the root.
NO_UI_HTTP = frozenset({"GET /"})
#: The non-verb operations of an app serving a built UI: the SPA fallback that
#: ``associate.bridge.static.install`` adds (``test_ui_http_is_exactly_what_static_adds``).
UI_HTTP = frozenset({"GET /{path:path}", "GET /_ui/{path:path}"})

#: Top-level CLI commands that are not bridge verbs, by name, each with its reason. The
#: parity check above looks only at the ``runs`` noun, so a new top-level command must be
#: classified here explicitly (``test_every_top_level_cli_command_is_classified``); none is
#: exempted by loosening the check.
#: Operator verbs: they run or administer the service itself, they are not operations the
#: service offers, so they have no MCP tool and no HTTP operation by design.
OPERATOR_ONLY_CLI = frozenset(
    {
        "serve",  # starts the HTTP listener that serves the verbs
        "tokens",  # issues the credentials the HTTP surface checks (the token file, no server)
        "mcp",  # starts the MCP server that serves the verbs
    }
)
#: The agent-first identity and self-description verbs, and the harness's own run and bench.
OTHER_CLI = frozenset({"whoami", "learn", "explain", "overview", "doctor", "cli", "run", "bench"})

Params = dict[str, bool]  # accepted name -> required


# --------------------------------------------------------------------------- the three surfaces


def collect_cli(parser: argparse.ArgumentParser) -> dict[str, Params]:
    """``{verb: {dest: required}}`` for every ``<NOUN> <verb>`` the argparse tree accepts."""
    out: dict[str, Params] = {}
    for top in parser._actions:
        if not isinstance(top, argparse._SubParsersAction) or NOUN not in top.choices:
            continue
        for inner in top.choices[NOUN]._actions:
            if not isinstance(inner, argparse._SubParsersAction):
                continue
            for verb, verb_parser in inner.choices.items():
                out[verb] = {
                    a.dest: bool(a.required)
                    for a in verb_parser._actions
                    if a.dest not in ("help", "json") and a.option_strings != ["-h", "--help"]
                }
    return out


def _schema_params(schema: dict[str, Any]) -> Params:
    required = set(schema.get("required", []))
    return {name: name in required for name in schema.get("properties", {})}


def collect_mcp(tools: Any) -> dict[str, Params]:
    """``{tool name: {param: required}}`` from a real in-memory session's ``list_tools()``."""
    from mcp.shared.memory import create_connected_server_and_client_session

    async def go() -> list[Any]:
        server = mcpserver.build_server(mcp_tools.SERVER_NAME, tools)
        async with create_connected_server_and_client_session(server) as session:
            return (await session.list_tools()).tools

    return {t.name: _schema_params(t.inputSchema) for t in asyncio.run(go())}


#: A request that passes every check up to the allowlist (the probe's allowlist is empty, so
#: a body that gets that far is a 403): the values are the probe's, not the registry's.
def _valid_body(repo: Path) -> dict[str, Any]:
    return {
        "checkout": str(repo),
        "model": "worker",
        "instruction": HOSTILE,
        "test_commands": ["true"],
        "timeout": 60,
    }


def write_dist(tmp_path: Path) -> Path:
    """A minimal built UI: what ``static.install`` needs to mount (an ``index.html``)."""
    dist = tmp_path / "web_dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>ui</title>", encoding="utf-8")
    return dist


class Http:
    """The real app, an admin token and a recorded way to probe a hand-read body."""

    def __init__(self, tmp_path: Path, web_dist: Path | None = None) -> None:
        self.repo = make_repo(tmp_path / "probe-repo")
        tokens = ServiceTokens(FileTokenStore(tmp_path / "tokens.json"), prefix=TOKEN_PREFIX)
        self.headers = {
            "Authorization": f"Bearer {tokens.issue('test', name='ops', roles=['admin']).token}"
        }
        config = RunsConfig(state_dir=tmp_path / "probe-state", allowed_roots=())
        self.app = create_app(
            tokens=tokens, runs_config=config, child_command=fake("plain"), web_dist=web_dist
        )
        self.client = TestClient(self.app)

    @property
    def non_verb(self) -> frozenset[str]:
        """The operations this app may have that are not verbs, by what it serves."""
        return LOCAL_ONLY_HTTP | (UI_HTTP if self.app.state.web_ui else NO_UI_HTTP)

    def post(self, path: str, body: dict[str, Any]) -> Any:
        return self.client.post(path, json=body, headers=self.headers)


def _body_params(http: Http, path: str, verb: Verb | None) -> Params:
    """The fields a hand-read POST body accepts, and which are required, by probing."""
    declared = list(verb.params["properties"]) if verb else []
    full = _valid_body(http.repo)
    accepted: Params = {}
    for name in declared:
        sent = http.post(path, {**full, name: full.get(name)})
        if sent.status_code in (400, 403) and "unknown field" in sent.text:
            continue
        without = {k: v for k, v in full.items() if k != name}
        accepted[name] = http.post(path, without).status_code == 400
    bogus = http.post(path, {**full, "__not_a_field__": 1})
    if not (bogus.status_code == 400 and "unknown field" in bogus.text):
        accepted["__anything__"] = False  # an undeclared field is accepted: a mismatch
    return accepted


def collect_http(http: Http, verbs: tuple[Verb, ...] = ()) -> dict[str, Params]:
    """``{"METHOD /path": {param: required}}`` for every route of the real FastAPI app."""
    declared = {f"{v.http[0]} {v.http[1]}": v for v in verbs}
    out: dict[str, Params] = {}
    for route in http.app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            key = f"{method} {route.path}"
            params: Params = {
                f.name: f.field_info.is_required() for f in route.dependant.path_params
            }
            params |= {f.name: f.field_info.is_required() for f in route.dependant.query_params}
            if method in ("POST", "PUT", "PATCH") and not route.dependant.body_params:
                params |= _body_params(http, route.path, declared.get(key))
            out[key] = params
    return out


# --------------------------------------------------------------------------- the parity check


def _expected(verb: Verb) -> Params:
    return _schema_params(verb.params)


def parity_failures(
    verbs: tuple[Verb, ...] | list[Verb],
    *,
    cli: dict[str, Params],
    mcp: dict[str, Params],
    http: dict[str, Params],
    non_verb_http: frozenset[str] = LOCAL_ONLY_HTTP | NO_UI_HTTP,
) -> list[str]:
    """Every way a verb is missing from, or differs on, a surface, and every operation a
    surface has that no verb declares. Empty means parity holds."""
    failures: list[str] = []
    for v in verbs:
        label = f"{NOUN} {v.name}"
        want = _expected(v)
        for surface, key, found in (
            ("CLI", v.name, cli),
            ("MCP tool", f"{NOUN}_{v.name}", mcp),
            ("HTTP operation", f"{v.http[0]} {v.http[1]}", http),
        ):
            if key not in found:
                failures.append(f"{label}: missing from the {surface} ({key})")
            elif found[key] != want:
                failures.append(f"{label}: {surface} params {found[key]} differ from {want}")
    names = {v.name for v in verbs}
    for verb in sorted(set(cli) - names - LOCAL_ONLY_CLI):
        failures.append(f"CLI command '{NOUN} {verb}' has no registry verb")
    tool_names = {f"{NOUN}_{n}" for n in names}
    for tool in sorted(set(mcp) - tool_names):
        failures.append(f"MCP tool '{tool}' has no registry verb")
    operations = {f"{v.http[0]} {v.http[1]}" for v in verbs}
    for op in sorted(set(http) - operations - non_verb_http):
        failures.append(f"HTTP operation '{op}' has no registry verb")
    return failures


@pytest.fixture(params=["api-only", "with-ui"])
def http(request, tmp_path):
    """Every check runs against the API-only app and the app serving a built UI."""
    return Http(tmp_path, write_dist(tmp_path) if request.param == "with-ui" else None)


def surfaces(http: Http) -> dict[str, Any]:
    return {
        "cli": collect_cli(_build_parser()),
        "mcp": collect_mcp(mcp_tools.tools()),
        "http": collect_http(http, service.VERBS),
        "non_verb_http": http.non_verb,
    }


# --------------------------------------------------------------------------- tests


def test_the_registry_is_not_empty_and_names_are_unique():
    assert service.VERBS  # data-driven: a new verb needs no edit here
    assert len({v.name for v in service.VERBS}) == len(service.VERBS)


def test_every_registry_verb_is_a_cli_command_an_mcp_tool_and_an_http_operation(http):
    assert parity_failures(service.VERBS, **surfaces(http)) == []


def test_the_introspection_sees_the_real_params(http):
    found = surfaces(http)
    assert found["cli"]["start"] == {
        "checkout": True,
        "model": True,
        "instruction": True,
        "test_commands": True,
        "timeout": False,
    }
    assert found["cli"]["show"] == {"run_id": True}
    assert found["mcp"]["runs_list"] == {"limit": False}
    assert found["http"]["POST /runs"]["timeout"] is False
    assert found["http"]["POST /runs"]["checkout"] is True
    assert found["http"]["GET /runs/{run_id}"] == {"run_id": True}
    assert found["http"]["GET /runs"] == {"limit": False}
    verbs = {"GET /health", "POST /runs", "GET /runs/{run_id}", "GET /runs"}
    extra = UI_HTTP if http.app.state.web_ui else NO_UI_HTTP
    assert set(found["http"]) == verbs | extra


def test_ui_http_is_exactly_what_static_adds(tmp_path):
    """The UI exemption is what the cited static module adds to a bare app, nothing more, and
    none of it is in the schema; an API-only app has the root 404 and none of it."""
    from fastapi import FastAPI

    bare = FastAPI()
    before = {id(r) for r in bare.routes}
    assert static.install(bare, write_dist(tmp_path)) is True
    added = [r for r in bare.routes if id(r) not in before]
    ops = {f"{m} {r.path}" for r in added for m in r.methods - {"HEAD", "OPTIONS"}}
    assert ops == UI_HTTP
    assert all(r.include_in_schema is False for r in added)
    assert UI_HTTP.isdisjoint({f"{v.http[0]} {v.http[1]}" for v in service.VERBS})
    assert NO_UI_HTTP.isdisjoint(UI_HTTP | {f"{v.http[0]} {v.http[1]}" for v in service.VERBS})


def test_an_app_serving_the_ui_still_fails_on_an_undeclared_runs_route(tmp_path):
    http = Http(tmp_path, write_dist(tmp_path))
    assert http.app.state.web_ui is True
    http.app.add_api_route("/runs/frob", lambda: {}, methods=["GET"])
    assert parity_failures(service.VERBS, **surfaces(http)) == [
        "HTTP operation 'GET /runs/frob' has no registry verb"
    ]


def test_the_root_404_is_not_exempt_on_an_app_serving_the_ui(tmp_path):
    http = Http(tmp_path, write_dist(tmp_path))
    found = surfaces(http)
    found["http"]["GET /"] = {}
    assert parity_failures(service.VERBS, **found) == [
        "HTTP operation 'GET /' has no registry verb"
    ]


def test_the_local_only_exemptions_are_not_stale():
    assert LOCAL_ONLY_CLI <= set(collect_cli(_build_parser()))
    assert LOCAL_ONLY_CLI.isdisjoint({v.name for v in service.VERBS})


def test_every_top_level_cli_command_is_classified():
    """A new top-level command must be a bridge noun, or named as operator-only or other."""
    top = next(
        a for a in _build_parser()._actions if isinstance(a, argparse._SubParsersAction)
    ).choices
    assert set(top) == {NOUN} | OPERATOR_ONLY_CLI | OTHER_CLI


def test_the_operator_only_commands_are_not_registry_verbs_or_stale():
    top = next(
        a for a in _build_parser()._actions if isinstance(a, argparse._SubParsersAction)
    ).choices
    assert OPERATOR_ONLY_CLI <= set(top)
    assert OPERATOR_ONLY_CLI.isdisjoint({v.name for v in service.VERBS} | {NOUN})


# ----- mutation checks: remove a surface for a real verb, and the check fails for that reason


def test_a_verb_with_no_cli_command_fails_parity_for_that_reason(http, monkeypatch):
    real = _build_parser

    def without_show():
        parser = real()
        for top in parser._actions:
            if isinstance(top, argparse._SubParsersAction):
                for inner in top.choices[NOUN]._actions:
                    if isinstance(inner, argparse._SubParsersAction):
                        inner.choices.pop("show")
        return parser

    monkeypatch.setattr(f"{__name__}._build_parser", without_show)
    assert parity_failures(service.VERBS, **surfaces(http)) == [
        "runs show: missing from the CLI (show)"
    ]


def test_a_verb_with_no_mcp_tool_fails_parity_for_that_reason(http, monkeypatch):
    real = mcp_tools.tools
    monkeypatch.setattr(
        mcp_tools, "tools", lambda **kw: [t for t in real(**kw) if t.name != "runs_list"]
    )
    assert parity_failures(service.VERBS, **surfaces(http)) == [
        "runs list: missing from the MCP tool (runs_list)"
    ]


def test_a_verb_with_no_http_operation_fails_parity_for_that_reason(http):
    http.app.router.routes[:] = [
        r for r in http.app.router.routes if getattr(r, "path", "") != "/runs/{run_id}"
    ]
    assert parity_failures(service.VERBS, **surfaces(http)) == [
        "runs show: missing from the HTTP operation (GET /runs/{run_id})"
    ]


# ----- a fake verb added to the registry, lacking one surface


def _fake_verb() -> Verb:
    return Verb(
        name="frob",
        summary="A fake verb.",
        params={
            "type": "object",
            "properties": {"thing": {"type": "string"}},
            "required": ["thing"],
        },
        http=("POST", "/runs/frob"),
        role="admin",
    )


def _complete_surfaces(http: Http, verb: Verb) -> dict[str, Any]:
    found = surfaces(http)
    found["cli"][verb.name] = {"thing": True}
    found["mcp"][f"{NOUN}_{verb.name}"] = {"thing": True}
    found["http"][f"{verb.http[0]} {verb.http[1]}"] = {"thing": True}
    return found


def test_a_fake_verb_on_every_surface_passes(http):
    verb = _fake_verb()
    assert parity_failures((*service.VERBS, verb), **_complete_surfaces(http, verb)) == []


@pytest.mark.parametrize(
    "surface, key, label",
    [
        ("cli", "frob", "CLI (frob)"),
        ("mcp", "runs_frob", "MCP tool (runs_frob)"),
        ("http", "POST /runs/frob", "HTTP operation (POST /runs/frob)"),
    ],
)
def test_a_fake_verb_lacking_one_surface_fails_for_exactly_that_reason(http, surface, key, label):
    verb = _fake_verb()
    found = _complete_surfaces(http, verb)
    del found[surface][key]
    assert parity_failures((*service.VERBS, verb), **found) == [
        f"runs frob: missing from the {label}"
    ]


# ----- params must match, and an operation no verb declares must fail


@pytest.mark.parametrize(
    "surface, key", [("cli", "start"), ("mcp", "runs_start"), ("http", "POST /runs")]
)
def test_a_surface_accepting_other_params_fails(http, surface, key):
    found = surfaces(http)
    found[surface][key] = {**found[surface][key], "extra": False}
    failures = parity_failures(service.VERBS, **found)
    assert len(failures) == 1
    assert failures[0].startswith("runs start: ") and "differ from" in failures[0]


@pytest.mark.parametrize(
    "surface, key", [("cli", "start"), ("mcp", "runs_start"), ("http", "POST /runs")]
)
def test_a_surface_with_another_required_set_fails(http, surface, key):
    found = surfaces(http)
    found[surface][key] = {**found[surface][key], "timeout": True}
    failures = parity_failures(service.VERBS, **found)
    assert len(failures) == 1 and "differ from" in failures[0]


def test_an_mcp_tool_no_verb_declares_fails(http, monkeypatch):
    real = mcp_tools.tools
    extra = mcpserver.Tool("runs_frob", "x", {"type": "object"}, lambda a: {})
    monkeypatch.setattr(mcp_tools, "tools", lambda **kw: [*real(**kw), extra])
    assert parity_failures(service.VERBS, **surfaces(http)) == [
        "MCP tool 'runs_frob' has no registry verb"
    ]


def test_a_runs_route_no_verb_declares_fails(http):
    http.app.add_api_route("/runs/frob", lambda: {}, methods=["POST"])
    assert parity_failures(service.VERBS, **surfaces(http)) == [
        "HTTP operation 'POST /runs/frob' has no registry verb"
    ]


def test_a_cli_command_no_verb_declares_fails(http, monkeypatch):
    real = _build_parser

    def with_frob():
        parser = real()
        for top in parser._actions:
            if isinstance(top, argparse._SubParsersAction):
                for inner in top.choices[NOUN]._actions:
                    if isinstance(inner, argparse._SubParsersAction):
                        inner.add_parser("frob")
        return parser

    monkeypatch.setattr(f"{__name__}._build_parser", with_frob)
    assert parity_failures(service.VERBS, **surfaces(http)) == [
        "CLI command 'runs frob' has no registry verb"
    ]
