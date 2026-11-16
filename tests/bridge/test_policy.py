"""The route-to-role mechanism: an ordered rule list the app fills in, failing closed."""

from __future__ import annotations

import pytest

from associate.bridge.policy import RoutePolicy
from associate.bridge.principal import Forbidden, Principal, Unauthenticated


def sample() -> RoutePolicy:
    p = RoutePolicy()
    p.public("/health")
    p.add("GET", "/items", "viewer")
    p.add("POST", "/items", "editor")
    p.add("GET", "/items/{id}", "viewer")
    p.add(("PUT", "DELETE"), "/items/{id}", "editor")
    p.add("*", "/admin/**", "admin")
    return p


@pytest.mark.parametrize(
    "method, path, role",
    [
        ("GET", "/health", None),
        ("GET", "/items", "viewer"),
        ("HEAD", "/items", "viewer"),
        ("POST", "/items", "editor"),
        ("GET", "/items/7", "viewer"),
        ("DELETE", "/items/7", "editor"),
        ("GET", "/items/", "viewer"),
        ("GET", "/admin", "admin"),
        ("PATCH", "/admin/a/b", "admin"),
        # nothing matched: fail closed to the default (admin)
        ("GET", "/items/7/secret", "admin"),
        ("PATCH", "/items/7", "admin"),
        ("GET", "/nope", "admin"),
        ("GET", "/healthz", "admin"),
        ("GET", "/health/x", "admin"),
    ],
)
def test_required_role(method, path, role):
    assert sample().required_role(method, path) == role


def test_first_matching_rule_wins():
    p = RoutePolicy()
    p.add("GET", "/a/special", "admin")
    p.add("GET", "/a/{x}", "viewer")
    assert p.required_role("GET", "/a/special") == "admin"
    assert p.required_role("GET", "/a/other") == "viewer"


def test_the_default_is_configurable_and_validated():
    assert RoutePolicy(default="viewer").required_role("GET", "/x") == "viewer"
    with pytest.raises(ValueError):
        RoutePolicy(default="root")
    with pytest.raises(ValueError):
        RoutePolicy().add("GET", "/x", "root")


@pytest.mark.parametrize("bad", ["items", "/a//b", "/a/**/b", "/a/{}", ""])
def test_malformed_patterns_are_refused(bad):
    with pytest.raises(ValueError):
        RoutePolicy().add("GET", bad, "viewer")


def test_check_enforces_the_role_order():
    p = sample()
    viewer = Principal("v", "sso", frozenset({"viewer"}))
    editor = Principal("e", "sso", frozenset({"editor"}))
    p.check(None, "GET", "/health")  # public: no principal needed
    p.check(viewer, "GET", "/items")
    p.check(editor, "GET", "/items")
    with pytest.raises(Forbidden) as ei:
        p.check(viewer, "POST", "/items")
    assert ei.value.status == 403
    with pytest.raises(Forbidden):
        p.check(editor, "GET", "/admin/x")
    with pytest.raises(Unauthenticated) as ei2:
        p.check(None, "GET", "/items")
    assert ei2.value.status == 401


def test_policy_holds_no_routes_of_its_own():
    p = RoutePolicy()
    assert p.rules == ()
    assert p.required_role("GET", "/anything") == "admin"
