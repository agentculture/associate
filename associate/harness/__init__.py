"""Harness adapters and their registry.

``get_harness(name)`` resolves a registry key to an adapter class. Two are
registered: ``pi`` (the fail-closed launcher over the installed ``pi`` binary)
and ``stub`` (plumbing only — no runtime, no lane). Imports are function-local
so importing this package never pulls in an adapter's dependencies.
"""

from __future__ import annotations

from typing import Any, Callable

from associate.harness.base import ExtensionNotLoadedError, Harness, HarnessError

__all__ = [
    "Harness",
    "HarnessError",
    "ExtensionNotLoadedError",
    "available_harnesses",
    "get_harness",
]


def _load_stub() -> type[Harness]:
    from associate.harness.stub import StubHarness

    return StubHarness


def _load_pi() -> type[Harness]:
    from associate.harness.pi import PiHarness

    return PiHarness


_REGISTRY: dict[str, Callable[[], type[Harness]]] = {
    "pi": _load_pi,
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
