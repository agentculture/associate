"""A minimal, stdlib-only JSON Schema checker.

``dependencies = []`` is deliberate in this repo, so ``jsonschema`` is not
available. This module implements exactly the draft 2020-12 subset the
contract's own schemas use and nothing more:

``type`` (object/array/string/integer/number/boolean/null, and a list of
those), ``required``, ``properties``, ``additionalProperties`` (``false`` or a
subschema), ``items``, ``enum``, ``pattern``, and local
``$ref`` pointers of the form ``#/$defs/<name>``.

Anything else in a schema is ignored rather than guessed at — if a schema
starts needing a keyword that is not listed above, add it here *with a test*
rather than reaching for a dependency.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

#: Longest regex the contract will compile. Schemas and policy.json are package
#: data, not user input, but a cap plus a compile cache keeps a pathological
#: pattern from ever reaching ``re`` uncompiled on every call.
MAX_PATTERN_LENGTH = 256


@lru_cache(maxsize=256)
def compile_pattern(pattern: str) -> re.Pattern[str]:
    """Compile a contract pattern once, refusing anything over the length cap."""
    if not isinstance(pattern, str) or len(pattern) > MAX_PATTERN_LENGTH:
        raise ValueError(f"contract pattern rejected (max {MAX_PATTERN_LENGTH} chars)")
    return re.compile(pattern)


__all__ = ["ValidationError", "validate", "assert_valid", "validate_models"]


class ValidationError(ValueError):
    """Raised by :func:`assert_valid` when an instance fails its schema."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    # JSON has no bool type; Python's bool is an int subclass, so exclude it
    # explicitly or `true` would validate as an integer.
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _resolve(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    """Follow a local ``#/a/b`` ``$ref`` inside *root*, once."""
    ref = schema.get("$ref")
    if not isinstance(ref, str):
        return schema
    if not ref.startswith("#/"):
        raise ValidationError([f"unsupported $ref {ref!r}: only local '#/...' pointers"])
    target: Any = root
    for token in ref[2:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        if not isinstance(target, dict) or token not in target:
            raise ValidationError([f"unresolvable $ref {ref!r}"])
        target = target[token]
    if not isinstance(target, dict):
        raise ValidationError([f"$ref {ref!r} does not point at a schema"])
    return target


def _check_type(instance: Any, schema: dict[str, Any], path: str) -> list[str]:
    """Return the type-mismatch error, if any.

    A non-empty result means every nested check is meaningless (the caller
    stops there rather than checking a wrongly-typed instance further).
    """
    expected = schema.get("type")
    if expected is None:
        return []
    names = [expected] if isinstance(expected, str) else list(expected)
    if any(_TYPE_CHECKS[name](instance) for name in names):
        return []
    return [f"{path}: expected type {'|'.join(names)}"]


def _check_enum(instance: Any, schema: dict[str, Any], path: str) -> list[str]:
    if "enum" in schema and instance not in schema["enum"]:
        return [f"{path}: {instance!r} is not one of {schema['enum']}"]
    return []


def _check_pattern(instance: Any, schema: dict[str, Any], path: str) -> list[str]:
    pattern = schema.get("pattern")
    if pattern is None or not isinstance(instance, str):
        return []
    if compile_pattern(pattern).search(instance):
        return []
    return [f"{path}: {instance!r} does not match pattern {pattern!r}"]


def _check_object(
    instance: Any, schema: dict[str, Any], root: dict[str, Any], path: str
) -> list[str]:
    if not isinstance(instance, dict):
        return []
    errors: list[str] = []
    for key in schema.get("required", []):
        if key not in instance:
            errors.append(f"{path}: missing required property {key!r}")
    for key, subschema in schema.get("properties", {}).items():
        if key in instance:
            errors.extend(_check(instance[key], subschema, root, f"{path}.{key}"))
    extra = schema.get("additionalProperties")
    if extra is not None:
        known = schema.get("properties", {})
        for key in instance:
            if key in known:
                continue
            if extra is False:
                errors.append(f"{path}: unknown property {key!r}")
            elif isinstance(extra, dict):
                errors.extend(_check(instance[key], extra, root, f"{path}.{key}"))
    return errors


def _check_array(
    instance: Any, schema: dict[str, Any], root: dict[str, Any], path: str
) -> list[str]:
    if not isinstance(instance, list) or "items" not in schema:
        return []
    errors: list[str] = []
    for index, item in enumerate(instance):
        errors.extend(_check(item, schema["items"], root, f"{path}[{index}]"))
    return errors


def _check(instance: Any, schema: dict[str, Any], root: dict[str, Any], path: str) -> list[str]:
    schema = _resolve(schema, root)

    type_errors = _check_type(instance, schema, path)
    if type_errors:
        return type_errors

    errors: list[str] = []
    errors.extend(_check_enum(instance, schema, path))
    errors.extend(_check_pattern(instance, schema, path))
    errors.extend(_check_object(instance, schema, root, path))
    errors.extend(_check_array(instance, schema, root, path))
    return errors


def validate(instance: Any, schema: dict[str, Any]) -> list[str]:
    """Return a list of human-readable errors — empty when *instance* is valid."""
    return _check(instance, schema, schema, "$")


def assert_valid(instance: Any, schema: dict[str, Any]) -> None:
    """Raise :class:`ValidationError` when *instance* fails *schema*."""
    errors = validate(instance, schema)
    if errors:
        raise ValidationError(errors)


#: Where a model's prompt file must live (checked for shape, not existence).
PROMPT_DIR = ".pi/extensions/associate/prompts/"


def _check_model_tools(name: str, model: dict[str, Any], known: set[str], mutating: set[str]):
    errors: list[str] = []
    tools = model.get("tools", [])
    for tool in tools:
        if tool not in known:
            errors.append(f"models.{name}: tool {tool!r} is not in tool_names")
    if len(set(tools)) != len(tools):
        errors.append(f"models.{name}: duplicate tool names")
    if not model.get("may_mutate") and mutating.intersection(tools):
        held = sorted(mutating.intersection(tools))
        errors.append(f"models.{name}: may_mutate is false but holds {held}")
    if ("spawn_subagent" in tools) != bool(model.get("may_spawn")):
        errors.append(f"models.{name}: spawn_subagent and may_spawn must go together")
    return errors


def _check_prompt_file(name: str, model: dict[str, Any]) -> list[str]:
    prompt = model.get("prompt_file", "")
    parts = prompt.split("/")
    ok = (
        isinstance(prompt, str)
        and prompt.startswith(PROMPT_DIR)
        and prompt.endswith(".md")
        and ".." not in parts
        and not prompt.startswith("/")
    )
    return [] if ok else [f"models.{name}: prompt_file must be {PROMPT_DIR}<name>.md"]


def validate_models(doc: dict[str, Any]) -> list[str]:
    """Cross-field checks for models.json; empty list means valid.

    Runs the structural schema first, then: every tool is in the canonical
    ``tool_names``; a non-mutating model holds no mutating tool; only models
    that may spawn hold ``spawn_subagent``; ``may_spawn`` names real models;
    prompt files have the right shape; and the default exists and is active.
    """
    from associate.contract import load_schema  # noqa: PLC0415 - avoid import cycle

    errors = validate(doc, load_schema("models"))
    if errors:
        return errors
    known = set(doc["tool_names"])
    mutating = set(doc["mutating_tools"])
    models = doc["models"]
    for tool in sorted(mutating - known):
        errors.append(f"mutating_tools: {tool!r} is not in tool_names")
    for name, model in models.items():
        errors.extend(_check_model_tools(name, model, known, mutating))
        errors.extend(_check_prompt_file(name, model))
        for target in model["may_spawn"]:
            if target not in models:
                errors.append(f"models.{name}: may_spawn names unknown model {target!r}")
            elif target == name:
                errors.append(f"models.{name}: may_spawn names itself")
    default = doc["default"]
    if default not in models:
        errors.append(f"default {default!r} is not a model")
    elif models[default]["status"] == "pending":
        errors.append(f"default {default!r} is pending and cannot be the default")
    return errors
