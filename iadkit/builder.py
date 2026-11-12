"""Validate authored data and compile a deterministic, self-contained viewer."""

from copy import deepcopy
import hashlib
import html
import json
from pathlib import Path
import re

from . import __version__
from .project import load_project, validate_project
from .schema import validate_schema
from .sources import collect_sources, diagnostic
from .locations import require_external_directory

ASSETS = Path(__file__).with_name("assets")


def json_text(value):
    return json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def script_json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def inspect_project(path, repo_overrides=None, strict=False):
    project = load_project(path)
    diagnostics = validate_project(project)
    evidence, sources = [], {}
    if not any(item["severity"] == "error" for item in diagnostics):
        rules = project["config"].get("rules")
        if rules:
            root = Path(project["root"]).resolve()
            rules_path = (root / rules).resolve()
            if not rules_path.is_relative_to(root):
                diagnostics.append(diagnostic("rules.path", "project.json.rules", "Rules file must stay inside the authored project directory."))
            elif not rules_path.is_file():
                diagnostics.append(diagnostic("rules.unavailable", "project.json.rules", "Referenced rules file is unavailable; its hash cannot be recorded.", "warning"))
        evidence, sources, source_diagnostics = collect_sources(project, repo_overrides)
        diagnostics.extend(source_diagnostics)
    errors = sum(item["severity"] == "error" for item in diagnostics)
    warnings = sum(item["severity"] == "warning" for item in diagnostics)
    status = "error" if errors or (strict and warnings) else "warning" if warnings else "ok"
    return project, evidence, sources, {"status": status, "errors": errors, "warnings": warnings, "strict": bool(strict), "diagnostics": diagnostics}


def _input_paths(project):
    """Keep logical input names while following accepted file aliases for reads."""
    root = Path(project["root"]).resolve()
    inputs = {name: root / name for name in ("project.json", "view.json")}
    for category in ("nodes", "edges", "contracts", "scenarios", "evidence"):
        inputs.update((path.relative_to(root).as_posix(), path) for path in (root / category).glob("*.json"))
    archive = project["config"].get("sourceArchive", "snapshots.json")
    inputs[archive] = root / archive
    rules = project["config"].get("rules")
    if rules:
        # Rules have already been checked to resolve inside the project. Their
        # authored path may be absolute; never publish that local path.
        path = (root / rules).resolve()
        inputs[path.relative_to(root).as_posix()] = path
    return inputs


