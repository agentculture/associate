"""An in-process adapter that replays a scripted walk — **plumbing only**.

It exists so the contract, the artifact shapes and the adapter interface can be
exercised in CI with no Pi, no Node, and no lane. Every artifact it writes and
every result it returns carries ``plumbing_only: true``: a green stub run says
the wiring works, and says *nothing* about model reliability. Never present a
stub result as a behavioral measurement.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from associate import contract
from associate.contract import validate
from associate.harness.base import STATEMENTS_FILENAME, WALK_FILENAME, Harness

__all__ = ["StubHarness", "DEFAULT_SCRIPT", "DEFAULT_STATEMENTS"]

#: The scripted tool events replayed when no script is supplied. Shaped like a
#: minimal read/find run: one search, one bounded read, one refused read.
DEFAULT_SCRIPT: tuple[dict[str, Any], ...] = (
    {
        "tool": "shell",
        "args": {"argv": ["rg", "--line-number", "def ", "associate"]},
        "result": {"content": "associate/contract/validate.py:44:def _resolve(...)"},
    },
    {
        "tool": "read",
        "args": {"path": "associate/contract/validate.py", "offset": 1, "limit": 40},
        "result": {"content": "     1\t# a bounded read of a fixture file\n"},
    },
    {
        "tool": "read",
        "args": {"path": "../outside-root"},
        "result": {},
        "error": "path '../outside-root' escapes the repo root",
    },
)

#: Statements replayed when none are supplied. One referenced, one not — so a
#: consumer of the stub sees both states of the UNREFERENCED marker.
DEFAULT_STATEMENTS: tuple[dict[str, Any], ...] = (
    {"text": "validate.py defines _resolve", "evidence": ["w1", "w2"]},
    {"text": "the package is small", "evidence": []},
)

DEFAULT_CITATIONS: tuple[dict[str, Any], ...] = (
    {"path": "associate/contract/validate.py", "line": 44, "check": "encountered"},
)


class StubHarness(Harness):
    """Replay scripted events into real contract-shaped artifacts."""

    name = "stub"

    def __init__(
        self,
        script: Iterable[dict[str, Any]] | None = None,
        statements: Iterable[dict[str, Any]] | None = None,
        citations: Iterable[dict[str, Any]] | None = None,
        outcome: str = "ok",
    ) -> None:
        self._script = [dict(event) for event in (script if script is not None else DEFAULT_SCRIPT)]
        self._statements = [
            dict(s) for s in (statements if statements is not None else DEFAULT_STATEMENTS)
        ]
        self._citations = [
            dict(c) for c in (citations if citations is not None else DEFAULT_CITATIONS)
        ]
        self._outcome = outcome
        self._export_dir: Path | None = None
        self._session_id: str | None = None
        self._result: dict[str, Any] | None = None

    # -- lifecycle ---------------------------------------------------------

    def start(
        self,
        checkout: Path,
        contract_dir: Path,
        session_id: str,
        export_dir: Path,
    ) -> None:
        self._checkout = Path(checkout)
        self._contract_dir = Path(contract_dir)
        self._session_id = session_id
        self._export_dir = Path(export_dir)
        self._export_dir.mkdir(parents=True, exist_ok=True)
        self._result = None

    def submit(self, task: dict[str, Any]) -> None:
        if self._export_dir is None:
            raise RuntimeError("StubHarness.submit() called before start()")
        validate.assert_valid(task, contract.load_schema("task"))

        started = time.monotonic()
        entries = [self._entry(index, event) for index, event in enumerate(self._script, start=1)]
        written = {entry["id"] for entry in entries}
        run_record = {
            "duration_ms": max(0, int((time.monotonic() - started) * 1000)),
            "tool_calls": len(entries),
            "outcome": self._outcome,
            "truncated": any(entry["truncated"] for entry in entries),
        }

        walk_path = self._export_dir / WALK_FILENAME
        with walk_path.open("w", encoding="utf-8") as handle:
            for entry in entries:
                handle.write(json.dumps(_redact(entry), sort_keys=True) + "\n")
            handle.write(json.dumps({"run": run_record}, sort_keys=True) + "\n")

        statements = {
            "statements": [self._statement(s, written) for s in self._statements],
            "citations": list(self._citations),
            "not_fully_read": run_record["truncated"],
            "plumbing_only": True,
        }
        statements_path = self._export_dir / STATEMENTS_FILENAME
        statements_path.write_text(
            json.dumps(_redact(statements), indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        self._result = {
            "walk_path": str(walk_path),
            "statements_path": str(statements_path),
            "outcome": run_record["outcome"],
            "session_id": self._session_id,
            "plumbing_only": True,
        }

    def collect(self) -> dict[str, Any]:
        if self._result is None:
            raise RuntimeError("StubHarness.collect() called before submit()")
        return dict(self._result)

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _entry(index: int, event: dict[str, Any]) -> dict[str, Any]:
        result = dict(event.get("result") or {})
        content = result.get("content")
        if isinstance(content, str) and "sha256" not in result:
            result["sha256"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
            result["bytes"] = len(content.encode("utf-8"))
        entry = {
            "id": f"w{index}",
            "ts": datetime.now(timezone.utc).isoformat(),
            "tool": event.get("tool", "unknown"),
            "args": dict(event.get("args") or {}),
            "result": result,
            "truncated": bool(event.get("truncated", False)),
        }
        if event.get("error"):
            entry["error"] = str(event["error"])
        return entry

    @staticmethod
    def _statement(statement: dict[str, Any], written: set[str]) -> dict[str, Any]:
        evidence = [ref for ref in statement.get("evidence", []) if ref in written]
        return {
            "text": statement.get("text", ""),
            "evidence": evidence,
            "status": "referenced" if evidence else "unreferenced",
        }


# ---------------------------------------------------------------------------
# Redaction — a harness-side filter applied before an artifact is written
# (spec claim c38), driven by policy.json so the patterns live in the contract.
# ---------------------------------------------------------------------------


def _compiled_patterns() -> list[re.Pattern[str]]:
    policy = contract.load_policy()["redaction"]
    return [re.compile(pattern) for pattern in policy["patterns"]]


def _redact(value: Any) -> Any:
    """Return *value* with every string leaf passed through the redaction filter."""
    replacement = contract.load_policy()["redaction"]["replacement"]
    patterns = _compiled_patterns()

    def walk(node: Any) -> Any:
        if isinstance(node, str):
            for pattern in patterns:
                node = pattern.sub(replacement, node)
            return node
        if isinstance(node, dict):
            return {key: walk(item) for key, item in node.items()}
        if isinstance(node, list):
            return [walk(item) for item in node]
        return node

    return walk(value)
