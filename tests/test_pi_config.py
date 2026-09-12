"""Acceptance tests for tracked Pi project config and package manifest.

Covers t1: .pi/settings.json, package.json (pi key), .gitignore entries for
Pi's project-local caches and the associate export root.
"""

import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_pi_settings_tracked_with_no_home_paths():
    settings_path = REPO_ROOT / ".pi" / "settings.json"
    assert settings_path.is_file()

    tracked = subprocess.run(
        ["git", "ls-files", ".pi/settings.json"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert tracked == ".pi/settings.json"

    raw = settings_path.read_text(encoding="utf-8")
    assert "~" not in raw
    assert "/home" not in raw

    data = _read_json(settings_path)
    assert data["defaultTools"] == []
    assert ".claude/skills" in data["skills"]


def test_pi_settings_extensions_point_at_associate_extensions_dir():
    settings_path = REPO_ROOT / ".pi" / "settings.json"
    data = _read_json(settings_path)
    assert ".pi/extensions/associate" in data["extensions"]


def test_package_json_pi_key_no_deps_no_scripts():
    package_path = REPO_ROOT / "package.json"
    assert package_path.is_file()

    data = _read_json(package_path)
    assert "pi" in data
    assert ".pi/extensions/associate" in data["pi"]["extensions"]
    assert ".claude/skills" in data["pi"]["skills"]

    assert "dependencies" not in data
    assert "devDependencies" not in data
    assert "scripts" not in data


def test_python_package_dependencies_still_empty():
    pyproject = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "dependencies = []" in pyproject


def test_gitignore_covers_pi_caches_and_export_root():
    gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    for expected in (".pi/npm/", ".pi/git/", "node_modules/", ".associate-runs/"):
        assert expected in gitignore, f"missing {expected!r} in .gitignore"


def test_ignored_pi_and_export_paths_are_not_tracked():
    tracked = subprocess.run(
        ["git", "ls-files"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()

    for entry in tracked:
        assert not entry.startswith(".pi/npm/")
        assert not entry.startswith(".pi/git/")
        assert not entry.startswith("node_modules/")
        assert not entry.startswith(".associate-runs/")
