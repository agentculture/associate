"""Contamination detection over a run's walk (plan task t5)."""

import json

from associate.measure.contamination import check_walk, load_walk

KEY = "docs/accuracy/tasks.json"
REPO = {"host": "github.com", "owner": "agentculture", "name": "associate"}


def _entry(wid, tool, args, content="", **extra):
    entry = {
        "id": wid,
        "ts": "2026-11-18T00:00:00+00:00",
        "tool": tool,
        "args": args,
        "result": {"content": content},
        "truncated": False,
    }
    entry.update(extra)
    return entry


def _check(walk):
    return check_walk(walk, answer_key_paths=[KEY], **REPO)


def test_clean_walk_is_clean():
    walk = [
        _entry("w1", "read", {"path": "README.md", "purpose": "look"}),
        _entry("w2", "web_page", {"url": "https://docs.python.org/3/"}),
        _entry("w3", "eidetic_recall", {"query": "x"}, '{"query": "x", "items": []}'),
    ]
    verdict = _check(walk)
    assert verdict.contaminated is False
    assert verdict.reasons == []


def test_web_page_to_repository_hosting_is_contaminated_with_walk_id():
    walk = [
        _entry("w1", "read", {"path": "README.md"}),
        _entry("w2", "web_page", {"url": "https://github.com/agentculture/associate/blob/main/x"}),
    ]
    verdict = _check(walk)
    assert verdict.contaminated is True
    assert [(r.kind, r.walk_id) for r in verdict.reasons] == [("repository_hosting", "w2")]
    assert "github.com/agentculture/associate" in verdict.reasons[0].detail


def test_web_search_naming_the_repository_is_contaminated():
    walk = [_entry("w4", "web_search", {"query": "agentculture/associate accuracy tasks"})]
    verdict = _check(walk)
    assert [(r.kind, r.walk_id) for r in verdict.reasons] == [("repository_hosting", "w4")]


def test_raw_hosting_of_the_repository_is_contaminated():
    url = "https://raw.githubusercontent.com/AgentCulture/Associate/main/docs/x.md"
    verdict = _check([_entry("w1", "web_page", {"url": url})])
    assert verdict.contaminated is True


def test_other_repository_on_same_host_is_clean():
    url = "https://github.com/agentculture/culture"
    assert _check([_entry("w1", "web_page", {"url": url})]).contaminated is False


def test_answer_key_path_in_any_argument_is_contaminated():
    walk = [
        _entry("w1", "shell", {"argv": ["cat", KEY], "purpose": "p"}),
        _entry("w2", "read", {"path": "x"}, args_used={"path": f"/clone/{KEY}"}),
    ]
    verdict = _check(walk)
    assert [(r.kind, r.walk_id) for r in verdict.reasons] == [
        ("answer_key", "w1"),
        ("answer_key", "w2"),
    ]


def test_recalled_record_is_contaminated():
    body = json.dumps({"query": "k", "items": [{"id": "r1", "text": "t"}]})
    verdict = _check([_entry("w7", "eidetic_recall", {"query": "k"}, body)])
    assert [(r.kind, r.walk_id) for r in verdict.reasons] == [("recalled_record", "w7")]


def test_empty_recall_is_not_contaminated():
    body = json.dumps({"query": "k", "items": []})
    assert _check([_entry("w7", "eidetic_recall", {"query": "k"}, body)]).contaminated is False


def test_unreadable_recall_result_is_contaminated_not_assumed_empty():
    verdict = _check([_entry("w7", "eidetic_recall", {"query": "k"}, "not json at all")])
    assert [(r.kind, r.walk_id) for r in verdict.reasons] == [("recalled_record", "w7")]


def test_failed_recall_is_not_contaminated():
    walk = [_entry("w7", "eidetic_recall", {"query": "k"}, "", error={"code": "recall_failed"})]
    assert _check(walk).contaminated is False


def test_recall_stored_by_digest_is_read_from_saved_result(tmp_path):
    (tmp_path / "results").mkdir()
    (tmp_path / "results" / "w7.txt").write_text('{"items": [{"id": "r"}]}', encoding="utf-8")
    entry = _entry("w7", "eidetic_recall", {"query": "k"}, saved_result="results/w7.txt")
    entry["result"] = {"sha256": "0" * 64, "bytes": 24}
    verdict = check_walk([entry], answer_key_paths=[KEY], export_dir=tmp_path, **REPO)
    assert [r.kind for r in verdict.reasons] == ["recalled_record"]


def test_load_walk_skips_format_gate_child_and_run_lines(tmp_path):
    lines = [
        {"format": 2},
        _entry("w1", "read", {"path": "a"}),
        {"gate": {"verdict": "allow"}},
        {"child": {"id": "c1"}},
        {"run": {"duration_ms": 1}},
    ]
    path = tmp_path / "walk.jsonl"
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    assert [e["id"] for e in load_walk(path)] == ["w1"]
