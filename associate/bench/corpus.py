"""The behavioral corpus: seven cases, one per category, adapter-free (c48/h40).

A case is *data*. It names a fixture tree with known facts, the task prompt, and
the deterministic expectations a correct run must satisfy — never a tool name a
particular runtime happens to use, never a scripted transcript, never an
adapter. That is what makes "two configurations differ only in the adapter and
model-role columns" (h40) checkable rather than asserted: the loader rejects any
key it does not know, so an adapter-specific field cannot quietly appear.

The corpus lives at ``tests/behavioral/cases/`` in a source checkout. It is the
runner's default and can be pointed elsewhere with ``--cases``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

__all__ = [
    "CATEGORIES",
    "CASE_KEYS",
    "EXPECT_KEYS",
    "Case",
    "CorpusError",
    "check_fixture_path",
    "default_cases_dir",
    "load_cases",
    "materialize",
]

#: Either path separator, so a Windows-flavoured key is segmented too.
_SEPARATOR = re.compile(r"[\\/]")

#: The seven behavioral categories named by claim c48. One case each.
CATEGORIES: tuple[str, ...] = (
    "local read/find",
    "repo exploration",
    "summarization",
    "structured evidence extraction",
    "tool-call reliability",
    "forbidden mutation attempts",
    "bounded completion and hand-back",
)

#: Top-level keys a case file may carry. Anything else is a corpus error.
CASE_KEYS: frozenset[str] = frozenset({"id", "category", "title", "prompt", "fixture", "expect"})

#: Keys the ``expect`` block may carry — the vocabulary of the checks in
#: :mod:`associate.bench.checks`. Deliberately closed.
EXPECT_KEYS: frozenset[str] = frozenset(
    {
        "searches",
        "reads",
        "read_limit",
        "facts",
        "citations",
        "refused_paths",
        "unchanged_files",
        "absent_from_statements",
        "absent_from_artifacts",
        "unreferenced_statements",
        "not_fully_read",
        "min_tool_calls",
        "max_tool_calls",
        "max_duration_ms",
        "outcome",
    }
)


class CorpusError(ValueError):
    """Raised when the corpus directory is missing or a case is malformed."""


@dataclass
class Case:
    """One behavioral case, loaded from one JSON file."""

    id: str
    category: str
    title: str
    prompt: str
    fixture_files: dict[str, str]
    expect: dict[str, Any] = field(default_factory=dict)
    source: Path | None = None


def default_cases_dir() -> Path:
    """The corpus directory in a source checkout, resolved from this module.

    Walks up from the installed package looking for ``tests/behavioral/cases``.
    In a wheel install there is no such directory; the caller gets a
    :class:`CorpusError` naming ``--cases``.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "behavioral" / "cases"
        if candidate.is_dir():
            return candidate
    return here.parents[2] / "tests" / "behavioral" / "cases"


def load_cases(cases_dir: Path | str | None = None) -> list[Case]:
    """Load every ``*.json`` case in *cases_dir*, ordered by file name."""
    directory = Path(cases_dir) if cases_dir is not None else default_cases_dir()
    if not directory.is_dir():
        raise CorpusError(
            f"no behavioral corpus at {directory}; pass --cases <dir> pointing at the "
            "tests/behavioral/cases directory of a source checkout"
        )
    paths = sorted(directory.glob("*.json"))
    if not paths:
        raise CorpusError(f"behavioral corpus at {directory} holds no case files")

    cases = [_load_one(path) for path in paths]
    _check_corpus(cases, directory)
    return cases


def _load_one(path: Path) -> Case:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise CorpusError(f"{path.name}: unreadable case file: {err}") from err
    if not isinstance(raw, dict):
        raise CorpusError(f"{path.name}: a case must be a JSON object")

    unknown = sorted(set(raw) - CASE_KEYS)
    if unknown:
        raise CorpusError(
            f"{path.name}: unknown case key(s) {', '.join(unknown)}; "
            f"the corpus is adapter-free — allowed keys: {', '.join(sorted(CASE_KEYS))}"
        )
    missing = sorted(CASE_KEYS - set(raw))
    if missing:
        raise CorpusError(f"{path.name}: missing case key(s) {', '.join(missing)}")

    expect = raw["expect"]
    if not isinstance(expect, dict):
        raise CorpusError(f"{path.name}: 'expect' must be an object")
    unknown_expect = sorted(set(expect) - EXPECT_KEYS)
    if unknown_expect:
        raise CorpusError(
            f"{path.name}: unknown expect key(s) {', '.join(unknown_expect)}; "
            f"allowed: {', '.join(sorted(EXPECT_KEYS))}"
        )

    if raw["category"] not in CATEGORIES:
        raise CorpusError(f"{path.name}: category {raw['category']!r} is not one of the seven")

    files = raw["fixture"].get("files") if isinstance(raw["fixture"], dict) else None
    if not isinstance(files, dict) or not files:
        raise CorpusError(f"{path.name}: 'fixture.files' must be a non-empty object")
    # The strict loader refuses an escaping fixture key outright, so a bad
    # custom corpus fails before any case runs rather than mid-suite, after
    # earlier cases have already written.
    for relative in files:
        check_fixture_path(path.name, str(relative))

    return Case(
        id=str(raw["id"]),
        category=str(raw["category"]),
        title=str(raw["title"]),
        prompt=str(raw["prompt"]),
        fixture_files={str(k): str(v) for k, v in files.items()},
        expect=dict(expect),
        source=path,
    )


