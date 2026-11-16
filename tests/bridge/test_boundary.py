"""The bridge is a reusable framework: provenance on every cited file, no app name inside."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

BRIDGE = Path(__file__).resolve().parents[2] / "associate" / "bridge"
CITED = ("access", "resolve", "tokens", "principal", "static", "caching", "guards", "mcpserver")
ORIGINAL = ("policy", "origin")
SOURCE_PATH = re.compile(r"culture_rules/[\w/]+\.py")
COMMIT = re.compile(r"\b[0-9a-f]{40}\b")
NAME = re.compile("associate", re.IGNORECASE)


def _split(text: str) -> tuple[str, str]:
    """The leading ``#`` provenance header and the rest of the file."""
    lines = text.splitlines(keepends=True)
    n = 0
    while n < len(lines) and lines[n].startswith("#"):
        n += 1
    return "".join(lines[:n]), "".join(lines[n:])


def test_the_bridge_modules_exist():
    for name in CITED + ORIGINAL + ("__init__",):
        assert (BRIDGE / f"{name}.py").is_file(), name


@pytest.mark.parametrize("name", CITED)
def test_each_cited_file_names_its_source_path_and_commit(name):
    header, _ = _split((BRIDGE / f"{name}.py").read_text(encoding="utf-8"))
    assert "culture-rules" in header
    assert SOURCE_PATH.search(header), f"{name}: no culture_rules/... source path in the header"
    assert COMMIT.search(header), f"{name}: no 40-hex commit in the header"


@pytest.mark.parametrize("path", sorted(BRIDGE.rglob("*.py")), ids=lambda p: p.name)
def test_no_file_under_the_bridge_names_the_app(path):
    _, body = _split(path.read_text(encoding="utf-8"))
    # the only allowed occurrences are import paths (`associate.` in an import statement)
    stripped = "\n".join(
        line
        for line in body.splitlines()
        if not re.match(r"\s*(from|import)\s+associate(\.|\s)", line)
    )
    assert not NAME.search(stripped), f"{path.name} mentions the app name outside imports"


def test_no_bridge_file_reads_the_source_projects_env_prefix_or_names():
    for path in BRIDGE.rglob("*.py"):
        _, body = _split(path.read_text(encoding="utf-8"))
        assert "CULTURE_RULES" not in body, path.name
        assert "culture_rules" not in body, path.name


def test_bridge_files_import_each_other_relatively_or_not_at_all():
    """A second app cites the folder; absolute imports of the first app would break it."""
    for path in BRIDGE.rglob("*.py"):
        assert not re.search(r"^\s*(from|import)\s+associate", path.read_text(), re.M), path.name


def test_no_third_party_import_at_module_level_except_static_and_caching_free():
    """Everything except static.py imports with only the standard library."""
    code = (
        "import sys\n"
        "for m in ('fastapi','starlette','pydantic','uvicorn','mcp','httpx','cryptography'):\n"
        "    sys.modules[m] = None\n"
        "import associate.bridge, associate.bridge.access, associate.bridge.principal\n"
        "import associate.bridge.tokens, associate.bridge.resolve, associate.bridge.policy\n"
        "import associate.bridge.guards, associate.bridge.caching, associate.bridge.mcpserver\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "ok"
