# Cited into this repo through qodo-cli qodo/bridge/guards.py @
#  d87e2db7f3e84390a4662b348088c76c1ad68012
# Cited from culture-rules culture_rules/auth/guards.py @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: only the pattern is kept. The source's checks are about its own documents (workflow
# inline scripts, actor secrets, runner commands, machine install, actor briefs) and its
# import/export bundle; those are cut. What remains is the shared shape of the three "only an
# admin may change this field" guards (runner commands, install, briefs): a ChangeGuard compares
# a JSON-normalised field of the stored and incoming document, and save_check composes guards
# per document kind. Denials are Forbidden (HTTP 403) with a stable code.
"""Body-dependent authorization on saves (a route-to-role table cannot see bodies).

A :class:`ChangeGuard` says "only ``role`` may add, change or remove this part of a document".
It compares the part of the stored document with the part of the incoming one; an unchanged
part passes for anyone, so a lower role may still save the document around it. Run the guard
inside the save transaction (it needs the stored version). Standard library only.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .principal import Forbidden, Principal

__all__ = ["ChangeGuard", "GuardDenied", "save_check"]

#: ``(kind, stored document or None, document about to be written)``; raises to refuse.
SaveCheck = Callable[[str, "Mapping[str, Any] | None", Mapping[str, Any]], None]


class GuardDenied(Forbidden):
    """A principal below the guard's role changed a guarded part of a document (HTTP 403)."""


def _normal(value: Any) -> Any:
    """JSON-normalised, so a tuple and a list compare equal. Only ``None`` is absent:
    ``False``, ``0`` and an empty container are values, and setting one is a change."""
    return None if value is None else json.loads(json.dumps(value, sort_keys=True, default=str))


@dataclass(frozen=True)
class ChangeGuard:
    """Only ``role`` (or above) may change what ``extract`` reads from a document.

    ``applies`` limits the guard to some documents (a part that is inert elsewhere counts as
    absent there, so turning a document into one it applies to is a change).
    """

    code: str
    label: str
    extract: Callable[[Mapping[str, Any]], Any]
    applies: Callable[[Mapping[str, Any]], bool] = lambda doc: True  # noqa: E731
    role: str = "admin"

    def _part(self, doc: Mapping[str, Any] | None) -> Any:
        if not isinstance(doc, Mapping) or not self.applies(doc):
            return None
        return _normal(self.extract(doc))

    def check(
        self, principal: Principal, before: Mapping[str, Any] | None, after: Mapping[str, Any]
    ) -> None:
        if principal.has_role(self.role):
            return
        if self._part(after) != self._part(before):
            raise GuardDenied(
                self.code,
                f"changing {self.label} ({after.get('id', '?')}) is {self.role}-only; "
                f"{principal.identity!r} is not an {self.role}",
            )


def save_check(principal: Principal, guards: Mapping[str, Iterable[ChangeGuard]]) -> SaveCheck:
    """The in-transaction save check for ``principal``: every guard registered for the kind."""
    by_kind = {kind: tuple(gs) for kind, gs in guards.items()}

    def check(kind: str, before: Mapping[str, Any] | None, after: Mapping[str, Any]) -> None:
        for guard in by_kind.get(kind, ()):
            guard.check(principal, before, after)

    return check
