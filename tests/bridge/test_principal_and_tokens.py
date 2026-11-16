# Cited from culture-rules tests/auth/test_principal_and_tokens.py @
#  b7f861f690b57c4355f81371cc02ad1dd2ae9cac (adapted)
"""Principal {identity, kind, roles}, role order, hashed service tokens (issue/revoke audited)."""

from __future__ import annotations

import hashlib

import pytest

from associate.bridge.principal import ROLES, Principal, role_rank
from associate.bridge.tokens import SERVICE_TOKENS, ServiceTokens, TokenError
from tests.bridge.memstore import Audit, MemoryStore

PREFIX = "tok_"


def test_roles_are_ordered_viewer_editor_admin():
    assert ROLES == ("viewer", "editor", "admin")
    assert role_rank("viewer") < role_rank("editor") < role_rank("admin")


@pytest.mark.parametrize(
    "held, required, ok",
    [
        ({"viewer"}, "viewer", True),
        ({"viewer"}, "editor", False),
        ({"editor"}, "viewer", True),
        ({"editor"}, "admin", False),
        ({"admin"}, "editor", True),
        (set(), "viewer", False),
    ],
)
def test_principal_has_role_honours_the_order(held, required, ok):
    assert Principal("p", "sso", frozenset(held)).has_role(required) is ok


def test_principal_validates_kind_and_roles_and_serialises():
    p = Principal("bot", "agent", frozenset({"editor"}))
    assert p.to_dict() == {"identity": "bot", "kind": "agent", "roles": ["editor"]}
    with pytest.raises(ValueError):
        Principal("x", "robot", frozenset())
    unknown_role = frozenset({"superuser"})
    with pytest.raises(ValueError):
        Principal("x", "sso", unknown_role)
    no_roles = frozenset()
    with pytest.raises(ValueError):
        Principal("  ", "sso", no_roles)


@pytest.fixture
def store() -> MemoryStore:
    return MemoryStore()


def test_issue_returns_secret_once_and_stores_only_a_hash(store):
    issued = ServiceTokens(store, prefix=PREFIX).issue("root", name="ci-bot", roles=["editor"])
    assert issued.token.startswith(PREFIX)
    (doc,) = store.find(SERVICE_TOKENS)
    assert doc["id"] == issued.id
    assert doc["identity"] == "ci-bot"
    assert doc["roles"] == ["editor"]
    assert doc["kind"] == "service"
    assert doc["revoked_at"] is None
    assert issued.token not in repr(doc)
    secret = issued.token.split(".", 1)[1]
    assert doc["hash"] == hashlib.sha256(secret.encode()).hexdigest()
    assert "hash" not in issued.record


def test_authenticate_resolves_a_principal(store):
    tokens = ServiceTokens(store, prefix=PREFIX)
    issued = tokens.issue("root", name="mesh-agent", roles=["viewer"], kind="agent")
    p = tokens.authenticate(issued.token)
    assert p == Principal("mesh-agent", "agent", frozenset({"viewer"}))


@pytest.mark.parametrize("bad", ["", PREFIX, "tok_nope.secret", "Bearer x", "tok_a.b.c"])
def test_unknown_or_garbled_tokens_do_not_authenticate(store, bad):
    ServiceTokens(store, prefix=PREFIX).issue("root", name="x", roles=["viewer"])
    assert ServiceTokens(store, prefix=PREFIX).authenticate(bad) is None


def test_wrong_secret_for_a_real_id_does_not_authenticate(store):
    issued = ServiceTokens(store, prefix=PREFIX).issue("root", name="x", roles=["viewer"])
    assert ServiceTokens(store, prefix=PREFIX).authenticate(issued.token[:-2] + "zz") is None


def test_revoked_token_no_longer_authenticates(store):
    tokens = ServiceTokens(store, prefix=PREFIX)
    issued = tokens.issue("root", name="x", roles=["viewer"])
    revoked = tokens.revoke(issued.id, "root")
    assert revoked["revoked_by"] == "root"
    assert revoked["revoked_at"]
    assert tokens.authenticate(issued.token) is None
    with pytest.raises(TokenError):
        tokens.revoke(issued.id, "root")
    with pytest.raises(TokenError):
        tokens.revoke("missing", "root")


def test_issue_validates_roles_kind_and_name(store):
    tokens = ServiceTokens(store, prefix=PREFIX)
    with pytest.raises(TokenError):
        tokens.issue("root", name="x", roles=["god"])
    with pytest.raises(TokenError):
        tokens.issue("root", name="x", roles=["viewer"], kind="sso")
    with pytest.raises(TokenError):
        tokens.issue("root", name="", roles=["viewer"])
    with pytest.raises(TokenError):
        tokens.issue("root", name="x", roles=[])


def test_list_never_exposes_hashes(store):
    tokens = ServiceTokens(store, prefix=PREFIX)
    tokens.issue("root", name="a", roles=["viewer"])
    tokens.issue("root", name="b", roles=["admin"])
    listed = tokens.list()
    assert [t["identity"] for t in listed] == ["a", "b"]
    assert all("hash" not in t for t in listed)


def test_prefix_is_a_parameter_and_a_foreign_prefix_does_not_authenticate(store):
    issued = ServiceTokens(store, prefix="zzz_").issue("root", name="x", roles=["viewer"])
    assert issued.token.startswith("zzz_")
    assert ServiceTokens(store, prefix="zzz_").authenticate(issued.token) is not None
    assert ServiceTokens(store, prefix=PREFIX).authenticate(issued.token) is None


def test_issue_and_revoke_call_the_audit_hook_without_the_hash(store):
    audit = Audit()
    tokens = ServiceTokens(store, prefix=PREFIX, audit=audit)
    issued = tokens.issue("root", name="a", roles=["viewer"])
    tokens.revoke(issued.id, "root")
    assert [e["verb"] for e in audit.entries] == ["service_tokens.issue", "service_tokens.revoke"]
    assert all(e["identity"] == "root" for e in audit.entries)
    assert all(issued.token.split(".", 1)[1] not in repr(e) for e in audit.entries)
    assert all("hash" not in repr(e) for e in audit.entries)


def test_audit_is_optional(store):
    ServiceTokens(store, prefix=PREFIX).issue("root", name="a", roles=["viewer"])
