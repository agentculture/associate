"""t15 — a mutating run works in its own git worktree, then merges to main (c51, h33).

Every repository here is a throwaway ``git init`` under ``tmp_path``; the git
environment is made hermetic (no global/system config) so the operator's own
``~/.gitconfig`` — signing, hooks paths, default branch — cannot change what
these tests see. The run itself is a **fake harness** registered for the test:
it writes files into whatever checkout it is handed, the way a mutating model
would, and records what the operator checkout looked like mid-run. No pi, no
network, no model.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from associate import harness as harness_pkg
from associate.cli import main
from associate.harness import worktree as wt
from associate.harness.base import WALK_FILENAME, Harness, HarnessError

# ---------------------------------------------------------------- fixtures


def git(cwd: Path, *args: str, check: bool = True) -> str:
    completed = subprocess.run(  # nosec B603 B607 - test helper, fixed argv
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, check=False
    )
    if check and completed.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {completed.stderr}")
    return completed.stdout.strip()


@pytest.fixture(autouse=True)
def hermetic_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    empty = tmp_path / "empty.gitconfig"
    empty.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        monkeypatch.delenv(name, raising=False)


def make_repo(path: Path, *, branch: str = "main", identity: bool = True) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", branch)
    if identity:
        git(path, "config", "user.name", "Operator")
        git(path, "config", "user.email", "operator@example.invalid")
    (path / "README.md").write_text("# fixture\n", encoding="utf-8")
    (path / "sub").mkdir()
    (path / "sub" / "notes.txt").write_text("notes\n", encoding="utf-8")
    git(path, "add", "-A")
    git(
        path,
        "-c",
        "user.name=Operator",
        "-c",
        "user.email=operator@example.invalid",
        "commit",
        "-q",
        "-m",
        "initial",
    )
    return path


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    return make_repo(tmp_path / "ws" / "proj")


class FakeHarness(Harness):
    """Writes ``WRITES`` into the checkout it is handed, like a mutating model."""

    name = "fake"
    WRITES: dict[str, str] = {}
    OUTCOME = "ok"
    RAISE: str | None = None
    #: The operator checkout, to observe mid-run (criterion 1).
    OPERATOR: Path | None = None
    seen: dict[str, Any] = {}

    def start(self, checkout, contract_dir, session_id, export_dir) -> None:
        self._checkout = Path(checkout)
        self._export = Path(export_dir) / session_id
        self._session = session_id

    def submit(self, task: dict[str, Any]) -> None:
        cls = type(self)
        cls.seen["checkout"] = str(self._checkout)
        cls.seen["task_checkout"] = task["checkout"]
        for rel, text in cls.WRITES.items():
            target = self._checkout / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        if cls.OPERATOR is not None:
            cls.seen["operator_has_writes_mid_run"] = any(
                (cls.OPERATOR / rel).exists() for rel in cls.WRITES
            )
        if cls.RAISE:
            raise HarnessError(cls.RAISE, remediation="fake remediation")
        self._export.mkdir(parents=True, exist_ok=True)
        run = {"duration_ms": 1, "tool_calls": 1, "outcome": cls.OUTCOME, "truncated": False}
        (self._export / WALK_FILENAME).write_text(json.dumps({"run": run}) + "\n")

    def collect(self) -> dict[str, Any]:
        return {
            "walk_path": str(self._export / WALK_FILENAME),
            "outcome": type(self).OUTCOME,
            "session_id": self._session,
        }


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(harness_pkg._REGISTRY, "fake", lambda: FakeHarness)
    monkeypatch.setattr(FakeHarness, "WRITES", {"NEW.md": "written by the run\n"})
    monkeypatch.setattr(FakeHarness, "OUTCOME", "ok")
    monkeypatch.setattr(FakeHarness, "RAISE", None)
    monkeypatch.setattr(FakeHarness, "OPERATOR", None)
    monkeypatch.setattr(FakeHarness, "seen", {})
    return FakeHarness


def run_cli(checkout: Path, tmp_path: Path, *extra: str) -> int:
    return main(
        [
            "run",
            "--harness",
            "fake",
            "--checkout",
            str(checkout),
            "--export-root",
            str(tmp_path / "runs"),
            "--session-id",
            "s1",
            "--json",
            *extra,
        ]
    )


def root_of(repo: Path) -> Path:
    return repo.parent / f".worktrees.{repo.name}"


def branches(repo: Path) -> list[str]:
    return git(repo, "branch", "--format=%(refname:short)").splitlines()


# ------------------------------------------------------- naming and layout


def test_the_worktree_lives_under_the_repo_owned_root_on_a_scoped_branch(repo: Path):
    run = wt.create_run_worktree(repo, "abc")
    assert run.path == root_of(repo).resolve() / "run-abc"
    assert run.branch == "associate-run/abc"
    assert run.path.is_dir()
    assert git(run.path, "rev-parse", "--abbrev-ref", "HEAD") == "associate-run/abc"
    assert run.base == git(repo, "rev-parse", "HEAD")


def test_a_subdirectory_checkout_runs_in_the_same_subdirectory_of_the_worktree(repo: Path):
    run = wt.create_run_worktree(repo / "sub", "abc")
    assert run.run_checkout == run.path / "sub"
    assert (run.run_checkout / "notes.txt").is_file()


def test_a_linked_worktree_checkout_resolves_to_the_main_repo_root(repo: Path, tmp_path: Path):
    linked = tmp_path / "elsewhere" / "linked"
    git(repo, "worktree", "add", "-q", "-b", "side", str(linked))
    run = wt.create_run_worktree(linked, "abc")
    assert run.path.parent == root_of(repo).resolve()


def test_a_session_id_already_in_use_is_refused(repo: Path):
    wt.create_run_worktree(repo, "abc")
    with pytest.raises(HarnessError):
        wt.create_run_worktree(repo, "abc")


def test_a_non_git_checkout_is_reported_as_such(tmp_path: Path):
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(wt.NotAGitRepository):
        wt.create_run_worktree(plain, "abc")


# ---------------------------------------- criterion 1: isolation and discard


def test_writes_exist_only_in_the_worktree_until_merge(repo: Path, tmp_path: Path, fake):
    fake.OPERATOR = repo
    assert run_cli(repo, tmp_path) == 0
    assert fake.seen["checkout"] == str(root_of(repo).resolve() / "run-s1")
    assert fake.seen["task_checkout"] == fake.seen["checkout"]
    assert fake.seen["operator_has_writes_mid_run"] is False


def test_removing_the_worktree_before_merge_discards_the_run(repo: Path):
    head = git(repo, "rev-parse", "main")
    run = wt.create_run_worktree(repo, "abc")
    (run.path / "BAD.md").write_text("a bad write\n", encoding="utf-8")
    (run.path / "README.md").write_text("clobbered\n", encoding="utf-8")

    wt.discard(run)

    assert not run.path.exists()
    assert "associate-run/abc" not in branches(repo)
    assert git(repo, "rev-parse", "main") == head
    assert not (repo / "BAD.md").exists()
    assert (repo / "README.md").read_text(encoding="utf-8") == "# fixture\n"
    assert git(repo, "status", "--porcelain") == ""
    assert root_of(repo).is_dir(), "the .worktrees.<name> root is never removed"


# ---------------------------------- criterion 2: clean merges, failed doesn't


def test_a_clean_run_is_committed_and_merged_into_a_checked_out_main(
    repo: Path, tmp_path: Path, fake, capsys
):
    before = git(repo, "rev-parse", "main")
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["merge"] == "merged"
    assert (repo / "NEW.md").read_text(encoding="utf-8") == "written by the run\n"
    parents = git(repo, "rev-list", "--parents", "-n", "1", "main").split()
    assert len(parents) == 3, "--no-ff: a merge commit with two parents"
    assert parents[1] == before
    log = git(repo, "log", "--format=%s", "main")
    assert "s1" in log
    # cleanup after a merge: worktree and branch gone, root kept
    assert not (root_of(repo) / "run-s1").exists()
    assert "associate-run/s1" not in branches(repo)
    assert root_of(repo).is_dir()
    assert git(repo, "status", "--porcelain") == ""


def test_the_harness_commit_falls_back_to_an_identity_when_none_is_configured(
    tmp_path: Path, fake, capsys
):
    repo = make_repo(tmp_path / "ws" / "anon", identity=False)
    assert run_cli(repo, tmp_path) == 0
    assert json.loads(capsys.readouterr().out)["merge"] == "merged"
    assert (repo / "NEW.md").is_file()


def test_a_run_that_committed_its_own_work_is_merged(repo: Path, tmp_path: Path, fake, capsys):
    class Committing(FakeHarness):
        def submit(self, task):
            super().submit(task)
            git(self._checkout, "add", "-A")
            git(self._checkout, "commit", "-q", "-m", "agent commit")

    harness_pkg._REGISTRY["fake"] = lambda: Committing
    assert run_cli(repo, tmp_path) == 0
    assert json.loads(capsys.readouterr().out)["merge"] == "merged"
    assert "agent commit" in git(repo, "log", "--format=%s", "main")


def test_a_failed_run_is_not_merged_or_committed_and_is_kept(
    repo: Path, tmp_path: Path, fake, capsys
):
    fake.RAISE = "the fake run died"
    before = git(repo, "rev-parse", "main")
    assert run_cli(repo, tmp_path) == 2
    err = capsys.readouterr().err
    path = root_of(repo).resolve() / "run-s1"
    assert str(path) in err
    assert "associate-run/s1" in err

    assert git(repo, "rev-parse", "main") == before
    assert not (repo / "NEW.md").exists()
    assert path.is_dir() and (path / "NEW.md").is_file()
    assert git(repo, "rev-parse", "associate-run/s1") == before, "never commit a failed run"


def test_a_non_ok_outcome_is_not_merged_or_committed(repo: Path, tmp_path: Path, fake, capsys):
    fake.OUTCOME = "error"
    before = git(repo, "rev-parse", "main")
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["merge"] == "kept"
    assert "error" in payload["merge_reason"]
    assert git(repo, "rev-parse", "main") == before
    assert git(repo, "rev-parse", "associate-run/s1") == before
    assert Path(payload["worktree"]).is_dir()


def test_a_clean_run_with_nothing_changed_merges_nothing_and_cleans_up(
    repo: Path, tmp_path: Path, fake, capsys
):
    fake.WRITES = {}
    before = git(repo, "rev-parse", "main")
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["merge"] == "nothing_to_merge"
    assert git(repo, "rev-parse", "main") == before
    assert not (root_of(repo) / "run-s1").exists()
    assert "associate-run/s1" not in branches(repo)


# ------------------------------------------------- merge refusals keep the run


def test_a_conflicting_merge_is_aborted_and_main_is_untouched(
    repo: Path, tmp_path: Path, fake, capsys
):
    class ConflictingFake(FakeHarness):
        def submit(self, task):
            super().submit(task)
            # main moves on while the run is in flight, touching the same line
            (repo / "README.md").write_text("# main changed\n", encoding="utf-8")
            git(repo, "commit", "-q", "-am", "concurrent main change")

    harness_pkg._REGISTRY["fake"] = lambda: ConflictingFake
    fake.WRITES = {"README.md": "# run changed\n"}
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["merge"] == "kept"
    assert "conflict" in payload["merge_reason"]
    assert git(repo, "log", "-1", "--format=%s", "main") == "concurrent main change"
    assert (repo / "README.md").read_text(encoding="utf-8") == "# main changed\n"
    assert git(repo, "status", "--porcelain") == ""
    assert not (repo / ".git" / "MERGE_HEAD").exists()
    assert Path(payload["worktree"]).is_dir()
    assert "associate-run/s1" in branches(repo)


def test_a_dirty_main_checkout_is_never_merged_into(repo: Path, tmp_path: Path, fake, capsys):
    (repo / "README.md").write_text("operator's unsaved edit\n", encoding="utf-8")
    before = git(repo, "rev-parse", "main")
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["merge"] == "kept"
    assert "uncommitted" in payload["merge_reason"]
    assert git(repo, "rev-parse", "main") == before
    assert (repo / "README.md").read_text(encoding="utf-8") == "operator's unsaved edit\n"
    assert not (repo / "NEW.md").exists()
    # the clean run's writes were committed on the kept branch
    assert git(repo, "show", "associate-run/s1:NEW.md") == "written by the run"


def test_an_untracked_operator_file_does_not_block_a_merge(
    repo: Path, tmp_path: Path, fake, capsys
):
    (repo / "scratch.txt").write_text("mine\n", encoding="utf-8")
    assert run_cli(repo, tmp_path) == 0
    assert json.loads(capsys.readouterr().out)["merge"] == "merged"
    assert (repo / "scratch.txt").read_text(encoding="utf-8") == "mine\n"


def test_an_untracked_operator_file_in_the_way_is_never_overwritten(
    repo: Path, tmp_path: Path, fake, capsys
):
    (repo / "NEW.md").write_text("operator's own NEW.md\n", encoding="utf-8")
    before = git(repo, "rev-parse", "main")
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["merge"] == "kept"
    assert git(repo, "rev-parse", "main") == before
    assert (repo / "NEW.md").read_text(encoding="utf-8") == "operator's own NEW.md\n"


def test_main_not_checked_out_is_updated_without_touching_the_operator_tree(
    repo: Path, tmp_path: Path, fake, capsys
):
    git(repo, "switch", "-q", "-c", "side")  # operator on a branch at main's tip
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["merge"] == "merged"
    assert git(repo, "rev-parse", "--abbrev-ref", "HEAD") == "side"
    assert not (repo / "NEW.md").exists(), "the operator's working tree is untouched"
    assert git(repo, "show", "main:NEW.md") == "written by the run"
    assert len(git(repo, "rev-list", "--parents", "-n", "1", "main").split()) == 3
    assert git(repo, "status", "--porcelain") == ""
    leftovers = sorted(p.name for p in root_of(repo).iterdir())
    assert leftovers == [], f"temporary merge worktree left behind: {leftovers}"
    assert git(repo, "worktree", "list", "--porcelain").count("worktree ") == 1


def test_a_run_based_off_main_is_not_merged_into_main(repo: Path, tmp_path: Path, fake, capsys):
    git(repo, "switch", "-q", "-c", "feature")
    (repo / "feature.txt").write_text("unreviewed\n", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "feature work")
    main_before = git(repo, "rev-parse", "main")
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["merge"] == "kept"
    assert "not on main" in payload["merge_reason"]
    assert git(repo, "rev-parse", "main") == main_before


def test_a_repo_without_main_is_not_merged(tmp_path: Path, fake, capsys):
    repo = make_repo(tmp_path / "ws" / "legacy", branch="master")
    before = git(repo, "rev-parse", "master")
    assert run_cli(repo, tmp_path) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["merge"] == "kept"
    assert "main" in payload["merge_reason"]
    assert git(repo, "rev-parse", "master") == before
    assert "main" not in branches(repo)


def test_merging_never_contacts_a_remote(repo: Path, tmp_path: Path, fake, monkeypatch):
    git(repo, "remote", "add", "origin", "https://example.invalid/never.git")
    calls: list[list[str]] = []
    real = wt._git

    def spy(args, cwd, **kwargs):
        calls.append(list(args))
        return real(args, cwd, **kwargs)

    monkeypatch.setattr(wt, "_git", spy)
    assert run_cli(repo, tmp_path) == 0
    verbs = {c[0] for c in calls if c}
    assert not verbs & {"push", "fetch", "pull", "clone", "ls-remote", "remote"}


# ----------------------------------------------------- who gets a worktree


def test_a_read_only_model_runs_in_place(repo: Path, tmp_path: Path, fake, capsys):
    fake.WRITES = {}
    assert run_cli(repo, tmp_path, "--model", "senses") == 0
    payload = json.loads(capsys.readouterr().out)
    assert fake.seen["checkout"] == str(repo.resolve())
    assert "worktree" not in payload
    assert not root_of(repo).exists()


def test_a_mutating_run_on_a_non_git_checkout_runs_in_place_with_a_warning(
    tmp_path: Path, fake, capsys
):
    plain = tmp_path / "plain"
    plain.mkdir()
    assert run_cli(plain, tmp_path) == 0
    captured = capsys.readouterr()
    assert fake.seen["checkout"] == str(plain.resolve())
    assert "not a git" in captured.err
    assert json.loads(captured.out)["isolation"] == "in-place"


def test_without_git_a_git_checkout_is_refused(repo: Path, monkeypatch):
    monkeypatch.setattr(wt.shutil, "which", lambda name: None)
    with pytest.raises(wt.WorktreeError) as caught:
        wt.create_run_worktree(repo, "abc")
    assert not isinstance(caught.value, wt.NotAGitRepository)


def test_without_git_a_plain_directory_is_not_a_repository(tmp_path: Path, monkeypatch):
    plain = tmp_path / "plain"
    plain.mkdir()
    monkeypatch.setattr(wt.shutil, "which", lambda name: None)
    with pytest.raises(wt.NotAGitRepository):
        wt.create_run_worktree(plain, "abc")
