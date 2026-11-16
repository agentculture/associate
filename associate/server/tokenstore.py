"""Where this app's service tokens live, and the one way the CLI and the API open them.

The store is one file (:class:`associate.bridge.filetokens.FileTokenStore`, mode 0600, hashes
only): ``--tokens PATH`` on the commands, else ``$ASSOCIATE_SERVER_TOKENS``, else
``$XDG_STATE_HOME/associate/service_tokens.json`` (``~/.local/state`` when unset). The CLI that
issues a token and the server that checks it must read the same file. Standard library only.

There is one store implementation, the cited generic one in the bridge folder; this module is
only the app's wiring around it (the path and the token prefix).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from associate.bridge.filetokens import FileTokenStore
from associate.bridge.tokens import ServiceTokens
from associate.server.app import TOKEN_PREFIX

__all__ = ["ENV_TOKENS", "default_token_path", "open_tokens"]

ENV_TOKENS = "ASSOCIATE_SERVER_TOKENS"


def default_token_path(
    path: str | Path | None = None, env: Mapping[str, str] | None = None
) -> Path:
    """``path``, else ``$ASSOCIATE_SERVER_TOKENS``, else the XDG state default."""
    if path:
        return Path(path)
    env = os.environ if env is None else env
    explicit = (env.get(ENV_TOKENS) or "").strip()
    if explicit:
        return Path(explicit)
    state = (env.get("XDG_STATE_HOME") or "").strip()
    base = Path(state) if state and os.path.isabs(state) else Path.home() / ".local" / "state"
    return base / "associate" / "service_tokens.json"


def open_tokens(
    path: str | Path | None = None, env: Mapping[str, str] | None = None
) -> ServiceTokens:
    """The service tokens stored at :func:`default_token_path`."""
    return ServiceTokens(FileTokenStore(default_token_path(path, env)), prefix=TOKEN_PREFIX)
