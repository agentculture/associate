"""The complete configuration a bench run was measured on (claim c48).

A behavioral number means nothing without the configuration that produced it,
so every row of the table carries all of it: the harness, the model *role* and
the served model id the endpoint reports, the pi version, the extension
version, and the provider and reasoning settings.

Two rules hold here:

* **No secret is ever collected.** ``ASSOCIATE_API_KEY`` and anything else whose
  name looks like a credential is never read into a value; the base URL has any
  embedded userinfo stripped, and every string is passed through the contract's
  redaction patterns as a backstop.
* **Absent is reported as absent.** A missing ``pi`` or extension is the string
  ``"absent"`` — never a guess, never an empty column.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess  # nosec B404 - fixed argv, no shell, used only for `pi --version`
from pathlib import Path
from typing import Any

from associate import contract
from associate.cli._commands.whoami import find_culture_yaml, read_agent_fields
from associate.contract import validate

__all__ = ["describe", "pi_version", "extension_version", "redact"]

#: Environment variable names whose *value* is never read into a row.
_SECRET_MARKERS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "BEARER", "CREDENTIAL", "AUTH")

_USERINFO = re.compile(r"://[^/@\s]*@")


def redact(text: str) -> str:
    """Run *text* through the contract's redaction patterns (policy.json)."""
    policy = contract.load_policy()["redaction"]
    for pattern in policy["patterns"]:
        text = validate.compile_pattern(pattern).sub(policy["replacement"], text)
    return text


def _env(*names: str) -> str | None:
    for name in names:
        if any(marker in name.upper() for marker in _SECRET_MARKERS):
            continue
        value = os.environ.get(name)
        if value:
            return value
    return None


def pi_version() -> str:
    """``pi --version``, or ``"absent"`` when pi is not on PATH."""
    executable = shutil.which("pi")
    if executable is None:
        return "absent"
    try:
        completed = subprocess.run(  # nosec B603 - fixed argv, shell=False
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):  # pragma: no cover - environment dependent
        return "unavailable"
    output = (completed.stdout or completed.stderr).strip().splitlines()
    return output[0].strip() if output else "unavailable"


def _repo_root() -> Path | None:
    cfg = find_culture_yaml()
    return cfg.parent if cfg is not None else None


def extension_version(root: Path | None = None) -> str:
    """The Pi extension's declared version, or ``"absent"``.

    Looks at ``.pi/extensions/associate/package.json`` first, then a ``version``
    literal in ``index.ts``. The extension is another task's deliverable; until
    it declares one, this column honestly reads ``absent``.
    """
    base = root if root is not None else _repo_root()
    if base is None:
        return "absent"
    extension = base / ".pi" / "extensions" / "associate"
    manifest = extension / "package.json"
    if manifest.is_file():
        try:
            declared = json.loads(manifest.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):  # pragma: no cover - malformed manifest
            declared = None
        if declared:
            return str(declared)
    index = extension / "index.ts"
    if index.is_file():
        match = re.search(
            r"""version\s*[:=]\s*["']([^"']+)["']""", index.read_text(encoding="utf-8")
        )
        if match:
            return match.group(1)
    return "absent"


def _served_model_id(harness: Any, result: dict[str, Any]) -> str:
    """Ask the adapter what the endpoint reports; the stub reports ``stub``."""
    reported = result.get("served_model_id")
    if isinstance(reported, str) and reported:
        return reported
    probe = getattr(harness, "served_model_id", None)
    if callable(probe):
        try:
            value = probe()
        except Exception:  # noqa: BLE001 - a probe failure is a column, not a crash
            return "unavailable"
        if isinstance(value, str) and value:
            return value
    if result.get("plumbing_only"):
        return "stub"
    return "unknown"


def describe(harness_name: str, harness: Any, result: dict[str, Any]) -> dict[str, Any]:
    """Assemble the configuration row shared by every case of one run."""
    fields = read_agent_fields()
    provider = _env("ASSOCIATE_PROVIDER", "ASSOCIATE_BASE_URL") or "unset"
    reasoning = _env("ASSOCIATE_REASONING_EFFORT", "ASSOCIATE_REASONING") or "unset"
    configuration = {
        "harness": harness_name,
        "model_role": fields.get("model", "unknown"),
        "served_model_id": _served_model_id(harness, result),
        "pi_version": pi_version(),
        "extension_version": extension_version(),
        "provider": _USERINFO.sub("://", provider),
        "reasoning": reasoning,
        "plumbing_only": bool(result.get("plumbing_only", False)),
    }
    return {
        key: redact(value) if isinstance(value, str) else value
        for key, value in configuration.items()
    }
