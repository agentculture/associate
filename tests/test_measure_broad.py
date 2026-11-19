"""The broad tasks: the task file, the first marking, the rule file (decider-score t11).

Nothing here runs a model. The first marking is ``evidence.answer.grade`` per
checklist fact; it is a first marking only, read by hand afterwards.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from associate.measure import broad
from associate.measure import runner as runner_mod
from associate.measure.clone import make_clone
from associate.measure.contamination import ANSWER_KEY, check_walk

REPO_ROOT = Path(__file__).resolve().parents[1]
COMMIT = "a" * 40
GIT_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}
UNCHECKED = "## Unchecked: the model's own words, not checked by the harness"


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **GIT_ENV},
    ).stdout.strip()


def fact(fact_id: str, *groups: list[str]) -> dict:
    return {
        "id": fact_id,
        "question": f"question {fact_id}?",
        "answer": f"answer {fact_id}",
        "match": [list(group) for group in groups],
        "evidence": [{"file": "README.md", "line": 1, "quote": "x"}],
    }


def broad_doc(*tasks: dict) -> dict:
    return {"version": 1, "prompt": "Explain this repository.", "tasks": list(tasks)}


def broad_task(task_id: str = "broad-demo", name: str = "demo", facts=None) -> dict:
    return {
        "id": task_id,
        "repo": {"host": "github.com", "owner": "example", "name": name},
        "commit": COMMIT,
        "facts": facts if facts is not None else [fact("f1", ["hatchling"])],
    }


# --- the committed task file ---------------------------------------------------------------


def test_the_committed_broad_file_loads_as_six_runner_tasks():
    tasks = broad.load_broad_tasks()
    assert [t["id"] for t in tasks] == [
        "broad-culture",
        "broad-culture-rules",
        "broad-colleague",
        "broad-associate",
        "broad-coherence-cli",
        "broad-workledger-cli",
    ]
    doc = json.loads(broad.BROAD_TASKS_PATH.read_text(encoding="utf-8"))
    for task in tasks:
        assert task["prompt"] == doc["prompt"]
        assert set(task["repository"]) == {"host", "owner", "name"}
        assert len(task["commit"]) == 40
        assert task["facts"], task["id"]
        # The answers and the evidence are the answer key; a runner task carries neither.
        assert all(set(f) == {"id", "match"} for f in task["facts"])
        assert "expected" not in task


def test_a_broad_file_with_a_bad_fact_is_refused_with_every_reason(tmp_path):
    bad = broad_task(facts=[fact("f1"), {"id": "f1", "match": [["x"]]}, fact("f3", [""])])
    bad["commit"] = "main"
    path = tmp_path / "broad.json"
    path.write_text(json.dumps(broad_doc(bad)), encoding="utf-8")
    with pytest.raises(broad.BroadFileError) as caught:
        broad.load_broad_tasks(path)
    text = "; ".join(caught.value.problems)
    assert "commit" in text
    assert "f1" in text
    assert "match" in text
    assert "duplicate fact id" in text
    assert "f3" in text


def test_a_broad_file_without_a_prompt_is_refused(tmp_path):
    path = tmp_path / "broad.json"
    path.write_text(json.dumps({"version": 1, "tasks": [broad_task()]}), encoding="utf-8")
    with pytest.raises(broad.BroadFileError) as caught:
        broad.load_broad_tasks(path)
    assert "prompt" in "; ".join(caught.value.problems)


# --- the first marking ---------------------------------------------------------------------


def test_a_fact_is_marked_when_every_group_is_found_by_one_alternative():
    two_groups = fact("f1", ["culture_core"], ["meta-path", "alias finder"])
    assert broad.mark_fact(two_groups, "It has culture_core and an Alias Finder.") is True
    assert broad.mark_fact(two_groups, "It has culture_core only.") is False
    assert broad.mark_fact(two_groups, "An alias finder, nothing else.") is False


def test_the_first_marking_is_case_insensitive():
    assert broad.mark_fact(fact("f1", ["Hatchling"]), "built with HATCHLING") is True


def test_an_empty_answer_marks_no_fact():
    marking = broad.first_marking([fact("f1", ["x"]), fact("f2", ["y"])], "")
    assert marking["facts_stated"] == 0
    assert [f["stated"] for f in marking["facts"]] == [False, False]


def test_the_first_marking_counts_per_fact_and_is_labelled_a_first_marking():
    facts = [fact("f1", ["hatchling"]), fact("f2", ["pytest"]), fact("f3", ["tox"])]
    marking = broad.first_marking(facts, "Built with hatchling; tested with pytest.")
    assert marking["facts_total"] == 3
    assert marking["facts_stated"] == 2
    assert marking["facts"] == [
        {"id": "f1", "stated": True},
        {"id": "f2", "stated": True},
        {"id": "f3", "stated": False},
    ]
    assert marking["marking"] == "first marking"
    forbidden = ("score", "accuracy", "percent", "share", "rate")
    assert not [key for key in marking if any(word in key for word in forbidden)]


# --- what the runner stores for a broad run ------------------------------------------------


def runner_task(facts=None) -> dict:
    return {
        "id": "broad-demo",
        "repository": {"host": "github.com", "owner": "example", "name": "demo"},
        "commit": COMMIT,
        "prompt": "Explain this repository.",
        "facts": facts
        or [{"id": "f1", "match": [["hatchling"]]}, {"id": "f2", "match": [["tox"]]}],
    }


def test_a_broad_run_stores_the_whole_answer_from_answer_md_and_the_marking(tmp_path):
    long_answer = "The build backend is hatchling. " + "It has many parts. " * 300
    assert len(long_answer) > 2 * broad.FINAL_REPLY_CAP
    export = tmp_path / "export"
    export.mkdir()
    quoted = "\n".join(f"> {line}" for line in ["Final message (301 sentences):", long_answer])
    (export / "answer.md").write_text(f"# Answer\n\n{UNCHECKED}\n\n{quoted}\n", encoding="utf-8")
    fields = runner_mod._broad_fields({"final_reply": "tail only"}, export, runner_task())
    assert fields["answer"]["text"] == long_answer.strip()
    assert fields["answer"]["source"] == "answer.md"
    assert fields["broad"]["answer_source"] == "answer.md"
    assert fields["broad"]["at_cap"] is False
    assert fields["broad"]["facts_stated"] == 1
    assert fields["broad"]["facts_total"] == 2
    assert fields["broad"]["marking"] == "first marking"
    # No whole-task grade: the counts are per fact and never pooled into one verdict.
    assert fields["grade"] is None
    assert fields["grades"] == []
    assert fields["graded"] is False


def test_a_broad_run_from_a_final_reply_at_the_cap_says_so():
    reply = ("hatchling " * 400)[: broad.FINAL_REPLY_CAP]
    assert len(reply) == broad.FINAL_REPLY_CAP
    fields = runner_mod._broad_fields({"final_reply": reply}, None, runner_task())
    assert fields["broad"]["answer_source"] == "final_reply"
    assert fields["broad"]["at_cap"] is True
    assert fields["broad"]["final_reply_cap"] == broad.FINAL_REPLY_CAP


def test_a_short_final_reply_is_not_at_the_cap():
    fields = runner_mod._broad_fields({"final_reply": "uses hatchling"}, None, runner_task())
    assert fields["broad"]["answer_source"] == "final_reply"
    assert fields["broad"]["at_cap"] is False


def test_the_cap_is_the_harness_constant():
    from associate.harness import pi

    assert broad.FINAL_REPLY_CAP == pi.FINAL_REPLY_CHARS


def test_the_runner_accepts_a_broad_task_and_names_its_facts_in_the_identity():
    task = runner_task()
    assert runner_mod._task_problems(task) == []
    other = runner_task([{"id": "f1", "match": [["other"]]}])
    first, second = runner_mod._task_identity(task), runner_mod._task_identity(other)
    assert first["expected_sha256"] != second["expected_sha256"]


# --- the answer key stays out of the clone and out of a clean run --------------------------


def test_the_clone_of_this_repository_holds_no_broad_task_file(tmp_path):
    made = make_clone(REPO_ROOT, "HEAD", list(runner_mod.DEFAULT_EXCLUDED), tmp_path / "clones")
    assert (made.path / "pyproject.toml").is_file()
    assert [p for p in made.path.rglob("broad-tasks.json")] == []
    assert not (made.path / "docs" / "accuracy").exists()


def test_a_broad_run_excludes_the_broad_file_even_when_the_exclusions_were_changed():
    assert runner_mod._excluded_for(["notes"], runner_task()) == [
        "notes",
        "docs/accuracy/broad-tasks.json",
    ]
    assert runner_mod._excluded_for(["docs/accuracy"], runner_task()) == ["docs/accuracy"]
    short = {**runner_task(), "expected": {}}
    del short["facts"]
    assert runner_mod._excluded_for(["notes"], short) == ["notes"]


@pytest.mark.parametrize(
    "args",
    [
        {"path": "docs/accuracy/broad-tasks.json"},
        {"command": "cat ../somewhere/broad-tasks.json"},
        {"pattern": "f1", "path": "broad-tasks.json"},
    ],
)
def test_reading_the_broad_file_is_a_read_of_the_answer_key(args):
    walk = [{"id": "w1", "tool": "read", "args": args}]
    verdict = check_walk(
        walk,
        answer_key_paths=runner_mod._key_paths(["docs/accuracy"], runner_task()),
        host="github.com",
        owner="example",
        name="demo",
    )
    assert verdict.contaminated is True
    assert verdict.reasons[0].kind == ANSWER_KEY


def test_a_short_task_run_is_not_contaminated_by_the_broad_file_name():
    short = {**runner_task(), "expected": {}}
    del short["facts"]
    assert runner_mod._key_paths(["docs/accuracy"], short) == ["docs/accuracy"]


# --- the committed rule file ---------------------------------------------------------------

CONFIRMED = """# The difference that will be called a change, broad tasks

