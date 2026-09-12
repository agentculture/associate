"""The Pi adapter — a fail-closed launcher over the ``pi`` binary.

**Subprocess only.** This module runs the installed ``pi`` executable and reads
its ``--mode json`` event stream (pi ``docs/json.md``). It imports no pi
package, and the unrelated PyPI distribution that happens to be named
``pi-coding-agent`` is never installed: spec claim c13 makes driving Pi a
*process* boundary, which is what keeps ``dependencies = []`` true.

How readiness is decided (c34, honesty condition h26, deviation d8)
-------------------------------------------------------------------
h26 pins the mechanism: the check is made **from the tool list Pi reports**,
never from trusting that ``.pi/settings.json`` or the extension directory
exists on disk. Pi 0.84.2 offers no ``--list-tools``, and its JSON event stream
carries no startup tool inventory — the session header is
``{"type":"session",…}`` and nothing else precedes the first turn.

The first implementation read that list off an ``associate_ready`` tool result
in the task's own turn, which made the proof depend on the *model* choosing to
call the sentinel: measured on the live lane on 2026-09-12, a model handed real
work went straight to the work and a perfectly healthy run was refused.
Deviation d8 moves the proof off the model. Every run is now two pi
invocations:

1. a **preflight** — the same argv plus ``-e lib/preflight.ts``, an extension
   whose only handler ends the process on ``before_agent_start``. Pi fires
   ``session_start`` at startup, where the associate extension writes the same
   report the sentinel returns to ``<export dir>/ready.json``; the preflight
   then exits before a single provider request. No ``ready.json`` means the
   extension did not load, and the run is refused right there;
2. the **task turn**, unchanged, run only once that report passed the gate.

The extension is also passed explicitly with ``-e <index.ts>`` in *both*, so
the lane travels with the launcher instead of depending on the examined
checkout carrying its own ``.pi/`` — the second half of d8.

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

import hashlib
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
    "READY_REPORT_FILENAME",
    "resolve_export_root",
    "resolve_extension_path",
    "sanitize_session_id",
    "generate_session_id",
    "stderr_tail",
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

#: What the extension writes into the export directory on ``session_start``.
READY_REPORT_FILENAME = "ready.json"

#: Where the extension lives inside a checkout, relative to the repo root.
EXTENSION_RELATIVE_PATH = Path(".pi") / "extensions" / "associate" / "index.ts"

#: The preflight extension, beside the entry point it accompanies.
PREFLIGHT_RELATIVE_PATH = Path("lib") / "preflight.ts"

#: Overrides the resolved entry point — an installed copy, or a fork's.
EXTENSION_PATH_ENV = "ASSOCIATE_EXTENSION_PATH"

#: A preflight loads extensions and exits; it must never wait a full task budget.
PREFLIGHT_TIMEOUT = 60.0

_UNSAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")
_LEADING_JUNK = re.compile(r"^[.-]+")

#: The longest a sanitized session id may be — one path segment on every
#: filesystem this lane runs on. Mirrors ``lib/session.ts``'s own constant.
MAX_SESSION_ID_LENGTH = 96

#: Hex characters of the disambiguating digest appended to a rewritten id.
SESSION_ID_DIGEST_LENGTH = 8

#: What is left for the cleaned stem: 87 + "-" + 8 == 96.
_SESSION_ID_STEM_LENGTH = MAX_SESSION_ID_LENGTH - SESSION_ID_DIGEST_LENGTH - 1

#: How many stderr lines a failure message may quote back.
_STDERR_TAIL_LINES = 3


def _warn(line: str) -> None:
    """Diagnostics go to stderr; stdout carries results only."""
    sys.stderr.write(line if line.endswith("\n") else line + "\n")


def _redact(text: str) -> str:
    """Apply the contract's redaction patterns to *text*.

    Anything quoted back out of pi's stderr passes through here first: a
    launcher that helpfully pasted the last three lines of a failed run into an
    error message is a launcher that can paste a bearer token into a log. The
    patterns are the contract's (``policy.json``'s ``redaction``), never a
    second copy defined here.
    """
    redaction = contract.load_policy().get("redaction", {})
    replacement = redaction.get("replacement", "[REDACTED]")
    for pattern in redaction.get("patterns", []):
        try:
            text = re.sub(pattern, replacement, text)
        except re.error:  # pragma: no cover - the contract's patterns compile
            continue
    return text


def stderr_tail(stderr: str | None, lines: int = _STDERR_TAIL_LINES) -> str:
    """The last *lines* non-empty, redacted lines of *stderr*, joined for one message.

    Bounded on purpose: a failed pi run can print a great deal, and an error a
    caller has to scroll is an error nobody reads.
    """
    kept = [line.strip() for line in (stderr or "").strip().splitlines() if line.strip()]
    return " | ".join(_redact(line) for line in kept[-lines:])


# ---------------------------------------------------------------- session ids


def sanitize_session_id(raw: str) -> str:
    """Make an arbitrary id safe as one path segment (mirrors ``lib/session.ts``).

    An ACP session id is an opaque string; a ``/`` or ``..`` in one must not be
    able to redirect the export directory. But *making* an id safe is a
    many-to-one map, and this directory keys a run's artifacts: plain
    substitution sent ``task/a`` and ``task-a`` — and every id longer than the
    length cap that shares a 96-character prefix — to the same directory, where
    two concurrent runs appended to one another's ``walk.jsonl``.

    So a rewritten id carries a digest of what it was rewritten *from*:

    * an id that survives cleaning unchanged and fits the cap is returned
      verbatim, so a well-formed id is still readable on disk;
    * any other id becomes ``<cleaned stem>-<8 hex of sha256(trimmed)>``, which
      is collision-free for distinct inputs in every practical sense;
    * an id that cleans away to nothing gets a generated one.

    ``lib/session.ts`` implements this algorithm byte for byte; the golden
    value in ``tests/test_run.py`` is what cross-checks the two sides.
    """
    trimmed = raw.strip()
    cleaned = _LEADING_JUNK.sub("", _UNSAFE_SEGMENT.sub("-", trimmed))
    if not cleaned:
        return generate_session_id()
    if cleaned == trimmed and len(cleaned) <= MAX_SESSION_ID_LENGTH:
        return cleaned
    digest = hashlib.sha256(trimmed.encode("utf-8")).hexdigest()[:SESSION_ID_DIGEST_LENGTH]
    return f"{cleaned[:_SESSION_ID_STEM_LENGTH]}-{digest}"


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


# ------------------------------------------------------------ the extension


def resolve_extension_path(env: dict[str, str] | None = None) -> Path:
    """The extension entry point this launcher hands pi with ``-e``.

    Deviation d8, half two. Pi auto-discovers ``.pi/extensions/*/index.ts``
    **relative to the checkout it is run in**, so an adapter that relies on
    discovery only works when the examined checkout happens to be this repo:
    ``associate bench --harness pi`` in a fixture checkout got ``Unknown
    provider "associate"`` and no extension at all, which is the precise
    fail-open c34 exists to close. Naming the file explicitly makes the lane
    the *launcher's* property rather than the examined repo's, and needs
    neither project trust nor a global install.

    Resolution order: ``$ASSOCIATE_EXTENSION_PATH`` (an installed or forked
    copy), else the repo the package was imported from, found by walking up
    from this module. Raises ``HarnessError`` when neither exists — a run
    without the extension is one with pi's full built-in tool set.
    """
    source = env if env is not None else os.environ
    override = (source.get(EXTENSION_PATH_ENV) or "").strip()
    if override:
        candidate = Path(override).expanduser().resolve()
        if candidate.is_file():
            return candidate
        raise HarnessError(
            f"{EXTENSION_PATH_ENV} names {candidate}, which is not a file",
            remediation=(
                f"point {EXTENSION_PATH_ENV} at the extension's index.ts, or unset it to use "
                "the copy shipped in this checkout"
            ),
        )

    for parent in Path(__file__).resolve().parents:
        candidate = parent / EXTENSION_RELATIVE_PATH
        if candidate.is_file():
            return candidate

    raise HarnessError(
        f"the associate Pi extension ({EXTENSION_RELATIVE_PATH}) was not found above "
        f"{Path(__file__).resolve().parent}",
        remediation=(
            f"run from a checkout of associate, or set {EXTENSION_PATH_ENV} to the "
            "index.ts of an extension copy pi should load"
        ),
    )


def preflight_extension_path(index_path: Path) -> Path:
    """``lib/preflight.ts`` beside *index_path* — the load-and-exit extension."""
    return index_path.parent / PREFLIGHT_RELATIVE_PATH


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

        base_args = self.pi_arguments()
        env = self.environment(task)
        export_dir = self.export_dir

        report = self._run_preflight(executable, base_args, env, export_dir)
        completed = self._run_task_turn(executable, base_args, env, task, export_dir)

        # The task run's own session_start rewrites ready.json; the sentinel
        # event is only a fallback for a pi that somehow wrote no file, and the
        # preflight's report is the last resort.
        report = (
            self._read_ready_report(export_dir)
            or sentinel_report(parse_events(completed.stdout))
            or report
        )

        self._result = self._assemble_result(export_dir, report)

    def _run_preflight(
        self,
        executable: str,
        base_args: list[str],
        env: dict[str, str],
        export_dir: Path,
    ) -> dict[str, Any]:
        """Deviation d8: prove the extension loaded before the task turn runs.

        The old proof asked the *model* to call the sentinel in the same turn
        as the task; measured on the live lane, a model given real work went
        straight to it and a healthy run was refused. So readiness is proven
        by a run that never reaches the model at all: `lib/preflight.ts` ends
        the process on `before_agent_start`, after `session_start` has
        written `ready.json`, and the gate is that file.
        """
        index_path = resolve_extension_path(self._base_env)
        preflight_args = [*base_args, "-e", str(preflight_extension_path(index_path))]
        # A report left by an earlier run under the same pinned session id must
        # never stand in for this one's: the gate is evidence *this* pi wrote.
        export_dir.mkdir(parents=True, exist_ok=True)
        (export_dir / READY_REPORT_FILENAME).unlink(missing_ok=True)
        preflight = self._run_pi(
            executable,
            [*preflight_args, READINESS_PROMPT],
            env,
            timeout=min(PREFLIGHT_TIMEOUT, self._timeout),
        )

        self._assert_preflight_succeeded(preflight, index_path)
        report = self._load_ready_report_or_refuse(preflight, export_dir, index_path)
        self._assert_ready(report)
        return report

    @staticmethod
    def _assert_preflight_succeeded(
        preflight: subprocess.CompletedProcess[str], index_path: Path
    ) -> None:
        """The preflight is *expected* to exit 0: `lib/preflight.ts` ends it with
        `process.exit(0)` on `before_agent_start`. A non-zero code therefore
        means pi itself could not get that far — a bad `-e` path, an
        unloadable extension, a refused project — which is the same fail-open
        c34 exists to close, so it is refused with the same error class.
        """
        if preflight.returncode == 0:
            return
        tail = stderr_tail(preflight.stderr)
        raise ExtensionNotLoadedError(
            f"the preflight run of pi exited {preflight.returncode}, so the associate "
            f"extension at {index_path} was never proven to load"
            + (f" (pi stderr: {tail})" if tail else ""),
            remediation=(
                f"run pi by hand with -e {index_path} to see why it fails, and keep "
                "--approve for a checkout whose project files pi must trust"
            ),
        )

    def _load_ready_report_or_refuse(
        self,
        preflight: subprocess.CompletedProcess[str],
        export_dir: Path,
        index_path: Path,
    ) -> dict[str, Any]:
        report = self._read_ready_report(export_dir)
        if report is not None:
            return report
        tail = stderr_tail(preflight.stderr)
        if tail:
            self._warn("associate: pi stderr tail: " + tail)
        raise ExtensionNotLoadedError(
            f"the preflight run wrote no {READY_REPORT_FILENAME} in {export_dir}, so the "
            f"associate extension at {index_path} did not load and the run is refused",
            remediation=(
                f"check that {index_path} loads under the installed pi (it is passed with "
                "-e), keep --approve for a checkout whose project files pi must trust, and "
                f"set {EXTENSION_PATH_ENV} if the extension lives elsewhere"
            ),
        )

    def _run_task_turn(
        self,
        executable: str,
        base_args: list[str],
        env: dict[str, str],
        task: dict[str, Any],
        export_dir: Path,
    ) -> subprocess.CompletedProcess[str]:
        """The task turn, unchanged: run once the preflight has passed the gate.

        A run that failed must not be handed back as a result. The launcher
        used to build the artifact paths from the session id alone, so a pi
        that died on the task turn — or one that ran and wrote nothing —
        still exited 0 with a result naming files that were absent or, worse,
        left over from an earlier run under the same id.
        """
        prompt = self._prompt or task.get("prompt") or READINESS_PROMPT
        completed = self._run_pi(executable, [*base_args, prompt], env, timeout=self._timeout)
        self._assert_task_succeeded(completed, export_dir)
        return completed

    def _assemble_result(self, export_dir: Path, report: dict[str, Any]) -> dict[str, Any]:
        """The result dict handed back by ``collect()``."""
        return {
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

    # -- running pi --------------------------------------------------------

    def _run_pi(
        self,
        executable: str,
        argv_tail: list[str],
        env: dict[str, str],
        *,
        timeout: float,
    ) -> subprocess.CompletedProcess[str]:
        """One pi invocation: fixed argv, no shell, closed stdin."""
        try:
            return subprocess.run(  # nosec B603 - fixed argv, shell=False
                [executable, *argv_tail],
                capture_output=True,
                text=True,
                cwd=str(self._checkout),
                env=env,
                # The recorded gotcha: pi blocks reading an inherited stdin in
                # print mode, so it is closed rather than passed through.
                stdin=subprocess.DEVNULL,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as err:
            raise HarnessError(
                f"pi did not finish within {timeout:g}s",
                remediation="raise --timeout, or check that the configured lane is reachable",
            ) from err
        except OSError as err:
            raise HarnessError(
                f"could not run {executable}: {err}",
                remediation="install pi and make sure it is on PATH",
            ) from err

    @staticmethod
    def _read_ready_report(export_dir: Path) -> dict[str, Any] | None:
        """The ``ready.json`` the extension wrote, or ``None`` if there is none.

        An unreadable or malformed file is *no report*: the launcher then fails
        closed exactly as it does for a missing one, which is the only safe
        reading of "the extension may not have loaded".
        """
        try:
            parsed = json.loads((export_dir / READY_REPORT_FILENAME).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return parsed if isinstance(parsed, dict) else None

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
        * ``-e <index.ts>`` — deviation d8: the extension is named explicitly
          so it loads in **any** checkout, not only one that happens to carry
          its own ``.pi/``. ``--approve`` stays: the examined checkout may
          still carry project files pi needs to trust.
        """
        args = ["-p", "--mode", "json", "--no-session", "--approve", "--no-context-files"]
        args.extend(["-e", str(resolve_extension_path(self._base_env))])
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

    @staticmethod
    def _assert_task_succeeded(
        completed: subprocess.CompletedProcess[str], export_dir: Path
    ) -> None:
        """Refuse to report success for a task run that failed or wrote nothing.

        Two distinct failures, named separately because they need different
        remediation: pi exiting non-zero (the run died — the message quotes a
        bounded, redacted stderr tail so the operator does not have to re-run
        it blind), and pi exiting 0 having produced no artifact (the run
        happened but persisted nothing, so there is no walk to check and
        nothing to hand back).
        """
        if completed.returncode != 0:
            tail = stderr_tail(completed.stderr)
            raise HarnessError(
                f"pi exited {completed.returncode} on the task run, so nothing is served"
                + (f" (pi stderr: {tail})" if tail else ""),
                remediation=(
                    "check that the configured lane is reachable and that the prompt is "
                    "within the run's budget, then run again; the export directory "
                    f"({export_dir}) holds whatever the run did persist"
                ),
            )

        for filename in (WALK_FILENAME, STATEMENTS_MD_FILENAME):
            if not (export_dir / filename).is_file():
                raise HarnessError(
                    f"the task run left no {filename} in {export_dir}, so it produced no "
                    "artifact to hand back",
                    remediation=(
                        "the extension writes both artifacts itself; check that the run "
                        "reached its export directory and was not killed before it exited"
                    ),
                )

    def _assert_ready(self, report: dict[str, Any]) -> None:
        """Fail closed unless the report Pi produced names a writer-free lane.

        The report is the preflight's ``ready.json`` (deviation d8) — written
        by the extension itself at ``session_start``, so it is evidence the
        extension loaded, not a claim the model made.
        """
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
        except (OSError, ValueError):
            return None

        data = payload.get("data") if isinstance(payload, dict) else None
        if isinstance(data, Sequence):
            for entry in data:
                if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]:
                    return entry["id"]
        return None
