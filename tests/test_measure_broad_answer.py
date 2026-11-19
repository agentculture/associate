"""A broad run that ended without ``finish``: where its answer text comes from.

Such a run leaves no ``answer.md``. Its export holds the model's last message
whole (``final_message.md``, exports of the harness that writes it) or split
into statements (``statements.json``, every export); the run result holds only
the last 2,000 characters of it. Every fixture here is CONSTRUCTED, small, and
of the shape of two real exports that ended this way: one whose last message
was markdown prose with walk citations, one whose last message spelled the
hand-back out as JSON-like text.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from associate.cli import main
from associate.measure import answer as answer_mod
from associate.measure import broad
from associate.measure import runner as runner_mod
from associate.measure import sheet as sheet_mod
from tests.test_measure_broad import runner_task
from tests.test_measure_broad_command import OFF, ON, store
from tests.test_measure_command import run_json
from tests.test_measure_sheet import record, some_records

UNCHECKED = "## Unchecked: the model's own words, not checked by the harness"
CAP = broad.FINAL_REPLY_CAP

# Markdown prose with walk citations. It holds lines of the very shapes the
# harness writes into answer.md, written here by the model itself.
PROSE = "\n".join(
    [
        "All quotes verified. Here is my hand-back.",
        "",
        "## Facts",
        "",
        "- **build:** the backend is hatchling [w17]",
        '- f1: hatchling — "build-backend" (w17, file; quote found in the saved result)',
        "- none",
        "",
        "> quoted from pyproject.toml [w3]",
        "",
        "```bash",
        "tox -e py312",
        "```",
        "",
        "| verb | does |",
        "| --- | --- |",
        "| run | starts it |",
        "",
        "## Open items",
        "",
        "No open items remain [w17, w3].",
    ]
)

# The hand-back written out as text instead of being passed to finish.
JSONISH = "\n".join(
    [
        "I have a complete picture now. Here is the hand-back.",
        "",
        "---",
        "",
        '<facts> [{"id": "f1", "value": "the build backend is hatchling", "source": "w26", '
        '"quote": "build-backend = \\"hatchling.build\\"", "action": false}]',
        "",
        '<verdicts> [{"id": "v1", "text": "tests run under tox", "rests_on": ["f1"]}]',
        "",
        '<open_items> [{"id": "o1", "text": "Whether the suite passes here"}]',
    ]
)

NOT_FINISHED = {"handback_outcome": "none"}


def export_dir(tmp_path: Path, **files: str) -> Path:
    export = tmp_path / "export"
    export.mkdir()
    for name, text in files.items():
        (export / name.replace("_json", ".json").replace("_md", ".md")).write_text(
            text, encoding="utf-8"
        )
    return export


def statements_json(*texts: str) -> str:
    """A statements.json of the extension's shape holding *texts* in order."""
    entries = [
        {"text": text, "evidence": [], "status": "unreferenced", "citations": []} for text in texts
    ]
    return json.dumps({"statements": entries, "citations": [], "not_fully_read": False})


def split_like_the_extension(message: str) -> list[str]:
    """Hand-written result of ``lib/statements.ts`` ``splitStatements`` for PROSE."""
    assert message == PROSE
    return [
        "All quotes verified. Here is my hand-back.",
        "**build:** the backend is hatchling [w17]",
        'f1: hatchling — "build-backend" (w17, file; quote found in the saved result)',
        "none",
        "> quoted from pyproject.toml [w3]",
        "| verb | does | | --- | --- | | run | starts it |",
        "No open items remain [w17, w3].",
    ]


def long_tail(text: str) -> str:
    """A final reply at the cap: the last characters of a long message ending in *text*."""
    return ("padding " * CAP + text)[-CAP:]


# --- what the short-task filter does to a model's own lines ---------------------------------


