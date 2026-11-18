"""The model's own answer text, and its grade (plan task t7).

One rule for every arm, whatever harness version produced the run: the answer
is the words the model gave, with no line the harness wrote.

- A harness that has no hand-back (before PR #27) leaves the model's last
  reply in the run result (``final_reply``). That is the answer.
- The current harness writes ``answer.md`` into the export: a rendering of
  the checked items (conclusions, open items, the facts list) followed by one
  labelled section holding the model's finish summary and final message. The
  answer is the text of that last section. The checked items, the facts list
  and the labels are the harness's, and are never part of it. The result's
  ``final_reply`` is not used when ``answer.md`` exists: it is a tail of the
  final message, which a model may fill with a copy of the rendering.

Whatever the source, a line of the shape ``lib/render.ts`` writes (a heading,
a conclusion, a fact line, a sentence-count label, ...) is dropped from the
text, because a model that repeats what the hand-back returned to it repeats
the harness's lines.

``facts.json`` is never read: a grade must not depend on it.

Grading is ``evidence.answer.grade``: a run that gave no text is
``cannot_tell`` (cause ``empty_answer``) with ``empty_reason`` saying why, not
a failure.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from evidence.answer import grade

ANSWER_FILE = "answer.md"
SOURCE_ANSWER_MD = "answer.md"
SOURCE_FINAL_REPLY = "final_reply"
SOURCE_NONE = "none"

REASON_NO_TEXT = "no_model_text"
REASON_NOTHING_TO_READ = "no_result_and_no_export"

# Lines lib/render.ts writes. Fixed lines compare after trimming.
_FIXED_LINES = frozenset(
    {
        "# Answer (rendered by the harness from checked items)",
        "## Conclusions",
        "## Open items",
        "## Facts",
        "No fact or conclusion passed the check.",
        "## Unchecked: the model's own words, not checked by the harness",
        'A fact marked "quote found" means its quote is in the saved result it cites; '
        "it does not mean the value is true.",
        "- none",
    }
)
_ID = r"[fvoa]\d+"
_SHAPES = tuple(
    re.compile(pattern, re.ASCII)
    for pattern in (
        r"^(Finish summary|Final message) \(\d+ sentences?\):$",
        r"^\d+ items? (was|were) refused by the check and (is|are) not part of this answer ",
        rf"^- {_ID}: .*\([^()]*; [^()]*\)$",
        rf"^- {_ID} \[[a-z_]+\] ",
        rf"^- {_ID}: .*\(deciding check: ",
        rf"^- alternative {_ID}: ",
        r"^- (predicts|refuted by): ",
    )
)
_UNCHECKED_HEADING = "## Unchecked: the model's own words, not checked by the harness"
_QUOTE_PREFIX = re.compile(r"^(?:\s*>)+ ?")


@dataclass(frozen=True)
class ModelAnswer:
    """The model's text, where it came from, and why it is empty when it is."""

    text: str
    source: str
    empty_reason: str | None


def load_result(path: Path | str) -> dict[str, Any] | None:
    """The parsed ``associate run --json`` result, or None when unreadable."""
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def is_harness_line(line: str) -> bool:
    """Whether *line* has a shape the renderer writes."""
    text = _QUOTE_PREFIX.sub("", line).strip()
    return text in _FIXED_LINES or any(shape.search(text) for shape in _SHAPES)


def _without_harness_lines(text: str) -> str:
    kept = []
    for line in text.splitlines():
        if is_harness_line(line):
            continue
        kept.append(_QUOTE_PREFIX.sub("", line, count=1) if line.lstrip().startswith(">") else line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def _unchecked_section(answer_md: str) -> str | None:
    """The quoted text under the unchecked heading, or None when there is none."""
    lines = answer_md.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == _UNCHECKED_HEADING)
    except StopIteration:
        return None
    return "\n".join(line for line in lines[start + 1 :] if line.lstrip().startswith(">"))


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _candidate(result: Mapping[str, Any] | None, export_dir: Path | None) -> tuple[str, str]:
    """The raw text and its source, before harness lines are removed."""
    if export_dir is not None:
        rendered = _read(Path(export_dir) / ANSWER_FILE)
        if rendered is not None:
            return _unchecked_section(rendered) or "", SOURCE_ANSWER_MD
    reply = (result or {}).get("final_reply")
    return (reply if isinstance(reply, str) else ""), SOURCE_FINAL_REPLY


def model_answer(
    result: Mapping[str, Any] | None, export_dir: Path | str | None = None
) -> ModelAnswer:
    """The text the model gave as its answer, with no line the harness wrote."""
    directory = Path(export_dir) if export_dir is not None else None
    if directory is None and result and isinstance(result.get("export_dir"), str):
        directory = Path(result["export_dir"])
    raw, source = _candidate(result, directory)
    text = _without_harness_lines(raw)
    if text:
        return ModelAnswer(text, source, None)
    nothing = not result and (directory is None or not directory.is_dir())
    return ModelAnswer("", SOURCE_NONE, REASON_NOTHING_TO_READ if nothing else REASON_NO_TEXT)


def grade_run(
    result: Mapping[str, Any] | None, export_dir: Path | str | None, expected: Any
) -> dict[str, Any]:
    """``evidence.answer.grade`` of the model's text; adds ``source`` and ``empty_reason``."""
    answer = model_answer(result, export_dir)
    graded = grade(answer.text, expected)
    return {**graded, "source": answer.source, "empty_reason": answer.empty_reason}
