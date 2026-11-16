# Cited into this repo from qodo-cli tests/test_serve_config.py @
#  9ac0a9c4f1d7a93507ccc15295f565123025e1e1
# (cite-don't-import: this repo owns its copy.) Adapted: ASSOCIATE_ variables, associate
# modules, the extra's name 'associate[server]'.
"""The listener configuration as data: no socket is opened, no web framework is imported."""

from __future__ import annotations

import sys

import pytest

from associate.bridge.access import AccessConfigError
from associate.server import serve as srv

ACCESS = {
    "ASSOCIATE_ACCESS_LISTEN": "127.0.0.1:9100",
    "ASSOCIATE_ACCESS_TEAM_DOMAIN": "team.example.com",
    "ASSOCIATE_ACCESS_AUD": "aud-tag",
}


def test_by_default_only_the_loopback_listener_exists():
    specs = srv.plan_listeners({})
    assert [(s.name, s.host, s.port, s.access) for s in specs] == [
        ("loopback", "127.0.0.1", srv.DEFAULT_PORT, None)
    ]
    assert srv.DEFAULT_HOST == "127.0.0.1"


def test_the_lan_listener_is_off_unless_a_host_is_given():
    assert [s.name for s in srv.plan_listeners({"ASSOCIATE_LAN_PORT": "9001"})] == ["loopback"]
    specs = srv.plan_listeners({"ASSOCIATE_LAN_HOST": "0.0.0.0"})
    assert [(s.name, s.host, s.port) for s in specs] == [
        ("loopback", "127.0.0.1", srv.DEFAULT_PORT),
        ("lan", "0.0.0.0", srv.DEFAULT_LAN_PORT),
    ]
    assert specs[1].access is None


def test_flags_beat_the_environment():
    env = {
        "ASSOCIATE_HOST": "127.0.0.2",
        "ASSOCIATE_PORT": "1111",
        "ASSOCIATE_LAN_HOST": "10.0.0.1",
        "ASSOCIATE_LAN_PORT": "2222",
    }
    specs = srv.plan_listeners(env, host="127.0.0.3", port=3333, lan_host="10.0.0.9", lan_port=4444)
    assert [(s.host, s.port) for s in specs] == [("127.0.0.3", 3333), ("10.0.0.9", 4444)]
    env_only = srv.plan_listeners(env)
    assert [(s.host, s.port) for s in env_only] == [("127.0.0.2", 1111), ("10.0.0.1", 2222)]


@pytest.mark.parametrize("host", ["0.0.0.0", "10.0.0.5", "example.com", "::", ""])
def test_the_loopback_listener_refuses_a_non_loopback_address(host):
    with pytest.raises(srv.ListenerConfigError, match="loopback"):
        srv.plan_listeners({}, host=host or "0.0.0.0")


@pytest.mark.parametrize("host", ["127.0.0.1", "127.9.9.9", "::1", "localhost"])
def test_loopback_addresses_are_accepted(host):
    assert srv.plan_listeners({}, host=host)[0].host == host


def test_access_makes_the_loopback_listener_trust_access_headers():
    spec = srv.plan_listeners(ACCESS)[0]
    assert (spec.name, spec.host, spec.port) == ("loopback", "127.0.0.1", 9100)
    assert spec.access is not None and spec.access.team_domain == "team.example.com"
    assert spec.access.audience == "aud-tag"


def test_access_never_attaches_to_the_lan_listener():
    specs = srv.plan_listeners({**ACCESS, "ASSOCIATE_LAN_HOST": "0.0.0.0"})
    assert specs[0].access is not None and specs[1].access is None


def test_access_on_a_non_loopback_address_is_refused():
    for listen in ("0.0.0.0:9100", ":9100", "10.0.0.5:9100"):
        with pytest.raises(srv.ListenerConfigError, match="loopback"):
            srv.plan_listeners({**ACCESS, "ASSOCIATE_ACCESS_LISTEN": listen})


def test_a_partial_access_configuration_is_refused():
    with pytest.raises(AccessConfigError):
        srv.plan_listeners({"ASSOCIATE_ACCESS_TEAM_DOMAIN": "team.example.com"})


def test_the_two_listeners_cannot_share_an_address():
    with pytest.raises(srv.ListenerConfigError, match="same address"):
        srv.plan_listeners({}, lan_host="127.0.0.1", lan_port=srv.DEFAULT_PORT)


@pytest.mark.parametrize("port", ["0", "70000", "x", "-1", ""])
def test_a_bad_port_is_refused(port):
    with pytest.raises(srv.ListenerConfigError, match="port"):
        srv.plan_listeners({"ASSOCIATE_PORT": port or "x"})
    with pytest.raises(srv.ListenerConfigError, match="port"):
        srv.plan_listeners({"ASSOCIATE_LAN_HOST": "0.0.0.0", "ASSOCIATE_LAN_PORT": port or "x"})


def test_admins_and_editors_are_comma_lists():
    names = srv.names({"ASSOCIATE_ADMINS": " a@x.com, b@x.com ,, "}, "ASSOCIATE_ADMINS")
    assert names == {"a@x.com", "b@x.com"}
    assert srv.names({}, "ASSOCIATE_EDITORS") == frozenset()


def test_importing_the_serve_module_imports_no_web_framework():
    import subprocess

    code = (
        "import sys\n"
        "for m in ('fastapi','starlette','uvicorn'): sys.modules[m] = None\n"
        "import associate.server.serve, associate.server\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.stdout.strip() == "ok", done.stderr


def test_without_the_server_extra_serve_names_it(monkeypatch):
    monkeypatch.setitem(sys.modules, "fastapi", None)
    monkeypatch.setitem(sys.modules, "uvicorn", None)
    with pytest.raises(srv.ServerExtraMissing, match=r"associate\[server\]"):
        srv.require_extra()


def test_the_default_ports_are_this_apps_own():
    """8792/8793 belong to qodo-cli; this app's pair is 8794 (loopback) and 8795 (LAN)."""
    assert (srv.DEFAULT_PORT, srv.DEFAULT_LAN_PORT) == (8794, 8795)


def test_a_port_of_superscript_digits_is_a_config_error_not_a_crash():
    with pytest.raises(srv.ListenerConfigError):
        srv.plan_listeners({"ASSOCIATE_PORT": "²"})
