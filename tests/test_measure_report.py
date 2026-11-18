"""The comparison table and the hand-grading sample (plan task t10).

Every stored result here is a record file written straight into a temporary
results directory; no model, network or key is involved.
"""

from __future__ import annotations

import json
from pathlib import Path

from associate.measure.report import (
    INTERNAL_LINE,
    READING_ANSWER,
    READING_WITH_HANDBACK,
    compare_hand_grades,
    draw_sample,
    readings_differences,
    render_agreement,
    render_success_numbers,
    render_table,
    success_numbers,
    write_blank_sheet,
)
from associate.measure.runner import load_records

MAGIC = "MAGIC-VALUE-1234"
EXPECTED = {
    "schema_version": 1,
    "must_appear": [{"text": MAGIC, "kind": "text"}],
    "must_not_appear": [],
    "one_of": [],
}
TASKS = {"t1": {"id": "t1", "expected": EXPECTED}, "t2": {"id": "t2", "expected": EXPECTED}}
MATCH, NOT, CANT = "matches", "does_not_match", "cannot_tell"


def verdict_dict(verdict):
    return {"verdict": verdict, "found": [], "missing": [], "forbidden_present": []}


def make_record(task, arm, repeat, verdict=MATCH, **kw):
    """One stored record in the runner's shape; keyword options adjust it."""
    status = kw.get("status", "finished")
    finished = status == "finished"
    text = kw.get("text", MAGIC if verdict == MATCH else "nothing useful")
    grades = []
    if finished:
        grades.append({"reading": READING_ANSWER, "grade": verdict_dict(verdict), "text": text})
        if kw.get("plus") is not None:
            plus = {"reading": READING_WITH_HANDBACK, "grade": verdict_dict(kw["plus"])}
            grades.append(plus)
    reasons = [{"kind": k, "walk_id": "w1", "detail": "d"} for k in kw.get("reasons", ())]
    contamination = {"checked": True, "contaminated": bool(reasons), "reasons": reasons}
    if kw.get("contaminated"):
        contamination["contaminated"] = True
    return {
        "record_format": 1,
        "task": {"id": task},
        "arm": {"name": arm},
        "repeat": repeat,
        "status": status,
        "graded": finished,
        "outcome": kw.get("outcome", "completed") if finished else None,
        "grade": grades[0]["grade"] if grades else None,
        "grades": grades,
        "answer": {"text": text},
        "contamination": contamination if finished else None,
    }


def store(results: Path, records):
    for rec in records:
        path = results / "records" / rec["task"]["id"] / rec["arm"]["name"]
        path.mkdir(parents=True, exist_ok=True)
        (path / f"r{rec['repeat']}.json").write_text(json.dumps(rec), encoding="utf-8")
    return load_records(results)


def rows_for(text: str, arm: str):
    return [line.split() for line in text.splitlines() if line.split()[:1] == [arm]]


def sample_pool(n: int):
    return [make_record("t1", "arm-a", i, MATCH if i % 3 else NOT) for i in range(n)]


def hand_count_records():
    recs = []
    # arm-a, t1: 2 matching, 1 not matching; t2: 1 matching, 1 cannot tell, 1 timeout
    recs += [make_record("t1", "arm-a", 0), make_record("t1", "arm-a", 1)]
    recs += [make_record("t1", "arm-a", 2, NOT)]
    recs += [make_record("t2", "arm-a", 0), make_record("t2", "arm-a", 1, CANT)]
    recs += [make_record("t2", "arm-a", 2, MATCH, outcome="timeout")]
    # arm-b, t1: 1 matching, 1 contaminated (would match), 1 failed launch
    recs += [make_record("t1", "arm-b", 0)]
    recs += [make_record("t1", "arm-b", 1, MATCH, reasons=["answer_key"])]
    recs += [make_record("t1", "arm-b", 2, status="launch_failed")]
    return recs


