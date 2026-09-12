"""Turn a case's expectations into a replayable script — **plumbing only**.

This module is the one place where the corpus meets a scripted adapter. It is
deliberately *not* part of the corpus: the cases stay adapter-free (h40), and a
replaying adapter (today only the stub) is handed a script synthesised from the
case's own ``expect`` block, read out of the materialised fixture.

A green run built this way proves the runner, the artifact shapes, the schema
validation and the checks all work end to end with no pi and no lane. It proves
**nothing** about a model. Every row it produces is labelled ``plumbing-only``,
and the harness result carries ``plumbing_only: true``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from associate.bench.corpus import Case

__all__ = ["replay_kwargs"]


def _numbered(lines: list[str], start: int) -> str:
    """Render *lines* the way a bounded read does: absolute line numbers, cat -n style."""
    return "".join(f"{number:6d}\t{text}\n" for number, text in enumerate(lines, start=start))


def _grep(checkout: Path, term: str) -> str:
    hits: list[str] = []
    for path in sorted(p for p in checkout.rglob("*") if p.is_file()):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):  # pragma: no cover - fixtures are text
            continue
        relative = path.relative_to(checkout).as_posix()
        if relative.startswith("."):  # a denylisted dotfile is never searched
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if term in line:
                hits.append(f"{relative}:{number}:{line}")
    return "\n".join(hits) if hits else f"no matches for {term!r}"


def replay_kwargs(case: Case, checkout: Path) -> dict[str, Any]:
    """Build ``script``/``statements``/``citations``/``outcome`` for a replaying adapter."""
    expect = case.expect
    script: list[dict[str, Any]] = []

    for term in expect.get("searches", []):
        script.append(
            {
                "tool": "shell",
                "args": {"argv": ["rg", "--line-number", term, "."]},
                "result": {"content": _grep(checkout, term)},
            }
        )

    limit = expect.get("read_limit")
    read_ids: list[str] = []
    for relative in expect.get("reads", []):
        lines = (checkout / relative).read_text(encoding="utf-8").splitlines()
        window = lines[:limit] if limit else lines
        script.append(
            {
                "tool": "read",
                "args": {"path": relative, "offset": 1, "limit": len(window)},
                "result": {"content": _numbered(window, 1)},
                "truncated": bool(limit) and len(window) < len(lines),
            }
        )
        read_ids.append(f"w{len(script)}")

    refused_ids: list[str] = []
    for relative in expect.get("refused_paths", []):
        script.append(
            {
                "tool": "read",
                "args": {"path": relative},
                "result": {},
                "error": (
                    f"refused: the policy forbids this operation on {relative} "
                    "(no write tool is registered; credentials files are denylisted)"
                ),
            }
        )
        refused_ids.append(f"w{len(script)}")

    statements: list[dict[str, Any]] = [
        {"text": f"The run recorded {fact} in the examined checkout.", "evidence": list(read_ids)}
        for fact in expect.get("facts", [])
    ]
    if refused_ids:
        statements.append(
            {
                "text": "The requested modification was refused and the checkout is unchanged.",
                "evidence": list(refused_ids),
            }
        )
    for index in range(int(expect.get("unreferenced_statements", 0))):
        statements.append({"text": f"General remark {index + 1} with no evidence.", "evidence": []})

    citations = [
        {"path": citation["path"], "line": citation["line"], "check": "encountered"}
        for citation in expect.get("citations", [])
    ]

    return {
        "script": script,
        "statements": statements,
        "citations": citations,
        "outcome": expect.get("outcome", "ok"),
    }
