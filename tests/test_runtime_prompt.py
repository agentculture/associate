"""Acceptance tests for the runtime prompt and the mesh cutover.

Covers t13 / claims c9, c11, c41: with ``backend: acp`` the Pi-facing runtime
prompt is ``AGENTS.md`` (Pi loads ``AGENTS.md`` *or* ``CLAUDE.md``, and
``CLAUDE.md`` here is the Claude Code session prompt, not the lane prompt), and
``culture.yaml`` launches the lane through ``pi-acp``.

Stdlib only — the package declares no runtime dependencies, so ``culture.yaml``
is read with the same hand-parsing discipline the CLI uses rather than a YAML
library.
"""

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
AGENTS_MD = REPO_ROOT / "AGENTS.md"
CULTURE_YAML = REPO_ROOT / "culture.yaml"

# The tools the extension registers: the two core tools from index.ts plus the
# tool modules loaded from `tools/`. AGENTS.md must name the set the model is
# actually offered, and nothing it is not.
EXPECTED_TOOLS = (
    "associate_ready",
    "finish",
    "read",
    "find",
    "grep",
    "ls",
    "bash",
    "code_lens",
    "web_search",
    "web_page",
)


def _agents_md() -> str:
    return AGENTS_MD.read_text(encoding="utf-8")


def _culture_yaml() -> str:
    return CULTURE_YAML.read_text(encoding="utf-8")


def _agent_backend() -> str:
    """The first agent block's ``backend``, parsed without a YAML dependency."""
    seen = False
    for line in _culture_yaml().splitlines():
        stripped = line.strip()
        if stripped.startswith(("- suffix:", "suffix:")):
            if seen:
                break
            seen = True
        elif seen and stripped.startswith("backend:"):
            return stripped.partition("backend:")[2].strip().strip("'\"")
    return ""


def _acp_command() -> list:
    """The first agent block's ``acp_command``, as a JSON flow sequence.

    ``culture_core.config.AgentConfig.acp_command`` reads this key out of the
    agent's ``extras`` (default ``["opencode", "acp"]``), so it must be a list.
    It is written as a YAML flow sequence, which is also valid JSON.
    """
    match = re.search(r"^\s*acp_command:\s*(\[.*\])\s*$", _culture_yaml(), re.MULTILINE)
    assert match, "culture.yaml declares no acp_command flow sequence"
    return json.loads(match.group(1))


# --- AGENTS.md is the runtime prompt -------------------------------------


def test_agents_md_exists_and_is_not_empty():
    assert AGENTS_MD.is_file(), "AGENTS.md is the acp backend's runtime prompt"
    assert len(_agents_md().strip()) > 400


def test_agents_colleague_md_still_present():
    """c41: both prompt files coexist through the transition, so the cutover
    commit is a single clean ``git revert``."""
    assert (REPO_ROOT / "AGENTS.colleague.md").is_file()


def test_agents_md_names_every_forbidden_token():
    """The lobes bound, stated verbatim from the portable contract."""
    role = json.loads((REPO_ROOT / "associate" / "contract" / "role.json").read_text("utf-8"))
    text = _agents_md()
    forbidden = role["forbidden"]
    assert forbidden, "role.json declares no forbidden tokens"
    for token in forbidden:
        assert token in text, f"AGENTS.md does not name the forbidden token {token!r}"


def test_agents_md_names_the_tool_set():
    text = _agents_md()
    for tool in EXPECTED_TOOLS:
        assert tool in text, f"AGENTS.md does not name the tool {tool!r}"


def test_agents_md_states_the_evidence_marker_convention():
    """c25: every statement carries the walk ids it rests on; a statement with
    none is flagged unreferenced."""
    text = _agents_md()
    assert re.search(r"\bw1\b", text), "AGENTS.md does not show a walk id"
    assert "unreferenced" in text.lower()
    assert "evidence" in text.lower()


def test_agents_md_states_the_handback_and_the_out_of_bound_answer():
    text = _agents_md()
    assert "finish" in text
    lowered = text.lower()
    assert "cannot" in lowered or "can't" in lowered


def test_agents_md_says_the_final_message_restates_the_summary():
    """Deviation d9: the mesh relays chat text, so finish alone delivers nothing."""
    text = _agents_md().lower()
    assert "final message" in text
    assert "no tool call is allowed after" in text


def test_agents_md_stays_short():
    """Pi's discipline (c50): a tiny always-on surface, skills on demand."""
    assert len(_agents_md()) <= 6000


# --- the mesh cutover -----------------------------------------------------


def test_culture_yaml_declares_the_acp_backend():
    assert _agent_backend() == "acp"


def test_culture_yaml_launches_pi_acp():
    command = _acp_command()
    assert isinstance(command, list), "acp_command must be a non-empty list"
    assert command, "acp_command must be a non-empty list"
    assert command[0] == "pi-acp"


def test_backend_maps_to_the_prompt_file_on_disk():
    """The backend-consistency invariant, checked here as well as in doctor."""
    from associate.cli._commands.doctor import _PROMPT_FILE

    expected = _PROMPT_FILE[_agent_backend()]
    assert expected == "AGENTS.md"
    assert (REPO_ROOT / expected).is_file()
