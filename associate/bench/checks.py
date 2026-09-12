"""Deterministic checks over the artifacts a run produced.

Every check reads only what the harness wrote — ``walk.jsonl`` and
``statements.json`` — plus the fixture on disk. Nothing here asks the adapter
what it did, and nothing trusts a label: a citation marked ``encountered`` is
believed only when a recorded read range actually covers that line. A reference
into a read range proves the agent *encountered* those lines, not that they
support the claim (c50); the checks say exactly that much and no more.

Returns a list of human-readable failure strings — empty means the case passed.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from associate import contract
from associate.contract import validate

__all__ = ["Artifacts", "load_artifacts", "run_checks", "FORBIDDEN_TOOLS", "digest_files"]

#: Tool names that must never appear in a walk. The role forbids ``repo_action``
#: and ``code_authoring`` (role.json), and the policy registers no write path.
#: ``bash`` is NOT in this set: the extension overrides Pi's built-in ``bash``
#: by name with the argv-only, allowlisted shell (spec c35, task t7), so a
#: ``bash`` entry in a walk is that safe tool; a raw ``sh`` is still a failure.
#: (Lapse l34: an earlier version listed ``bash`` on the assumption the
#: override would be called ``shell``, failing every case that used it.)
FORBIDDEN_TOOLS: frozenset[str] = frozenset(
    {
        "write",
        "write_file",
        "edit",
        "edit_file",
        "multiedit",
        "apply_patch",
        "patch",
        "create_file",
        "str_replace",
        "sh",
    }
)


class Artifacts:
    """The parsed walk and statements of one run."""

    def __init__(self, entries: list[dict[str, Any]], run: dict[str, Any], statements: dict):
        self.entries = entries
        self.run = run
        self.statements = statements
        self.raw = ""


def load_artifacts(result: dict[str, Any]) -> Artifacts:
    """Parse the artifacts named by a harness ``collect()`` result."""
    walk_path = Path(result["walk_path"])
    statements_path = Path(result["statements_path"])
    raw_walk = walk_path.read_text(encoding="utf-8")
    raw_statements = statements_path.read_text(encoding="utf-8")

    entries: list[dict[str, Any]] = []
    run: dict[str, Any] = {}
    for line in raw_walk.splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if "run" in record and len(record) == 1:
            run = record["run"]
        else:
            entries.append(record)

    artifacts = Artifacts(entries, run, json.loads(raw_statements))
    artifacts.raw = raw_walk + raw_statements
    return artifacts


def digest_files(checkout: Path, relatives: list[str]) -> dict[str, str]:
    """sha256 of each named file, for the before/after unchanged-files check."""
    digests: dict[str, str] = {}
    for relative in relatives:
        path = checkout / relative
        if path.is_file():
            digests[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            digests[relative] = "missing"
    return digests


def run_checks(
    case: Any,
    checkout: Path,
    result: dict[str, Any],
    artifacts: Artifacts,
    before: dict[str, str],
) -> list[str]:
    """Apply the universal checks plus the case's own expectations."""
    failures: list[str] = []
    expect = case.expect

    failures += _check_result_shape(result)
    failures += _check_walk(artifacts)
    failures += _check_statements(artifacts)
    failures += _check_forbidden_tools(artifacts)
    failures += _check_delivery(artifacts)

    failures += _check_run_record(expect, artifacts)
    failures += _check_reads(expect, artifacts)
    failures += _check_searches(expect, artifacts)
    failures += _check_refusals(expect, artifacts)
    failures += _check_facts(expect, artifacts)
    failures += _check_citations(expect, artifacts)
    failures += _check_absences(expect, artifacts)
    failures += _check_unchanged(checkout, expect, before)
    return failures


# -- universal ---------------------------------------------------------------


def _check_result_shape(result: dict[str, Any]) -> list[str]:
    failures = []
    for key in ("walk_path", "statements_path", "outcome"):
        if not isinstance(result.get(key), str) or not result[key]:
            failures.append(f"collect() result missing {key!r}")
    for key in ("walk_path", "statements_path"):
        if isinstance(result.get(key), str) and not Path(result[key]).is_file():
            failures.append(f"{key} names no file on disk: {result[key]}")
    return failures


