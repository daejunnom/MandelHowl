"""Dependency-free validator for the JSON Schema subset used by MandelHowl."""

from __future__ import annotations

import math
import re
from typing import Any


class SchemaValidationError(ValueError):
    pass


def _resolve(root: dict[str, Any], reference: str) -> dict[str, Any]:
    if not reference.startswith("#/"):
        raise SchemaValidationError(f"external schema reference is forbidden: {reference}")
    value: Any = root
    for token in reference[2:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        value = value[token]
    if not isinstance(value, dict):
        raise SchemaValidationError(f"schema reference is not an object: {reference}")
    return value


def _is_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
        )
    raise SchemaValidationError(f"unsupported schema type {expected!r}")


def validate(instance: Any, schema: dict[str, Any], *, root: dict[str, Any] | None = None, path: str = "$") -> None:
    root = schema if root is None else root
    if "$ref" in schema:
        validate(instance, _resolve(root, schema["$ref"]), root=root, path=path)
        return
    if "oneOf" in schema:
        accepted = 0
        for branch in schema["oneOf"]:
            try:
                validate(instance, branch, root=root, path=path)
                accepted += 1
            except SchemaValidationError:
                pass
        if accepted != 1:
            raise SchemaValidationError(
                f"{path}: expected exactly one oneOf branch, matched {accepted}"
            )
    if "const" in schema and instance != schema["const"]:
        raise SchemaValidationError(
            f"{path}: expected constant {schema['const']!r}, received {instance!r}"
        )
    if "enum" in schema and instance not in schema["enum"]:
        raise SchemaValidationError(f"{path}: value is not in enum")
    expected_type = schema.get("type")
    if expected_type is not None:
        alternatives = [expected_type] if isinstance(expected_type, str) else expected_type
        if not any(_is_type(instance, alternative) for alternative in alternatives):
            raise SchemaValidationError(f"{path}: expected type {expected_type!r}")

    if isinstance(instance, dict):
        required = schema.get("required", [])
        missing = [key for key in required if key not in instance]
        if missing:
            raise SchemaValidationError(f"{path}: missing required keys {missing}")
        properties = schema.get("properties", {})
        for key, value in instance.items():
            if key in properties:
                validate(value, properties[key], root=root, path=f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                raise SchemaValidationError(f"{path}: unexpected key {key!r}")
            elif isinstance(schema.get("additionalProperties"), dict):
                validate(
                    value,
                    schema["additionalProperties"],
                    root=root,
                    path=f"{path}.{key}",
                )
    if isinstance(instance, list):
        if len(instance) < schema.get("minItems", 0):
            raise SchemaValidationError(f"{path}: too few array items")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            raise SchemaValidationError(f"{path}: too many array items")
        if schema.get("uniqueItems"):
            serialized = [repr(value) for value in instance]
            if len(serialized) != len(set(serialized)):
                raise SchemaValidationError(f"{path}: array items are not unique")
        prefix = schema.get("prefixItems", [])
        for index, item_schema in enumerate(prefix):
            if index < len(instance):
                validate(instance[index], item_schema, root=root, path=f"{path}[{index}]")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index in range(len(prefix), len(instance)):
                validate(
                    instance[index],
                    item_schema,
                    root=root,
                    path=f"{path}[{index}]",
                )
        elif item_schema is False and len(instance) > len(prefix):
            raise SchemaValidationError(f"{path}: additional array items are forbidden")
    if isinstance(instance, str):
        if len(instance) < schema.get("minLength", 0):
            raise SchemaValidationError(f"{path}: string is too short")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            raise SchemaValidationError(f"{path}: string is too long")
        if "pattern" in schema and re.search(schema["pattern"], instance) is None:
            raise SchemaValidationError(f"{path}: string does not match pattern")
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            raise SchemaValidationError(f"{path}: value is below minimum")
        if "maximum" in schema and instance > schema["maximum"]:
            raise SchemaValidationError(f"{path}: value is above maximum")
        if "exclusiveMinimum" in schema and instance <= schema["exclusiveMinimum"]:
            raise SchemaValidationError(f"{path}: value is not above exclusiveMinimum")
        if "exclusiveMaximum" in schema and instance >= schema["exclusiveMaximum"]:
            raise SchemaValidationError(f"{path}: value is not below exclusiveMaximum")
