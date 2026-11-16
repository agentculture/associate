# Cited into this repo from qodo-cli tests/bridge/test_filetokens.py @
#  9ac0a9c4f1d7a93507ccc15295f565123025e1e1
# (cite-don't-import: this repo owns its copy.) Adapted: imports are associate.bridge.*.
"""The file-backed token store: one 0600 JSON file, hashes only, safe under concurrent writers."""

from __future__ import annotations

import json
import multiprocessing
import os
import stat

import pytest

from associate.bridge.filetokens import FileTokenStore
from associate.bridge.tokens import SERVICE_TOKENS, ServiceTokens


def _tokens(path) -> ServiceTokens:
    return ServiceTokens(FileTokenStore(path), prefix="tst_")


def test_an_issued_token_authenticates_through_a_new_store_object(tmp_path):
    path = tmp_path / "state" / "tokens.json"
    issued = _tokens(path).issue("admin", name="ci", roles=["viewer"])
    principal = _tokens(path).authenticate(issued.token)
    assert principal is not None and principal.identity == "ci"
    assert principal.roles == {"viewer"}


def test_the_file_is_0600_in_a_0700_directory_and_holds_only_hashes(tmp_path):
    path = tmp_path / "state" / "tokens.json"
    issued = _tokens(path).issue("admin", name="ci", roles=["editor"])
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    text = path.read_text(encoding="utf-8")
    secret = issued.token.split(".", 1)[1]
    assert secret not in text and issued.token not in text
    doc = json.loads(text)[SERVICE_TOKENS][issued.id]
    assert len(doc["hash"]) == 64


def test_revoke_persists_and_the_token_stops_working(tmp_path):
    path = tmp_path / "tokens.json"
    issued = _tokens(path).issue("admin", name="ci", roles=["viewer"])
    _tokens(path).revoke(issued.id, "admin")
    assert _tokens(path).authenticate(issued.token) is None
    assert [t["id"] for t in _tokens(path).list()] == [issued.id]
    assert _tokens(path).list()[0]["revoked_at"]


def test_a_corrupt_file_is_an_error_not_an_empty_store(tmp_path):
    path = tmp_path / "tokens.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        _tokens(path).list()


def test_a_file_that_is_not_an_object_is_an_error(tmp_path):
    path = tmp_path / "tokens.json"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(ValueError, match="not a JSON object"):
        _tokens(path).list()


def test_a_missing_file_is_an_empty_store_and_reading_creates_nothing(tmp_path):
    path = tmp_path / "nope" / "tokens.json"
    assert _tokens(path).list() == []
    assert _tokens(path).authenticate("tst_a.b") is None
    assert not path.parent.exists()


def test_the_file_is_never_left_group_or_world_readable_after_a_write(tmp_path):
    path = tmp_path / "tokens.json"
    _tokens(path).issue("admin", name="a", roles=["viewer"])
    os.chmod(path, 0o644)  # someone loosened it; the next write tightens it again
    _tokens(path).issue("admin", name="b", roles=["viewer"])
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def _issue_many(args):
    path, n = args
    for i in range(n):
        _tokens(path).issue("admin", name=f"t{os.getpid()}-{i}", roles=["viewer"])


def test_concurrent_issuers_lose_no_write(tmp_path):
    path = tmp_path / "tokens.json"
    with multiprocessing.get_context("spawn").Pool(4) as pool:
        pool.map(_issue_many, [(path, 5)] * 4)
    assert len(_tokens(path).list()) == 20
