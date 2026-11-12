"""Local-only CLI; no network or LLM dependency is needed to build an IAD."""

import argparse
from collections import Counter
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from . import __version__
from .builder import build_project, inspect_project, json_text
from .comparison import build_comparison
from .locations import require_external_directory

TEMPLATE_DIR = Path(__file__).with_name("templates") / "project"


def _overrides(values):
    result = {}
    for value in values:
        if "=" not in value:
            raise ValueError("Repository override must be ID=PATH")
        key, path = value.split("=", 1)
        if not key or not path or key in result:
            raise ValueError("Repository override must have a unique nonempty ID and path")
        result[key] = path
    return result


def init_project(destination, repository, name=None, revision="HEAD"):
    """Pin a repository and create empty authoring files, without inventing facts."""
    destination = require_external_directory(destination, "Diagram data")
    source = Path(repository).expanduser().resolve()
    if destination.is_symlink() or (destination.exists() and any(destination.iterdir())):
        raise ValueError("Destination must be absent or an empty directory")
    try:
        resolved = subprocess.run(["git", "-C", str(source), "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"], capture_output=True, text=True, timeout=20, check=False)
        top = subprocess.run(["git", "-C", str(source), "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError("Cannot inspect the source Git repository") from exc
    if resolved.returncode or top.returncode or Path(top.stdout.strip()).resolve() != source:
        raise ValueError("--repo must point to a Git repository root containing the requested revision")
    sha = resolved.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha):
        raise ValueError("Git did not resolve a full commit object ID")
    name = name or destination.name
    project_id = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-.") or "project"
    config = json.loads((TEMPLATE_DIR / "project.json").read_text(encoding="utf-8"))
    for category in ("nodes", "edges", "contracts", "scenarios", "evidence"):
        files = list((TEMPLATE_DIR / category).glob("*.json"))
        if not files or any(json.loads(file.read_text(encoding="utf-8")) != [] for file in files):
            raise ValueError("The shared authoring template must contain only empty entity arrays")
    if config.get("repositories"):
        raise ValueError("The shared authoring template must not contain source repositories")
    config.update({
        "schemaVersion": 1, "id": project_id, "name": name,
        "primaryRepository": project_id,
        "repositories": [{"id": project_id, "path": os.path.relpath(source, destination), "revision": sha, "included": True, "scope": "repository"}],
    })
    shutil.copytree(TEMPLATE_DIR, destination, dirs_exist_ok=True)
    (destination / "project.json").write_text(json_text(config), encoding="utf-8")
    return {"status": "ok", "project": str(destination), "revision": sha}


def _print_report(report, as_json=False):
    if as_json:
        print(json_text(report), end="")
        return
    diagnostics = report.get("diagnostics", [])
    shown = diagnostics[:20]
    for item in shown:
        print(f"{item['severity'].upper()} {item['code']} {item['path']}: {item['message']}")
    if len(diagnostics) > len(shown):
        counts = Counter(item["code"] for item in diagnostics[len(shown):])
        print(f"... {len(diagnostics) - len(shown)} more diagnostics ({', '.join(f'{code}: {count}' for code, count in sorted(counts.items()))}). Use iad validate <project> --json for the full report.")
    print(f"IAD {report['status']}: {report.get('errors', 0)} errors, {report.get('warnings', 0)} warnings")
    if report["status"] != "error" and report.get("output"):
        print(f"Viewer: {Path(report['output']) / 'index.html'}")


def _parser():
    parser = argparse.ArgumentParser(prog="iad", description="Create, validate, build and locally preview source-backed IAD projects.")
    parser.add_argument("--version", action="version", version=f"IAD Kit {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Create an empty authoring scaffold pinned to a real repository revision")
    init.add_argument("destination")
    init.add_argument("--repo", required=True, help="Source Git repository root")
    init.add_argument("--name")
    init.add_argument("--revision", default="HEAD")
    compare = commands.add_parser("compare", help="Build an offline architecture comparison from two authored versions")
    compare.add_argument("project", help="Directory containing comparison.json")
    compare.add_argument("--repo", action="append", default=[], metavar="ID=PATH")
    compare.add_argument("--strict", action="store_true")
    compare.add_argument("--json", action="store_true")
    compare.add_argument("-o", "--output")
    for name in ("validate", "build", "preview"):
        command = commands.add_parser(name)
        command.add_argument("project")
        command.add_argument("--repo", action="append", default=[], metavar="ID=PATH", help="Override a local checkout path without changing project data")
        command.add_argument("--strict", action="store_true", help="Fail on semantic-review warnings as well as errors")
        if name != "preview":
            command.add_argument("--json", action="store_true", help="Print a machine-readable report")
        if name in {"build", "preview"}:
            command.add_argument("-o", "--output")
        if name == "preview":
            command.add_argument("--port", type=int, default=8000)
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    try:
        if args.command == "init":
            result = init_project(args.destination, args.repo, args.name, args.revision)
            print(f"Created authoring scaffold: {result['project']}\nPinned revision: {result['revision']}\nFill nodes and scenarios, then run iad validate.")
            return 0
        overrides = _overrides(args.repo)
        if args.command == "compare":
            report = build_comparison(args.project, output=args.output, repo_overrides=overrides, strict=args.strict)
        elif args.command == "validate":
            _, _, _, report = inspect_project(args.project, repo_overrides=overrides, strict=args.strict)
        else:
            report = build_project(args.project, output=args.output, repo_overrides=overrides, strict=args.strict)
        _print_report(report, getattr(args, "json", False))
        if report["status"] == "error":
            return 1
        if args.command == "preview":
            if not 0 <= args.port <= 65535:
                raise ValueError("Port must be in the range 0..65535")
            handler = functools.partial(SimpleHTTPRequestHandler, directory=report["output"])
            with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
                print(f"Open http://127.0.0.1:{server.server_port}/ in Chrome. Press Ctrl+C to stop.", flush=True)
                try:
                    server.serve_forever()
                except KeyboardInterrupt:
                    pass
        return 0
    except (OSError, ValueError) as exc:
        message = {"status": "error", "errors": 1, "warnings": 0, "diagnostics": [{"severity": "error", "code": "cli.input", "path": "command", "message": str(exc)}]}
        _print_report(message, getattr(args, "json", False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