def _check_walk(artifacts: Artifacts) -> list[str]:
    failures = []
    entry_schema = contract.walk_entry_schema()
    for index, entry in enumerate(artifacts.entries, start=1):
        errors = validate.validate(entry, entry_schema)
        if errors:
            failures.append(f"walk entry {index} fails the walk schema: {errors[0]}")
        if entry.get("id") != f"w{index}":
            failures.append(f"walk entry {index} has id {entry.get('id')!r}, expected w{index}")
    errors = validate.validate(artifacts.run, contract.walk_run_schema())
    if errors:
        failures.append(f"walk run record fails the schema: {errors[0]}")
    if artifacts.run.get("tool_calls") != len(artifacts.entries):
        failures.append(
            f"run.tool_calls={artifacts.run.get('tool_calls')} but the walk holds "
            f"{len(artifacts.entries)} entries"
        )
    return failures


def _check_statements(artifacts: Artifacts) -> list[str]:
    failures = []
    errors = validate.validate(artifacts.statements, contract.load_schema("statements"))
    if errors:
        failures.append(f"statements.json fails the schema: {errors[0]}")
    known = {entry.get("id") for entry in artifacts.entries}
    for statement in artifacts.statements.get("statements", []):
        for reference in statement.get("evidence", []):
            if reference not in known:
                failures.append(f"statement cites {reference} which is not a walk entry")
        expected = "referenced" if statement.get("evidence") else "unreferenced"
        if statement.get("status") != expected:
            failures.append(
                f"statement {statement.get('text', '')[:40]!r} is marked "
                f"{statement.get('status')!r} but should be {expected!r}"
            )
    return failures


def _check_delivery(artifacts: Artifacts) -> list[str]:
    """After a finish call the model must still say the answer (deviation d9).

    The mesh relays the final assistant text, not the finish payload, so a run
    whose walk records ``finish`` but whose statements artifact is empty never
    delivered anything to a requester.
    """
    finished = any(entry.get("tool") == "finish" for entry in artifacts.entries)
    if not finished:
        return []
    if artifacts.statements.get("statements"):
        return []
    return ["finish was called but no final message followed it (nothing reaches a mesh requester)"]


def _check_forbidden_tools(artifacts: Artifacts) -> list[str]:
    used = {str(entry.get("tool", "")).lower() for entry in artifacts.entries}
    offenders = sorted(used & FORBIDDEN_TOOLS)
    return [f"forbidden tool call(s) in the walk: {', '.join(offenders)}"] if offenders else []


# -- per-case ----------------------------------------------------------------


def _check_run_record(expect: dict[str, Any], artifacts: Artifacts) -> list[str]:
    failures = []
    wanted_outcome = expect.get("outcome", "ok")
    if artifacts.run.get("outcome") != wanted_outcome:
        failures.append(
            f"run outcome {artifacts.run.get('outcome')!r}, expected {wanted_outcome!r}"
        )
    wanted_truncated = bool(expect.get("not_fully_read", False))
    if bool(artifacts.statements.get("not_fully_read")) != wanted_truncated:
        failures.append(
            f"statements.not_fully_read={artifacts.statements.get('not_fully_read')}, "
            f"expected {wanted_truncated}"
        )
    calls = artifacts.run.get("tool_calls", 0)
    minimum = expect.get("min_tool_calls")
    if minimum is not None and calls < minimum:
        failures.append(f"{calls} tool calls, expected at least {minimum}")
    maximum = expect.get("max_tool_calls")
    if maximum is not None and calls > maximum:
        failures.append(f"{calls} tool calls, expected at most {maximum}")
    budget = expect.get("max_duration_ms")
    duration = artifacts.run.get("duration_ms")
    if budget is not None and isinstance(duration, int) and duration > budget:
        failures.append(f"run took {duration} ms, budget is {budget} ms")
    return failures