def test_same_results_print_the_same_table_and_counts_match_a_hand_count(tmp_path):
    records = store(tmp_path, hand_count_records())
    first = render_table(records)
    assert render_table(load_records(tmp_path)) == first
    assert render_table(list(reversed(records))) == first
    # columns: arm runs matching not-matching cannot-tell not-graded contaminated
    assert rows_for(first, "arm-a")[-1] == ["arm-a", "6", "3", "1", "1", "1", "0"]
    assert rows_for(first, "arm-b")[-1] == ["arm-b", "3", "1", "0", "0", "1", "1"]
    assert len(rows_for(first, "arm-a")) == 3  # task t1, task t2, total


def test_contaminated_run_is_not_matching_but_is_contaminated(tmp_path):
    clean = make_record("t1", "arm-b", 0)
    dirty = make_record("t1", "arm-b", 1, MATCH, reasons=["answer_key"])
    text = render_table(store(tmp_path, [clean, dirty]))
    assert rows_for(text, "arm-b")[-1] == ["arm-b", "2", "1", "0", "0", "0", "1"]
    only = render_table(store(tmp_path / "x", [dirty]))
    assert rows_for(only, "arm-b")[-1] == ["arm-b", "1", "0", "0", "0", "0", "1"]


def test_every_output_carries_the_internal_line_and_never_claims_a_score(tmp_path):
    records = store(tmp_path, hand_count_records())
    outputs = [
        render_table(records),
        render_table(records, READING_WITH_HANDBACK),
        render_table([]),
        render_success_numbers(success_numbers(records, TASKS)),
    ]
    sheet = tmp_path / "sheet.json"
    sample = draw_sample(records, 1, 5)
    write_blank_sheet(sample, sheet)
    outputs.append(render_agreement(compare_hand_grades(sample, sheet)))
    for text in outputs:
        assert INTERNAL_LINE in text.splitlines()
        assert "accuracy" not in text.lower()
        assert text.lower().count("benchmark score") == 1
        others = [ln for ln in text.splitlines() if ln != INTERNAL_LINE]
        assert not any("score" in ln.lower() for ln in others)


def test_the_header_names_the_reading_and_the_second_reading_falls_back(tmp_path):
    recs = [
        make_record("t1", "arm-a", 0, NOT, plus=MATCH),
        make_record("t1", "arm-a", 1, NOT),
        make_record("t1", "arm-a", 2, MATCH),
        make_record("t1", "arm-old", 0, NOT),
    ]
    records = store(tmp_path, recs)
    default = render_table(records)
    assert "Reading shown: answer_text" in default.splitlines()
    assert "plus_handback" not in default
    second = render_table(records, READING_WITH_HANDBACK)
    assert "Reading shown: answer_text_plus_handback_values" in second.splitlines()
    assert rows_for(second, "arm-a")[-1][:4] == ["arm-a", "3", "2", "1"]
    assert "arm-a: 2 of 3 runs have no second reading and are counted under answer_text" in second
    assert "arm-old: 1 of 1 runs have no second reading and are counted under answer_text" in second
    assert "have no second reading" not in default
    assert readings_differences(records) == {"arm-a": 1, "arm-old": 0}


def test_sample_is_fixed_by_the_seed_and_has_48_runs(tmp_path):
    records = store(tmp_path, sample_pool(60))
    one = draw_sample(records, 7)
    two = draw_sample(records, 7)
    assert [r.key for r in one.runs] == [r.key for r in two.runs]
    assert len(one.runs) == 48
    assert len({r.key for r in one.runs}) == 48
    assert not one.short
    other = draw_sample(records, 8)
    assert [r.key for r in other.runs] != [r.key for r in one.runs]


def test_short_sample_returns_every_graded_run_and_says_so(tmp_path):
    records = store(
        tmp_path, sample_pool(10) + [make_record("t2", "arm-a", 0, status="launch_failed")]
    )
    sample = draw_sample(records, 7)
    assert len(sample.runs) == 10
    assert sample.short
    assert "short" in sample.message.lower()
    assert "10" in sample.message
    assert "48" in sample.message


