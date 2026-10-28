"""A minimal, stdlib-only JSON Schema checker.

``dependencies = []`` is deliberate in this repo, so ``jsonschema`` is not
available. This module implements exactly the draft 2020-12 subset the
contract's own schemas use and nothing more:

``type`` (object/array/string/integer/number/boolean/null, and a list of
those), ``required``, ``properties``, ``additionalProperties`` (``false`` or a
subschema), ``items``, ``minItems``, ``enum``, ``pattern``, and local
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


__all__ = [
    "ValidationError",
    "validate",
    "assert_valid",
    "validate_models",
    "validate_gate",
    "validate_walk_gate",
]


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
    errors.extend(_check_additional(instance, schema, root, path))
    return errors


def _check_additional(
    instance: dict[str, Any], schema: dict[str, Any], root: dict[str, Any], path: str
) -> list[str]:
    """``additionalProperties``: refuse (``false``) or validate (a schema) unknown keys."""
    extra = schema.get("additionalProperties")
    if extra is None or extra is True:
        return []
    known = schema.get("properties", {})
    errors: list[str] = []
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
    if not isinstance(instance, list):
        return []
    errors: list[str] = []
    minimum = schema.get("minItems")
    if isinstance(minimum, int) and len(instance) < minimum:
        errors.append(f"{path}: expected at least {minimum} item(s), got {len(instance)}")
    if "items" not in schema:
        return errors
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

#: The delegation pair (deviation d18): start a delegated run, read its result.
DELEGATE_TOOLS = ("delegate_run", "delegate_status")


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
    for tool in DELEGATE_TOOLS:
        if (tool in tools) != bool(model.get("may_delegate")):
            errors.append(f"models.{name}: {tool} and may_delegate must go together")
    return errors


def _check_delegation(doc: dict[str, Any]) -> list[str]:
    """``may_delegate`` (deviation d18): who may hand a task to a delegated run.

    A target must be a real, writing (``may_mutate``) model other than the
    delegator, and must not delegate itself — the hand-off exists to give a
    write a worktree, a test check and a clean-only merge, and a chain of
    delegations would only hide who started what. ``delegate_run`` is gated
    for every model and never a mutating tool (the delegator changes nothing
    itself); ``delegate_status`` is a read and is neither.
    """
    errors: list[str] = []
    models = doc["models"]
    for name, model in models.items():
        targets = model["may_delegate"]
        if len(set(targets)) != len(targets):
            errors.append(f"models.{name}: may_delegate has duplicates")
        for target in targets:
            entry = models.get(target)
            if entry is None:
                errors.append(f"models.{name}: may_delegate names unknown model {target!r}")
            elif target == name:
                errors.append(f"models.{name}: may_delegate names itself")
            elif entry.get("may_mutate") is not True:
                errors.append(f"models.{name}: may_delegate names {target!r}, which may not mutate")
            elif entry["may_delegate"]:
                errors.append(f"models.{name}: may_delegate names {target!r}, which delegates")
    known = set(doc["tool_names"])
    if "delegate_run" in known and "delegate_run" not in doc["gated_tools"]:
        errors.append("gated_tools: delegate_run must be gated (deviation d18)")
    for tool in DELEGATE_TOOLS:
        if tool in doc["mutating_tools"]:
            errors.append(f"mutating_tools: {tool!r} must not be a mutating tool (deviation d18)")
    if "delegate_status" in doc["gated_tools"]:
        errors.append("gated_tools: delegate_status is a read and is not gated (deviation d18)")
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


def _check_gated_tools(gated: list[str], known: set[str], mutating: set[str]) -> list[str]:
    """``gated_tools`` (deviation d6): known names, none of them a repo mutation.

    A gated tool passes the CLEF gate for every model, a may_mutate=false model
    included; a mutating tool is refused for such a model before the gate. A
    name on both lists would silently take the tool away from senses, so the
    two lists must be disjoint.
    """
    errors: list[str] = []
    for tool in sorted(set(gated) - known):
        errors.append(f"gated_tools: {tool!r} is not in tool_names")
    for tool in sorted(set(gated) & mutating):
        errors.append(
            f"gated_tools: {tool!r} is also in mutating_tools; the lists must be disjoint"
        )
    if len(set(gated)) != len(gated):
        errors.append("gated_tools: duplicate tool names")
    return errors


def validate_models(doc: dict[str, Any]) -> list[str]:
    """Cross-field checks for models.json; empty list means valid.

    Runs the structural schema first, then: every tool is in the canonical
    ``tool_names``; ``gated_tools`` are known and disjoint from
    ``mutating_tools``; a non-mutating model holds no mutating tool; only models
    that may spawn hold ``spawn_subagent``; ``may_spawn`` names real models;
    ``may_delegate`` names writing models that do not delegate, and only those
    models hold ``delegate_run`` / ``delegate_status`` (d18);
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
    errors.extend(_check_gated_tools(doc["gated_tools"], known, mutating))
    for name, model in models.items():
        errors.extend(_check_model_tools(name, model, known, mutating))
        errors.extend(_check_prompt_file(name, model))
        for target in model["may_spawn"]:
            if target not in models:
                errors.append(f"models.{name}: may_spawn names unknown model {target!r}")
            elif target == name:
                errors.append(f"models.{name}: may_spawn names itself")
    errors.extend(_check_delegation(doc))
    default = doc["default"]
    if default not in models:
        errors.append(f"default {default!r} is not a model")
    elif models[default]["status"] == "pending":
        errors.append(f"default {default!r} is pending and cannot be the default")
    return errors