def _manifest(project, sources):
    config = project["config"]
    repositories = deepcopy(config["repositories"])
    primary = config["primaryRepository"]
    revision = next(repo["revision"] for repo in repositories if repo["id"] == primary)
    result = {
        "format": "IAD", "formatVersion": 1, "kitVersion": __version__,
        "project": {"id": config["id"], "name": config["name"]},
        "settings": deepcopy(project["view"]),
        "target": deepcopy(config.get("target", {"id": config["id"], "name": config["name"], "type": "repository"})),
        "revision": revision, "primaryRepository": primary, "repositories": repositories,
        "metadata": deepcopy(config.get("metadata", {})),
        "limitations": deepcopy(config.get("limitations", [])),
        "sourceSnapshotPolicy": "Exact pinned Git blobs when available; SHA-256-checked embedded archive otherwise. Source integrity does not establish semantic support.",
        "sourceCount": len(sources),
    }
    inputs = _input_paths(project)
    result["inputs"] = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in sorted(inputs.items()) if path.is_file()}
    result["assets"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(ASSETS.glob("*")) if path.is_file()}
    package = Path(__file__).resolve().parent
    toolchain = sorted([*package.glob("*.py"), *package.glob("schemas/*.json")])
    result["toolchain"] = {f"iadkit/{path.relative_to(package).as_posix()}": hashlib.sha256(path.read_bytes()).hexdigest() for path in toolchain if path.is_file()}
    kit_rules = package / "spec" / "iad-rules.md"
    result["kitRules"] = {"path": "iadkit/spec/iad-rules.md", "sha256": hashlib.sha256(kit_rules.read_bytes()).hexdigest()}
    rules = config.get("rules")
    if rules:
        path = (Path(project["root"]) / rules).resolve()
        if path.is_relative_to(Path(project["root"]).resolve()) and path.is_file():
            result["rules"] = {"path": path.relative_to(project["root"]).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    return result


def build_project(path, output=None, strict=False, repo_overrides=None):
    project, evidence, sources, report = inspect_project(path, repo_overrides=repo_overrides, strict=strict)
    output_path = (Path(output).expanduser() if output else Path(project["root"]) / "build").resolve()
    runtime_report = {**report, "output": str(output_path)}
    try:
        require_external_directory(project["root"], "Diagram data")
        require_external_directory(output_path, "Build output")
    except ValueError as exc:
        runtime_report["diagnostics"].append(diagnostic("build.kit_directory", "build", str(exc)))
        runtime_report["errors"] += 1
        runtime_report["status"] = "error"
        return runtime_report
    if report["status"] == "error":
        return runtime_report
    try:
        manifest = _manifest(project, sources)
        model = {
            "schemaVersion": 1, "manifest": manifest, "view": deepcopy(project["view"]),
            **{field: deepcopy(project[field]) for field in ("nodes", "edges", "contracts", "scenarios")},
            "evidence": evidence, "limitations": deepcopy(project["config"].get("limitations", [])),
        }
        model_diagnostics = validate_schema(model, "model.schema.json", "model")
        if model_diagnostics:
            runtime_report["diagnostics"].extend({**item, "code": "build.model_schema"} for item in model_diagnostics)
            runtime_report["errors"] += sum(item["severity"] == "error" for item in model_diagnostics)
            runtime_report["warnings"] += sum(item["severity"] == "warning" for item in model_diagnostics)
            runtime_report["status"] = "error"
            return runtime_report
        template = (ASSETS / "index.template.html").read_text(encoding="utf-8")
        replacements = {
            "/* IAD_STYLES */": (ASSETS / "style.css").read_text(encoding="utf-8"),
            "/* IAD_MODEL */": script_json(model),
            "/* IAD_SOURCES */": script_json(sources),
            "/* IAD_PLAYER */": (ASSETS / "player.js").read_text(encoding="utf-8"),
            "/* IAD_ROUTING */": (ASSETS / "routing.js").read_text(encoding="utf-8"),
            "/* IAD_LAYOUT */": (ASSETS / "layout.js").read_text(encoding="utf-8"),
            "/* IAD_PORTS */": (ASSETS / "ports.js").read_text(encoding="utf-8"),
            "/* IAD_VIEWER */": (ASSETS / "viewer.js").read_text(encoding="utf-8"),
            "/* IAD_PROJECT_NAME */": html.escape(project["config"]["name"], quote=True),
            "/* IAD_PROJECT_DESCRIPTION */": html.escape(f"IAD: интерактивная карта архитектуры {project['config']['name']} с маршрутами по исходному коду.", quote=True),
        }
        for marker in ("/* IAD_STYLES */", "/* IAD_PLAYER */", "/* IAD_ROUTING */", "/* IAD_LAYOUT */", "/* IAD_PORTS */", "/* IAD_VIEWER */", "/* IAD_SOURCES */", "/* IAD_MODEL */"):
            if marker not in template:
                raise ValueError(f"Viewer template lacks required marker {marker}")
        # One substitution pass: authored text containing a marker remains literal.
        pattern = "|".join(re.escape(marker) for marker in replacements)
        template = re.sub(pattern, lambda match: replacements[match.group()], template)
        generated = {
            "index.html": template,
            "model.json": json_text(model), "sources.json": json_text(sources),
            "manifest.json": json_text(manifest), "report.json": json_text(report),
        }
        root = Path(project["root"]).resolve()
        if root.is_relative_to(output_path) or any(output_path.is_relative_to((root / name).resolve()) for name in ("nodes", "edges", "contracts", "scenarios", "evidence")):
            raise ValueError("Output must be a separate build directory, not the authored project, an ancestor, or an entity directory")
        if any((output_path / filename).is_symlink() for filename in generated):
            raise ValueError("Refusing to overwrite a symlink at a generated file")
        inputs = _input_paths(project)
        for filename in generated:
            target = output_path / filename
            for name, source in inputs.items():
                if target.resolve() == source.resolve() or (target.exists() and source.exists() and target.samefile(source)):
                    raise ValueError(f"Generated file {filename!r} would overwrite authoring input {name!r}")
        output_path.mkdir(parents=True, exist_ok=True)
        for filename, content in generated.items():
            target = output_path / filename
            target.write_text(content, encoding="utf-8", newline="\n")
    except (OSError, ValueError) as exc:
        error = diagnostic("build.output", "build", str(exc))
        runtime_report["diagnostics"].append(error)
        runtime_report["errors"] += 1
        runtime_report["status"] = "error"
        return runtime_report
    runtime_report["files"] = list(generated)
    runtime_report["counts"] = {field: len(model[field]) for field in ("nodes", "edges", "contracts", "scenarios", "evidence")}
    return runtime_report