@pytest.mark.parametrize(
    "line",
    [
        "## Facts",
        "## Open items",
        "- none",
        '- f1: hatchling — "build-backend" (w17, file; quote found in the saved result)',
    ],
)
def test_the_short_task_filter_drops_these_lines_of_the_prose_hand_back(line):
    assert line in PROSE.splitlines()
    assert answer_mod.is_harness_line(line) is True
    assert line not in answer_mod.model_answer({"final_reply": PROSE}).text.splitlines()


def test_the_short_task_filter_removes_the_quote_mark_of_a_quoted_line():
    kept = answer_mod.model_answer({"final_reply": PROSE}).text.splitlines()
    assert "quoted from pyproject.toml [w3]" in kept
    assert "> quoted from pyproject.toml [w3]" not in kept


def test_the_short_task_filter_leaves_a_line_with_a_walk_citation():
    kept = answer_mod.model_answer({"final_reply": PROSE}).text.splitlines()
    assert "- **build:** the backend is hatchling [w17]" in kept


def test_the_short_task_filter_leaves_the_json_like_hand_back_as_it_is():
    assert answer_mod.model_answer({"final_reply": JSONISH}).text == JSONISH


# --- the broad answer: the whole final message ----------------------------------------------


@pytest.mark.parametrize("message", [PROSE, JSONISH], ids=["prose", "json-like"])
def test_the_final_message_file_is_the_answer_word_for_word(tmp_path, message):
    export = export_dir(tmp_path, final_message_md=message, statements_json=statements_json("x"))
    found = answer_mod.broad_answer({"final_reply": long_tail("the tail")}, export)
    assert found.text == message
    assert found.source == "final_message.md"
    assert found.empty_reason is None


def test_answer_md_is_still_the_first_source_when_the_run_finished(tmp_path):
    rendered = f"# Answer\n\n{UNCHECKED}\n\n> Final message (1 sentence):\n> Uses hatchling.\n"
    export = export_dir(tmp_path, answer_md=rendered, final_message_md="# Answer\n\n## Facts")
    found = answer_mod.broad_answer({"final_reply": "tail"}, export)
    assert found.text == "Uses hatchling."
    assert found.source == "answer.md"


def test_a_final_reply_below_the_cap_is_the_whole_message_and_is_not_filtered(tmp_path):
    assert len(PROSE) < CAP
    export = export_dir(tmp_path, statements_json=statements_json("only a split"))
    found = answer_mod.broad_answer({"final_reply": PROSE}, export)
    assert found.text == PROSE
    assert found.source == "final_reply"


def test_without_the_file_a_capped_run_is_read_from_the_statements(tmp_path):
    texts = split_like_the_extension(PROSE)
    export = export_dir(tmp_path, statements_json=statements_json(*texts))
    found = answer_mod.broad_answer({"final_reply": long_tail("the tail")}, export)
    assert found.text == "\n\n".join(texts)
    assert found.source == "statements.json"


def test_the_statements_keep_a_json_like_hand_back_line_for_line(tmp_path):
    texts = [line for line in JSONISH.splitlines() if line]
    export = export_dir(tmp_path, statements_json=statements_json(*texts))
    found = answer_mod.broad_answer({"final_reply": long_tail(JSONISH[-50:])}, export)
    assert found.text.split("\n\n") == texts


@pytest.mark.parametrize(
    "content",
    [
        "",
        "not json",
        "[]",
        '{"statements": "no"}',
        '{"statements": []}',
        '{"statements": [{"text": 3}, 4, {"text": "  "}]}',
    ],
)
def test_statements_that_hold_no_text_fall_back_to_the_capped_reply(tmp_path, content):
    export = export_dir(tmp_path, statements_json=content)
    reply = long_tail("## Facts\n- none\nuses hatchling")
    found = answer_mod.broad_answer({"final_reply": reply}, export)
    assert found.text == reply.strip()
    assert found.source == "final_reply_capped"


