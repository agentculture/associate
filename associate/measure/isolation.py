"""Per-run memory and ledger locations for a measured run.

The harness reads ``ASSOCIATE_EIDETIC_DIR`` (the memory store the eidetic tools
pin) and ``ASSOCIATE_LEDGER_PATH`` (the workledger file the ledger tools pin).
A measured run is given both, new and empty, under its own run directory, so a
record written by one run can never be recalled by another, and nothing is read
from or written to the operator's own stores.
"""

from __future__ import annotations

import os
from pathlib import Path

MEMORY_DIRNAME = "memory"
LEDGER_DIRNAME = "ledger"
LEDGER_FILENAME = "ledger.jsonl"


def isolate_run(run_dir: str | os.PathLike[str]) -> dict[str, str]:
    """Create empty memory and ledger locations under ``run_dir``.

    Returns the two environment variables to hand to the run, as absolute
    paths. Raises ``ValueError`` when ``run_dir`` already holds a non-empty
    memory directory or a ledger file: a location is only ever new, so reusing
    a run directory is refused rather than silently shared.
    """
    root = Path(run_dir).resolve()
    memory = root / MEMORY_DIRNAME
    ledger = root / LEDGER_DIRNAME / LEDGER_FILENAME
    if memory.exists() and any(memory.iterdir()):
        raise ValueError(f"memory directory {memory} is not empty")
    if ledger.exists():
        raise ValueError(f"ledger file {ledger} already exists")
    memory.mkdir(parents=True, exist_ok=True)
    ledger.parent.mkdir(parents=True, exist_ok=True)
    return {
        "ASSOCIATE_EIDETIC_DIR": str(memory),
        "ASSOCIATE_LEDGER_PATH": str(ledger),
    }
