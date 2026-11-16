"""A stand-in for ``python -m associate`` in the runs tests: it never runs a model.

Invoked as ``python runs_fake_child.py <mode> run --json --model M --checkout C --export-root E
--session-id S --timeout T ... -- <instruction>``. It records the argv it received in
``<E>/argv.json`` and then behaves per ``mode``:

- ``gate``: wait for ``<run dir>/release`` (``E``'s parent), then print an ok result with no merge;
- ``merge`` / ``gate-merge``: make a real run worktree with ``associate.harness.worktree``, add a
  file, finish it clean (the real commit + merge), print the result ``associate run`` would;
- ``refused``: a real worktree with a written file, reported kept by a refused merge, exit 0;
- ``tests-fail``: a real worktree, the outcome ok but the tests failed, kept, exit 0;
- ``exit2``: a ``--json`` error object on stderr and exit 2, nothing on stdout;
- ``plain``: an ok result with no merge (a read-only model's run).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

TESTS_OK = {
    "passed": True,
    "commands": [{"argv": ["true"], "exit_code": 0, "timed_out": False}],
    "reverted": [],
}
TESTS_BAD = {
    "passed": False,
    "commands": [{"argv": ["false"], "exit_code": 1, "timed_out": False}],
    "reverted": [],
}


def _opt(rest: list[str], name: str) -> str:
    return rest[rest.index(name) + 1]


def main(argv: list[str]) -> int:
    mode, rest = argv[0], argv[1:]
    export_root = Path(_opt(rest, "--export-root"))
    export_root.mkdir(parents=True, exist_ok=True)
    (export_root / "argv.json").write_text(json.dumps(rest), encoding="utf-8")
    run_dir = export_root.parent
    checkout = Path(_opt(rest, "--checkout"))
    session = _opt(rest, "--session-id")

    if mode.startswith("gate"):
        deadline = time.time() + 60
        while not (run_dir / "release").exists() and time.time() < deadline:
            time.sleep(0.05)

    base = {"outcome": "ok", "session_id": session, "final_reply": "done"}
    if mode == "exit2":
        sys.stderr.write("associate: a diagnostic line\n")
        sys.stderr.write(json.dumps({"code": 2, "message": "pi is not on PATH", "remediation": ""}))
        sys.stderr.write("\n")
        return 2
    if mode in ("plain", "gate"):
        print(json.dumps({**base, "tests": TESTS_OK}))
        return 0

    from associate.harness import worktree

    run = worktree.create_run_worktree(checkout, session)
    (run.run_checkout / "added.txt").write_text("added by the fake run\n", encoding="utf-8")
    if mode in ("merge", "gate-merge"):
        report = worktree.finish(run, clean=True, session_id=session, outcome="ok")
        result = {**base, "isolation": "worktree", "tests": TESTS_OK, **report}
    elif mode == "refused":
        result = {
            **base,
            "isolation": "worktree",
            "tests": TESTS_OK,
            "merge": "kept",
            "merge_reason": "main is checked out at /x with uncommitted changes; not merging",
            "worktree": str(run.path),
            "run_branch": run.branch,
        }
    elif mode == "tests-fail":
        report = worktree.finish(
            run, clean=False, session_id=session, outcome="ok", reason="tests failed: `false`"
        )
        result = {**base, "isolation": "worktree", "tests": TESTS_BAD, **report}
    else:
        sys.stderr.write(f"unknown fake mode {mode}\n")
        return 3
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
