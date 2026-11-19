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
from associate.accuracy import (
    ANSWER_FILENAME,
    CHECK_FILENAME,
    FACTS_FILENAME,
    REPORT_FILENAME,
    accuracy_result,
    check_handback,
)
from associate.contract import validate
from associate.harness.base import STATEMENTS_FILENAME, WALK_FILENAME, Harness

__all__ = ["StubHarness", "DEFAULT_SCRIPT", "DEFAULT_STATEMENTS", "DEFAULT_PAYLOAD"]

#: The scripted tool events replayed when no script is supplied. Shaped like a
#: minimal read/find run: one search, one bounded read, one refused read.
DEFAULT_SCRIPT: tuple[dict[str, Any], ...] = (
    {
        "tool": "shell",
        "purpose": "find where the contract resolves a schema",
        "args": {"argv": ["rg", "--line-number", "def ", "associate"]},
        "result": {"content": "associate/contract/validate.py:44:def _resolve(...)"},
    },
    {
        "tool": "read",
        "purpose": "read the top of the validator",
        "args": {"path": "associate/contract/validate.py", "offset": 1, "limit": 40},
        "result": {"content": "     1\t# a bounded read of a fixture file\n"},
    },
    {
        "tool": "read",
        "purpose": "check that a path outside the repo is refused",
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


#: The facts payload (``facts.schema.json``) replayed with the default script. The
#: quotes are lines of the default script's saved results, so the re-check passes them.
DEFAULT_PAYLOAD: dict[str, Any] = {
    "summary": "Plumbing-only stub hand-back. It says nothing about any model.",
    "facts": [
        {
            "id": "f1",
            "value": "fixture",
            "source": "w2",
            "quote": "a bounded read of a fixture file",
        },
        {"id": "f2", "value": "_resolve", "source": "w1", "quote": "def _resolve(...)"},
    ],
    "verdicts": [
        {
            "id": "v1",
            "text": "validate.py defines _resolve",
            "verdict": "supported",
            "basis": ["f1", "f2"],
            "closing": True,
        }
    ],
    "open_items": [
        {
            "id": "o1",
            "text": "whether another module also defines _resolve",
            "check": "rg --line-number '_resolve' associate",
        }
    ],
}

#: Added to the payload when ``unsupported_fact`` is set: a quote the saved result
#: does not hold, so the checker refuses it and the verdict resting on it.
_UNSUPPORTED_FACT: dict[str, Any] = {
    "id": "f3",
    "value": "nowhere",
    "source": "w1",
    "quote": "a line the saved result does not hold",
}


class StubHarness(Harness):
    """Replay scripted events into real contract-shaped artifacts."""

    name = "stub"

    def __init__(
        self,
        script: Iterable[dict[str, Any]] | None = None,
        statements: Iterable[dict[str, Any]] | None = None,
        citations: Iterable[dict[str, Any]] | None = None,
        outcome: str = "ok",
        payload: dict[str, Any] | None = None,
        check_mode: str | None = None,
        unsupported_fact: bool = False,
    ) -> None:
        self._script = [dict(event) for event in (script if script is not None else DEFAULT_SCRIPT)]
        self._statements = [
            dict(s) for s in (statements if statements is not None else DEFAULT_STATEMENTS)
        ]
        self._citations = [
            dict(c) for c in (citations if citations is not None else DEFAULT_CITATIONS)
        ]
        self._outcome = outcome
        if payload is not None:
            self._payload = json.loads(json.dumps(payload))
        elif script is None:
            self._payload = json.loads(json.dumps(DEFAULT_PAYLOAD))
        else:
            # A caller's own script has no known quotes: an empty hand-back.
            self._payload = {"facts": []}
        if unsupported_fact:
            self._payload["facts"] = [*self._payload["facts"], dict(_UNSUPPORTED_FACT)]
            for verdict in self._payload.get("verdicts", []):
                verdict["basis"] = [*verdict["basis"], _UNSUPPORTED_FACT["id"]]
        self._check_mode = check_mode
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
        accuracy = contract.load_accuracy()
        entries = [
            self._entry(index, event, accuracy) for index, event in enumerate(self._script, start=1)
        ]
        written = {entry["id"] for entry in entries}
        results = self._save_results(entries)
        entries = [_redact(entry) for entry in entries]

        payload = _redact(self._payload)
        mode = self._check_mode or "report"
        check = check_handback(
            {"payload": payload, "entries": entries, "results": results}, accuracy
        )
        ended_refused = mode == "enforce" and not check["accepted"]
        outcome = "refused" if ended_refused else self._outcome
        run_record = {
            "duration_ms": max(0, int((time.monotonic() - started) * 1000)),
            "tool_calls": len(entries),
            "outcome": outcome,
            "truncated": any(entry["truncated"] for entry in entries),
        }

        walk_path = self._export_dir / WALK_FILENAME
        with walk_path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps({"format": {"name": "associate-walk", "version": 2}}) + "\n")
            for entry in entries:
                handle.write(json.dumps(entry, sort_keys=True) + "\n")
            handle.write(json.dumps({"run": run_record}, sort_keys=True) + "\n")

        self._write_handback(payload, check, mode, ended_refused, accuracy)

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
            **accuracy_result(
                self._export_dir,
                accuracy,
                continue_from=task.get("continue_from"),
                check_mode=self._check_mode,
            ),
        }

    def collect(self) -> dict[str, Any]:
        if self._result is None:
            raise RuntimeError("StubHarness.collect() called before submit()")
        return dict(self._result)

    # -- helpers -----------------------------------------------------------

    def _save_results(self, entries: list[dict[str, Any]]) -> dict[str, str]:
        """Write each entry's redacted result text to ``results/wN.txt``; id to text."""
        assert self._export_dir is not None
        saved: dict[str, str] = {}
        for entry in entries:
            content = entry["result"].get("content")
            if not isinstance(content, str):
                continue
            text = _redact(content)
            target = self._export_dir / "results" / f"{entry['id']}.txt"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
            entry["saved_result"] = f"results/{entry['id']}.txt"
            saved[entry["id"]] = text
        return saved

    def _write_handback(
        self,
        payload: dict[str, Any],
        check: dict[str, Any],
        mode: str,
        ended_refused: bool,
        accuracy: dict[str, Any],
    ) -> None:
        """Write facts.json, check.json, report.json and (when accepted) answer.md.

        The shapes the Pi extension writes at ``finish``; the answer is a plain
        stand-in, not the extension's renderer.
        """
        assert self._export_dir is not None
        refusals = [
            {"id": item["id"], "item": kind, "reason": item["reason"], "check": item["check"]}
            for kind, items in (
                ("fact", check["facts"]),
                ("verdict", check["verdicts"]),
                ("open_item", check["open_items"]),
            )
            for item in items
            if item.get("outcome", item.get("verdict")) == "refused"
        ]
        summary = payload.get("summary") if isinstance(payload.get("summary"), str) else ""
        unchecked = {
            "summary_sentences": len(re.findall(r"[.!?]+(?:\s|$)", summary)),
            "final_message_sentences": 0,
        }
        record: dict[str, Any] = {
            "mode": mode,
            "mode_source": "env" if self._check_mode else "stub_default",
            "accepted": check["accepted"],
            "facts": check["facts"],
            "verdicts": check["verdicts"],
            "open_items": check["open_items"],
            "unchecked_text": {**unchecked, "final_message": "none"},
        }
        if ended_refused:
            record.update(
                outcome="refused",
                round=accuracy["retry_rounds"] + 1,
                rounds_left=0,
                run_ended=True,
                refusals=refusals,
            )
        else:
            record.update(outcome="accepted", would_refuse=refusals if mode == "report" else [])
        self._write_json(FACTS_FILENAME, payload)
        self._write_json(CHECK_FILENAME, record)
        self._write_json(REPORT_FILENAME, {**check["report"], "unchecked_text": unchecked})
        answer = self._export_dir / ANSWER_FILENAME
        if ended_refused:
            answer.unlink(missing_ok=True)
        else:
            lines = ["# Answer (plumbing only)", "", summary, ""]
            lines += [
                f"- {v['id']}: {v['text']} ({v['verdict']})" for v in payload.get("verdicts", [])
            ]
            answer.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _write_json(self, name: str, value: Any) -> None:
        assert self._export_dir is not None
        (self._export_dir / name).write_text(
            json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

    @staticmethod
    def _entry(index: int, event: dict[str, Any], accuracy: dict[str, Any]) -> dict[str, Any]:
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
        if event.get("purpose"):
            entry["purpose"] = str(event["purpose"])
        kind = (accuracy.get("source_kinds") or {}).get(entry["tool"])
        if kind:
            entry["source_kind"] = kind
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
