# Cited from qodo-cli hatch_build.py @ ee73d5682a02952a76567887995b4f2e3aca5ea2
# (which cited culture-rules hatch_build.py @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac;
# cite-don't-import: this repo owns its copy and may change it.)
# Adapted: the package is ``associate`` (``associate/web_dist``); the strict switch is
#          ASSOCIATE_REQUIRE_WEB and ASSOCIATE_SKIP_WEB builds a wheel without the UI on purpose
#          (the tests that prove the API-only wheel).
"""Hatch build hook: ship the built web UI (``web/dist``) inside the wheel as ``associate/web_dist``.

The hook packages an existing build; it never runs Node. Release CI runs ``npm ci && npm run
build`` in ``web/`` before ``uv build`` (``.github/workflows/publish.yml``); this hook then
force-includes ``web/dist`` as ``associate/web_dist`` (never committed; git-ignored). It applies to
the sdist too (``uv build`` builds the wheel from the sdist), so the build survives the round
trip. With ``ASSOCIATE_REQUIRE_WEB=1`` (release CI) a missing build fails the build instead of
silently shipping a wheel without the UI. Without it, a plain ``uv sync`` / editable install /
wheel build works with no Node installed, and ``associate serve`` then answers the API only
(``/`` is a JSON 404). ``ASSOCIATE_SKIP_WEB=1`` leaves the UI out even when ``web/dist`` exists.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from hatchling.builders.hooks.plugin.interface import BuildHookInterface
except ImportError:  # pragma: no cover - only absent when imported outside a build (tests)
    BuildHookInterface = object  # type: ignore[assignment,misc]

WEB_DIST_TARGET = "associate/web_dist"


def _flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in ("1", "true", "yes")


def web_force_include(root: Path | str, *, require: bool, skip: bool = False) -> dict[str, str]:
    """``{source: target}`` for the built UI, empty when absent (an error if ``require``)."""
    if skip:
        return {}
    dist = Path(root) / "web" / "dist"
    if (dist / "index.html").is_file():
        return {str(dist): WEB_DIST_TARGET}
    # a wheel built from the sdist: the UI is already in the package tree there (and no git
    # ignore applies), so it ships as ordinary package data; force-including it again would
    # add every file twice
    if (Path(root) / WEB_DIST_TARGET / "index.html").is_file():
        return {}
    if require:
        raise RuntimeError(
            "web/dist/index.html is missing: run `npm ci && npm run build` in web/ before "
            "building (ASSOCIATE_REQUIRE_WEB is set)"
        )
    return {}


class WebDistHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version, build_data):
        build_data["force_include"].update(
            web_force_include(
                self.root,
                require=_flag("ASSOCIATE_REQUIRE_WEB"),
                skip=_flag("ASSOCIATE_SKIP_WEB"),
            )
        )
