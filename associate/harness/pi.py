"""The Pi adapter — a fail-closed launcher over the ``pi`` binary.

**Subprocess only.** This module runs the installed ``pi`` executable and reads
its ``--mode json`` event stream (pi ``docs/json.md``). It imports no pi
package, and the unrelated PyPI distribution that happens to be named
``pi-coding-agent`` is never installed: spec claim c13 makes driving Pi a
*process* boundary, which is what keeps ``dependencies = []`` true.

How readiness is decided (c34, honesty condition h26)
-----------------------------------------------------
h26 pins the mechanism: the check is made **from the tool list Pi reports**,
never from trusting that ``.pi/settings.json`` or the extension directory
exists on disk. Pi 0.84.2 offers no ``--list-tools``, and its JSON event stream
carries no startup tool inventory — the session header is
``{"type":"session",…}`` and nothing else precedes the first turn. The only
list Pi reports is therefore the one the extension's ``associate_ready``
sentinel returns, so this adapter drives one turn ("call ``associate_ready``,
then ``finish``") and reads the report off the ``tool_execution_end`` event.

Two things are checked on that report, and the distinction is measured, not
guessed (risk r14, against pi 0.84.2): ``defaultTools: []`` narrows the
**active** tool set while ``pi.getAllTools()`` still lists
``read``/``bash``/``edit``/``write``/``grep``/``find``/``ls``. So the gate is

* ``associate_ready`` present in ``active_tools`` — the extension loaded;
* ``writer_tools_active`` empty — no write path was offered.

The full ``tools`` list is reported for the record and is never a failure.

Ancestor context files (risk r16)
---------------------------------
Pi loads ``AGENTS.md``/``CLAUDE.md`` from every ancestor directory, so a
workspace-level ``CLAUDE.md`` one level above a checkout would leak into the
system prompt of a run examining that checkout. The launcher passes
``--no-context-files`` and sets ``ASSOCIATE_INJECT_PROMPT=1``, which the
extension's ``lib/prompt.ts`` answers by injecting the checkout's own
``AGENTS.md`` — the runtime prompt for this lane — and nothing else.

Version pin (c39)
-----------------
``pi`` is pinned exactly at the tested 0.84.2. A different version **warns on
stderr naming the tested one and still runs**: refusing on a version number
alone would make the harness unusable the day pi ships a patch, and the
behavioural evidence is what the bench is for.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess  # nosec B404 - fixed argv, shell=False; the whole point of c13
import sys
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from associate import contract
from associate.contract import validate
from associate.harness.base import (
    STATEMENTS_FILENAME,
    STATEMENTS_MD_FILENAME,
    WALK_FILENAME,
    ExtensionNotLoadedError,
    Harness,
    HarnessError,
)

__all__ = [
    "PiHarness",
    "PINNED_PI_VERSION",
    "SENTINEL_TOOL",
    "READINESS_PROMPT",
    "resolve_export_root",
    "sanitize_session_id",
    "generate_session_id",
]

#: The tested pi version (CLAUDE.md, "The Pi harness floors"; spec c39).
PINNED_PI_VERSION = "0.84.2"

#: The tool whose presence in the reported active tool list proves the load.
SENTINEL_TOOL = "associate_ready"

#: Default export root name when the contract names none — mirrors
#: ``lib/session.ts``'s ``DEFAULT_EXPORT_ROOT_NAME`` so both sides agree.
DEFAULT_EXPORT_ROOT_NAME = ".associate-runs"

#: The lobes gateway; the same documented default ``lib/provider.ts`` carries.
DEFAULT_BASE_URL = "http://localhost:8001/v1"

#: The first (and, for a readiness probe, only) turn.
READINESS_PROMPT = (
    "Call the associate_ready tool to confirm the extension is loaded, then call "
    "finish with a one-line summary of what it reported. Do nothing else."
)

_UNSAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")
_LEADING_JUNK = re.compile(r"^[.-]+")


def _warn(line: str) -> None:
    """Diagnostics go to stderr; stdout carries results only."""
    sys.stderr.write(line if line.endswith("\n") else line + "\n")


# ---------------------------------------------------------------- session ids


def sanitize_session_id(raw: str) -> str:
    """Make an arbitrary id safe as one path segment (mirrors ``lib/session.ts``).

    An ACP session id is an opaque string; a ``/`` or ``..`` in one must not be
    able to redirect the export directory.
    """
    cleaned = _LEADING_JUNK.sub("", _UNSAFE_SEGMENT.sub("-", raw.strip()))[:96]
    return cleaned or generate_session_id()


def generate_session_id() -> str:
    """A sortable, unique id: UTC stamp plus randomness (mirrors ``lib/session.ts``)."""
    from datetime import datetime, timezone
    from secrets import token_hex

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{token_hex(4)}"


# --------------------------------------------------------------- export roots


def resolve_export_root(checkout: Path | str, override: str | None = None) -> Path:
    """Where this run's session directory is created.

    Precedence mirrors ``lib/session.ts`` exactly, so the Python side and the
    extension never disagree about where an artifact landed: an explicit
    override (``--export-root``) wins, then the contract's ``export.root``,
    then ``export.root_name`` beside the checkout, then ``.associate-runs``
    beside the checkout.

    Raises ``ValueError`` when the result would land inside the examined
    checkout while the contract says ``export.outside_examined_checkout`` — a
    silent relocation would put the artifacts somewhere nobody is looking.
    """
    root_of_checkout = Path(checkout).resolve()
    export_policy = contract.load_policy().get("export", {})

    if override and override.strip():
        root = Path(override.strip()).expanduser().resolve()
    elif isinstance(export_policy.get("root"), str) and export_policy["root"].strip():
        root = (root_of_checkout / export_policy["root"].strip()).resolve()
    else:
        name = export_policy.get("root_name")
        name = name.strip() if isinstance(name, str) and name.strip() else DEFAULT_EXPORT_ROOT_NAME
        root = (root_of_checkout.parent / name).resolve()

    if export_policy.get("outside_examined_checkout") is True and _is_inside(
        root_of_checkout, root
    ):
        raise ValueError(
            f"export root {root} is inside the examined checkout {root_of_checkout}, but the "
            "contract's export.outside_examined_checkout is true"
        )
    return root


def _is_inside(parent: Path, child: Path) -> bool:
    return child == parent or parent in child.parents


# ------------------------------------------------------------- event stream


def parse_events(stdout: str) -> list[dict[str, Any]]:
    """Every well-formed JSON line of a ``pi --mode json`` stream.

    A partial or non-JSON line is not an event and is dropped rather than
    raising: pi interleaves nothing on stdout today, but a launcher that dies
    on an unexpected line would be trading a working run for a cosmetic one.
    """
    events: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def sentinel_report(events: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """The ``associate_ready`` report Pi reported, or ``None`` if it never did."""
    for event in events:
        if event.get("type") != "tool_execution_end":
            continue
        if event.get("toolName") != SENTINEL_TOOL:
            continue
        result = event.get("result")
        if not isinstance(result, dict):
            continue
        details = result.get("details")
        if isinstance(details, dict):
            return details
        # Fall back to the text content, which carries the same JSON object.
        for block in result.get("content") or []:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                try:
                    parsed = json.loads(block["text"])
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    return parsed
    return None


# --------------------------------------------------------------- the adapter


class PiHarness(Harness):
    """Run one associate task on the installed ``pi`` binary."""

    name = "pi"

    def __init__(
        self,
        *,
        prompt: str | None = None,
        continue_from: str | None = None,
        timeout: float = 900.0,
        executable: str | None = None,
        env: dict[str, str] | None = None,
        warn: Callable[[str], None] | None = None,
    ) -> None:
        self._prompt = prompt
        self._continue_from = continue_from
        self._timeout = timeout
        self._executable = executable
        self._base_env = dict(env) if env is not None else None
        self._warn = warn if warn is not None else _warn

        self._checkout: Path | None = None
        self._contract_dir: Path | None = None
        self._session_id: str | None = None
        self._export_root: Path | None = None
        self._result: dict[str, Any] | None = None

    # -- lifecycle ---------------------------------------------------------

    def start(
        self,
        checkout: Path,
        contract_dir: Path,
        session_id: str,
        export_dir: Path,
    ) -> None:
        """Bind this adapter to one run.

        ``export_dir`` is the **export root** for the Pi adapter, not the
        session's own directory: the extension owns the layout below it
        (``<root>/<session id>/export``, spec c42) and computes it from
        ``$ASSOCIATE_EXPORT_ROOT``. Handing pi a pre-keyed directory instead
        would mean two implementations of the same path rule.
        """
        self._checkout = Path(checkout).resolve()
        self._contract_dir = Path(contract_dir).resolve()
        self._session_id = sanitize_session_id(session_id)
        self._export_root = Path(export_dir).resolve()
        self._export_root.mkdir(parents=True, exist_ok=True)
        self._result = None

    @property
    def export_dir(self) -> Path:
        """``<export root>/<session id>/export`` — where the artifacts land."""
        if self._export_root is None or self._session_id is None:
            raise HarnessError("PiHarness.export_dir read before start()")
        return self._export_root / self._session_id / "export"

    def submit(self, task: dict[str, Any]) -> None:
        if self._checkout is None or self._session_id is None:
            raise HarnessError("PiHarness.submit() called before start()")
        validate.assert_valid(task, contract.load_schema("task"))

        executable = self._resolve_executable()
        self._check_version(executable)

        prompt = self._prompt or task.get("prompt") or READINESS_PROMPT
        argv = [executable, *self.pi_arguments(), prompt]
        env = self.environment(task)

        try:
            completed = subprocess.run(  # nosec B603 - fixed argv, shell=False
                argv,
                capture_output=True,
                text=True,
                cwd=str(self._checkout),
                env=env,
                # The recorded gotcha: pi blocks reading an inherited stdin in
                # print mode, so it is closed rather than passed through.
                stdin=subprocess.DEVNULL,
                timeout=self._timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as err:
            raise HarnessError(
                f"pi did not finish within {self._timeout:g}s",
                remediation="raise --timeout, or check that the configured lane is reachable",
            ) from err
        except OSError as err:
            raise HarnessError(
                f"could not run {executable}: {err}",
                remediation="install pi and make sure it is on PATH",
            ) from err

        events = parse_events(completed.stdout)
        report = sentinel_report(events)
        self._assert_ready(report, completed)

        export_dir = self.export_dir
        self._result = {
            "walk_path": str(export_dir / WALK_FILENAME),
            "statements_path": str(export_dir / STATEMENTS_FILENAME),
            "statements_md_path": str(export_dir / STATEMENTS_MD_FILENAME),
            "export_dir": str(export_dir),
            "outcome": self._outcome(export_dir / WALK_FILENAME),
            "session_id": self._session_id,
            "extension_version": report.get("extension_version"),
            "contract_version": report.get("contract_version"),
            "active_tools": list(report.get("active_tools") or []),
        }

    def collect(self) -> dict[str, Any]:
        if self._result is None:
            raise HarnessError("PiHarness.collect() called before submit()")
        return dict(self._result)

    # -- what pi is told ---------------------------------------------------

    def pi_arguments(self) -> list[str]:
        """The flags every associate run passes, and why each one is there.

        * ``-p --mode json`` — headless, with the event stream the sentinel is
          read from.
        * ``--no-session`` — a scout seat leaves no session file behind; pi
          persists tool output into sessions (spec s18) and a read-only lane
          should not accumulate a transcript store.
        * ``--approve`` — headless modes skip the project-trust prompt and
          would otherwise ignore ``.pi/extensions`` entirely, which is the
          exact fail-open c34 exists to close.
        * ``--no-context-files`` — risk r16: ancestor ``CLAUDE.md``/``AGENTS.md``
          files would leak into the system prompt.
        """
        args = ["-p", "--mode", "json", "--no-session", "--approve", "--no-context-files"]
        provider = self._provider_arguments()
        if provider:
            args.extend(provider)
        return args

    def _provider_arguments(self) -> list[str]:
        """``--provider``/``--model`` only when a key configures the lane.

        With no ``ASSOCIATE_API_KEY`` the extension registers no provider at
        all (``lib/provider.ts``), so naming it here would fail the run outright.
        pi's own default provider applies instead, and the launcher says so
        rather than leaving the operator to infer which model answered.
        """
        env = self._base_env if self._base_env is not None else os.environ
        if not (env.get("ASSOCIATE_API_KEY") or "").strip():
            self._warn(
                "associate: ASSOCIATE_API_KEY is unset, so no associate provider is "
                "registered and pi's own default model applies to this run."
            )
            return []
        model = (env.get("ASSOCIATE_MODEL") or "associate").strip() or "associate"
        return ["--provider", "associate", "--model", model]

    def environment(self, task: dict[str, Any]) -> dict[str, str]:
        """The environment handed to pi. No secret is read, written or logged."""
        if self._contract_dir is None or self._export_root is None or self._session_id is None:
            raise HarnessError("PiHarness.environment() called before start()")

        env = dict(self._base_env if self._base_env is not None else os.environ)
        env["ASSOCIATE_CONTRACT_DIR"] = str(self._contract_dir)
        env["ASSOCIATE_SESSION_ID"] = self._session_id
        env["ASSOCIATE_EXPORT_ROOT"] = str(self._export_root)
        # r16: context-file discovery is off, so the runtime prompt is injected
        # by the extension from the checkout's own AGENTS.md instead.
        env["ASSOCIATE_INJECT_PROMPT"] = "1"

        continue_from = self._continue_from or task.get("continue_from")
        if continue_from:
            env["ASSOCIATE_CONTINUE_FROM"] = str(continue_from)
        else:
            env.pop("ASSOCIATE_CONTINUE_FROM", None)
        return env

    # -- checks ------------------------------------------------------------

    def _resolve_executable(self) -> str:
        executable = self._executable or shutil.which("pi")
        if executable is None:
            raise HarnessError(
                "pi is not on PATH, so the associate lane cannot be launched",
                remediation=(
                    f"install @earendil-works/pi-coding-agent {PINNED_PI_VERSION} "
                    "(the tested pin), or pass --harness stub for a plumbing-only run"
                ),
            )
        return executable

    def _check_version(self, executable: str) -> str | None:
        """Warn on a version other than the pin; never refuse on one (c39)."""
        try:
            completed = subprocess.run(  # nosec B603 - fixed argv, shell=False
                [executable, "--version"],
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):  # pragma: no cover - env dependent
            self._warn(f"associate: could not read `pi --version`; tested pin {PINNED_PI_VERSION}")
            return None

        lines = (completed.stdout or completed.stderr).strip().splitlines()
        found = lines[0].strip() if lines else ""
        if found and found != PINNED_PI_VERSION:
            self._warn(
                f"associate: pi {found} is installed; this harness was tested against "
                f"{PINNED_PI_VERSION}. Running anyway — a pin is bumped only after "
                "`associate bench` passes on the new version."
            )
        return found or None

    def _assert_ready(
        self, report: dict[str, Any] | None, completed: subprocess.CompletedProcess[str]
    ) -> None:
        """Fail closed unless Pi itself reported a loaded, writer-free extension."""
        if report is None:
            tail = (completed.stderr or "").strip().splitlines()[-3:]
            if tail:
                self._warn("associate: pi stderr tail: " + " | ".join(tail))
            raise ExtensionNotLoadedError(
                f"pi never reported the {SENTINEL_TOOL} tool, so the associate extension "
                "did not load and the run is refused",
                remediation=(
                    "run from a checkout containing .pi/extensions/associate, keep --approve "
                    "(headless pi ignores project extensions on an untrusted checkout), and "
                    "check that the configured lane can complete one turn"
                ),
            )

        active = [str(name) for name in report.get("active_tools") or []]
        if SENTINEL_TOOL not in active:
            raise ExtensionNotLoadedError(
                f"{SENTINEL_TOOL} is not in the active tool list pi reported: "
                f"{', '.join(active) or '(none)'}",
                remediation="check the extension's defaultTools and any --tools/-t filter",
            )

        writers = [str(name) for name in report.get("writer_tools_active") or []]
        if writers:
            raise ExtensionNotLoadedError(
                "pi reported active writer tools, which the associate role forbids: "
                + ", ".join(writers),
                remediation=(
                    "the lane is read-only (lobes `worker` minus `repo_action`); remove the "
                    "write tools from the extension's active set before serving"
                ),
            )

    @staticmethod
    def _outcome(walk_path: Path) -> str:
        """The run outcome the walk recorded, or ``unknown`` when it recorded none."""
        try:
            lines = walk_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return "unknown"
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            run = record.get("run") if isinstance(record, dict) else None
            if isinstance(run, dict) and isinstance(run.get("outcome"), str):
                return run["outcome"]
        return "unknown"

    # -- bench support -----------------------------------------------------

    def served_model_id(self) -> str | None:
        """What the configured endpoint calls the model it is serving.

        Read by ``associate/bench/config.py`` so a bench row names the actual
        checkpoint behind the ``associate`` *role*. Returns ``None`` on any
        failure — a bench row is not worth an exception — and the bearer, if
        one is set, is sent as a header and never printed anywhere.
        """
        import urllib.error
        import urllib.request

        env = self._base_env if self._base_env is not None else os.environ
        base = (env.get("ASSOCIATE_BASE_URL") or DEFAULT_BASE_URL).strip().rstrip("/")
        url = f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"

        # The scheme is checked before a Request is built, so no file:// or
        # custom-scheme base URL can be opened by this probe.
        if not url.startswith(("http://", "https://")):
            return None

        request = urllib.request.Request(url, method="GET")  # nosec B310
        key = (env.get("ASSOCIATE_API_KEY") or "").strip()
        if key:
            request.add_header("Authorization", f"Bearer {key}")

        try:
            with urllib.request.urlopen(request, timeout=5) as response:  # nosec B310
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, ValueError, urllib.error.URLError):
            return None

        data = payload.get("data") if isinstance(payload, dict) else None
        if isinstance(data, Sequence):
            for entry in data:
                if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]:
                    return entry["id"]
        return None
