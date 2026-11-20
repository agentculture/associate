"""The Python re-check of a hand-back, imported from evidence-cli.

The checker, the export loader, the counts and the quote matcher moved from
this directory (commit ``266dad3``) into the first-party package evidence-cli
(import name ``evidence``). associate imports the public names its
``docs/library.md`` lists for associate (eight for the quote check, four for
the strict re-check: ``strict_recheck``, ``load_strict_vectors``,
``is_strict_export`` and ``recheck_strict_export``), plus ``ExportError``;
everything else in that package is internal to it.

evidence-cli is the one runtime dependency on associate's named first-party
list (``CLAUDE.md``, "What not to invent"). Importing this package when
evidence-cli is missing, or older than :data:`EVIDENCE_FLOOR`, raises a
:class:`~associate.cli._errors.CliError` (exit 2) naming the package and the
install command. Every importer imports it inside a verb's handler, so the verb
exits through the CLI's error contract with no traceback.

A passed fact means its quote was found in the saved result it cites (for a
strict fact: its evidence was copied from a saved result, or its quote found in
one). It does not mean the value is true.
"""

from __future__ import annotations

import re
from importlib import metadata
from pathlib import Path
from typing import Any, Mapping, Optional

from associate.cli._errors import EXIT_ENV_ERROR, CliError

#: The distribution, its oldest usable version, and how to install it.
EVIDENCE_PACKAGE = "evidence-cli"
EVIDENCE_FLOOR = "0.8.0"
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
    "is_strict_export",
    "load_export",
    "load_handback_input",
    "load_strict_vectors",
    "parse_source_ref",
    "recheck_strict_export",
    "require_evidence",
    "strict_recheck",
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

from evidence.accuracy.check import (  # noqa: E402 - only after the version check; noqa: E402
    ExportError,
)
from evidence.accuracy.check import accuracy_result as _recheck_result  # noqa: E402
from evidence.accuracy.check import (  # noqa: E402 - only after the version check; noqa: E402
    check_handback,
    inspect_export,
    load_export,
    load_handback_input,
    parse_source_ref,
)
from evidence.accuracy.counts import fact_counts  # noqa: E402
from evidence.accuracy.matcher import check_quote  # noqa: E402
from evidence.accuracy.strict import strict_recheck  # noqa: E402
from evidence.accuracy.strict_export import (  # noqa: E402 - only after the version check
    is_strict_export,
    recheck_strict_export,
)
from evidence.accuracy.vectors import load_strict_vectors  # noqa: E402

from associate.accuracy import strict as _strict  # noqa: E402
from associate.accuracy import support as _support  # noqa: E402


def _inspected(
    export_dir: Path, accuracy: Mapping[str, Any], continue_from: Optional[Path]
) -> dict[str, Any]:
    """The re-check's facts for *export_dir*; no facts when the export cannot be read."""
    try:
        return inspect_export(export_dir, accuracy, continue_from)
    except ExportError:
        return {"facts": []}


def accuracy_result(
    export_dir: Path,
    accuracy: Mapping[str, Any],
    *,
    continue_from: Optional[Path] = None,
    check_mode: Optional[str] = None,
) -> dict[str, Any]:
    """evidence-cli's ``accuracy_result``, plus the support score the export holds.

    When the export's ``check.json`` carries a support result for any fact (or
    ``report.json`` a ``support_scored`` count), the result gains
    ``support_source`` (``"extension"``), ``support_scored``, ``support_answers``
    (one count per option of *accuracy*'s support score, in order, zeros
    included), ``support_facts`` (``[{"id", "support"}]``) and, when they
    apply, ``support_scored_reported``
    and ``support_unmatched``. They sit beside ``accuracy``, not in it: the
    score is copied from the extension's files, never recomputed, and is not
    part of the re-check. An export with no score gets no such key.

    A strict export (``check.json`` mode ``strict``) is re-checked by
    evidence-cli's strict re-check. Its ``accuracy`` object then also carries
    ``python_recheck_agrees`` (the re-check found no difference from the
    export's own ``check.json`` in any compared part), ``python_recheck_compared``
    and ``python_recheck_not_compared`` (the parts of the record that were and
    were not compared) and ``python_recheck_disagreements`` (each field that
    differs, with both values); all four are None when the re-check did not run,
    and ``not_applicable_reason`` then says why. The result keeps ``strict``,
    the extension's own counts copied from the export, whose ``recheck`` says
    whether the re-check ran and agrees. No other export gains these keys.
    """
    export_dir = Path(export_dir)
    result = _recheck_result(
        export_dir, accuracy, continue_from=continue_from, check_mode=check_mode
    )
    strict = _strict.read_strict(export_dir)
    if strict is not None:
        # evidence-cli's accuracy_result has run the strict re-check already, but
        # hands back only its counts; the comparison with check.json needs
        # recheck_strict_export. It is asked only when the first run says the
        # re-check applied (an export with no facts payload is not applicable).
        held_accuracy = result["accuracy"]
        if held_accuracy.get("python_recheck_ran") and held_accuracy.get("check") == "strict":
            summary, _ = _strict.run_recheck(export_dir, accuracy, continue_from)
        else:
            summary = _strict.not_run(held_accuracy.get("not_applicable_reason"))
        # No support copy: a strict fact carries the decider's stored answer
        # (judge), not the support score's result.
        return {
            **result,
            "accuracy": _strict.checked_accuracy(held_accuracy, summary),
            _strict.RESULT_KEY: _strict.with_recheck(strict, summary),
        }
    # The two score files are read once. evidence-cli's accuracy_result runs
    # inspect_export inside itself and does not hand its facts back, so the
    # facts for the support copy need one more run, and only when the export
    # holds a support result (review finding 4, measured by tests/test_support_copy.py).
    held = _support.read_support(export_dir)
    if held is None:
        return result
    inspected = _inspected(export_dir, accuracy, continue_from)
    options = _support.option_keys(accuracy)
    return {**result, **_support.run_fields(inspected, held, options)}
