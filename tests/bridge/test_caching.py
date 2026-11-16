"""Cache policy: every response carries a Cache-Control header, no-store by default."""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from associate.bridge.caching import ASSET, NO_STORE, SHELL, NoStoreByDefault  # noqa: E402


@pytest.fixture
def client():
    app = FastAPI()

    @app.get("/plain")
    def plain():
        return {"a": 1}

    @app.get("/own")
    def own():
        return JSONResponse({"a": 1}, headers={"Cache-Control": SHELL})

    app.add_middleware(NoStoreByDefault)
    return TestClient(app)


def test_a_response_without_a_policy_is_no_store(client):
    assert client.get("/plain").headers["cache-control"] == NO_STORE
    assert client.get("/missing").headers["cache-control"] == NO_STORE


def test_an_explicit_policy_is_kept(client):
    assert client.get("/own").headers["cache-control"] == SHELL


def test_constants():
    assert NO_STORE == "no-store"
    assert "no-cache" in SHELL and "private" in SHELL
    assert "immutable" in ASSET and "private" in ASSET
