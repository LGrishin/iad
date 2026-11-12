"""Compose two source-backed IAD projects into an offline comparison viewer.

Architecture interpretation stays in the two authored models and change notes.
The browser compares their snapshots with the same IADCore used by ordinary maps.
This module neither infers architecture from Git diff nor fabricates execution.
"""

import hashlib
import html
import json
from pathlib import Path, PurePosixPath
import re
import tempfile

from . import __version__
from .builder import ASSETS, _input_paths, build_project, inspect_project, json_text, script_json
from .jsonio import loads
from .schema import validate_schema
from .sources import diagnostic
from .locations import require_external_directory

COMPARISON_ASSETS = Path(__file__).with_name("comparison_assets")
SIDES = ("before", "after")


def _read_config(root):
    try:
        config = loads((root / "comparison.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        return None, [diagnostic("comparison.read", "comparison.json", str(exc))]
    return config, validate_schema(config, "comparison.schema.json", "comparison.json")


def _side_path(root, name):
    value = PurePosixPath(name)
    if "\\" in name or "\x00" in name or value.is_absolute() or ".." in value.parts or name != value.as_posix():
        raise ValueError("Version directories must use relative POSIX paths inside the comparison directory")
    result = (root / name).resolve()
    if result == root or not result.is_relative_to(root):
        raise ValueError("Version directories must be separate subdirectories inside the comparison directory")
    return result


def _status(diagnostics, strict):
    errors = sum(item["severity"] == "error" for item in diagnostics)
    warnings = sum(item["severity"] == "warning" for item in diagnostics)
    return {"status": "error" if errors or (strict and warnings) else "warning" if warnings else "ok", "errors": errors, "warnings": warnings, "strict": bool(strict), "diagnostics": diagnostics}


def build_comparison(path, output=None, strict=False, repo_overrides=None):
    """Build both versions and a self-contained comparison page.

    ``path`` is the directory containing comparison.json (or that file itself).
    Normal validation failures return diagnostics; no output is created for them.
    Side artifacts and their exact source snapshots are retained under before/after.
    """
    root = Path(path).expanduser().resolve()
    if root.name == "comparison.json" and root.is_file():
        root = root.parent
    destination = Path(output).expanduser().resolve() if output else root / "build"
    config, diagnostics = _read_config(root)
    try:
        require_external_directory(root, "Comparison data")
        require_external_directory(destination, "Comparison output")
    except ValueError as exc:
        diagnostics.append(diagnostic("comparison.kit_directory", "comparison.json", str(exc)))

    def report():
        return {**_status(diagnostics, strict), "output": str(destination)}

    if diagnostics:
        return report()
    directories = {}
    try:
        directories = {side: _side_path(root, config[side]) for side in SIDES}
        if directories["before"] == directories["after"] or any(directories[a].is_relative_to(directories[b]) for a, b in (("before", "after"), ("after", "before"))):
            raise ValueError("Before and after must be independent authoring directories")
        if root.is_relative_to(destination) or any(destination.is_relative_to(directory) or directory.is_relative_to(destination) for directory in directories.values()):
            raise ValueError("Output must be separate from the comparison root, its ancestors, and both authored versions")
    except (OSError, ValueError) as exc:
        diagnostics.append(diagnostic("comparison.path", "comparison.json", str(exc)))
        return report()

    projects = {}
    union_repositories = set()
    # Read each side once to resolve per-version override IDs without rejecting
    # repositories that exist in only one of the compared versions.
    from .project import load_project
    for side in SIDES:
        project = load_project(directories[side])
        repositories = project.get("config", {}).get("repositories", []) if isinstance(project.get("config"), dict) else []
        union_repositories.update(repo["id"] for repo in (repositories if isinstance(repositories, list) else []) if isinstance(repo, dict) and isinstance(repo.get("id"), str))
    for unknown in sorted(set(repo_overrides or {}) - union_repositories):
        diagnostics.append(diagnostic("comparison.repository", "repositories", f"Unknown repository override: {unknown}"))
    for side in SIDES:
        # inspect_project handles malformed authoring, reference validation,
        # semantic warnings and immutable source integrity.
        loaded = load_project(directories[side])
        repositories = loaded.get("config", {}).get("repositories", []) if isinstance(loaded.get("config"), dict) else []
        ids = {repo["id"] for repo in (repositories if isinstance(repositories, list) else []) if isinstance(repo, dict) and isinstance(repo.get("id"), str)}
        overrides = {key: value for key, value in (repo_overrides or {}).items() if key in ids}
        project, _evidence, _sources, side_report = inspect_project(directories[side], repo_overrides=overrides, strict=strict)
        projects[side] = (project, overrides)
        diagnostics.extend({**item, "path": f"{side}/{item['path']}"} for item in side_report["diagnostics"])
    if report()["status"] == "error":
        return report()

    targets = {side: projects[side][0]["config"].get("target", {"id": projects[side][0]["config"]["id"], "type": "repository"}) for side in SIDES}
    if (targets["before"]["id"], targets["before"].get("type")) != (targets["after"]["id"], targets["after"].get("type")):
        diagnostics.append(diagnostic("comparison.target", "comparison.json", "Both versions must describe the same target ID and type"))
    seen_changes = set()
    for index, change in enumerate(config["changes"]):
        at = f"comparison.json.changes[{index}]"
        if change["id"] in seen_changes:
            diagnostics.append(diagnostic("comparison.duplicate", at + ".id", "Change IDs must be unique"))
        seen_changes.add(change["id"])
        for side in SIDES:
            project = projects[side][0]
            scenarios = {scenario["id"] for scenario in project["scenarios"]}
            if change["scenarioId"] not in scenarios:
                diagnostics.append(diagnostic("comparison.scenario", at + ".scenarioId", f"Unknown {side} scenario: {change['scenarioId']}"))
            for suffix, category in (("Sources", "evidence"), ("Nodes", "nodes")):
                ids = {item["id"] for item in project[category]}
                field = side + suffix
                for item in change.get(field, []):
                    if item not in ids:
                        diagnostics.append(diagnostic("comparison.reference", at + "." + field, f"Unknown {side} {category} ID: {item}"))
    if report()["status"] == "error":
        return report()

    try:
        with tempfile.TemporaryDirectory(prefix="iad-comparison-") as temporary:
            staging = Path(temporary)
            models, documents, side_reports = {}, {}, {}
            for side in SIDES:
                side_report = build_project(directories[side], staging / side, strict=strict, repo_overrides=projects[side][1])
                side_reports[side] = side_report
                if side_report["status"] == "error":
                    diagnostics.extend({**item, "path": f"{side}/{item['path']}"} for item in side_report["diagnostics"])
                    return report()
                models[side] = json.loads((staging / side / "model.json").read_text(encoding="utf-8"))
                documents[side] = (staging / side / "index.html").read_text(encoding="utf-8")
            asset_hashes = {asset.name: hashlib.sha256(asset.read_bytes()).hexdigest() for asset in sorted(COMPARISON_ASSETS.glob("*")) if asset.is_file()}
            manifest = {
                "format": "IADComparison", "formatVersion": 1, "kitVersion": __version__,
                "id": config["id"], "title": config["title"],
                "before": models["before"]["manifest"], "after": models["after"]["manifest"],
                "inputs": {"comparison.json": hashlib.sha256((root / "comparison.json").read_bytes()).hexdigest()},
                "assets": asset_hashes,
                "models": {side: hashlib.sha256((staging / side / "model.json").read_bytes()).hexdigest() for side in SIDES},
            }
            template = (COMPARISON_ASSETS / "index.template.html").read_text(encoding="utf-8")
            replacements = {
                "/* IAD_COMPARISON_TITLE */": html.escape(config["title"], quote=True),
                "/* IAD_COMPARISON_STYLES */": (COMPARISON_ASSETS / "style.css").read_text(encoding="utf-8"),
                "/* IAD_COMPARISON_DATA */": script_json({"config": config, "models": models, "documents": documents}),
                "/* IAD_PLAYER */": (ASSETS / "player.js").read_text(encoding="utf-8"),
                "/* IAD_COMPARISON_VIEWER */": (COMPARISON_ASSETS / "viewer.js").read_text(encoding="utf-8"),
            }
            if any(marker not in template for marker in replacements):
                raise ValueError("Comparison template lacks required markers")
            template = re.sub("|".join(re.escape(marker) for marker in replacements), lambda match: replacements[match.group()], template)
            counts = {side: {key: len(models[side][key]) for key in ("nodes", "edges", "contracts", "scenarios", "evidence")} for side in SIDES}
            counts["changes"] = len(config["changes"])
            persisted_report = {**_status(diagnostics, strict), "counts": counts}
            generated = {"index.html": template, "comparison.json": json_text(config), "manifest.json": json_text(manifest), "report.json": json_text(persisted_report)}
            all_files = {name: value.encode("utf-8") for name, value in generated.items()}
            for side in SIDES:
                all_files.update({f"{side}/{item.name}": item.read_bytes() for item in sorted((staging / side).iterdir()) if item.is_file()})
            inputs = {"comparison.json": root / "comparison.json"}
            entity_directories = []
            for side in SIDES:
                project = projects[side][0]
                inputs.update((f"{side}/{name}", source) for name, source in _input_paths(project).items())
                entity_directories.extend((Path(project["root"]) / name).resolve() for name in ("nodes", "edges", "contracts", "scenarios", "evidence"))
            # Resolve every destination before writing; never follow an output
            # alias into authoring data, including aliases on the input side.
            for name in all_files:
                target = destination / name
                if target.is_symlink() or any(part.is_symlink() for part in target.parents if part != destination.parent):
                    raise ValueError("Refusing symlinked comparison output paths")
                if any(target.resolve().is_relative_to(directory) for directory in entity_directories):
                    raise ValueError("Comparison output must not enter an authored entity directory")
                for input_name, source in inputs.items():
                    if target.resolve() == source.resolve() or (target.exists() and source.exists() and target.samefile(source)):
                        raise ValueError(f"Generated file {name!r} would overwrite authoring input {input_name!r}")
            destination.mkdir(parents=True, exist_ok=True)
            for name, content in all_files.items():
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
    except (OSError, ValueError) as exc:
        diagnostics.append(diagnostic("comparison.output", "build", str(exc)))
        return report()
    return {**report(), "counts": counts, "files": sorted(all_files)}