def _check_unit(label: str, value: Any) -> list[str]:
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1
    return [] if ok else [f"{label}: {value!r} must be a number in [0, 1]"]


def _gate_question_errors(questions: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for key, question in questions.items():
        criteria = question.get("criteria")
        if question["type"] == "choice" and not criteria:
            errors.append(f"questions.{key}: a choice question needs criteria")
        if question["type"] == "noul" and criteria is not None:
            errors.append(f"questions.{key}: a noul question takes no criteria")
    return errors


def _gate_rule_errors(rules: list[dict[str, Any]], questions: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for index, rule in enumerate(rules):
        label = f"clef.allow_when[{index}]"
        question = questions.get(rule["question"])
        if question is None:
            errors.append(f"{label}: unknown question {rule['question']!r}")
            continue
        errors.extend(_check_unit(f"{label}.value", rule["value"]))
        option = rule.get("option")
        if question["type"] == "noul" and option is not None:
            errors.append(f"{label}: a noul question has no option")
        if question["type"] == "choice" and option not in question.get("criteria", {}):
            errors.append(f"{label}: unknown option {option!r} for {rule['question']!r}")
    ruled = {rule["question"] for rule in rules}
    for key in sorted(set(questions) - ruled):
        errors.append(f"clef.allow_when: question {key!r} has no rule")
    return errors


def _gate_super_errors(allow: dict[str, Any], questions: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for key in allow:
        if key not in questions:
            errors.append(f"super.allow_when: unknown question {key!r}")
    for key, question in questions.items():
        if key not in allow:
            errors.append(f"super.allow_when: question {key!r} has no rule")
            continue
        want = allow[key]
        if question["type"] == "noul" and not isinstance(want, bool):
            errors.append(f"super.allow_when.{key}: must be a boolean")
        if question["type"] == "choice":
            options = set(question.get("criteria", {}))
            if not (isinstance(want, list) and want and set(want) <= options):
                errors.append(
                    f"super.allow_when.{key}: must be a non-empty subset of {sorted(options)}"
                )
    return errors


def validate_gate(doc: dict[str, Any], models: dict[str, Any] | None = None) -> list[str]:
    """Cross-field checks for gate.json; empty list means valid.

    Runs the structural schema first, then: choice questions carry criteria;
    every CLEF rule names an existing question (and, for a choice, a real
    option) with a threshold in [0, 1]; both tiers rule on every question;
    Super's verdict rule matches each question's type; ``super.model`` is a
    key of *models* (``models.json`` when omitted); and ``effects`` names
    exactly that registry's ``mutating_tools`` + ``gated_tools`` (d10); and
    ``large_state`` names distinct registry evaluators with a budget above the
    decider's (d16) and a positive timeout (d20); and ``change`` applies only to
    tools with an effect, within positive bounds (d20).
    """
    from associate.contract import load_models, load_schema  # noqa: PLC0415 - avoid import cycle

    errors = validate(doc, load_schema("gate"))
    if errors:
        return errors
    questions = doc["questions"]
    errors.extend(_gate_question_errors(questions))
    errors.extend(_gate_rule_errors(doc["clef"]["allow_when"], questions))
    errors.extend(_gate_super_errors(doc["super"]["allow_when"], questions))
    models_doc = models if models is not None else load_models()
    if doc["super"]["model"] not in models_doc["models"]:
        errors.append(f"super.model: {doc['super']['model']!r} is not a models.json key")
    errors.extend(_gate_effect_errors(doc["effects"], models_doc))
    errors.extend(_gate_large_state_errors(doc["large_state"], doc["decider"], models_doc))
    errors.extend(
        f"isolation.applies_to: {tool!r} has no entry in effects"
        for tool in doc["isolation"]["applies_to"]
        if tool not in doc["effects"] or tool == "$comment"
    )
    errors.extend(_gate_change_errors(doc["change"], doc["effects"]))
    return errors


def _gate_change_errors(change: dict[str, Any], effects: dict[str, Any]) -> list[str]:
    """d20: the change line goes only to described tools, within positive bounds."""
    errors = [
        f"change.applies_to: {tool!r} has no entry in effects"
        for tool in change["applies_to"]
        if tool not in effects or tool == "$comment"
    ]
    errors.extend(
        f"change.{key}: must be a positive integer"
        for key in ("max_file_bytes", "max_render_bytes")
        if change[key] <= 0
    )
    return errors


def _gate_large_state_errors(
    large: dict[str, Any], decider: dict[str, Any], models: dict[str, Any]
) -> list[str]:
    """d16/d19: the large-state evaluators are distinct registry keys with a bigger budget.

    The upper bound (room for the answer in the provider's registered context
    window) is the extension's own check: the window is not a contract value.
    """
    evaluators = large["evaluators"]
    errors: list[str] = []
    if not evaluators:
        errors.append("large_state.evaluators: must name at least one models.json key")
    if len(set(evaluators)) != len(evaluators):
        errors.append("large_state.evaluators: keys must be distinct")
    errors.extend(
        f"large_state.evaluators: {key!r} is not a models.json key"
        for key in evaluators
        if key not in models["models"]
    )
    if large["timeout_ms"] <= 0:
        errors.append("large_state.timeout_ms: must be a positive integer (milliseconds)")
    if large["max_input_tokens"] <= decider["max_input_tokens"]:
        errors.append(
            "large_state.max_input_tokens: must be above decider.max_input_tokens "
            f"({decider['max_input_tokens']})"
        )
    return errors


def _gate_effect_errors(effects: dict[str, Any], models: dict[str, Any]) -> list[str]:
    """d10: ``effects`` describes exactly the tools that can reach the gate."""
    reachable = set(models["mutating_tools"]) | set(models.get("gated_tools", []))
    described = {name for name in effects if name != "$comment"}
    errors = [
        f"effects: {tool!r} can reach the gate but has no effect"
        for tool in sorted(reachable - described)
    ]
    errors.extend(
        f"effects: {tool!r} never reaches the gate (not in mutating_tools or gated_tools)"
        for tool in sorted(described - reachable)
    )
    return errors


def validate_walk_gate(line: dict[str, Any]) -> list[str]:
    """Structural plus tier-specific checks for one walk gate line."""
    from associate.contract import walk_gate_schema  # noqa: PLC0415 - avoid import cycle

    errors = validate(line, walk_gate_schema())
    if errors:
        return errors
    tier = line["tier"]
    if tier == "clef" and "probabilities" not in line:
        errors.append("$: a clef gate line needs probabilities")
    if tier == "super" and "verdict" not in line:
        errors.append("$: a super gate line needs a verdict")
    if tier != "clef" and "probabilities" in line:
        errors.append("$: probabilities belong to the clef tier only")
    if tier == "large" and "verdict" not in line:
        errors.append("$: a large gate line needs a verdict")
    if tier == "large" and "evaluator" not in line:
        errors.append("$: a large gate line needs the evaluator that judged it")
    if tier not in ("super", "large") and "verdict" in line:
        errors.append("$: verdict belongs to the super and large tiers only")
    for field in ("evaluator", "self_evaluated"):
        if tier != "large" and field in line:
            errors.append(f"$: {field} belongs to the large tier only")
    return errors
