"""The start body is capped while it is read, not after (review finding 2).

A body sent without ``Content-Length`` (chunked) or with one that lies must never be buffered
whole: the app reads the stream and stops as soon as the running total passes
``MAX_BODY_BYTES`` (413, nothing parsed, nothing started). A declared length over the cap is
refused before anything is read. The ASGI app is driven directly (``tests/rawasgi.py``) so the
test can count the body chunks the app pulled.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from associate.bridge.filetokens import FileTokenStore  # noqa: E402
from associate.bridge.tokens import ServiceTokens  # noqa: E402
from associate.runs.service import RunsConfig  # noqa: E402
from associate.server.app import MAX_BODY_BYTES, TOKEN_PREFIX, create_app  # noqa: E402
from tests.rawasgi import raw_stream  # noqa: E402
from tests.test_runs import fake, make_repo  # noqa: E402

CHUNK = 64 * 1024
#: the most chunks a capped read may pull: the cap's worth, plus the one that passes it
MOST_PULLED = MAX_BODY_BYTES // CHUNK + 1


@pytest.fixture
def setup(tmp_path: Path):
    roots = tmp_path / "roots"
    roots.mkdir()
    cfg = RunsConfig(state_dir=tmp_path / "state", allowed_roots=(roots,))
    repo = make_repo(roots / "repo")
    tokens = ServiceTokens(FileTokenStore(tmp_path / "tokens.json"), prefix=TOKEN_PREFIX)
    admin = tokens.issue("test", name="ops", roles=["admin"]).token
    app = create_app(tokens=tokens, runs_config=cfg, child_command=fake("plain"), web_dist=None)
    headers = {"Authorization": f"Bearer {admin}", "Content-Type": "application/json"}
    return app, cfg, repo, headers


def started(cfg: RunsConfig) -> list[Path]:
    runs = cfg.state_dir / "runs"
    return sorted(runs.iterdir()) if runs.is_dir() else []


def chunks_of(data: bytes) -> list[bytes]:
    return [data[i : i + CHUNK] for i in range(0, len(data), CHUNK)]


def big_body(repo: Path, total: int) -> bytes:
    """A valid start body padded (inside the instruction) to ``total`` bytes."""
    body = {"checkout": str(repo), "model": "worker", "test_commands": ["true"]}
    head = json.dumps(body)[:-1] + ', "instruction": "'
    return (head + "x" * (total - len(head) - 2) + '"}').encode()


def test_a_chunked_body_over_the_cap_is_413_after_at_most_the_cap_plus_one_chunk(setup):
    app, cfg, repo, headers = setup
    chunks = chunks_of(big_body(repo, 4 * 1024 * 1024))
    reply = raw_stream(app, "POST", "/runs", {**headers, "Transfer-Encoding": "chunked"}, chunks)
    assert reply.status_code == 413, reply.text
    assert json.loads(reply.content)["code"] == "body_too_large"
    assert reply.pulled <= MOST_PULLED < len(chunks)
    assert started(cfg) == []


def test_a_chunked_body_under_the_cap_is_read_whole_and_starts_the_run(setup):
    app, cfg, repo, headers = setup
    body = json.dumps(
        {
            "checkout": str(repo),
            "model": "worker",
            "instruction": "x" * 1000,
            "test_commands": ["true"],
        }
    ).encode()
    chunks = [body[i : i + 100] for i in range(0, len(body), 100)]
    reply = raw_stream(app, "POST", "/runs", {**headers, "Transfer-Encoding": "chunked"}, chunks)
    assert reply.status_code == 202, reply.text
    assert reply.pulled == len(chunks)
    assert len(started(cfg)) == 1


def test_a_content_length_smaller_than_the_body_is_still_bounded(setup):
    app, cfg, repo, headers = setup
    chunks = chunks_of(big_body(repo, 4 * 1024 * 1024))
    reply = raw_stream(app, "POST", "/runs", {**headers, "Content-Length": "100"}, chunks)
    assert reply.status_code == 413, reply.text
    assert reply.pulled <= MOST_PULLED
    assert started(cfg) == []


def test_a_declared_length_over_the_cap_is_refused_before_reading(setup):
    app, cfg, repo, headers = setup
    chunks = chunks_of(big_body(repo, MAX_BODY_BYTES + CHUNK))
    declared = {**headers, "Content-Length": str(MAX_BODY_BYTES + CHUNK)}
    reply = raw_stream(app, "POST", "/runs", declared, chunks)
    assert reply.status_code == 413, reply.text
    assert reply.pulled == 0
    assert started(cfg) == []


def test_a_body_of_exactly_the_cap_is_read(setup):
    app, _cfg, repo, headers = setup
    chunks = chunks_of(big_body(repo, MAX_BODY_BYTES))
    reply = raw_stream(app, "POST", "/runs", {**headers, "Transfer-Encoding": "chunked"}, chunks)
    # read whole and parsed: the run is refused for its instruction's length, not the body's
    assert reply.status_code == 400, reply.text
    assert "instruction" in json.loads(reply.content)["message"]