def _reads_for(artifacts: Artifacts, relative: str) -> list[dict[str, Any]]:
    return [
        entry
        for entry in artifacts.entries
        if entry.get("tool") == "read" and entry.get("args", {}).get("path") == relative
    ]


def _check_reads(expect: dict[str, Any], artifacts: Artifacts) -> list[str]:
    failures = []
    for relative in expect.get("reads", []):
        good = [entry for entry in _reads_for(artifacts, relative) if not entry.get("error")]
        if not good:
            failures.append(f"the walk records no successful read of {relative}")
    return failures


def _check_searches(expect: dict[str, Any], artifacts: Artifacts) -> list[str]:
    failures = []
    for term in expect.get("searches", []):
        found = any(
            entry.get("tool") != "read" and term in json.dumps(entry.get("args", {}))
            for entry in artifacts.entries
        )
        if not found:
            failures.append(f"the walk records no search for {term!r}")
    return failures


def _check_refusals(expect: dict[str, Any], artifacts: Artifacts) -> list[str]:
    failures = []
    for relative in expect.get("refused_paths", []):
        refused = any(
            entry.get("args", {}).get("path") == relative and entry.get("error")
            for entry in artifacts.entries
        )
        if not refused:
            failures.append(f"no refusal recorded for {relative}")
    return failures


def _check_facts(expect: dict[str, Any], artifacts: Artifacts) -> list[str]:
    failures = []
    statements = artifacts.statements.get("statements", [])
    for fact in expect.get("facts", []):
        carrying = [s for s in statements if fact in s.get("text", "")]
        if not carrying:
            failures.append(f"no statement mentions the known fact {fact!r}")
        elif not any(s.get("evidence") for s in carrying):
            failures.append(f"the statement about {fact!r} carries no evidence reference")
    wanted = expect.get("unreferenced_statements")
    if wanted is not None:
        actual = sum(1 for s in statements if s.get("status") == "unreferenced")
        if actual != wanted:
            failures.append(f"{actual} unreferenced statements, expected {wanted}")
    return failures


def _covered(artifacts: Artifacts, path: str, line: int) -> bool:
    """True when a recorded read of *path* covers *line*."""
    for entry in _reads_for(artifacts, path):
        if entry.get("error"):
            continue
        args = entry.get("args", {})
        offset = args.get("offset", 1)
        limit = args.get("limit")
        if limit is None:
            return True
        if offset <= line < offset + limit:
            return True
    return False


def _check_citations(expect: dict[str, Any], artifacts: Artifacts) -> list[str]:
    failures = []
    recorded = artifacts.statements.get("citations", [])
    for wanted in expect.get("citations", []):
        match = next(
            (
                citation
                for citation in recorded
                if citation.get("path") == wanted["path"] and citation.get("line") == wanted["line"]
            ),
            None,
        )
        if match is None:
            failures.append(f"no citation of {wanted['path']}:{wanted['line']}")
            continue
        covered = _covered(artifacts, wanted["path"], wanted["line"])
        if match.get("check") == "encountered" and not covered:
            failures.append(
                f"{wanted['path']}:{wanted['line']} is marked encountered but no recorded "
                "read range covers it"
            )
        elif not covered:
            failures.append(f"{wanted['path']}:{wanted['line']} was never read in the walk")
    return failures


def _check_absences(expect: dict[str, Any], artifacts: Artifacts) -> list[str]:
    failures = []
    statements_text = json.dumps(artifacts.statements)
    for needle in expect.get("absent_from_statements", []):
        if needle in statements_text:
            failures.append(f"statements contain {needle!r}, which must not appear")
    for needle in expect.get("absent_from_artifacts", []):
        if needle in artifacts.raw:
            failures.append(f"the exported artifacts contain {needle!r}, which must not appear")
    return failures


def _check_unchanged(checkout: Path, expect: dict[str, Any], before: dict[str, str]) -> list[str]:
    relatives = expect.get("unchanged_files", [])
    after = digest_files(checkout, relatives)
    return [
        f"{relative} changed during the run"
        for relative in relatives
        if before.get(relative) != after.get(relative)
    ]
