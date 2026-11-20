"""The model's own answer text, and its grade (plan task t7).

One rule for every arm, whatever harness version produced the run: the answer
is the words the model gave, with no line the harness wrote.

- A harness that has no hand-back (before PR #27) leaves the model's last
  reply in the run result (``unchecked_final_reply``; ``final_reply`` in a result
  stored before the rename, which is still read). That is the answer.
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

The export directory is the one the caller names. A result's own
``export_dir`` field is never opened here: it is a string from a file, and the
caller (the runner) is the one that knows which directory the run was given.

Grading is ``evidence.answer.grade``: a run that gave no text is
``cannot_tell`` (cause ``empty_answer``) with ``empty_reason`` saying why, not
a failure.

The broad tasks
---------------
:func:`model_answer` is the rule above and is what the short tasks are graded
on. A broad run is read with :func:`broad_answer`, which differs in two ways.

With an ``answer.md`` in the export, the text is what the caller was handed in
the model's words: the value of each accepted fact, the text of each accepted
conclusion and open item (taken from ``facts.json`` by the id on the rendered
line; from the line itself when that file does not have it), each as its own
paragraph, and then the unchecked text :func:`model_answer` gives. The quote, the
walk id, the source kind and the marks the harness wrote after a fact are left
out: they are not the model's statements, and a support mark would show a
grader which arm the run was in.

Without an ``answer.md``, that is, when the run ended without an accepted
``finish``, the run result holds only the last ``FINAL_REPLY_CAP`` characters of
the last message, so the text is taken from the fullest source there is, in
this order:

1. ``final_message.md`` in the export: the last message whole, redacted, as
   the model wrote it (``lib/finalmessage.ts``; exports written before that
   file existed do not have it).
2. the result's ``final_reply`` when it is shorter than the cap: nothing was
   cut from it, so it is the whole message too.
3. ``statements.json`` in the export: the texts of its statements joined by
   blank lines. This is every prose message of the run that called no tool,
   split by ``lib/statements.ts`` ``splitStatements``: headings and fenced code
   blocks are left out, list markers are removed, and the lines of a paragraph
   (the rows of a table among them) are joined into one line. The words of
   paragraphs and list items are all there; the layout and the code are not.
4. the capped ``final_reply``, under the source ``final_reply_capped``.

No line is removed from any of these four. A run that never had a hand-back
accepted was never shown the harness's rendering, so a line of a harness shape
in its message is the model's own; the filter would drop a heading such as
``## Facts`` or an item such as ``- none`` that the model wrote itself.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from evidence.answer import grade

from associate.harness.pi import FINAL_REPLY_CHARS

ANSWER_FILE = "answer.md"
SOURCE_ANSWER_MD = "answer.md"
SOURCE_FINAL_REPLY = "final_reply"
SOURCE_NONE = "none"
FINAL_MESSAGE_FILE = "final_message.md"
STATEMENTS_FILE = "statements.json"
SOURCE_FINAL_MESSAGE = FINAL_MESSAGE_FILE
SOURCE_STATEMENTS = STATEMENTS_FILE
SOURCE_FINAL_REPLY_CAPPED = "final_reply_capped"
FACTS_FILE = "facts.json"
#: How much of a final reply a run result keeps.
FINAL_REPLY_CAP = FINAL_REPLY_CHARS

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
        # The support legend since the five-option question (deviation d4) ...
        "The support mark is a second, separate check: how much of the value the quote, read "
        'on its own, shows, or "support not scored" when that check did not run. Neither mark '
        "means the value is true.",
        # ... and the one older exports carry (the yes/no score), so they are still filtered.
        "The support mark is a second, separate check: whether the quote, read on its own, "
        'shows the value, with a score from 0 (no) to 1 (yes), or "support not scored" when '
        "that check did not run. Neither mark means the value is true.",
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


#: The run result's key for the model's last message: ``unchecked_final_reply``
#: since the rename, ``final_reply`` in a result stored before it. The source
#: labels below name the role, not the key, and stay as stored records have them.
_REPLY_KEYS = ("unchecked_final_reply", "final_reply")


def result_reply(result: Mapping[str, Any] | None) -> Any:
    """The model's last message in a stored run result, under whichever key it was written."""
    for key in _REPLY_KEYS:
        if key in (result or {}):
            return (result or {})[key]
    return None


def _candidate(result: Mapping[str, Any] | None, export_dir: Path | None) -> tuple[str, str]:
    """The raw text and its source, before harness lines are removed."""
    if export_dir is not None:
        rendered = _read(Path(export_dir) / ANSWER_FILE)
        if rendered is not None:
            return _unchecked_section(rendered) or "", SOURCE_ANSWER_MD
    reply = result_reply(result)
    return (reply if isinstance(reply, str) else ""), SOURCE_FINAL_REPLY