def _check_corpus(cases: list[Case], directory: Path) -> None:
    ids = [case.id for case in cases]
    if len(set(ids)) != len(ids):
        raise CorpusError(f"{directory}: duplicate case id(s)")
    categories = [case.category for case in cases]
    if len(set(categories)) != len(categories):
        raise CorpusError(f"{directory}: two cases share a category")


def materialize(case: Case, checkout: Path) -> Path:
    """Write *case*'s fixture tree under *checkout* and return it.

    Every fixture key is checked again here, not only at load time: a ``Case``
    can be constructed directly (the runner accepts a caller's own ``cases``
    list), and the one place that turns a corpus key into a filesystem write is
    the place that must not be able to write outside the checkout.

    Containment is enforced segment by segment rather than by resolving the
    joined path at the end, because a symlinked intermediate directory would
    otherwise be *followed* by ``mkdir``/``write_text`` before any check saw it.
    """
    root = checkout.resolve()
    root.mkdir(parents=True, exist_ok=True)
    for relative, content in case.fixture_files.items():
        target = _safe_fixture_target(case.id, relative, root)
        target.write_text(content, encoding="utf-8")
    return checkout


def _safe_fixture_target(case_id: str, relative: str, root: Path) -> Path:
    """Create the parents of *relative* under *root* and return the file path.

    Raises :class:`CorpusError` the moment a segment would leave the checkout,
    traverse a symlink, or overwrite a symlinked file.
    """
    segments = check_fixture_path(case_id, relative)
    current = root
    for segment in segments[:-1]:
        current = current / segment
        if current.is_symlink():
            raise CorpusError(
                f"{case_id}: fixture path {relative!r} traverses the symlink {current}; "
                "a fixture tree is written only into real directories under the checkout"
            )
        current.mkdir(exist_ok=True)
        if not _is_strictly_under(root, current.resolve()):
            raise CorpusError(
                f"{case_id}: fixture path {relative!r} resolves to {current.resolve()}, "
                f"which is outside the checkout {root}"
            )
    target = current / segments[-1]
    if target.is_symlink():
        raise CorpusError(
            f"{case_id}: fixture path {relative!r} names the symlink {target}; "
            "a fixture file is never written through a link"
        )
    if not _is_strictly_under(root, current.resolve() / segments[-1]):
        raise CorpusError(
            f"{case_id}: fixture path {relative!r} resolves outside the checkout {root}"
        )
    return target


def _is_strictly_under(root: Path, candidate: Path) -> bool:
    """True when *candidate* lies strictly beneath *root* (never *root* itself)."""
    return root in candidate.parents


def check_fixture_path(case_id: str, relative: str) -> list[str]:
    """Validate one fixture key and return its path segments.

    A case file is data, and until this check existed it was data that chose
    where the bench wrote: ``fixture.files`` keys were joined straight onto the
    checkout, so ``"../x"``, ``"/etc/x"`` or ``"a/../../x"`` in a custom corpus
    (``associate bench --cases <dir>``) overwrote files outside it. They are
    refused here — at load time, and again at write time: absolute paths, any
    parent (``..``) or dot-only segment, and empty segments.
    """
    if not isinstance(relative, str) or not relative.strip():
        raise CorpusError(f"{case_id}: a fixture file path may not be empty")
    if relative != relative.strip():
        raise CorpusError(
            f"{case_id}: fixture path {relative!r} is padded with whitespace; "
            "write the path exactly as it should appear on disk"
        )
    if PurePosixPath(relative).is_absolute() or PureWindowsPath(relative).is_absolute():
        raise CorpusError(
            f"{case_id}: fixture path {relative!r} is absolute; fixture paths are "
            "relative to the case's own checkout"
        )
    segments = _SEPARATOR.split(relative)
    for segment in segments:
        if not segment:
            raise CorpusError(f"{case_id}: fixture path {relative!r} has an empty path segment")
        if set(segment) == {"."}:
            raise CorpusError(
                f"{case_id}: fixture path {relative!r} contains the segment {segment!r}; "
                "'.' and '..' are refused so a case cannot write outside its checkout"
            )
    return segments
