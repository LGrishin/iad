import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from iadkit.cli import init_project, main
from fixtures import project_fixture


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project, self.checkout, _ = project_fixture(self.temporary.name)
        self.kit_root = Path(__file__).resolve().parents[1]

    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-m", "iadkit", *map(str, args)], cwd=self.kit_root, capture_output=True, text=True, timeout=30)

    def test_init_pins_real_revision_without_fabricating_graph(self):
        destination = Path(self.temporary.name) / "new-project"
        result = self.run_cli("init", destination, "--repo", self.checkout, "--name", "New Service")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        config = json.loads((destination / "project.json").read_text())
        self.assertEqual(self.project["config"]["repositories"][0]["revision"], config["repositories"][0]["revision"])
        self.assertEqual([], json.loads((destination / "nodes" / "main.json").read_text()))
        result = self.run_cli("validate", destination, "--json")
        self.assertEqual(1, result.returncode)
        self.assertEqual("error", json.loads(result.stdout)["status"])

    def test_init_refuses_nonempty_destination(self):
        with self.assertRaisesRegex(ValueError, "empty"):
            init_project(self.project["root"], self.checkout)

    def test_build_json_and_argument_failures_have_useful_exit_codes(self):
        result = self.run_cli("build", self.project["root"], "--json", "--strict")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual("ok", json.loads(result.stdout)["status"])
        result = self.run_cli("validate", self.project["root"], "--repo", "invalid", "--json")
        self.assertEqual(1, result.returncode)
        self.assertEqual("cli.input", json.loads(result.stdout)["diagnostics"][0]["code"])

    def test_version_and_help_work_without_source_repository(self):
        self.assertEqual(0, self.run_cli("--help").returncode)
        self.assertIn("0.1.0", self.run_cli("--version").stdout)

    def test_validate_and_build_reject_overflow_at_the_input_file(self):
        target = self.project["root"] / "nodes/main.json"
        text = target.read_text()
        for number in ("1e999", str(10**309)):
            target.write_text(text.replace('"id": "caller"', '"extensionNumber": ' + number + ', "id": "caller"'))
            for command in ("validate", "build"):
                with self.subTest(command=command, number=number):
                    result = self.run_cli(command, self.project["root"], "--strict", "--json")
                    self.assertEqual(1, result.returncode, result.stdout + result.stderr)
                    report = json.loads(result.stdout)
                    self.assertEqual("error", report["status"])
                    self.assertTrue(any(i["code"] == "file.json" and i["path"] == "nodes/main.json"
                                        for i in report["diagnostics"]), report)
        self.assertFalse((self.project["root"] / "build").exists())


if __name__ == "__main__":
    unittest.main()
