"""The model's own answer text, and its grade (plan task t7).

Fixtures under ``tests/fixtures/measure/answer/``:

- ``older``: a run from the harness before PR #27 (no hand-back, no
  ``facts.json``, no ``answer.md``). The walk is recorded (paths scrubbed);
  ``result.json`` is CONSTRUCTED from the keys that harness's ``associate run
  --json`` emitted, because no matching result was saved.
- ``current`` and ``echo``: recorded runs of the current harness, trimmed
  (machine paths removed). In ``echo`` the model's final message repeated the
  rendered answer.
- ``wrong``: CONSTRUCTED from the recorded ``current`` export: the model says 5
  and 7 where 2 and 3 are expected, and the harness lines of ``answer.md``
  still carry a 2 and a 3.
- ``empty``: CONSTRUCTED: a current-harness export whose model gave no text.
"""

import json
import re
import shutil
from pathlib import Path

import pytest
from evidence.answer import grade, load_expected

from associate.measure import answer as answer_module
from associate.measure.answer import grade_run, load_result, model_answer

FIXTURES = Path(__file__).parent / "fixtures" / "measure" / "answer"
RENDER_TS = Path(__file__).parent.parent / ".pi/extensions/associate/lib/render.ts"

# What lib/render.ts writes, from that file, written out here independently
# of associate/measure/answer.py. Fixed lines first, then the shapes.
FIXED_LINES = (
    "# Answer (rendered by the harness from checked items)",
    "## Conclusions",
    "## Open items",
    "## Facts",
    "No fact or conclusion passed the check.",
    "## Unchecked: the model's own words, not checked by the harness",
    'A fact marked "quote found" means its quote is in the saved result it cites; '
    "it does not mean the value is true.",
)
LINE_SHAPES = tuple(
    re.compile(pattern)
    for pattern in (
        r"^Finish summary \(\d+ sentences?\):$",
        r"^Final message \(\d+ sentences?\):$",
        r"^\d+ items? (was|were) refused by the check and (is|are) not part of this answer ",
        r"^- (none|[fvo]\d+[: \[].*)$",
        r"^\s*- alternative \w+: ",
        r"^\s*- (predicts|refuted by): ",
    )
)


def is_harness_line(line):
    text = line.strip()
    return text in FIXED_LINES or any(
        shape.search(line) or shape.search(text) for shape in LINE_SHAPES
    )


def harness_lines_in(text):
    return [line for line in text.splitlines() if is_harness_line(line)]


@pytest.fixture
def expected():
    data = json.loads((FIXTURES / "expected_settings.json").read_text(encoding="utf-8"))
    return load_expected(data)


def _run(name):
    root = FIXTURES / name
    return load_result(root / "result.json"), root / "export"


def test_render_ts_still_writes_the_fixed_lines():
    source = RENDER_TS.read_text(encoding="utf-8")
    for line in FIXED_LINES:
        literal = line.replace('"', '\\"')
        assert literal in source


def test_the_support_legend_is_a_harness_line_and_matches_render_ts():
    source = RENDER_TS.read_text(encoding="utf-8")
    pieces = re.findall(
        r"'([^']*)'", source.split("export const SUPPORT_LEGEND =", 1)[1].split(";", 1)[0]
    )
    legend = "".join(pieces)
    assert legend.startswith("The support mark is a second, separate check")
    assert answer_module.is_harness_line(legend)


# Acceptance 1: the grade of a run is unchanged when its facts.json is deleted.
@pytest.mark.parametrize("name", ["echo", "current", "wrong"])
def test_grade_is_unchanged_when_facts_json_is_deleted(tmp_path, expected, name):
    result, export = _run(name)
    before = grade_run(result, export, expected)
    copy = tmp_path / "export"
    shutil.copytree(export, copy)
    assert (copy / "facts.json").is_file()
    (copy / "facts.json").unlink()
    assert grade_run(result, copy, expected) == before
    assert model_answer(result, copy).text == model_answer(result, export).text


def test_echo_run_grades_matches_from_the_model_summary(expected):
    result, export = _run("echo")
    graded = grade_run(result, export, expected)
    assert graded["verdict"] == "matches"


# Acceptance 2: the wrong answer (5 and 7 for 2 and 3, harness lines carry 2 and 3).
def test_wrong_answer_is_reported_as_not_matching(expected):
    result, export = _run("wrong")
    graded = grade_run(result, export, expected)
    assert graded["verdict"] == "does_not_match"
    assert {"text": "3", "kind": "number"} in graded["missing"]


