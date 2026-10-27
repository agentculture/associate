"""Aggregating ten walk run records into a latency and failure table (c36)."""

from __future__ import annotations

import json

import pytest

from associate.bench import walkstats


def gate_line(index, tier, decision, *, tool="write"):
    """One ``{"gate": ...}`` line as the gate writes it (walk.schema.json)."""
    entry = {
        "id": f"g{index}",
        "ts": "2026-09-12T10:00:01.000Z",
        "tier": tier,
        "question_set_version": 1,
        "gated_tool": tool,
        "decision": decision,
    }
    if tier == "clef":
        entry["probabilities"] = {"is_safe": 0.9}
    if tier in ("super", "large"):
        entry["verdict"] = {"safe": decision == "allow"}
    if tier == "large":
        entry["evaluator"] = "cortex"
    return {"gate": entry}


def write_walk(directory, *, entries=1, run=None, gates=(), name="walk.jsonl"):
    """Write a walk with *entries* entries, optional gate lines and an optional run record."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    lines = [
        json.dumps(
            {
                "id": f"w{index}",
                "ts": "2026-09-12T10:00:00.000Z",
                "tool": "read",
                "args": {"path": "a.ts"},
                "result": {"content": "a", "sha256": "0" * 64, "bytes": 1},
                "truncated": False,
            }
        )
        for index in range(1, entries + 1)
    ]
    lines += [json.dumps(entry) for entry in gates]
    if run is not None:
        lines.append(json.dumps({"run": run}))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def ten_runs(tmp_path):
    """Ten session directories: eight ok, one error, one killed mid-run."""
    for index in range(8):
        write_walk(
            tmp_path / f"session-{index}" / "export",
            entries=2,
            run={
                "duration_ms": 100 * (index + 1),
                "tool_calls": 2,
                "outcome": "ok",
                "truncated": index == 7,
            },
        )
    write_walk(
        tmp_path / "session-8" / "export",
        entries=1,
        run={"duration_ms": 5000, "tool_calls": 1, "outcome": "error", "truncated": False},
    )
    # The killed run: entries on disk, no run record.
    write_walk(tmp_path / "session-9" / "export", entries=3, run=None)
    return tmp_path


def test_find_walks_discovers_every_session(tmp_path):
    root = ten_runs(tmp_path)
    walks = walkstats.find_walks([root])
    assert len(walks) == 10
    assert all(path.name == "walk.jsonl" for path in walks)


def test_find_walks_accepts_a_file_and_deduplicates(tmp_path):
    path = write_walk(tmp_path / "one", run={"duration_ms": 1, "tool_calls": 0, "outcome": "ok"})
    assert walkstats.find_walks([path, path, tmp_path]) == [path]


def test_a_walk_with_no_run_record_is_reported_incomplete(tmp_path):
    path = write_walk(tmp_path / "killed", entries=4, run=None)
    record = walkstats.load_run_record(path)
    assert record["complete"] is False
    assert record["outcome"] == "incomplete"
    assert record["tool_calls"] == 4, "the entries a killed run did write are still counted"
    assert record["duration_ms"] is None


def test_a_truncated_final_line_does_not_lose_the_earlier_entries(tmp_path):
    path = write_walk(tmp_path / "half", entries=2, run=None)
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"id": "w3", "ts": "2026-')
    record = walkstats.load_run_record(path)
    assert record["outcome"] == "incomplete"
    assert record["tool_calls"] == 2


def test_ten_records_aggregate_into_a_latency_and_failure_table(tmp_path):
    root = ten_runs(tmp_path)
    records = [walkstats.load_run_record(path) for path in walkstats.find_walks([root])]
    stats = walkstats.aggregate(records)
    row = stats.as_dict()

    assert row["runs"] == 10
    assert row["ok"] == 8
    assert row["failures"] == 2, "an errored run and an unfinished run both count as failures"
    assert row["failure_rate"] == pytest.approx(0.2)
    assert row["truncated"] == 1
    assert row["outcomes"] == {"ok": 8, "error": 1, "incomplete": 1}
    # Nine runs reported a duration: 100..800 and 5000.
    assert row["p50_ms"] == 500
    assert row["p90_ms"] == 5000
    assert row["max_ms"] == 5000
    # 8 runs of 2 calls, one of 1, and the killed run's 3 entries: 20 / 10.
    assert row["mean_tool_calls"] == pytest.approx(2.0)


def test_percentile_is_nearest_rank_so_it_names_a_real_observation():
    values = [10, 20, 30, 40]
    assert walkstats.percentile(values, 0.5) == 20
    assert walkstats.percentile(values, 0.9) == 40
    assert walkstats.percentile([], 0.5) == 0.0


def test_render_prints_a_table_with_a_header_and_an_outcome_breakdown(tmp_path):
    root = ten_runs(tmp_path)
    records = [walkstats.load_run_record(path) for path in walkstats.find_walks([root])]
    text = walkstats.render([walkstats.aggregate(records)], records)
    lines = text.splitlines()

    assert lines[0].startswith("| group")
    assert "fail rate" in lines[0]
    assert set(lines[1]) <= {"|", "-"}
    assert any("incomplete=1" in line for line in lines)
    # --per-run breakdown: one line per walk.
    assert sum(1 for line in lines if line.startswith("  ")) == 10


def test_main_prints_the_table_and_exits_zero(tmp_path, capsys):
    root = ten_runs(tmp_path)
    assert walkstats.main([str(root)]) == 0
    out = capsys.readouterr().out
    assert "| group" in out
    assert "10" in out


def test_main_json_mode_emits_the_aggregate_and_every_run(tmp_path, capsys):
    root = ten_runs(tmp_path)
    assert walkstats.main([str(root), "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["aggregate"]["runs"] == 10
    assert len(payload["runs"]) == 10
    assert {record["outcome"] for record in payload["runs"]} == {"ok", "error", "incomplete"}


def test_main_reports_when_there_is_nothing_to_aggregate(tmp_path, capsys):
    assert walkstats.main([str(tmp_path)]) == 1
    assert "no walk.jsonl found" in capsys.readouterr().err


def gated_walks(tmp_path):
    """Three walks whose gate lines hold five gated calls, two of them read-only fallbacks.

    Tiers: clef x2 (allow, refuse), super x1 (allow), readonly x2 (allow, refuse).
    The child link line must not be counted as a gated call.
    """
    write_walk(
        tmp_path / "a" / "export",
        entries=2,
        gates=[gate_line(1, "clef", "allow"), gate_line(2, "super", "allow")],
        run={"duration_ms": 10, "tool_calls": 2, "outcome": "ok"},
    )
    write_walk(
        tmp_path / "b" / "export",
        entries=1,
        gates=[
            gate_line(1, "clef", "refuse"),
            {
                "child": {
                    "id": "c1",
                    "ts": "2026-09-12T10:00:02.000Z",
                    "child_model": "associate",
                    "child_walk": "/x/walk.jsonl",
                    "child_session_id": "s",
                }
            },
            gate_line(2, "readonly", "allow"),
        ],
        run={"duration_ms": 20, "tool_calls": 1, "outcome": "ok"},
    )
    write_walk(
        tmp_path / "c" / "export",
        entries=1,
        gates=[gate_line(1, "readonly", "refuse")],
        run=None,
    )
    return tmp_path


def test_gate_lines_are_read_and_an_old_walk_has_none(tmp_path):
    old = write_walk(
        tmp_path / "old", entries=3, run={"duration_ms": 1, "tool_calls": 3, "outcome": "ok"}
    )
    assert walkstats.load_gate_records(old) == []
    gated = gated_walks(tmp_path / "new")
    records = [
        record
        for path in walkstats.find_walks([gated])
        for record in walkstats.load_gate_records(path)
    ]
    assert len(records) == 5, "child link lines are not gate records"
    assert all("tier" in record for record in records)


def test_tier_shares_and_readonly_fallbacks_over_fixture_walks(tmp_path):
    root = gated_walks(tmp_path)
    records = [
        record
        for path in walkstats.find_walks([root])
        for record in walkstats.load_gate_records(path)
    ]
    gates = walkstats.aggregate_gates(records).as_dict()

    assert gates["gated_calls"] == 5
    assert gates["readonly_fallbacks"] == 2
    assert gates["tiers"]["clef"] == {"count": 2, "share": 0.4, "allow": 1, "refuse": 1}
    assert gates["tiers"]["super"] == {"count": 1, "share": 0.2, "allow": 1, "refuse": 0}
    assert gates["tiers"]["readonly"] == {"count": 2, "share": 0.4, "allow": 1, "refuse": 1}


def test_zero_gated_calls_report_zero_shares_without_dividing(tmp_path):
    gates = walkstats.aggregate_gates([]).as_dict()
    assert gates["gated_calls"] == 0
    assert gates["readonly_fallbacks"] == 0
    for tier in ("clef", "super", "large", "readonly"):
        assert gates["tiers"][tier] == {"count": 0, "share": 0.0, "allow": 0, "refuse": 0}


def test_gate_lines_with_an_unknown_tier_are_not_counted(tmp_path):
    bogus = gate_line(1, "clef", "allow")
    bogus["gate"]["tier"] = "mystery"
    stats = walkstats.aggregate_gates([bogus["gate"], gate_line(2, "readonly", "refuse")["gate"]])
    assert stats.gated == 1
    assert stats.readonly_fallbacks == 1


def test_render_prints_a_gate_line_with_tier_shares_and_fallbacks(tmp_path):
    root = gated_walks(tmp_path)
    records = [walkstats.load_run_record(path) for path in walkstats.find_walks([root])]
    gates = walkstats.aggregate_gates(
        record
        for path in walkstats.find_walks([root])
        for record in walkstats.load_gate_records(path)
    )
    text = walkstats.render([walkstats.aggregate(records)], (), gates=gates)
    gate_lines = [line for line in text.splitlines() if line.startswith("gates:")]

    assert len(gate_lines) == 1
    assert "gated=5" in gate_lines[0]
    assert "clef=2 (40.0%" in gate_lines[0]
    assert "super=1 (20.0%" in gate_lines[0]
    assert "readonly=2 (40.0%" in gate_lines[0]
    assert "readonly fallbacks=2" in gate_lines[0]


def test_main_text_reports_gates_for_fixture_walks(tmp_path, capsys):
    root = gated_walks(tmp_path)
    assert walkstats.main([str(root)]) == 0
    out = capsys.readouterr().out
    assert "readonly fallbacks=2" in out
    assert "| group" in out, "the existing table is still printed"


def test_main_text_for_old_walks_reports_zero_gates(tmp_path, capsys):
    write_walk(
        tmp_path / "old", entries=1, run={"duration_ms": 1, "tool_calls": 1, "outcome": "ok"}
    )
    assert walkstats.main([str(tmp_path)]) == 0
    assert "gates: gated=0" in capsys.readouterr().out


def test_main_json_mode_includes_gate_aggregate(tmp_path, capsys):
    root = gated_walks(tmp_path)
    assert walkstats.main([str(root), "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["gates"]["gated_calls"] == 5
    assert payload["gates"]["readonly_fallbacks"] == 2
    assert payload["gates"]["tiers"]["clef"]["share"] == 0.4
    assert payload["aggregate"]["runs"] == 3, "existing fields are unchanged"


def test_large_state_gate_lines_count_as_their_own_tier(tmp_path):
    """d16: a state over CLEF's budget is judged by a registry evaluator, and the
    report keeps it apart from CLEF and Super."""
    stats = walkstats.aggregate_gates(
        [
            gate_line(1, "large", "allow")["gate"],
            gate_line(2, "large", "refuse")["gate"],
            gate_line(3, "clef", "allow")["gate"],
        ]
    ).as_dict()
    assert stats["gated_calls"] == 3
    assert stats["tiers"]["large"] == {"count": 2, "share": 0.6667, "allow": 1, "refuse": 1}
    text = walkstats.render_gates(
        walkstats.aggregate_gates([gate_line(1, "large", "allow")["gate"]])
    )
    assert "large=1 (100.0%" in text
