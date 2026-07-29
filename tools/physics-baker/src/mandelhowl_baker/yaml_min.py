"""A deliberately small YAML loader for the repository's canonical specs.

The baker has no network or third-party dependency requirement. This parser
therefore implements only the audited YAML subset used under ``specs/``:
indent-based mappings and sequences, JSON-style inline arrays, quoted/plain
scalars, booleans, nulls, and finite decimal numbers. Anchors, tags, merge
keys, block scalars, and executable/custom types are rejected.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


class YamlSubsetError(ValueError):
    """Raised when a spec uses YAML outside the deterministic subset."""


_NUMBER = re.compile(
    r"^[+-]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|0\.[0-9]+)"
    r"(?:[eE][+-]?[0-9]+)?$"
)


def _strip_comment(line: str) -> str:
    quote: str | None = None
    escaped = False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote == '"':
            escaped = True
            continue
        if char in {"'", '"'}:
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
            continue
        if char == "#" and quote is None:
            return line[:index]
    return line


def _split_mapping(text: str) -> tuple[str, str] | None:
    quote: str | None = None
    depth = 0
    for index, char in enumerate(text):
        if char in {"'", '"'}:
            quote = None if quote == char else (char if quote is None else quote)
        elif quote is None:
            if char in "[{":
                depth += 1
            elif char in "]}":
                depth -= 1
            elif char == ":" and depth == 0:
                return text[:index].strip(), text[index + 1 :].strip()
    return None


def _parse_scalar(text: str) -> Any:
    if not text:
        raise YamlSubsetError("empty scalar")
    if text.startswith(("&", "*", "!", "|", ">")):
        raise YamlSubsetError(f"unsupported YAML construct: {text!r}")
    if text[0] in {'"', "["} or text.startswith("{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise YamlSubsetError(f"invalid JSON-style YAML scalar: {text}") from error
    if text[0] == "'" and text[-1:] == "'":
        return text[1:-1].replace("''", "'")
    lower = text.lower()
    if lower in {"true", "false"}:
        return lower == "true"
    if lower in {"null", "~"}:
        return None
    if _NUMBER.fullmatch(text):
        value: int | float
        value = float(text) if any(char in text for char in ".eE") else int(text)
        if isinstance(value, float) and not math.isfinite(value):
            raise YamlSubsetError("non-finite numbers are forbidden")
        return value
    return text


def loads(source: str) -> dict[str, Any]:
    rows: list[tuple[int, str, int]] = []
    for number, raw in enumerate(source.splitlines(), start=1):
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise YamlSubsetError(f"tabs are forbidden at line {number}")
        clean = _strip_comment(raw).rstrip()
        if not clean.strip():
            continue
        indent = len(clean) - len(clean.lstrip(" "))
        if indent % 2:
            raise YamlSubsetError(f"indentation must use two-space steps at line {number}")
        rows.append((indent, clean.lstrip(" "), number))

    if not rows:
        return {}
    if rows[0][0] != 0 or rows[0][1].startswith("- "):
        raise YamlSubsetError("root must be a zero-indented mapping")

    root: dict[str, Any] = {}
    stack: list[tuple[int, Any]] = [(-1, root)]

    for row_index, (indent, content, line_number) in enumerate(rows):
        while indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]

        if content.startswith("- "):
            if not isinstance(parent, list):
                raise YamlSubsetError(f"sequence item without sequence at line {line_number}")
            item_text = content[2:].strip()
            mapping = _split_mapping(item_text)
            if mapping is not None:
                key, scalar = mapping
                if not key:
                    raise YamlSubsetError(f"empty key at line {line_number}")
                item: dict[str, Any] = {}
                parent.append(item)
                if scalar:
                    item[key] = _parse_scalar(scalar)
                else:
                    next_is_list = (
                        row_index + 1 < len(rows)
                        and rows[row_index + 1][0] > indent
                        and rows[row_index + 1][1].startswith("- ")
                    )
                    child: Any = [] if next_is_list else {}
                    item[key] = child
                    stack.append((indent, item))
                    stack.append((indent + 1, child))
                    continue
                stack.append((indent, item))
            elif item_text:
                parent.append(_parse_scalar(item_text))
            else:
                raise YamlSubsetError(f"empty sequence item at line {line_number}")
            continue

        if not isinstance(parent, dict):
            raise YamlSubsetError(f"mapping entry without mapping at line {line_number}")
        mapping = _split_mapping(content)
        if mapping is None:
            raise YamlSubsetError(f"expected key:value mapping at line {line_number}")
        key, scalar = mapping
        if not key or key in parent:
            raise YamlSubsetError(f"empty or duplicate key {key!r} at line {line_number}")
        if scalar:
            parent[key] = _parse_scalar(scalar)
            continue
        next_is_list = (
            row_index + 1 < len(rows)
            and rows[row_index + 1][0] > indent
            and rows[row_index + 1][1].startswith("- ")
        )
        child = [] if next_is_list else {}
        parent[key] = child
        stack.append((indent, child))

    return root


def load(path: Path) -> dict[str, Any]:
    return loads(path.read_text(encoding="utf-8"))
