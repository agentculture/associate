"""Exercises the fake OpenAI-compatible lane server (tests/fake_lane.py).

Covers t4 acceptance criterion 2: the fake server answers a chat completion
with a scripted tool_calls structure and is used by at least one pytest.

The base URL comes only from the ``fake_lane`` fixture's return value, never
from an environment variable — see conftest.py and CLAUDE.md's constraint
that no test may read an endpoint or bearer from the environment to pass.
"""

from __future__ import annotations

import json
import urllib.request


def _post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def test_models_lists_associate(fake_lane):
    data = _get_json(f"{fake_lane.base_url}/v1/models")
    ids = [entry["id"] for entry in data["data"]]
    assert ids == ["associate"]


def test_chat_completions_returns_scripted_tool_calls(fake_lane):
    response = _post_json(
        f"{fake_lane.base_url}/v1/chat/completions",
        {
            "model": "associate",
            "messages": [{"role": "user", "content": "read the readme"}],
        },
    )

    choice = response["choices"][0]
    assert choice["finish_reason"] == "tool_calls"

    tool_calls = choice["message"]["tool_calls"]
    assert len(tool_calls) == 1
    call = tool_calls[0]
    assert call["type"] == "function"
    assert call["function"]["name"] == "read"
    assert json.loads(call["function"]["arguments"]) == {"path": "README.md"}


def test_chat_completions_records_the_request_body(fake_lane):
    _post_json(
        f"{fake_lane.base_url}/v1/chat/completions",
        {"model": "associate", "messages": [{"role": "user", "content": "hi"}]},
    )

    assert len(fake_lane.requests.chat_completions) == 1
    assert fake_lane.requests.chat_completions[0]["model"] == "associate"


def test_custom_tool_calls_are_scriptable():
    from tests.fake_lane import FakeLaneServer

    custom_calls = [
        {
            "id": "call_1",
            "type": "function",
            "function": {"name": "grep", "arguments": json.dumps({"pattern": "TODO"})},
        }
    ]
    server = FakeLaneServer(tool_calls=custom_calls)
    server.start()
    try:
        response = _post_json(
            f"{server.base_url}/v1/chat/completions",
            {"model": "associate", "messages": []},
        )
        call = response["choices"][0]["message"]["tool_calls"][0]
        assert call["function"]["name"] == "grep"
    finally:
        server.stop()
