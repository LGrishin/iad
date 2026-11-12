"""Comparisons preserve two real revisions and never rewrite authored diagrams."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from iadkit.comparison import build_comparison
from fixtures import git, project_fixture, write_json


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.project, self.checkout, _ = project_fixture(self.base, archive=True)
        self.root = self.base / "comparison"
        self.root.mkdir()
        self.kit = Path(__file__).resolve().parents[1]
        self.before_revision = self.project["config"]["repositories"][0]["revision"]
        after_text = "def run(value):\n    return value + 2\n"
        (self.checkout / "service.py").write_text(after_text, encoding="utf-8")
        git(self.checkout, "add", "service.py")
        git(self.checkout, "commit", "--quiet", "-m", "Increment by two")
        self.after_revision = git(self.checkout, "rev-parse", "HEAD")
        for side in ("before", "after"):
            destination = self.root / side
            shutil.copytree(self.project["root"], destination)
            config = self.read(destination / "project.json")
            config["repositories"][0]["path"] = os.path.relpath(self.checkout, destination)
            if side == "after":
                config["repositories"][0]["revision"] = self.after_revision
                evidence = self.read(destination / "evidence/main.json")
                evidence[0]["revision"] = self.after_revision
                write_json(destination / "evidence/main.json", evidence)
                scenarios = self.read(destination / "scenarios/main.json")
                scenarios[0]["steps"][0]["output"] = "Integer 3."
                write_json(destination / "scenarios/main.json", scenarios)
                write_json(destination / "snapshots.json", {
                    f"service@{self.after_revision}:service.py": {
                        "repo": "service", "revision": self.after_revision,
                        "path": "service.py", "text": after_text,
                        "sha256": hashlib.sha256(after_text.encode()).hexdigest(),
                    }
                })
            write_json(destination / "project.json", config)
        self.config = {
            "schemaVersion": 1, "id": "increment-change", "title": "Increment strategy",
            "summary": "The service now increments by two.", "before": "before", "after": "after",
            "changes": [{
                "id": "increment-size", "title": "Increase increment", "summary": "One becomes two.",
                "details": "The return expression changed in the selected commit.",
                "consequence": "Input 1 now returns 3.", "scenarioId": "run",
                "beforeSources": ["ev-run"], "afterSources": ["ev-run"],
                "beforeNodes": ["service"], "afterNodes": ["service"],
            }],
            "limitations": ["The scenario is a code explanation, not a recorded execution."],
        }
        self.write_comparison(self.config)

    @staticmethod
    def read(path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def write_comparison(self, value):
        write_json(self.root / "comparison.json", value)

    def run_cli(self, *arguments):
        return subprocess.run(
            [sys.executable, "-m", "iadkit", *map(str, arguments)],
            cwd=self.kit, capture_output=True, text=True, timeout=30,
        )

    def assert_error(self, result):
        self.assertEqual("error", result["status"], result)
        self.assertGreater(result["errors"], 0, result)
        self.assertTrue(result["diagnostics"], result)

    def test_overflowing_json_number_is_rejected_before_comparison_build(self):
        target = self.root / "comparison.json"
        text = json.dumps(self.config)
        for number in ("1e999", str(10**309)):
            with self.subTest(number=number):
                target.write_text(text[:-1] + ', "extensionNumber": ' + number + '}')
                result = build_comparison(self.root, strict=True)
                self.assert_error(result)
                self.assertTrue(any(i["code"] == "comparison.read" and "Non-finite" in i["message"]
                                    for i in result["diagnostics"]))
        self.assertFalse((self.root / "build").exists())

    def test_two_pinned_revisions_build_deterministically_and_embed_both_maps(self):
        output_a, output_b = self.root / "first", self.root / "second"
        first = build_comparison(self.root, output_a, strict=True)
        self.assertEqual("ok", first["status"], first)
        second = build_comparison(self.root, output_b, strict=True)
        self.assertEqual("ok", second["status"], second)
        paths_a = sorted(path.relative_to(output_a) for path in output_a.rglob("*") if path.is_file())
        paths_b = sorted(path.relative_to(output_b) for path in output_b.rglob("*") if path.is_file())
        self.assertEqual(paths_a, paths_b)
        for relative in paths_a:
            self.assertEqual((output_a / relative).read_bytes(), (output_b / relative).read_bytes(), relative)
            self.assertNotIn(self.temporary.name, (output_a / relative).read_text(encoding="utf-8"), relative)
        self.assertEqual(1, first["counts"]["changes"])
        self.assertEqual(2, first["counts"]["before"]["nodes"])
        self.assertEqual(1, first["counts"]["after"]["scenarios"])
        self.assertEqual(self.config, self.read(output_a / "comparison.json"))
        manifest = self.read(output_a / "manifest.json")
        self.assertEqual("IADComparison", manifest["format"])
        self.assertEqual(self.before_revision, manifest["before"]["revision"])
        self.assertEqual(self.after_revision, manifest["after"]["revision"])
        self.assertNotEqual(manifest["before"]["revision"], manifest["after"]["revision"])
        html = (output_a / "index.html").read_text(encoding="utf-8")
        embedded = re.search(r'<script id="iad-comparison-data" type="application/json">([\s\S]*?)</script>', html)
        self.assertIsNotNone(embedded)
        payload = json.loads(embedded.group(1))
        self.assertEqual(self.config, payload["config"])
        for side, revision in (("before", self.before_revision), ("after", self.after_revision)):
            self.assertEqual(revision, payload["models"][side]["manifest"]["revision"])
            self.assertIn('id="iad-model"', payload["documents"][side])
            self.assertIn("git-verified", payload["documents"][side])
            self.assertEqual(payload["documents"][side], (output_a / side / "index.html").read_text())

    def test_authored_html_and_template_markers_remain_data(self):
        hostile = '</title><script>window.__UNSAFE_COMPARISON__=1</script>'
        self.config["title"] = hostile
        self.config["summary"] = "/* IAD_PLAYER */ </script>"
        self.config["changes"][0]["details"] = hostile
        self.write_comparison(self.config)
        result = build_comparison(self.root, strict=True)
        self.assertEqual("ok", result["status"], result)
        html = (self.root / "build/index.html").read_text()
        self.assertNotIn(hostile, html)
        embedded = re.search(r'<script id="iad-comparison-data" type="application/json">([\s\S]*?)</script>', html)
        self.assertIsNotNone(embedded)
        config = json.loads(embedded.group(1))["config"]
        self.assertEqual(hostile, config["title"])
        self.assertEqual("/* IAD_PLAYER */ </script>", config["summary"])
        self.assertEqual(hostile, config["changes"][0]["details"])

    def test_change_sources_nodes_and_scenarios_must_exist_on_the_right_side(self):
        for field, value in (
            ("beforeSources", ["missing-before"]), ("afterSources", ["missing-after"]),
            ("beforeSources", []), ("afterSources", []),
            ("beforeNodes", ["missing-before"]), ("afterNodes", ["missing-after"]),
            ("scenarioId", "missing-scenario"),
        ):
            with self.subTest(field=field):
                config = deepcopy(self.config)
                config["changes"][0][field] = value
                self.write_comparison(config)
                self.assert_error(build_comparison(self.root, self.root / ("invalid-" + field)))

    def test_scenario_must_exist_on_both_sides(self):
        scenarios = self.read(self.root / "after/scenarios/main.json")
        scenarios[0]["id"] = "different"
        write_json(self.root / "after/scenarios/main.json", scenarios)
        view = self.read(self.root / "after/view.json")
        view["initialScenario"] = "different"
        write_json(self.root / "after/view.json", view)
        self.assert_error(build_comparison(self.root))

    def test_targets_must_match(self):
        config_path = self.root / "after/project.json"
        config = self.read(config_path)
        config["target"] = {"id": "different-target", "name": "Other target", "type": "repository"}
        write_json(config_path, config)
        self.assert_error(build_comparison(self.root))

    def test_comparison_source_paths_stay_inside_the_comparison_directory(self):
        for name in ("../project", str(self.project["root"])):
            with self.subTest(name=name):
                config = deepcopy(self.config)
                config["before"] = name
                self.write_comparison(config)
                self.assert_error(build_comparison(self.root))

    def test_source_symlink_cannot_escape_the_comparison_directory(self):
        (self.root / "outside").symlink_to(self.project["root"], target_is_directory=True)
        config = deepcopy(self.config)
        config["before"] = "outside"
        self.write_comparison(config)
        self.assert_error(build_comparison(self.root))

    def test_output_cannot_overwrite_authored_data_or_ancestor(self):
        original = (self.root / "comparison.json").read_bytes()
        side_original = (self.root / "before/project.json").read_bytes()
        for output in (self.root, self.root.parent, self.root / "before", self.root / "after/nodes/out"):
            with self.subTest(output=output):
                self.assert_error(build_comparison(self.root, output))
                self.assertEqual(original, (self.root / "comparison.json").read_bytes())
                self.assertEqual(side_original, (self.root / "before/project.json").read_bytes())

    def test_generated_index_symlink_cannot_replace_authored_file(self):
        output = self.root / "build"
        output.mkdir()
        authored = self.root / "comparison.json"
        before = authored.read_bytes()
        (output / "index.html").symlink_to(authored)
        self.assert_error(build_comparison(self.root))
        self.assertEqual(before, authored.read_bytes())

    def test_output_hardlinks_cannot_replace_either_version_or_comparison_inputs(self):
        for label, relative, authored in (
            ("side", "before/model.json", self.root / "before/project.json"),
            ("comparison", "manifest.json", self.root / "comparison.json"),
        ):
            with self.subTest(input=label):
                output = self.root / ("blocked-" + label)
                target = output / relative
                target.parent.mkdir(parents=True)
                target.hardlink_to(authored)
                (output / "index.html").write_text("Keep the previous comparison.")
                before = {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()}
                authored_before = authored.read_bytes()

                result = build_comparison(self.root, output, strict=True)

                self.assert_error(result)
                self.assertIn("comparison.output", [item["code"] for item in result["diagnostics"]])
                self.assertEqual(authored_before, authored.read_bytes())
                self.assertEqual(before, {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()})

    def test_output_cannot_enter_an_entity_directory_through_an_input_alias(self):
        output = self.root / "build"
        output.mkdir()
        nodes = self.root / "before/nodes"
        nodes.rename(output / "before")
        nodes.symlink_to(output / "before", target_is_directory=True)
        (output / "index.html").write_text("Keep the previous comparison.")
        before = {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()}

        result = build_comparison(self.root, strict=True)

        self.assert_error(result)
        self.assertIn("comparison.output", [item["code"] for item in result["diagnostics"]])
        self.assertEqual(before, {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()})

    def test_missing_and_malformed_comparison_files_return_reports(self):
        self.assert_error(build_comparison(self.base / "not-there"))
        (self.root / "comparison.json").write_text("{", encoding="utf-8")
        self.assert_error(build_comparison(self.root))

    def test_malformed_side_repositories_return_diagnostics_instead_of_traceback(self):
        path = self.root / "after/project.json"
        for value in (None, 3, "not-an-array"):
            with self.subTest(value=value):
                config = self.read(path)
                config["repositories"] = value
                write_json(path, config)
                self.assert_error(build_comparison(self.root))

    def test_review_warnings_are_preserved_and_strict_mode_fails(self):
        path = self.root / "after/evidence/main.json"
        evidence = self.read(path)
        evidence[0]["support"]["status"] = "unreviewed"
        write_json(path, evidence)
        normal = build_comparison(self.root)
        self.assertEqual("warning", normal["status"], normal)
        self.assertGreater(normal["warnings"], 0)
        strict = build_comparison(self.root, self.root / "strict", strict=True)
        self.assertEqual("error", strict["status"], strict)
        self.assertGreater(strict["warnings"], 0)

    def test_cli_compare_supports_repository_override_and_machine_report(self):
        for side in ("before", "after"):
            path = self.root / side / "project.json"
            config = self.read(path)
            config["repositories"][0]["path"] = "missing-local-checkout"
            write_json(path, config)
            (self.root / side / "snapshots.json").unlink()
        result = self.run_cli("compare", self.root, "--repo", "service=" + str(self.checkout), "--strict", "--json")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual("ok", report["status"], report)
        self.assertEqual(1, report["counts"]["changes"])
        self.assertTrue((self.root / "build/index.html").is_file())


if __name__ == "__main__":
    unittest.main()