def test_a_blank_final_message_file_is_not_a_source(tmp_path):
    export = export_dir(tmp_path, final_message_md=" \n", statements_json=statements_json("a"))
    found = answer_mod.broad_answer({"final_reply": long_tail("tail")}, export)
    assert found.source == "statements.json"


def test_no_text_anywhere_is_an_empty_answer(tmp_path):
    export = export_dir(tmp_path)
    found = answer_mod.broad_answer({"final_reply": ""}, export)
    assert found.text == ""
    assert found.source == "none"
    assert found.empty_reason == "no_model_text"


def test_nothing_to_read_is_said_as_such():
    found = answer_mod.broad_answer(None, None)
    assert found.source == "none"
    assert found.empty_reason == "no_result_and_no_export"


def test_the_short_task_answer_does_not_read_the_new_sources(tmp_path):
    export = export_dir(tmp_path, final_message_md="whole", statements_json=statements_json("s"))
    found = answer_mod.model_answer({"final_reply": "## Facts\nthe reply"}, export)
    assert found.text == "the reply"
    assert found.source == "final_reply"


# --- what a broad run stores ----------------------------------------------------------------


def test_a_run_without_finish_is_marked_on_its_whole_final_message(tmp_path):
    message = (
        "## Build\n\nThe backend is hatchling.\n\n" + "More. " * CAP + "\n\nTests run with tox."
    )
    export = export_dir(tmp_path, final_message_md=message)
    result = {**NOT_FINISHED, "final_reply": message[-CAP:]}
    fields = runner_mod._broad_fields(result, export, runner_task())
    assert fields["answer"]["text"] == message
    assert fields["answer"]["source"] == "final_message.md"
    assert fields["broad"]["answer_source"] == "final_message.md"
    assert fields["broad"]["at_cap"] is False
    assert fields["broad"]["finished"] is False
    assert fields["broad"]["facts_stated"] == 2


def test_the_capped_reply_alone_misses_what_the_statements_hold(tmp_path):
    texts = ["The backend is hatchling.", *["More."] * CAP, "Tests run with tox."]
    result = {**NOT_FINISHED, "final_reply": long_tail("Tests run with tox.")}
    capped = runner_mod._broad_fields(result, None, runner_task())
    assert capped["broad"]["answer_source"] == "final_reply_capped"
    assert capped["broad"]["at_cap"] is True
    assert capped["broad"]["facts_stated"] == 1
    export = export_dir(tmp_path, statements_json=statements_json(*texts))
    full = runner_mod._broad_fields(result, export, runner_task())
    assert full["broad"]["answer_source"] == "statements.json"
    assert full["broad"]["at_cap"] is False
    assert full["broad"]["facts_stated"] == 2


@pytest.mark.parametrize(
    ("result", "finished"),
    [
        ({"handback_outcome": "accepted"}, True),
        ({"handback_outcome": "none"}, False),
        ({"handback_outcome": "refused_after_rounds"}, False),
        ({"final_reply": "an older harness says nothing"}, None),
        (None, None),
    ],
)
def test_finished_is_the_result_s_handback_outcome(result, finished):
    fields = runner_mod._broad_fields(result, None, runner_task())
    assert fields["broad"]["finished"] is finished


def test_a_reply_at_the_cap_is_flagged_only_when_it_is_the_source(tmp_path):
    export = export_dir(tmp_path, final_message_md="whole message")
    fields = runner_mod._broad_fields({"final_reply": "x" * CAP}, export, runner_task())
    assert fields["broad"]["at_cap"] is False


# --- the sheet uses the same text -----------------------------------------------------------


