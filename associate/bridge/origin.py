# Original to this repo (no cited source): written for a code review finding on the bridge's
# HTTP API (a write forged from another site).
"""Refuse a state-changing request that a browser sent on behalf of another site.

Behind Cloudflare Access a browser's cookie is the credential, and a page on another site can
make a browser send a "simple" request (``POST`` with a ``text/plain``, form or multipart body)
with that cookie and without a CORS preflight. :func:`check_write` closes that, for every method
other than ``GET``, ``HEAD`` and ``OPTIONS``:

- a request whose ``Sec-Fetch-Site`` header is ``cross-site`` is refused (403
  ``cross_site_request``);
- a request whose ``Sec-Fetch-Site`` is ``same-origin`` is the browser's own word that the page
  and the server share an origin (a page cannot set that header), so its ``Origin`` is not
  compared: a proxy that hides the outer scheme cannot break this app's own pages;
- any other request with an ``Origin`` header is refused unless it names the request's own
  origin: the scheme the server saw and the ``Host`` header (403 ``cross_origin_request``); a
  forwarded host header is never consulted;
- the body must be declared ``application/json`` (parameters such as ``; charset=utf-8`` are
  allowed), which a browser cannot send cross-site without a preflight (415
  ``unsupported_media_type``).

A request with neither ``Sec-Fetch-Site`` nor ``Origin`` (curl, a rules engine, a CLI) passes
the first two checks. Call it before authentication, so a forged request gets the same answer
whether or not it carries a credential. Nothing here grants CORS: the host app sends no
``Access-Control-*`` header at all. Standard library only.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

__all__ = ["SAFE_METHODS", "Refusal", "check_write", "is_json_media", "same_origin"]

#: Methods that never change state here and so are never checked.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_DEFAULT_PORTS = {"http": 80, "https": 443}
_HELP = "call the API from a server, a script or this app's own pages"


@dataclass(frozen=True)
class Refusal:
    """Why a request is refused: an HTTP status, a stable code, a message and a remediation."""

    status: int
    code: str
    message: str
    remediation: str = ""


def is_json_media(content_type: str | None) -> bool:
    """True when the ``Content-Type`` is ``application/json`` (any parameters, any case)."""
    return (content_type or "").split(";", 1)[0].strip().lower() == "application/json"


def _origin_of(url: str) -> tuple[str, str, int | None] | None:
    """``(scheme, host, port)`` of a bare origin URL (the scheme's default port filled in)."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.path or parts.query or parts.fragment or parts.username or parts.password:
        return None
    scheme = parts.scheme.lower()
    if not scheme or not parts.hostname:
        return None
    return scheme, parts.hostname, port if port is not None else _DEFAULT_PORTS.get(scheme)


def same_origin(origin: str, scheme: str, host: str | None) -> bool:
    """Whether the ``Origin`` header names ``scheme://host`` (the request's own origin)."""
    if not host or "/" in host or "@" in host:
        return False
    theirs = _origin_of(origin)
    return theirs is not None and theirs == _origin_of(f"{scheme}://{host}")


def _cross_site(headers: Mapping[str, str], scheme: str) -> Refusal | None:
    site = headers.get("sec-fetch-site", "").strip().lower()
    if site == "same-origin":
        return None
    if site == "cross-site":
        return Refusal(
            403,
            "cross_site_request",
            "a state-changing request sent by a page on another site is refused",
            _HELP,
        )
    origin = headers.get("origin")
    if origin is not None and not same_origin(origin.strip(), scheme, headers.get("host")):
        return Refusal(
            403, "cross_origin_request", "the request's Origin is not this server's origin", _HELP
        )
    return None


def check_write(method: str, headers: Mapping[str, str], scheme: str) -> Refusal | None:
    """The refusal for a forged or non-JSON write, or ``None`` when the request may proceed.

    ``headers`` has lower-case names; ``scheme`` is the scheme the server saw (``http`` or
    ``https``). Safe methods (:data:`SAFE_METHODS`) are never refused.
    """
    if method.upper() in SAFE_METHODS:
        return None
    refusal = _cross_site(headers, scheme)
    if refusal is not None:
        return refusal
    if not is_json_media(headers.get("content-type")):
        return Refusal(
            415,
            "unsupported_media_type",
            "the body must be sent as Content-Type: application/json",
            "send the parameters as a JSON object with Content-Type: application/json",
        )
    return None
