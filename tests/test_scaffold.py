"""The distributed kit stays empty; init fills metadata in an external copy."""

import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from iadkit.builder import build_project
from iadkit.cli import TEMPLATE_DIR, init_project
from iadkit.comparison import build_comparison
from iadkit.locations import toolkit_directory
from fixtures import project_fixture
from interactive_fixtures import comparison_fixture


class EmptyScaffoldTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project, self.checkout, _ = project_fixture(self.base)

    def test_distributed_template_contains_no_architecture_or_sources(self):
        config = json.loads((TEMPLATE_DIR / "project.json").read_text())
        self.assertEqual([], config["repositories"])
        for category in ("nodes", "edges", "contracts", "scenarios", "evidence"):
            files = list((TEMPLATE_DIR / category).glob("*.json"))
            self.assertTrue(files, category)
            for file in files:
                self.assertEqual([], json.loads(file.read_text()), str(file))
        for filename in ("model.json", "sources.json", "snapshots.json", "index.html"):
            self.assertFalse(list(TEMPLATE_DIR.rglob(filename)), filename)

    def test_checkout_does_not_ship_generated_diagrams(self):
        generated_names = {"project.json", "model.json", "sources.json", "snapshots.json", "comparison.json"}
        allowed = (TEMPLATE_DIR / "project.json").resolve()
        for file in toolkit_directory().rglob("*.json"):
            if ".git" in file.parts or file.resolve() == allowed:
                continue
            self.assertNotIn(file.name, generated_names, str(file))

    def test_init_uses_the_physical_template_and_only_injects_source_metadata(self):
        template = self.base / "template"
        shutil.copytree(TEMPLATE_DIR, template)
        view = json.loads((template / "view.json").read_text())
        view["theme"]["colors"] = {"--gold": "#998877"}
        (template / "view.json").write_text(json.dumps(view))
        destination = self.base / "new-diagram"
        with patch("iadkit.cli.TEMPLATE_DIR", template):
            result = init_project(destination, self.checkout, name="Requested project")
        self.assertEqual("ok", result["status"])
        self.assertEqual(view, json.loads((destination / "view.json").read_text()))
        config = json.loads((destination / "project.json").read_text())
        self.assertEqual("Requested project", config["name"])
        self.assertEqual(self.project["config"]["repositories"][0]["revision"], config["repositories"][0]["revision"])
        self.assertEqual([], json.loads((destination / "nodes/main.json").read_text()))
        self.assertEqual((template / "AUTHORING.md").read_bytes(), (destination / "AUTHORING.md").read_bytes())
        self.assertEqual("error", build_project(destination)["status"], "An empty scaffold is not a finished diagram")

    def test_filled_template_is_refused_before_creating_a_diagram(self):
        template = self.base / "filled-template"
        shutil.copytree(TEMPLATE_DIR, template)
        (template / "nodes/main.json").write_text('[{"id":"leftover-project"}]')
        destination = self.base / "should-not-exist"
        with patch("iadkit.cli.TEMPLATE_DIR", template):
            with self.assertRaisesRegex(ValueError, "empty entity arrays"):
                init_project(destination, self.checkout)
        self.assertFalse(destination.exists())

    def test_init_and_build_refuse_to_put_data_in_the_toolkit(self):
        destination = toolkit_directory() / "generated-data-probe"
        self.assertFalse(destination.exists())
        with self.assertRaisesRegex(ValueError, "outside the IAD toolkit"):
            init_project(destination, self.checkout)
        report = build_project(self.project["root"], output=destination)
        self.assertEqual("error", report["status"])
        self.assertTrue(any(item["code"] == "build.kit_directory" for item in report["diagnostics"]))
        self.assertFalse(destination.exists())

    def test_comparison_refuses_to_put_output_in_the_toolkit(self):
        comparison = comparison_fixture(self.base / "versions")
        destination = toolkit_directory() / "comparison-output-probe"
        self.assertFalse(destination.exists())
        report = build_comparison(comparison, output=destination)
        self.assertEqual("error", report["status"])
        self.assertTrue(any(item["code"] == "comparison.kit_directory" for item in report["diagnostics"]))
        self.assertFalse(destination.exists())