```json
{"status": "confirmed", "repositories": 6, "repositories_required": 5, "runs_per_arm": 3}
```

The rule in words.
"""


def test_the_committed_rule_file_exists_and_is_still_a_draft():
    text = broad.BROAD_NOTE.read_text(encoding="utf-8")
    assert broad.BROAD_NOTE.as_posix().endswith("docs/accuracy/broad-difference-threshold.md")
    assert broad.draft_problem(text) is not None
    rule = broad.read_rule(text)
    assert (rule.repositories, rule.repositories_required, rule.runs_per_arm) == (6, 5, 3)
    assert "at least 5 of 6 repositories" in text
    assert "no difference shown" in text


def test_a_confirmed_rule_file_is_not_a_draft():
    assert broad.draft_problem(CONFIRMED) is None


def test_a_rule_file_that_still_says_draft_anywhere_is_a_draft():
    assert broad.draft_problem(CONFIRMED + "\nDRAFT wording, to be replaced.\n") is not None
    assert broad.draft_problem(CONFIRMED.replace("confirmed", "draft")) is not None


def test_a_rule_file_without_readable_parameters_is_refused():
    with pytest.raises(broad.RuleError):
        broad.read_rule("# no parameters here\n")
    no_runs = CONFIRMED.replace('"runs_per_arm": 3', '"runs_per_arm": 0')
    with pytest.raises(broad.RuleError):
        broad.read_rule(no_runs)
    assert broad.draft_problem("# no parameters here\n") is not None


def repo_counts(better: int, tied: int = 0, worse: int = 0) -> dict:
    counts = {}
    for index in range(better):
        counts[f"r{index}"] = {"on": [5, 6, 5], "off": [5, 4, 3]}
    for index in range(tied):
        counts[f"t{index}"] = {"on": [5, 6, 5], "off": [5, 6, 4]}
    for index in range(worse):
        counts[f"w{index}"] = {"on": [1, 1, 1], "off": [2, 2, 2]}
    return counts


def test_the_rule_calls_a_change_at_five_of_six_repositories():
    rule = broad.read_rule(CONFIRMED)
    found = broad.rule_verdict(rule, repo_counts(5, 1), higher_is_better=True)
    assert found["verdict"] == "a change"
    assert found["better_arm"] == "on"
    assert found["repositories_for"] == {"off": 0, "on": 5}


def test_the_rule_says_no_difference_shown_at_four_of_six():
    rule = broad.read_rule(CONFIRMED)
    found = broad.rule_verdict(rule, repo_counts(4, 1, 1), higher_is_better=True)
    assert found["verdict"] == "no difference shown"
    assert found["better_arm"] is None
    assert found["repositories_for"] == {"off": 1, "on": 4}


def test_overlapping_runs_are_not_a_better_repository():
    rule = broad.read_rule(CONFIRMED)
    counts = repo_counts(5)
    counts["mixed"] = {"on": [5, 6, 2], "off": [3, 3, 3]}
    found = broad.rule_verdict(rule, counts, higher_is_better=True)
    assert found["repositories_for"] == {"off": 0, "on": 5}
    equal = {f"r{i}": {"on": [4, 4, 4], "off": [4, 4, 4]} for i in range(6)}
    assert broad.rule_verdict(rule, equal, higher_is_better=True)["repositories_for"] == {
        "off": 0,
        "on": 0,
    }


def test_for_a_count_of_false_statements_lower_is_better():
    rule = broad.read_rule(CONFIRMED)
    found = broad.rule_verdict(rule, repo_counts(6), higher_is_better=False)
    assert found["verdict"] == "a change"
    assert found["better_arm"] == "off"


@pytest.mark.parametrize(
    "counts, word",
    [
        ({f"r{i}": {"on": [1, 2, 3], "off": [1, 2, 3]} for i in range(5)}, "repositories"),
        ({f"r{i}": {"on": [1, 2], "off": [1, 2, 3]} for i in range(6)}, "runs"),
        ({f"r{i}": {"on": [1, 2, 3]} for i in range(6)}, "two arms"),
        ({f"r{i}": {"a": [1, 2, 3], "b": [1, 2, 3], "c": [1, 2, 3]} for i in range(6)}, "two arms"),
    ],
)
def test_the_rule_is_not_applied_to_runs_it_was_not_written_for(counts, word):
    found = broad.rule_verdict(broad.read_rule(CONFIRMED), counts, higher_is_better=True)
    assert found["verdict"] == "not applicable"
    assert word in found["why"]
    assert found["better_arm"] is None
