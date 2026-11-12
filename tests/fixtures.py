"""Small real Git fixtures: no fabricated revision or source-integrity status."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def git(path, *args):
    env = {**os.environ, "GIT_AUTHOR_NAME": "IAD fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_NAME": "IAD fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid", "GIT_AUTHOR_DATE": "2025-01-01T00:00:00+00:00", "GIT_COMMITTER_DATE": "2025-01-01T00:00:00+00:00"}
    return subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, check=True, env=env).stdout.strip()


def project_fixture(directory, archive=False):
    base = Path(directory)
    checkout, root = base / "checkout", base / "project"
    checkout.mkdir()
    root.mkdir()
    text = "def run(value):\n    return value + 1\n"
    (checkout / "service.py").write_text(text, encoding="utf-8")
    git(checkout, "init", "--quiet")
    git(checkout, "add", "service.py")
    git(checkout, "commit", "--quiet", "-m", "fixture")
    revision = git(checkout, "rev-parse", "HEAD")
    config = {"schemaVersion": 1, "id": "fixture", "name": "Fixture", "primaryRepository": "service", "repositories": [{"id": "service", "path": "../checkout", "revision": revision, "webUrlTemplate": "https://code.example.invalid/source/{revision}/{path}#L{line}"}], "limitations": []}
    evidence = [{"id": "ev-run", "repo": "service", "revision": revision, "path": "service.py", "line": 1, "symbol": "run", "support": {"kind": "callsite", "status": "reviewed", "note": "The fixture invokes run directly in its one-step scenario."}}]
    data = {
        "config": config, "view": {"rootOrder": ["caller", "service"], "initialScenario": "run"},
        "nodes": [{"id": "caller", "label": "Caller", "role": "Starts the request.", "sources": ["ev-run"]}, {"id": "service", "label": "Service", "role": "Increments an integer.", "sources": ["ev-run"]}],
        "edges": [{"id": "call", "from": "caller", "to": "service", "label": "Increment", "kind": "call", "sources": ["ev-run"], "verification": {"status": "reviewed"}}],
        "contracts": [{"id": "increment", "node": "service", "name": "Increment", "description": "Return the next integer.", "sources": ["ev-run"], "operations": [{"name": "run(value)", "description": "Add one to value.", "input": "An integer value.", "output": "The incremented integer.", "errors": "No expected errors.", "sources": ["ev-run"]}]}],
        "scenarios": [{"id": "run", "title": "Increment a value", "goal": "Return the next integer.", "entry": "increment", "basis": "code", "steps": [{"id": "increment", "from": "caller", "to": "service", "title": "Increment", "input": "Integer 1.", "action": "Call run(1).", "output": "Integer 2.", "next": None, "sources": ["ev-run"], "contracts": ["increment"], "verification": {"status": "reviewed"}}]}],
        "evidence": evidence, "root": root,
    }
    write_json(root / "project.json", config)
    write_json(root / "view.json", data["view"])
    for category in ("nodes", "edges", "contracts", "scenarios", "evidence"):
        write_json(root / category / "main.json", data[category])
    snapshots = {f"service@{revision}:service.py": {"repo": "service", "revision": revision, "path": "service.py", "text": text, "sha256": hashlib.sha256(text.encode()).hexdigest()}}
    if archive:
        write_json(root / "snapshots.json", snapshots)
    return data, checkout, snapshots
