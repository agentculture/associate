"""``hatch_build.py``: the built web UI ships as ``associate/web_dist``; the hook never runs Node.

The hook's decision is a pure function (:func:`hatch_build.web_force_include`), tested here
directly; the wheel tests in ``tests/test_base_install.py`` build real wheels through it.
"""

from __future__ import annotations

import importlib.util
import subprocess
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load_hook():
    spec = importlib.util.spec_from_file_location("hatch_build", ROOT / "hatch_build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def hook():
    return load_hook()


def built(root: Path) -> Path:
    dist = root / "web" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
    return dist


def test_pyproject_registers_the_hook():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["tool"]["hatch"]["build"]["hooks"]["custom"]["path"] == "hatch_build.py"
    assert pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == ["associate"]


def test_a_built_ui_is_force_included_as_the_packages_web_dist(hook, tmp_path):
    dist = built(tmp_path)
    assert hook.WEB_DIST_TARGET == "associate/web_dist"
    assert hook.web_force_include(tmp_path, require=False) == {str(dist): "associate/web_dist"}
    assert hook.web_force_include(tmp_path, require=True) == {str(dist): "associate/web_dist"}


def test_no_build_is_an_api_only_wheel_unless_required(hook, tmp_path):
    assert hook.web_force_include(tmp_path, require=False) == {}
    with pytest.raises(RuntimeError, match="ASSOCIATE_REQUIRE_WEB"):
        hook.web_force_include(tmp_path, require=True)


def test_skip_leaves_the_ui_out_even_when_built(hook, tmp_path):
    built(tmp_path)
    assert hook.web_force_include(tmp_path, require=True, skip=True) == {}


def test_a_tree_unpacked_from_the_sdist_ships_the_ui_as_package_data(hook, tmp_path):
    packaged = tmp_path / "associate" / "web_dist"
    packaged.mkdir(parents=True)
    (packaged / "index.html").write_text("<!doctype html>", encoding="utf-8")
    assert hook.web_force_include(tmp_path, require=True) == {}


@pytest.mark.parametrize(
    "value, expected", [("1", True), ("true", True), ("YES", True), ("", False), ("0", False)]
)
def test_the_switches_read_the_associate_prefix(hook, monkeypatch, value, expected):
    monkeypatch.setenv("ASSOCIATE_REQUIRE_WEB", value)
    assert hook._flag("ASSOCIATE_REQUIRE_WEB") is expected


def test_the_build_output_is_git_ignored_and_not_tracked():
    for path in ("web/dist/index.html", "associate/web_dist/index.html", "web/node_modules/x"):
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", path], cwd=ROOT, check=False, capture_output=True
        )
        assert ignored.returncode == 0, f"{path} is not git-ignored"
    tracked = subprocess.run(
        ["git", "ls-files", "web/dist", "associate/web_dist", "web/node_modules"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    assert tracked.stdout == ""
