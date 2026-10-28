"""Public benchmark suites as data (claim c49): load, validate, run, stamp.

A suite entry names an upstream runner (an argv template, never a shell
string) and the upstream's own scorer; this module only launches them against
the gateway and reads the score the scorer wrote. It never re-implements a
scorer, dataset or task set. Adding a suite is a data addition to
``suites.json`` (or the file named by ``ASSOCIATE_BENCH_SUITES``).
"""

from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess  # nosec B404 - argv list from data, shell=False
import tempfile
from pathlib import Path
from typing import Any

from associate import contract
from associate.bench import config as bench_config
from associate.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from associate.cli._output import diagnostic_fd

__all__ = ["suites_path", "load_suites", "run_suite", "render"]

_REQUIRED = ("name", "version", "homepage", "runner", "scorer", "models")


def suites_path() -> Path:
    override = os.environ.get("ASSOCIATE_BENCH_SUITES")
    return Path(override) if override else Path(__file__).resolve().parent / "suites.json"


def _bad(message: str) -> CliError:
    return CliError(
        code=EXIT_ENV_ERROR,
        message=message,
        remediation=f"fix the suites file {suites_path()}",
    )


def _validate(entry: Any, index: int) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise _bad(f"suite #{index} is not an object")
    for key in _REQUIRED:
        if key not in entry:
            raise _bad(f"suite #{index} ({entry.get('name', '?')}) is missing {key!r}")
    runner, scorer = entry["runner"], entry["scorer"]
    if not (
        isinstance(runner, dict)
        and isinstance(runner.get("argv"), list)
        and runner["argv"]
        and all(isinstance(a, str) for a in runner["argv"])
    ):
        raise _bad(f"suite {entry['name']!r}: runner.argv must be a non-empty list of strings")
    result = scorer.get("result") if isinstance(scorer, dict) else None
    if not (
        isinstance(result, dict)
        and isinstance(scorer.get("name"), str)
        and result.get("format") in ("json", "csv")
        and isinstance(result.get("file"), str)
    ):
        raise _bad(f"suite {entry['name']!r}: scorer needs name and result{{file,format}}")
    if not (isinstance(entry["models"], list) and entry["models"]):
        raise _bad(f"suite {entry['name']!r}: models must be a non-empty list")
    return entry


def load_suites() -> dict[str, dict[str, Any]]:
    path = suites_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise _bad(f"cannot read suites file {path}: {exc}") from exc
    suites: dict[str, dict[str, Any]] = {}
    for index, entry in enumerate(data.get("suites", [])):
        entry = _validate(entry, index)
        suites[entry["name"]] = entry
    return suites


def _sub(template: str, values: dict[str, str]) -> str:
    for key, value in values.items():
        template = template.replace("{" + key + "}", value)
    return template


def _parse_score(result: dict[str, Any], path: Path) -> float:
    try:
        if result["format"] == "json":
            node: Any = json.loads(path.read_text(encoding="utf-8"))
            for key in result.get("path", []):
                node = node[key]
        else:
            with path.open(encoding="utf-8", newline="") as handle:
                node = list(csv.DictReader(handle))[int(result.get("row", 0))][result["column"]]
        return float(str(node).strip().rstrip("%"))
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=f"could not read a score from {path.name}: {type(exc).__name__}",
            remediation="the upstream scorer's output layout may differ; check the suite entry",
        ) from exc


def _exec(argv: list[str], env_extra: dict[str, str], what: str, hint: str) -> None:
    if shutil.which(argv[0]) is None:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=f"upstream {what} {argv[0]!r} is not on PATH",
            remediation=hint,
        )
    env = {**os.environ, **env_extra}
    # CLI invariant 1: the upstream's progress is a diagnostic. Both of its
    # streams go to associate's stderr, live, so stdout carries only the row.
    fd = diagnostic_fd()
    completed = subprocess.run(  # nosec B603 - argv list from reviewed data, shell=False
        argv, env=env, check=False, stdout=fd, stderr=fd
    )
    if completed.returncode != 0:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=f"upstream {what} exited {completed.returncode}",
            remediation="see the upstream output above (on stderr)",
        )


def run_suite(name: str, model_key: str, output_dir: str | None = None) -> dict[str, Any]:
    suites = load_suites()
    if name not in suites:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"unknown suite {name!r}",
            remediation=f"valid suites: {', '.join(sorted(suites))}",
        )
    suite = suites[name]
    models = contract.load_models()["models"]
    entry = models.get(model_key)
    if entry is None or entry.get("status") != "active":
        active = sorted(k for k, v in models.items() if v.get("status") == "active")
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"unknown or pending model {model_key!r}",
            remediation=f"valid models: {', '.join(active)}",
        )
    if model_key not in suite["models"]:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"suite {name!r} does not list model {model_key!r}",
            remediation=f"models for {name}: {', '.join(suite['models'])}",
        )
    role = entry["lobes_role"]
    out = output_dir or tempfile.mkdtemp(prefix=f"associate-bench-{name}-")
    values = {
        "base_url": os.environ.get("ASSOCIATE_BASE_URL") or contract.default_base_url(),
        "api_key": os.environ.get("ASSOCIATE_API_KEY", ""),
        "model": role,
        "output_dir": out,
    }
    hint = suite.get("install_hint", f"see {suite['homepage']}")
    env_extra = {k: _sub(v, values) for k, v in suite["runner"].get("env", {}).items()}
    _exec([_sub(a, values) for a in suite["runner"]["argv"]], env_extra, "runner", hint)
    scorer = suite["scorer"]
    if scorer.get("argv"):
        _exec([_sub(a, values) for a in scorer["argv"]], env_extra, "scorer", hint)
    score = _parse_score(scorer["result"], Path(_sub(scorer["result"]["file"], values)))
    configuration = bench_config.describe(
        f"suite:{name}", None, {"served_model_id": role, "plumbing_only": False}
    )
    configuration["model_role"] = role
    return {
        "suite": name,
        "suite_version": suite["version"],
        "scorer": scorer["name"],
        "score": score,
        "model": model_key,
        "lobes_role": role,
        "verified": bool(suite.get("verified", True)),
        "configuration": configuration,
    }


def render(row: dict[str, Any]) -> str:
    cfg = row["configuration"]
    heads = ["suite", "version", "scorer", "model", "score"]
    vals = [row["suite"], row["suite_version"], row["scorer"], row["lobes_role"], str(row["score"])]
    for key in (
        "harness",
        "served_model_id",
        "pi_version",
        "extension_version",
        "provider",
        "reasoning",
    ):
        heads.append(key)
        vals.append(str(cfg.get(key, "")))
    widths = [max(len(h), len(v)) for h, v in zip(heads, vals)]
    fmt = lambda xs: "| " + " | ".join(x.ljust(w) for x, w in zip(xs, widths)) + " |"  # noqa: E731
    sep = "|-" + "-|-".join("-" * w for w in widths) + "-|"
    note = "" if row["verified"] else "\nnote: suite entry point is marked verified=false"
    return "\n".join([fmt(heads), sep, fmt(vals)]) + note