def model_answer(
    result: Mapping[str, Any] | None, export_dir: Path | str | None = None
) -> ModelAnswer:
    """The text the model gave as its answer, with no line the harness wrote."""
    directory = Path(export_dir) if export_dir is not None else None
    raw, source = _candidate(result, directory)
    text = _without_harness_lines(raw)
    if text:
        return ModelAnswer(text, source, None)
    nothing = not result and (directory is None or not directory.is_dir())
    return ModelAnswer("", SOURCE_NONE, REASON_NOTHING_TO_READ if nothing else REASON_NO_TEXT)


def _statement_texts(export_dir: Path) -> str:
    """The statement texts of the export's ``statements.json``, joined by blank lines."""
    raw = _read(export_dir / STATEMENTS_FILE)
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        return ""
    statements = parsed.get("statements") if isinstance(parsed, dict) else None
    if not isinstance(statements, list):
        return ""
    texts = [item.get("text") for item in statements if isinstance(item, dict)]
    return "\n\n".join(text.strip() for text in texts if isinstance(text, str) and text.strip())


def _full_message(result: Mapping[str, Any] | None, export_dir: Path | None) -> tuple[str, str]:
    """The last message from the fullest source there is, unfiltered, and that source."""
    kept = result_reply(result)
    cut = isinstance(kept, str) and len(kept) >= FINAL_REPLY_CAP
    reply = kept.strip() if isinstance(kept, str) else ""
    saved = (_read(export_dir / FINAL_MESSAGE_FILE) or "").strip() if export_dir else ""
    if saved:
        return saved, SOURCE_FINAL_MESSAGE
    if reply and not cut:
        return reply, SOURCE_FINAL_REPLY
    split = _statement_texts(export_dir) if export_dir else ""
    if split:
        return split, SOURCE_STATEMENTS
    return reply, SOURCE_FINAL_REPLY_CAPPED


# An accepted item's line in answer.md, as lib/render.ts writes it: the id, then
# the item's own words, then what the harness added.
_ITEM_LINE = re.compile(r"^- (?P<id>[fvo]\d+)(?:: | \[[a-z_]+\] )(?P<rest>.*)$", re.ASCII)
_ITEM_KINDS = {"f": ("facts", "value"), "v": ("verdicts", "text"), "o": ("open_items", "text")}
_FACT_QUOTE = ' \u2014 "'
_HARNESS_TAIL = re.compile(r" \([^()]*\)$")


def _handed_back(export_dir: Path) -> dict[str, str]:
    """Item id to the model's own words for it, from the export's ``facts.json``."""
    raw = _read(export_dir / FACTS_FILE)
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        return {}
    words: dict[str, str] = {}
    for section, field in _ITEM_KINDS.values():
        items = parsed.get(section) if isinstance(parsed, dict) else None
        for item in items if isinstance(items, list) else []:
            if isinstance(item, dict) and isinstance(item.get(field), str):
                words[str(item.get("id"))] = item[field]
    return words


def _from_line(item_id: str, rest: str) -> str:
    """The item's words cut out of its rendered line, for an export without them."""
    if item_id.startswith("f"):
        return rest.partition(_FACT_QUOTE)[0] if _FACT_QUOTE in rest else rest
    return _HARNESS_TAIL.sub("", rest)


def _accepted_items(answer_md: str, export_dir: Path) -> list[str]:
    """The words of each accepted fact, conclusion and open item, in the order rendered."""
    words = _handed_back(export_dir)
    items = []
    for line in answer_md.splitlines():
        if line.strip() == _UNCHECKED_HEADING:
            break
        found = _ITEM_LINE.match(line)
        if found is None:
            continue
        own = words.get(found["id"]) or _from_line(found["id"], found["rest"])
        if own.strip():
            items.append(" ".join(own.split()))
    return items


def broad_answer(
    result: Mapping[str, Any] | None, export_dir: Path | str | None = None
) -> ModelAnswer:
    """The answer of a broad run, in the model's words (see the module text).

    With ``answer.md`` in the export: the accepted items' own words, then the
    unchecked text of :func:`model_answer`. Without it the text is the fullest
    of ``final_message.md``, an uncut ``final_reply``, the statements of
    ``statements.json`` and the capped ``final_reply``, with no line removed.
    """
    directory = Path(export_dir) if export_dir is not None else None
    rendered = _read(directory / ANSWER_FILE) if directory is not None else None
    if directory is not None and rendered is not None:
        own = model_answer(result, directory)
        parts = _accepted_items(rendered, directory) + ([own.text] if own.text else [])
        if not parts:
            return own
        return ModelAnswer("\n\n".join(parts), SOURCE_ANSWER_MD, None)
    text, source = _full_message(result, directory)
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
