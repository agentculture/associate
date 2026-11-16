# Cited from qodo-cli qodo/bridge/policy.py @
#  d87e2db7f3e84390a4662b348088c76c1ad68012
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: none beyond this header. The file is original to qodo-cli (no culture-rules source).
"""Route -> required role: a small ordered rule list the app fills in. Standard library only.

The framework ships the mechanism and no routes. An app builds one :class:`RoutePolicy`::

    policy = RoutePolicy()                       # default: admin (fail closed)
    policy.public("/health")
    policy.add("GET", "/things", "viewer")
    policy.add("POST", "/things", "editor")
    policy.add(("PUT", "DELETE"), "/things/{id}", "editor")
    policy.add("*", "/ops/**", "admin")

and enforces it before any handler runs: ``policy.check(principal, method, path)``.

Rules are tried in the order they were added; the first whose method and path match decides. A
path with no matching rule needs the policy's ``default`` role (``admin`` unless the app says
otherwise), so a forgotten route is closed, not open. ``HEAD`` counts as ``GET``.

Path patterns are ``/``-separated segments: a literal, ``{name}`` (exactly one segment) or, as the
last segment only, ``**`` (zero or more segments). A trailing slash is ignored. Nothing else is
interpreted: no regex, no query string, no percent-decoding, so the caller passes the path the
router will route on.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from .principal import Forbidden, Principal, Unauthenticated, role_rank

__all__ = ["ANY_METHOD", "Rule", "RoutePolicy"]

ANY_METHOD = "*"
_PUBLIC = None


@dataclass(frozen=True)
class Rule:
    """One rule: the methods it covers, its path segments and the role it needs (None: public)."""

    methods: frozenset[str]
    segments: tuple[str, ...]
    role: str | None

    def matches(self, method: str, parts: tuple[str, ...]) -> bool:
        if ANY_METHOD not in self.methods and method not in self.methods:
            return False
        segs = self.segments
        if segs and segs[-1] == "**":
            head = segs[:-1]
            return len(parts) >= len(head) and _segments_match(head, parts[: len(head)])
        return len(parts) == len(segs) and _segments_match(segs, parts)


def _segments_match(pattern: tuple[str, ...], parts: tuple[str, ...]) -> bool:
    return all(p == s or (p.startswith("{") and bool(s)) for p, s in zip(pattern, parts))


def _parts(path: str) -> tuple[str, ...]:
    return tuple(path.strip("/").split("/")) if path.strip("/") else ()


def _compile(pattern: str) -> tuple[str, ...]:
    if not pattern.startswith("/"):
        raise ValueError(f"a route pattern starts with '/': {pattern!r}")
    segments = _parts(pattern)
    for i, seg in enumerate(segments):
        if not seg:
            raise ValueError(f"empty segment in route pattern {pattern!r}")
        if seg == "**" and i != len(segments) - 1:
            raise ValueError(f"'**' may only be the last segment: {pattern!r}")
        if seg.startswith("{") and (not seg.endswith("}") or len(seg) < 3):
            raise ValueError(f"bad parameter segment {seg!r} in {pattern!r}")
    return segments


class RoutePolicy:
    """An ordered rule list plus the role an unmatched route needs."""

    def __init__(self, *, default: str = "admin") -> None:
        role_rank(default)
        self.default = default
        self._rules: list[Rule] = []

    @property
    def rules(self) -> tuple[Rule, ...]:
        return tuple(self._rules)

    def add(self, methods: str | Iterable[str], pattern: str, role: str | None) -> RoutePolicy:
        """Append a rule needing ``role`` (None: public); returns self for chaining."""
        if role is not _PUBLIC:
            role_rank(role)
        names = [methods] if isinstance(methods, str) else list(methods)
        if not names:
            raise ValueError("a rule needs at least one method")
        self._rules.append(Rule(frozenset(m.upper() for m in names), _compile(pattern), role))
        return self

    def public(self, pattern: str, methods: str | Iterable[str] = ANY_METHOD) -> RoutePolicy:
        """Append a rule that needs no credential at all (health probes and the like)."""
        return self.add(methods, pattern, _PUBLIC)

    def required_role(self, method: str, path: str) -> str | None:
        """The role the first matching rule needs (None: public), else the default."""
        verb = method.upper()
        verb = "GET" if verb == "HEAD" else verb
        parts = _parts(path)
        for rule in self._rules:
            if rule.matches(verb, parts):
                return rule.role
        return self.default

    def check(self, principal: Principal | None, method: str, path: str) -> None:
        """Raise :class:`Unauthenticated` (no principal) or :class:`Forbidden` (role too low)."""
        role = self.required_role(method, path)
        if role is _PUBLIC:
            return
        if principal is None:
            raise Unauthenticated("no_credentials", "this route needs authentication")
        if not principal.has_role(role):
            raise Forbidden(
                "forbidden", f"{principal.identity!r} needs the {role!r} role for this route"
            )
