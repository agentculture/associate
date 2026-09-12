"""Harness adapters and their registry.

``get_harness(name)`` resolves a registry key to an adapter class. Only
``stub`` is registered today; the Pi adapter lands with its own task. Imports
are function-local so importing this package never pulls in an adapter's
dependencies.
"""

from __future__ import annotations

from typing import Any, Callable

from associate.harness.base import Harness

__all__ = ["Harness", "available_harnesses", "get_harness"]


def _load_stub() -> type[Harness]:
    from associate.harness.stub import StubHarness

    return StubHarness


_REGISTRY: dict[str, Callable[[], type[Harness]]] = {
    "stub": _load_stub,
}


def available_harnesses() -> tuple[str, ...]:
    """Registered adapter names, sorted."""
    return tuple(sorted(_REGISTRY))


def get_harness(name: Any) -> type[Harness]:
    """Return the adapter class registered under *name*.

    Raises ``KeyError`` naming the unknown value and listing what is
    available — the message a ``--harness bogus`` invocation prints.
    """
    loader = _REGISTRY.get(name)
    if loader is None:
        raise KeyError(f"unknown harness {name!r}; available: {', '.join(available_harnesses())}")
    return loader()
