"""The Python re-check of a hand-back, imported from evidence-cli.

The checker, the export loader, the counts and the quote matcher moved from
this directory (commit ``266dad3``) into the first-party package evidence-cli
(import name ``evidence``). associate imports the eight public names its
``docs/library.md`` lists for associate, plus ``ExportError``; everything else
in that package is internal to it.

evidence-cli is the one runtime dependency on associate's named first-party
list (``CLAUDE.md``, "What not to invent"). Importing this package when
evidence-cli is missing, or older than :data:`EVIDENCE_FLOOR`, raises a
:class:`~associate.cli._errors.CliError` (exit 2) naming the package and the
install command. Every importer imports it inside a verb's handler, so the verb
exits through the CLI's error contract with no traceback.

A passed fact means its quote was found in the saved result it cites. It does
not mean the value is true.
"""

from __future__ import annotations

import re
from importlib import metadata

from associate.cli._errors import EXIT_ENV_ERROR, CliError

#: The distribution, its oldest usable version, and how to install it.
EVIDENCE_PACKAGE = "evidence-cli"
EVIDENCE_FLOOR = "0.7.0"
INSTALL_COMMAND = f'pip install "{EVIDENCE_PACKAGE}>={EVIDENCE_FLOOR}"'

#: associate's own export file names (the harness writes them; evidence-cli reads them).
WALK_FILENAME = "walk.jsonl"
FACTS_FILENAME = "facts.json"
CHECK_FILENAME = "check.json"
REPORT_FILENAME = "report.json"
ANSWER_FILENAME = "answer.md"

__all__ = [
    "ANSWER_FILENAME",
    "CHECK_FILENAME",
    "EVIDENCE_FLOOR",
    "EVIDENCE_PACKAGE",
    "ExportError",
    "FACTS_FILENAME",
    "INSTALL_COMMAND",
    "REPORT_FILENAME",
    "WALK_FILENAME",
    "accuracy_result",
    "check_handback",
    "check_quote",
    "fact_counts",
    "inspect_export",
    "load_export",
    "load_handback_input",
    "parse_source_ref",
    "require_evidence",
]


def _release(version: str) -> tuple[int, ...]:
    """The leading numeric release of a version string: ``0.7.1.dev3`` -> ``(0, 7, 1)``."""
    match = re.match(r"\d+(?:\.\d+)*", version, re.ASCII)
    return tuple(int(part) for part in match.group(0).split(".")) if match else ()


def _unusable(why: str) -> CliError:
    return CliError(
        code=EXIT_ENV_ERROR,
        message=f"{EVIDENCE_PACKAGE} {why}; associate's re-check comes from it",
        remediation=f"install it: {INSTALL_COMMAND} (in an associate checkout: uv sync)",
    )


def require_evidence() -> str:
    """The installed evidence-cli version; a CliError (exit 2) when it is missing or too old."""
    try:
        import evidence.accuracy  # noqa: F401 - the import is the check
    except ImportError as err:
        raise _unusable("is not installed or cannot be imported") from err
    try:
        version = metadata.version(EVIDENCE_PACKAGE)
    except metadata.PackageNotFoundError as err:
        raise _unusable("is importable but its version cannot be read") from err
    if _release(version) < _release(EVIDENCE_FLOOR):
        raise _unusable(f"{version} is older than {EVIDENCE_FLOOR}")
    return version


require_evidence()

from evidence.accuracy.check import (  # noqa: E402 - only after the version check
    ExportError,
    accuracy_result,
    check_handback,
    inspect_export,
    load_export,
    load_handback_input,
    parse_source_ref,
)
from evidence.accuracy.counts import fact_counts  # noqa: E402
from evidence.accuracy.matcher import check_quote  # noqa: E402
