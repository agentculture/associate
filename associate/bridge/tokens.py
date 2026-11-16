# Cited into this repo through qodo-cli qodo/bridge/tokens.py @
#  d87e2db7f3e84390a4662b348088c76c1ad68012
# Cited from culture-rules culture_rules/auth/tokens.py @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: the crt_ token prefix is the required `prefix` parameter of ServiceTokens;
# Adapted: the engine.audit and store.port imports are cut: the store is a local Protocol
#          (TokenStore) and the audit log an optional AuditHook callable (the mutating_verb
#          registry is dropped);
# Adapted: role ordering uses principal.ROLES; imports are relative.
"""Service tokens: bearer credentials for the CLI, MCP servers and mesh agents.

A token reads ``<prefix><id>.<secret>`` (the prefix is a parameter of :class:`ServiceTokens`).
Only ``sha256(secret)`` is stored (collection :data:`SERVICE_TOKENS`, keyed by ``id``) together
with the identity, kind (``service`` or ``agent``) and roles it grants; the plaintext is
returned once, by :meth:`ServiceTokens.issue`. The secret is 256 random bits, so a fast hash is
enough (there is nothing to brute-force) and the comparison is constant-time. Revocation
tombstones the record (``revoked_at``) so the audit trail keeps pointing at it. Issue and revoke
are audited through an optional ``audit`` hook. Stdlib only."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from collections.abc import Callable, Iterable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from .principal import ROLES, Principal, validate_roles

__all__ = [
    "SERVICE_TOKENS",
    "AuditHook",
    "IssuedToken",
    "ServiceTokens",
    "TokenError",
    "TokenStore",
]

Document = dict[str, Any]
SERVICE_TOKENS = "service_tokens"
TOKEN_KINDS = ("service", "agent")
_SEP = "."


class TokenOps(Protocol):
    """The reads and writes a store handle offers (what a transaction hands back too)."""

    def get(self, collection: str, id: str) -> Document | None: ...

    def find(self, collection: str, where: Mapping[str, Any] | None = None) -> list[Document]: ...

    def insert(self, collection: str, document: Mapping[str, Any]) -> Document: ...

    def update_if(
        self, collection: str, id: str, expected: Mapping[str, Any], changes: Mapping[str, Any]
    ) -> Any:
        """Compare-and-set; the result has ``won`` (bool) and ``document`` (the new one)."""


class TokenStore(TokenOps, Protocol):
    def transaction(self) -> AbstractContextManager[TokenOps]: ...


class AuditHook(Protocol):
    """Called inside the issue/revoke transaction with the handle and one entry's fields."""

    def __call__(
        self,
        ops: TokenOps,
        *,
        identity: str,
        verb: str,
        collection: str,
        target_id: str,
        before: Mapping[str, Any] | None,
        after: Mapping[str, Any] | None,
    ) -> Any: ...


def _require_identity(identity: Any) -> str:
    if not isinstance(identity, str) or not identity.strip():
        raise TokenError("invalid", "identity must be a non-empty string")
    return identity


class TokenError(ValueError):
    """An invalid issue/revoke request (bad roles, unknown or already-revoked token)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class IssuedToken:
    """The one moment the plaintext ``token`` exists; ``record`` is the stored doc sans hash."""

    id: str
    token: str
    record: dict[str, Any]


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def public(doc: Document) -> dict[str, Any]:
    """A stored record without its hash (what lists, responses and audit diffs may show)."""
    return {k: v for k, v in doc.items() if k != "hash"}


class ServiceTokens:
    """Issue, revoke and authenticate service tokens stored in ``store``."""

    def __init__(
        self,
        store: TokenStore,
        *,
        prefix: str,
        audit: AuditHook | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not prefix:
            raise ValueError("a token prefix is required (e.g. 'app_')")
        self._store = store
        self.prefix = prefix
        self._audit = audit
        self._clock = clock or (lambda: datetime.now(UTC))

    def _write_audit(self, tx: TokenOps, **entry: Any) -> None:
        if self._audit is not None:
            self._audit(tx, **entry)

    def _now(self) -> str:
        return self._clock().astimezone(UTC).isoformat(timespec="microseconds")

    def issue(
        self, identity: str, *, name: str, roles: Iterable[str], kind: str = "service"
    ) -> IssuedToken:
        """Issue a token for principal ``name`` (granting ``roles``); ``identity`` is the issuer."""
        _require_identity(identity)
        if not isinstance(name, str) or not name.strip():
            raise TokenError("invalid", "token name (its principal identity) must be non-empty")
        if kind not in TOKEN_KINDS:
            raise TokenError("invalid", f"token kind must be one of {', '.join(TOKEN_KINDS)}")
        try:
            granted = validate_roles(roles)
        except ValueError as exc:
            raise TokenError("invalid", str(exc)) from None
        if not granted:
            raise TokenError("invalid", "a token must grant at least one role")
        token_id = uuid.uuid4().hex[:16]
        secret = secrets.token_urlsafe(32)
        doc = {
            "id": token_id,
            "identity": name.strip(),
            "kind": kind,
            "roles": sorted(granted, key=ROLES.index),
            "hash": _hash(secret),
            "created_at": self._now(),
            "created_by": identity,
            "revoked_at": None,
            "revoked_by": None,
        }
        with self._store.transaction() as tx:
            stored = tx.insert(SERVICE_TOKENS, doc)
            self._write_audit(
                tx,
                identity=identity,
                verb="service_tokens.issue",
                collection=SERVICE_TOKENS,
                target_id=token_id,
                before=None,
                after=public(stored),
            )
        return IssuedToken(token_id, f"{self.prefix}{token_id}{_SEP}{secret}", public(stored))

    def revoke(self, token_id: str, identity: str) -> dict[str, Any]:
        _require_identity(identity)
        with self._store.transaction() as tx:
            before = tx.get(SERVICE_TOKENS, token_id)
            if before is None:
                raise TokenError("not_found", f"service token {token_id!r} does not exist")
            if before.get("revoked_at"):
                raise TokenError("conflict", f"service token {token_id!r} is already revoked")
            res = tx.update_if(
                SERVICE_TOKENS,
                token_id,
                {"revoked_at": None},
                {"revoked_at": self._now(), "revoked_by": identity},
            )
            if not res.won:
                raise TokenError("conflict", f"service token {token_id!r} changed concurrently")
            self._write_audit(
                tx,
                identity=identity,
                verb="service_tokens.revoke",
                collection=SERVICE_TOKENS,
                target_id=token_id,
                before=public(before),
                after=public(res.document),
            )
        return public(res.document)

    def list(self) -> list[dict[str, Any]]:
        docs = self._store.find(SERVICE_TOKENS)
        return [public(d) for d in sorted(docs, key=lambda d: (d.get("created_at", ""), d["id"]))]

    def authenticate(self, presented: str) -> Principal | None:
        """The principal a live token grants, or None (unknown, garbled, wrong or revoked)."""
        if not isinstance(presented, str) or not presented.startswith(self.prefix):
            return None
        parts = presented[len(self.prefix) :].split(_SEP)
        if len(parts) != 2 or not all(parts):
            return None
        token_id, presented_secret = parts
        doc = self._store.get(SERVICE_TOKENS, token_id)
        if doc is None or doc.get("revoked_at"):
            return None
        if not hmac.compare_digest(_hash(presented_secret), str(doc.get("hash", ""))):
            return None
        try:
            return Principal(doc["identity"], doc["kind"], frozenset(doc.get("roles") or ()))
        except (KeyError, ValueError):
            return None
