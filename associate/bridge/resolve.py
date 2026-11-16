# Cited into this repo through qodo-cli qodo/bridge/resolve.py @
#  d87e2db7f3e84390a4662b348088c76c1ad68012
# Cited from culture-rules culture_rules/auth/resolve.py @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: the X-Culture-Identity dev header became the AuthSettings parameter
#          dev_identity_header (default X-Dev-Identity); Resolver takes any TokenAuthenticator (a
#          Protocol) instead of importing ServiceTokens; imports are relative.
"""Resolve a request's headers into a :class:`Principal`, per listener.

Two listeners, on purpose:

- ``loopback`` - reached only by ``cloudflared`` on the same host, i.e. traffic that passed
  Cloudflare Access. Honours ``Cf-Access-Jwt-Assertion`` (when Access is configured); a
  present-but-invalid assertion is refused outright, never silently downgraded.
- ``lan`` - the machines, the CLI and agents. Ignores the Access header (a JWT seen on the
  plaintext LAN is useless there) and requires ``Authorization: Bearer <service token>``.

A service token works on both. Roles: a token carries its own; an SSO principal gets
``sso_default_role`` (viewer) plus editor/admin when its identity is listed in ``editors`` /
``admins``; ``admins`` also elevates any other principal. The dev identity header
(``dev_identity_header``, default ``X-Dev-Identity``) is honoured only with
``insecure_dev_identity=True`` (off by default), and then makes every unauthenticated caller an
admin - never enable it outside a laptop."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Protocol

from .access import AccessIdentity, AccessVerifier
from .principal import Principal, Unauthenticated, role_rank

__all__ = [
    "ACCESS_HEADER",
    "ANONYMOUS",
    "DEFAULT_DEV_IDENTITY_HEADER",
    "LAN",
    "LOOPBACK",
    "AuthSettings",
    "Resolver",
    "TokenAuthenticator",
]

ACCESS_HEADER = "Cf-Access-Jwt-Assertion"
DEFAULT_DEV_IDENTITY_HEADER = "X-Dev-Identity"
ANONYMOUS = "anonymous"
LOOPBACK = "loopback"
LAN = "lan"


@dataclass(frozen=True)
class AuthSettings:
    """Per-listener authentication configuration (no secrets, no per-request state)."""

    listener: str = LAN
    access: AccessVerifier | None = None
    admins: frozenset[str] = field(default_factory=frozenset)
    editors: frozenset[str] = field(default_factory=frozenset)
    sso_default_role: str = "viewer"
    insecure_dev_identity: bool = False
    dev_identity_header: str = DEFAULT_DEV_IDENTITY_HEADER

    def __post_init__(self) -> None:
        if self.listener not in (LOOPBACK, LAN):
            raise ValueError(f"listener must be {LOOPBACK!r} or {LAN!r}, not {self.listener!r}")
        role_rank(self.sso_default_role)
        object.__setattr__(self, "admins", frozenset(self.admins))
        object.__setattr__(self, "editors", frozenset(self.editors))

    def with_admins(self, admins: Iterable[str]) -> AuthSettings:
        return AuthSettings(
            listener=self.listener,
            access=self.access,
            admins=self.admins | frozenset(admins),
            editors=self.editors,
            sso_default_role=self.sso_default_role,
            insecure_dev_identity=self.insecure_dev_identity,
            dev_identity_header=self.dev_identity_header,
        )


class TokenAuthenticator(Protocol):
    """What the resolver needs of a token store (``tokens.ServiceTokens`` fits)."""

    def authenticate(self, presented: str) -> Principal | None: ...


class Resolver:
    """``resolve(headers) -> Principal``; raises :class:`Unauthenticated` (HTTP 401)."""

    def __init__(self, settings: AuthSettings, tokens: TokenAuthenticator) -> None:
        self.settings = settings
        self._tokens = tokens

    def resolve(self, headers: Mapping[str, str]) -> Principal:
        h = {str(k).lower(): v for k, v in headers.items()}
        s = self.settings
        assertion = h.get(ACCESS_HEADER.lower(), "")
        if s.listener == LOOPBACK and s.access is not None and assertion:
            return self._from_access(s.access.verify(assertion))  # raises Unauthenticated
        authorization = h.get("authorization", "")
        if authorization:
            return self._from_bearer(authorization)
        if s.insecure_dev_identity:
            identity = (h.get(s.dev_identity_header.lower()) or "").strip() or ANONYMOUS
            return Principal(identity, "sso", frozenset({"admin"}))
        raise Unauthenticated(
            "no_credentials",
            "authenticate with 'Authorization: Bearer <service token>'"
            + (" or Cloudflare Access" if s.listener == LOOPBACK and s.access else ""),
        )

    def _from_access(self, asserted: AccessIdentity) -> Principal:
        s = self.settings
        # a person gets the default role; an Access service token only what is listed
        base = s.sso_default_role if asserted.kind == "sso" else "viewer"
        listed = "editor" if asserted.identity in s.editors else base
        role = max(base, listed, key=role_rank)
        return self._elevate(Principal(asserted.identity, asserted.kind, frozenset({role})))

    def _from_bearer(self, authorization: str) -> Principal:
        scheme, _, presented = authorization.partition(" ")
        principal = None
        if scheme.lower() == "bearer":
            principal = self._tokens.authenticate(presented.strip())
        if principal is None:
            raise Unauthenticated("bad_token", "the bearer token is unknown or revoked")
        return self._elevate(principal)

    def _elevate(self, principal: Principal) -> Principal:
        if principal.identity in self.settings.admins:
            return principal.with_roles({"admin"})
        return principal
