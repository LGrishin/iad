#!/usr/bin/env python3
"""Build transient source-backed fixtures and exercise the generic framework.

Nothing is generated in the toolkit. Source checkouts, authoring data, builds,
Chrome profiles, screenshots, and browser reports are removed on completion.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))

from iadkit.builder import build_project
from iadkit.comparison import build_comparison
from interactive_fixtures import comparison_fixture, hierarchy_fixture, interactive_fixture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", action="store_true", help="Also run offline desktop/mobile Chrome integration checks (Node 22+).")
    args = parser.parse_args()
    for executable in ("git", "node"):
        if not shutil.which(executable):
            parser.error(f"{executable} is required")

    with tempfile.TemporaryDirectory(prefix="iad-smoke-") as temporary:
        base = Path(temporary)
        artifacts = base / "artifacts"
        artifacts.mkdir()
        env = {**os.environ, "TMPDIR": str(artifacts)}
        flat = [interactive_fixture(base / "first", "synthetic-first")[0],
                interactive_fixture(base / "second", "synthetic-second", with_observer=True)[0]]
        compound = hierarchy_fixture(base / "nested")
        comparison = comparison_fixture(base / "versions")
        for project in [*flat, compound]:
            report = build_project(project, strict=True)
            if report["status"] != "ok":
                raise RuntimeError(json.dumps(report, indent=2))
            model = json.loads((project / "build/model.json").read_text())
            assert all(anchor["sourceIntegrity"]["status"] == "git-verified" for anchor in model["evidence"])
            print(f"PASS strict temporary build: {model['manifest']['target']['id']}", flush=True)
        report = build_comparison(comparison, strict=True)
        if report["status"] != "ok":
            raise RuntimeError(json.dumps(report, indent=2))
        print("PASS strict temporary comparison: two real Git commits", flush=True)

        def run(script, *arguments):
            subprocess.run(["node", str(KIT / "tests" / script), *map(str, arguments)], cwd=KIT, env=env, check=True)

        run("player.mjs")
        run("layout.mjs")
        run("ports.mjs")
        for project in [*flat, compound]:
            run("routing.mjs", project / "build/model.json")
        if args.browser:
            run("browser.mjs", *(project / "build/index.html" for project in flat))
            run("hierarchy-browser.mjs", compound / "build/index.html")
            run("comparison-browser.mjs", comparison / "build/index.html")
    print("PASS generic smoke checks; all generated fixtures and artifacts removed.")


if __name__ == "__main__":
    main()
