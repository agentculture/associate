"""The filtered clone a measured run examines (plan task t4)."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from associate.measure import clone as clone_mod
from associate.measure.clone import CloneError, make_clone

KEY_TEXT = "ANSWER-KEY-SECRET-42"
EXCLUDED = ["docs/accuracy", "tasks/t1.json"]
ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}


def git(repo: Path, *args: str) -> str:
    env = {**os.environ, **ENV}
    out = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return out.stdout


def write(repo: Path, rel: str, text: str) -> None:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


@pytest.fixture()
def source(tmp_path: Path) -> Path:
    repo = tmp_path / "source"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write(repo, "README.md", "hello\n")
    write(repo, "src/a.py", "print('a')\n")
    write(repo, "docs/accuracy/tasks.json", f'{{"answer": "{KEY_TEXT}"}}\n')
    write(repo, "tasks/t1.json", f"{KEY_TEXT} task file\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "first")
    # a later commit that changes the key, so history would leak it
    write(repo, "docs/accuracy/tasks.json", f'{{"answer": "{KEY_TEXT}-v2"}}\n')
    write(repo, "src/a.py", "print('a2')\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "second")
    git(repo, "remote", "add", "origin", "https://github.com/example/src.git")
    return repo


def commit_of(repo: Path) -> str:
    return git(repo, "rev-parse", "HEAD").strip()


def snapshot(repo: Path) -> tuple[str, str, str]:
    return (
        git(repo, "status", "--porcelain=v1", "--ignored"),
        git(repo, "for-each-ref"),
        git(repo, "rev-parse", "HEAD"),
    )


def all_revision_text(repo: Path) -> str:
    """Every reachable revision's tree listing and blob contents."""
    parts = []
    for rev in git(repo, "rev-list", "--all").split():
        parts.append(git(repo, "ls-tree", "-r", "--name-only", rev))
        for line in git(repo, "ls-tree", "-r", rev).splitlines():
            blob = line.split()[2]
            parts.append(git(repo, "cat-file", "-p", blob))
    parts.append(git(repo, "log", "--all", "-p"))
    return "\n".join(parts)


def test_no_answer_key_or_excluded_path_reachable(source: Path, tmp_path: Path):
    result = make_clone(source, commit_of(source), EXCLUDED, tmp_path / "out")
    root = result.path
    tracked = git(root, "ls-files").splitlines()
    for rel in tracked:
        assert KEY_TEXT not in (root / rel).read_text(encoding="utf-8")
        assert not rel.startswith("docs/accuracy")
        assert rel != "tasks/t1.json"
    history = all_revision_text(root)
    assert KEY_TEXT not in history
    assert "docs/accuracy" not in history
    assert "tasks/t1.json" not in history
    assert not (root / "docs" / "accuracy").exists()
    assert not (root / "tasks" / "t1.json").exists()
    assert "src/a.py" in tracked


def test_keeps_unexcluded_content_at_pinned_commit(source: Path, tmp_path: Path):
    first = git(source, "rev-list", "--max-parents=0", "HEAD").strip()
    result = make_clone(source, first, EXCLUDED, tmp_path / "out")
    assert (result.path / "src" / "a.py").read_text() == "print('a')\n"


def test_two_clones_same_tree_and_head_returned(source: Path, tmp_path: Path):
    pin = commit_of(source)
    one = make_clone(source, pin, EXCLUDED, tmp_path / "out")
    two = make_clone(source, pin, EXCLUDED, tmp_path / "out")
    assert one.path != two.path
    assert git(one.path, "rev-parse", "HEAD^{tree}") == git(two.path, "rev-parse", "HEAD^{tree}")
    assert one.head == git(one.path, "rev-parse", "HEAD").strip()
    assert one.head == two.head
    assert one.tree == git(one.path, "rev-parse", "HEAD^{tree}").strip()
    assert one.source_commit == pin


def test_single_commit_and_no_remote(source: Path, tmp_path: Path):
    result = make_clone(source, commit_of(source), EXCLUDED, tmp_path / "out")
    assert git(result.path, "rev-list", "--all", "--count").strip() == "1"
    assert git(result.path, "remote").strip() == ""
    config = (result.path / ".git" / "config").read_text()
    assert "github.com" not in config
    assert str(source) not in config
    assert not (result.path / ".git" / "objects" / "info" / "alternates").exists()


def test_source_unchanged(source: Path, tmp_path: Path):
    write(source, "untracked.txt", "x\n")
    before = snapshot(source)
    make_clone(source, commit_of(source), EXCLUDED, tmp_path / "out")
    assert snapshot(source) == before


def test_clone_is_outside_source_and_fresh_each_time(source: Path, tmp_path: Path):
    result = make_clone(source, commit_of(source), EXCLUDED, tmp_path / "out")
    assert not result.path.resolve().is_relative_to(source.resolve())


def test_destination_inside_source_refused(source: Path):
    with pytest.raises(CloneError):
        make_clone(source, commit_of(source), EXCLUDED, source / "inside")


def test_unknown_commit_refused(source: Path, tmp_path: Path):
    with pytest.raises(CloneError):
        make_clone(source, "0" * 40, EXCLUDED, tmp_path / "out")


@pytest.mark.parametrize("bad", ["/abs", "../up", "", "a/../../b", ".git"])
def test_bad_excluded_path_refused(source: Path, tmp_path: Path, bad: str):
    with pytest.raises(CloneError):
        make_clone(source, commit_of(source), [bad], tmp_path / "out")


def test_missing_excluded_path_is_reported_not_fatal(source: Path, tmp_path: Path):
    result = make_clone(source, commit_of(source), ["docs/accuracy", "nope"], tmp_path / "o")
    assert result.removed == ["docs/accuracy"]
    assert result.not_found == ["nope"]


def test_module_exposes_no_remote_helpers():
    assert not hasattr(clone_mod, "add_remote")


def test_tracked_file_matching_gitignore_is_kept(source: Path, tmp_path: Path):
    write(source, ".gitignore", "*.log\n")
    write(source, "kept.log", "tracked anyway\n")
    git(source, "add", "-f", "-A")
    git(source, "commit", "-q", "-m", "ignored but tracked")
    result = make_clone(source, commit_of(source), EXCLUDED, tmp_path / "out")
    assert "kept.log" in git(result.path, "ls-files").splitlines()
