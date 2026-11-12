"""Validate the JSON Schema vocabulary used by IAD's bundled v1 schemas.

This is deliberately not a general JSON Schema implementation. Unsupported
validation keywords raise SchemaDefinitionError instead of being ignored. It
accepts only bundled/local schema references; it never fetches remote schemas.
The published schemas are also usable with a full draft 2020-12 validator.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote


class SchemaDefinitionError(ValueError):
    """A bundled schema uses a keyword that this evaluator cannot enforce."""


ANNOTATIONS = {"$schema", "$id", "$defs", "title", "description", "default", "examples", "$comment", "deprecated", "readOnly", "writeOnly"}
KEYWORDS = ANNOTATIONS | {"$ref", "type", "const", "enum", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "anyOf", "oneOf", "allOf"}


def schema_directory() -> Path:
    packaged = Path(__file__).resolve().parent / "schemas"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parent.parent / "schemas"


def _kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return "string"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    return type(value).__name__


def _same(a: Any, b: Any) -> bool:
    # Python treats True == 1, which JSON Schema does not.
    return _kind(a) == _kind(b) and a == b


def validate_schema(instance: Any, schema_name: str, path: str = "$") -> list[dict]:
    """Return structured schema errors for a document against a bundled schema."""
    directory = schema_directory().resolve()
    cache: dict[Path, Any] = {}

    def read(file: Path) -> Any:
        file = file.resolve()
        if not file.is_relative_to(directory):
            raise SchemaDefinitionError("Schema references must stay inside the bundled schema directory")
        if file not in cache:
            cache[file] = json.loads(file.read_text(encoding="utf-8"))
        return cache[file]

    def resolve(ref: str, file: Path) -> tuple[Any, Path]:
        if ":" in ref or ref.startswith("/"):
            raise SchemaDefinitionError(f"Remote/absolute schema references are unsupported: {ref}")
        filename, _, fragment = ref.partition("#")
        target = (file.parent / filename).resolve() if filename else file
        schema = read(target)
        if fragment:
            if not fragment.startswith("/"):
                raise SchemaDefinitionError(f"Only JSON Pointer schema fragments are supported: {ref}")
            for token in fragment[1:].split("/"):
                schema = schema[unquote(token).replace("~1", "/").replace("~0", "~")]
        return schema, target

    def check(value: Any, schema: Any, at: str, file: Path) -> list[dict]:
        errors: list[dict] = []

        def error(message: str) -> None:
            errors.append({"severity": "error", "code": "schema", "path": at, "message": message})

        if isinstance(schema, bool):
            if not schema:
                error("Value is forbidden by the schema")
            return errors
        if not isinstance(schema, dict):
            raise SchemaDefinitionError("Schemas must be objects or booleans")
        unsupported = set(schema) - KEYWORDS
        if unsupported:
            raise SchemaDefinitionError("Unsupported schema keyword(s): " + ", ".join(sorted(unsupported)))
        if "$ref" in schema:
            resolved, target_file = resolve(schema["$ref"], file)
            errors.extend(check(value, resolved, at, target_file))
        for keyword in ("allOf", "anyOf", "oneOf"):
            if keyword in schema:
                alternatives = [check(value, part, at, file) for part in schema[keyword]]
                matches = sum(not issues for issues in alternatives)
                if keyword == "allOf":
                    for issues in alternatives:
                        errors.extend(issues)
                elif keyword == "anyOf" and not matches:
                    error("Value does not match any allowed schema")
                elif keyword == "oneOf" and matches != 1:
                    error("Value must match exactly one allowed schema")
        if "const" in schema and not _same(value, schema["const"]):
            error(f"Expected constant {schema['const']!r}")
        if "enum" in schema and not any(_same(value, item) for item in schema["enum"]):
            error("Expected one of " + repr(schema["enum"]))
        if "type" in schema:
            types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            kind = _kind(value)
            if kind not in types and not (kind == "integer" and "number" in types):
                error(f"Expected {' or '.join(types)}, got {kind}")
                return errors
        if isinstance(value, dict):
            for key in schema.get("required", []):
                if key not in value:
                    errors.append({"severity": "error", "code": "schema", "path": f"{at}.{key}", "message": "Required property is missing"})
            properties = schema.get("properties", {})
            for key, child in value.items():
                if key in properties:
                    errors.extend(check(child, properties[key], f"{at}.{key}", file))
                elif schema.get("additionalProperties") is False:
                    errors.append({"severity": "error", "code": "schema", "path": f"{at}.{key}", "message": "Unknown property"})
                elif isinstance(schema.get("additionalProperties"), dict):
                    errors.extend(check(child, schema["additionalProperties"], f"{at}.{key}", file))
        if isinstance(value, list):
            if len(value) < schema.get("minItems", 0):
                error(f"Expected at least {schema['minItems']} item(s)")
            if "maxItems" in schema and len(value) > schema["maxItems"]:
                error(f"Expected at most {schema['maxItems']} item(s)")
            if schema.get("uniqueItems"):
                normalized = [json.dumps(item, sort_keys=True, ensure_ascii=False) for item in value]
                if len(set(normalized)) != len(normalized):
                    error("Array items must be unique")
            if "items" in schema:
                for index, child in enumerate(value):
                    errors.extend(check(child, schema["items"], f"{at}[{index}]", file))
        if isinstance(value, str):
            if len(value) < schema.get("minLength", 0):
                error(f"Expected at least {schema['minLength']} character(s)")
            if "maxLength" in schema and len(value) > schema["maxLength"]:
                error(f"Expected at most {schema['maxLength']} character(s)")
            if "pattern" in schema and not re.search(schema["pattern"], value):
                error(f"String does not match {schema['pattern']}")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                error(f"Expected number >= {schema['minimum']}")
            if "maximum" in schema and value > schema["maximum"]:
                error(f"Expected number <= {schema['maximum']}")
            if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
                error(f"Expected number > {schema['exclusiveMinimum']}")
            if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
                error(f"Expected number < {schema['exclusiveMaximum']}")
        return errors

    audited = set()

    def audit(schema: Any, file: Path) -> None:
        if isinstance(schema, bool):
            return
        if not isinstance(schema, dict):
            raise SchemaDefinitionError("Schemas must be objects or booleans")
        marker = (str(file), id(schema))
        if marker in audited:
            return
        audited.add(marker)
        unsupported = set(schema) - KEYWORDS
        if unsupported:
            raise SchemaDefinitionError("Unsupported schema keyword(s): " + ", ".join(sorted(unsupported)))
        if "$ref" in schema:
            target, target_file = resolve(schema["$ref"], file)
            audit(target, target_file)
        for keyword in ("properties", "$defs"):
            for child in schema.get(keyword, {}).values():
                audit(child, file)
        for keyword in ("items", "additionalProperties"):
            if keyword in schema:
                audit(schema[keyword], file)
        for keyword in ("allOf", "anyOf", "oneOf"):
            for child in schema.get(keyword, []):
                audit(child, file)

    file = (directory / schema_name).resolve()
    schema = read(file)
    audit(schema, file)
    return check(instance, schema, path, file)
