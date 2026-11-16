# Cited from culture-rules tests/auth/test_resolve.py @
#  b7f861f690b57c4355f81371cc02ad1dd2ae9cac (adapted)
"""Criterion 2 (pure): loopback honours Access headers, LAN ignores them; bearer works on both."""

from __future__ import annotations

import pytest

from tests.bridge.jwks import AUD, TEAM, claims, jwks, now, token

from associate.bridge.access import AccessVerifier  # noqa: E402  isort: skip
from associate.bridge.principal import Principal, Unauthenticated  # noqa: E402  isort: skip
from associate.bridge.resolve import (  # noqa: E402  isort: skip
    ACCESS_HEADER,
    DEFAULT_DEV_IDENTITY_HEADER as DEV_IDENTITY_HEADER,
    LAN,
    LOOPBACK,
    AuthSettings,
    Resolver,
)
from associate.bridge.tokens import ServiceTokens  # noqa: E402  isort: skip
from tests.bridge.memstore import MemoryStore  # noqa: E402  isort: skip


def access() -> AccessVerifier:
    return AccessVerifier(TEAM, AUD, fetch_jwks=jwks, clock=now)


@pytest.fixture
def store() -> MemoryStore:
    return MemoryStore()


def resolver(store, **kw) -> Resolver:
    return Resolver(AuthSettings(**kw), ServiceTokens(store, prefix="tok_"))


def reject(r: Resolver, headers) -> str:
    with pytest.raises(Unauthenticated) as ei:
        r.resolve(headers)
    return ei.value.code


def test_loopback_listener_honours_a_valid_access_jwt(store):
    r = resolver(store, listener=LOOPBACK, access=access(), editors={"alice@example.com"})
    p = r.resolve({ACCESS_HEADER: token()})
    assert p == Principal("alice@example.com", "sso", frozenset({"editor"}))


def test_sso_principal_defaults_to_viewer_and_admins_elevate(store):
    r = resolver(store, listener=LOOPBACK, access=access(), admins={"root@example.com"})
    assert r.resolve({ACCESS_HEADER: token()}).roles == frozenset({"viewer"})
    root = r.resolve({ACCESS_HEADER: token(claims(email="root@example.com"))})
    assert "admin" in root.roles


def test_loopback_rejects_an_invalid_access_jwt_without_falling_back(store):
    tokens = ServiceTokens(store, prefix="tok_")
    issued = tokens.issue("root", name="ci", roles=["admin"])
    r = Resolver(AuthSettings(listener=LOOPBACK, access=access()), tokens)
    bad = token(claims(aud=["other"]))
    headers = {ACCESS_HEADER: bad, "Authorization": f"Bearer {issued.token}"}
    assert reject(r, headers) == "bad_audience"


def test_lan_listener_ignores_access_headers_entirely(store):
    r = resolver(store, listener=LAN, access=access())
    assert reject(r, {ACCESS_HEADER: token()}) == "no_credentials"


def test_lan_listener_requires_a_service_token(store):
    tokens = ServiceTokens(store, prefix="tok_")
    issued = tokens.issue("root", name="ci", roles=["editor"])
    r = Resolver(AuthSettings(listener=LAN, access=access()), tokens)
    p = r.resolve({ACCESS_HEADER: token(), "authorization": f"Bearer {issued.token}"})
    assert p == Principal("ci", "service", frozenset({"editor"}))


def test_bearer_is_accepted_on_the_loopback_listener_too(store):
    tokens = ServiceTokens(store, prefix="tok_")
    issued = tokens.issue("root", name="agent-x", roles=["viewer"], kind="agent")
    r = Resolver(AuthSettings(listener=LOOPBACK, access=access()), tokens)
    assert r.resolve({"Authorization": f"bearer {issued.token}"}).kind == "agent"


@pytest.mark.parametrize(
    "headers, code",
    [
        ({}, "no_credentials"),
        ({"Authorization": "Bearer tok_nope.nope"}, "bad_token"),
        ({"Authorization": "Basic Zm9vOmJhcg=="}, "bad_token"),
        ({DEV_IDENTITY_HEADER: "alice"}, "no_credentials"),
    ],
)
def test_unresolvable_requests_are_rejected(store, headers, code):
    assert reject(resolver(store, listener=LAN), headers) == code


def test_dev_identity_header_only_behind_the_insecure_flag(store):
    assert AuthSettings().insecure_dev_identity is False
    r = resolver(store, insecure_dev_identity=True)
    assert r.resolve({DEV_IDENTITY_HEADER: "alice"}).identity == "alice"
    assert r.resolve({}).identity == "anonymous"


def test_loopback_without_access_configured_ignores_the_header(store):
    r = resolver(store, listener=LOOPBACK, access=None)
    assert reject(r, {ACCESS_HEADER: token()}) == "no_credentials"


def test_settings_reject_unknown_listener():
    with pytest.raises(ValueError):
        AuthSettings(listener="wan")


def test_dev_identity_header_name_is_a_parameter(store):
    r = resolver(store, insecure_dev_identity=True, dev_identity_header="X-Other-Identity")
    assert r.resolve({"X-Other-Identity": "bob"}).identity == "bob"
    assert r.resolve({DEV_IDENTITY_HEADER: "bob"}).identity == "anonymous"