def test_the_sheet_splits_the_stored_final_message_with_nothing_dropped(tmp_path):
    export = export_dir(tmp_path, final_message_md=PROSE)
    fields = runner_mod._broad_fields({**NOT_FINISHED, "final_reply": "t"}, export, runner_task())
    stored = record("broad-one", OFF, 1, "")
    stored.update(answer=fields["answer"], broad=fields["broad"])
    sheet, _key = sheet_mod.build([stored], seed=1)
    texts = [statement["text"] for statement in sheet["runs"][0]["statements"]]
    assert sheet_mod.split_statements(PROSE) == texts
    for own_line in ("Facts", "Open items", "none", "```bash\ntox -e py312\n```"):
        assert own_line in texts
    assert any("(w17, file; quote found in the saved result)" in text for text in texts)
    assert any(text.startswith(">") for text in texts)


# --- the report -----------------------------------------------------------------------------


def unfinished(records: list[dict], index: int, source: str = "statements.json") -> None:
    records[index]["broad"].update(answer_source=source, finished=False)


def finished_records() -> list[dict]:
    records = some_records(tasks=("broad-one",))
    for stored in records:
        stored["broad"]["finished"] = True
    return records


def test_rows_carry_finished_and_the_source():
    records = finished_records()
    unfinished(records, 0)
    rows = sheet_mod.run_rows(records, None)
    assert [row["finished"] for row in rows] == [False, True, True, True, True, True]
    assert rows[0]["answer_source"] == "statements.json"
    assert rows[0]["at_cap"] is False


def test_the_text_says_per_run_how_it_ended():
    records = finished_records()
    unfinished(records, 0)
    text = sheet_mod.render_rows(sheet_mod.run_rows(records, None))
    assert text.count("answer from statements.json, not at the cap; ended without finish") == 1
    assert text.count("answer from answer.md, not at the cap; finish accepted") == 5


def test_the_text_counts_per_arm_the_runs_that_ended_without_finish():
    records = finished_records()
    unfinished(records, 0)
    unfinished(records, 1, "final_message.md")
    text = sheet_mod.render_rows(sheet_mod.run_rows(records, None))
    assert f"arm {OFF}: 2 of 3 runs ended without finish" in text
    assert f"arm {ON}: 0 of 3 runs ended without finish" in text


def test_the_text_says_in_one_line_that_such_runs_handed_back_no_checked_facts():
    records = finished_records()
    unfinished(records, 0)
    text = sheet_mod.render_rows(sheet_mod.run_rows(records, None))
    lines = [line for line in text.splitlines() if "handed back no checked facts" in line]
    assert len(lines) == 1
    assert "graded like the others" in lines[0]


def test_the_line_is_left_out_when_every_run_finished():
    text = sheet_mod.render_rows(sheet_mod.run_rows(finished_records(), None))
    assert "handed back no checked facts" not in text
    assert f"arm {OFF}: 0 of 3 runs ended without finish" in text


def test_a_record_stored_before_finished_was_recorded_is_counted_apart():
    records = some_records(tasks=("broad-one",))
    counts = sheet_mod.finish_counts(sheet_mod.run_rows(records, None))
    assert counts[OFF] == {"runs": 3, "without_finish": 0, "finish_not_recorded": 3}
    text = sheet_mod.render_rows(sheet_mod.run_rows(records, None))
    assert "finish not recorded" in text
    assert f"arm {OFF}: 0 of 3 runs ended without finish (3 not recorded)" in text


def test_the_report_command_gives_the_counts_per_arm(tmp_path, capsys):
    records = finished_records()
    unfinished(records, 0)
    results = store(tmp_path / "results", records)
    payload = run_json(capsys, ["measure", "report", str(results), "--json"])
    assert payload["without_finish"][OFF] == {
        "runs": 3,
        "without_finish": 1,
        "finish_not_recorded": 0,
    }
    assert payload["without_finish"][ON]["without_finish"] == 0
    assert payload["runs"][0]["finished"] is False
    capsys.readouterr()
    assert main(["measure", "report", str(results)]) == 0
    text = capsys.readouterr().out
    assert f"arm {OFF}: 1 of 3 runs ended without finish" in text
    assert "handed back no checked facts" in text