def test_the_trap_is_real_grading_the_whole_answer_file_would_match(expected):
    # The harness lines of answer.md hold a 2 (items refused) and a 3 (sentences).
    whole = (FIXTURES / "wrong" / "export" / "answer.md").read_text(encoding="utf-8")
    assert grade(whole, expected)["found"]
    _, export = _run("wrong")
    text = model_answer(None, export).text
    assert "retry_rounds is 5" in text
    assert "refusal_cap is 7" in text


# Acceptance 3: one function, older and current harness, no harness line.
@pytest.mark.parametrize("name", ["older", "current", "echo", "wrong"])
def test_model_text_has_no_harness_written_line(name):
    result, export = _run(name)
    answer = model_answer(result, export)
    assert answer.text.strip()
    assert harness_lines_in(answer.text) == []


def test_older_harness_returns_the_final_reply():
    result, export = _run("older")
    answer = model_answer(result, export)
    assert answer.text == result["final_reply"].strip()
    assert answer.source == "final_reply"


def test_current_harness_returns_the_summary_and_final_message_not_the_rendering():
    result, export = _run("echo")
    answer = model_answer(result, export)
    assert answer.source == "answer.md"
    assert "retry_rounds = 2, refusal_cap = 3, min_quote_length = 8" in answer.text
    for furniture in ("quote found", "Conclusions", "rests on", "Unchecked"):
        assert furniture not in answer.text


def test_the_worker_run_text_is_only_its_summary():
    result, export = _run("current")
    answer = model_answer(result, export)
    assert answer.text.startswith("Read-only inspection of evidence/accuracy/check.py")
    assert "retry_rounds" not in answer.text


def test_the_same_function_serves_both_arms_on_the_same_text(tmp_path):
    text = "retry_rounds is 2 and refusal_cap is 3."
    older = model_answer({"final_reply": text}, None)
    export = tmp_path / "export"
    export.mkdir()
    (export / "answer.md").write_text(
        "# Answer (rendered by the harness from checked items)\n\n"
        "No fact or conclusion passed the check.\n\n"
        "## Unchecked: the model's own words, not checked by the harness\n\n"
        f"Finish summary (1 sentence):\n\n> {text}\n",
        encoding="utf-8",
    )
    assert model_answer(None, export).text == older.text == text


# Acceptance 4: no answer text is cannot tell, with its cause.
def test_a_run_without_answer_text_is_cannot_tell_with_its_cause(expected):
    result, export = _run("empty")
    graded = grade_run(result, export, expected)
    assert graded["verdict"] == "cannot_tell"
    assert graded["cause"] == "empty_answer"
    assert graded["empty_reason"] == "no_model_text"


def test_a_run_with_nothing_to_read_is_cannot_tell_not_an_error(tmp_path, expected):
    graded = grade_run(None, tmp_path / "missing", expected)
    assert graded["verdict"] == "cannot_tell"
    assert graded["empty_reason"] == "no_result_and_no_export"


def test_text_made_only_of_harness_lines_counts_as_no_text(tmp_path, expected):
    export = tmp_path / "export"
    export.mkdir()
    (export / "answer.md").write_text(
        "## Unchecked: the model's own words, not checked by the harness\n\n"
        "Final message (1 sentence):\n\n> ## Facts\n"
        '> - f1: 2 — "x" (w1, file; quote found in the saved result)\n',
        encoding="utf-8",
    )
    graded = grade_run(None, export, expected)
    assert graded["verdict"] == "cannot_tell"
    assert graded["empty_reason"] == "no_model_text"


def test_an_unreadable_result_file_is_none(tmp_path):
    bad = tmp_path / "result.json"
    bad.write_text("", encoding="utf-8")
    assert load_result(bad) is None
    assert load_result(tmp_path / "absent.json") is None


def test_an_export_directory_named_only_by_the_result_is_never_opened(tmp_path):
    export = tmp_path / "export"
    export.mkdir()
    heading = "## Unchecked: the model's own words, not checked by the harness"
    (export / "answer.md").write_text(f"{heading}\n\n> from the file\n", encoding="utf-8")
    result = {"export_dir": str(export), "final_reply": "from the result"}
    answer = model_answer(result)
    assert answer.text == "from the result"
    assert answer.source == "final_reply"
    assert model_answer(result, export).text == "from the file"