def test_agreement_equals_a_hand_count_and_a_missing_hand_grade_is_not_agreement(tmp_path):
    records = store(tmp_path, sample_pool(12))
    sample = draw_sample(records, 3, 12)
    sheet = tmp_path / "sheet.json"
    write_blank_sheet(sample, sheet)
    doc = json.loads(sheet.read_text(encoding="utf-8"))
    assert len(doc["entries"]) == 12
    assert all(e["hand_grade"] is None for e in doc["entries"])
    grader = {r.key: r.grade for r in sample.runs}
    wrong = {MATCH: NOT, NOT: MATCH}
    for i, entry in enumerate(doc["entries"]):
        key = (entry["task"], entry["arm"], entry["repeat"])
        if i < 6:
            entry["hand_grade"] = grader[key]
        elif i < 8:
            entry["hand_grade"] = wrong[grader[key]]
        elif i == 8:
            entry["hand_grade"] = "banana"
        entry["note"] = "n"
    sheet.write_text(json.dumps(doc), encoding="utf-8")
    result = compare_hand_grades(sample, sheet)
    assert (result.sampled, result.hand_graded) == (12, 8)
    assert (result.agreed, result.disagreed) == (6, 2)
    assert len(result.missing) == 3
    assert len(result.invalid) == 1
    assert result.share == 6 / 8
    text = render_agreement(result)
    assert "6 of 8" in text
    assert "3 missing" in text


def test_no_hand_grade_file_means_all_missing_and_no_agreement(tmp_path):
    records = store(tmp_path, sample_pool(5))
    sample = draw_sample(records, 1, 5)
    result = compare_hand_grades(sample, tmp_path / "absent.json")
    assert result.agreed == 0
    assert len(result.missing) == 5
    assert result.share is None


def test_blank_sheet_does_not_show_the_grader_grade(tmp_path):
    records = store(tmp_path, sample_pool(4))
    sample = draw_sample(records, 1, 4)
    sheet = tmp_path / "sheet.json"
    write_blank_sheet(sample, sheet)
    doc = json.loads(sheet.read_text(encoding="utf-8"))
    for entry in doc["entries"]:
        assert set(entry) == {"task", "arm", "repeat", "answer_text", "hand_grade", "note"}
        assert entry["hand_grade"] is None


def test_success_numbers_match_a_hand_count(tmp_path):
    recs = [
        make_record("t1", "arm-a", 0, MATCH),  # stays matching
        make_record("t1", "arm-a", 1, NOT, text=MAGIC),  # stored not-matching, now matching
        make_record("t2", "arm-a", 0, MATCH, text="nothing"),  # stored matching, now not
        make_record("t2", "arm-a", 1, MATCH, outcome="timeout"),  # not graded
        make_record("t2", "arm-a", 2, status="launch_failed"),  # not graded
        make_record("t1", "arm-b", 0, MATCH, reasons=["answer_key"]),
        make_record("t1", "arm-b", 1, MATCH, reasons=["repository_hosting"]),
    ]
    numbers = success_numbers(store(tmp_path, recs), TASKS)
    arm_a, arm_b, total = numbers["arms"]["arm-a"], numbers["arms"]["arm-b"], numbers["total"]
    assert (arm_a["runs"], arm_a["graded"]) == (5, 3)
    assert arm_a["regrade_changes"] == 2
    assert arm_a["key_reads"] == 0
    assert (arm_b["runs"], arm_b["graded"], arm_b["key_reads"]) == (2, 2, 1)
    assert (total["runs"], total["graded"], total["key_reads"]) == (7, 5, 1)
    assert total["regrade_changes"] == 2
    text = render_success_numbers(numbers)
    assert "3 of 5" in text


def test_a_run_that_read_the_key_and_timed_out_is_a_key_read_and_contaminated(tmp_path):
    timed_out = make_record("t1", "arm-a", 0, MATCH, outcome="timeout", reasons=["answer_key"])
    records = store(tmp_path, [timed_out, make_record("t1", "arm-a", 1, MATCH)])
    row = success_numbers(records, TASKS)["arms"]["arm-a"]
    assert (row["runs"], row["graded"], row["key_reads"]) == (2, 1, 1)
    # columns: arm runs matching not-matching cannot-tell not-graded contaminated
    assert rows_for(render_table(records), "arm-a")[-1] == ["arm-a", "2", "1", "0", "0", "0", "1"]
    assert [run.key for run in draw_sample(records, seed=1).runs] == [("t1", "arm-a", 1)]
    assert readings_differences(records) == {"arm-a": 0}
