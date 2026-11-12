import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from iadkit.builder import build_project
from iadkit.sources import collect_sources
from fixtures import project_fixture, write_json


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project, self.checkout, self.archive = project_fixture(self.temporary.name, archive=True)
        self.root = self.project["root"]

    def test_build_is_deterministic_portable_and_has_provenance(self):
        first, second = self.root / "first", self.root / "second"
        report = build_project(self.root, first, strict=True)
        self.assertEqual("ok", report["status"], report)
        self.assertEqual("ok", build_project(self.root, second, strict=True)["status"])
        for path in first.iterdir():
            self.assertEqual(path.read_bytes(), (second / path.name).read_bytes(), path.name)
            self.assertNotIn(self.temporary.name, path.read_text(), path.name)
        manifest = json.loads((first / "manifest.json").read_text())
        self.assertIn("project.json", manifest["inputs"])
        self.assertEqual({"id":"fixture", "name":"Fixture"}, manifest["project"])
        self.assertEqual(self.project["view"], manifest["settings"])
        self.assertIn("viewer.js", manifest["assets"])
        self.assertIn("iadkit/builder.py", manifest["toolchain"])
        self.assertIn("iadkit/schemas/model.schema.json", manifest["toolchain"])
        self.assertEqual("iadkit/spec/iad-rules.md", manifest["kitRules"]["path"])
        self.assertEqual(64, len(manifest["kitRules"]["sha256"]))
        self.assertEqual("service", manifest["primaryRepository"])
        html = (first / "index.html").read_text()
        self.assertNotIn("/* IAD_MODEL */", html)
        self.assertIn("Fixture", html)

    def test_embedded_data_cannot_end_a_script_or_trigger_marker_replacement(self):
        self.project["nodes"][0]["details"] = "</script><script>/* IAD_MODEL */</script>"
        write_json(self.root / "nodes" / "main.json", self.project["nodes"])
        result = build_project(self.root)
        self.assertEqual("ok", result["status"], result)
        text = (self.root / "build" / "index.html").read_text()
        self.assertNotIn("</script><script>/* IAD_MODEL */", text)
        self.assertIn("\\u003c/script>\\u003cscript>/* IAD_MODEL */", text)

    def test_bad_reference_prevents_output(self):
        self.project["edges"][0]["to"] = "missing"
        write_json(self.root / "edges" / "main.json", self.project["edges"])
        result = build_project(self.root)
        self.assertEqual("error", result["status"])
        self.assertFalse((self.root / "build").exists())

    def test_malformed_compiled_integrity_is_rejected_before_output(self):
        evidence, snapshots, diagnostics = collect_sources(self.project)
        self.assertEqual([], diagnostics)
        evidence[0]["sourceIntegrity"]["status"] = "pretend-verified"
        with patch("iadkit.builder.collect_sources", return_value=(evidence, snapshots, [])):
            result = build_project(self.root)
        self.assertEqual("error", result["status"])
        self.assertGreater(result["errors"], 0)
        issues = [item for item in result["diagnostics"] if item["code"] == "build.model_schema"]
        self.assertTrue(issues, result)
        self.assertTrue(any("sourceIntegrity.status" in item["path"] for item in issues))
        self.assertFalse((self.root / "build").exists())

    def test_draft_is_buildable_and_strict_requires_review(self):
        self.project["evidence"][0]["support"]["status"] = "unreviewed"
        write_json(self.root / "evidence" / "main.json", self.project["evidence"])
        self.assertEqual("warning", build_project(self.root)["status"])
        result = build_project(self.root, self.root / "strict", strict=True)
        self.assertEqual("error", result["status"])
        self.assertGreater(result["warnings"], 0)
        self.assertFalse((self.root / "strict").exists())

    def test_unavailable_source_and_bad_rules_reference_return_error_reports(self):
        self.project["config"]["repositories"][0]["path"] = "missing-checkout"
        write_json(self.root / "project.json", self.project["config"])
        (self.root / "snapshots.json").unlink()
        result = build_project(self.root)
        self.assertEqual("error", result["status"])
        self.assertIn("source.unavailable", [item["code"] for item in result["diagnostics"]])
        self.project["config"]["repositories"][0]["path"] = "../checkout"
        self.project["config"]["rules"] = "missing-rules.md"
        write_json(self.root / "project.json", self.project["config"])
        result = build_project(self.root)
        self.assertEqual("warning", result["status"])
        self.assertIn("rules.unavailable", [item["code"] for item in result["diagnostics"]])
        self.assertEqual("error", build_project(self.root, strict=True)["status"])

    def test_build_cannot_overwrite_authoring_or_parent(self):
        for output in (self.root, self.root.parent, self.root / "nodes" / "nested"):
            with self.subTest(output=output):
                result = build_project(self.root, output)
                self.assertEqual("error", result["status"])
                self.assertIn("build.output", [item["code"] for item in result["diagnostics"]])

    def test_symlink_output_file_is_refused_without_touching_target(self):
        output = self.root / "build"
        output.mkdir()
        target = Path(self.temporary.name) / "keep.txt"
        target.write_text("keep")
        (output / "index.html").symlink_to(target)
        result = build_project(self.root)
        self.assertEqual("error", result["status"])
        self.assertEqual("keep", target.read_text())

    def test_default_output_cannot_replace_a_source_archive(self):
        output = self.root / "build"
        output.mkdir()
        archive = output / "model.json"
        (self.root / "snapshots.json").rename(archive)
        self.project["config"]["sourceArchive"] = "build/model.json"
        write_json(self.root / "project.json", self.project["config"])
        (output / "index.html").write_text("keep previous viewer")
        before = {path.name: path.read_bytes() for path in output.iterdir()}

        result = build_project(self.root)

        self.assertEqual("error", result["status"], result)
        self.assertIn("build.output", [item["code"] for item in result["diagnostics"]])
        self.assertEqual(before, {path.name: path.read_bytes() for path in output.iterdir()})

    def test_configured_archive_path_is_protected_even_when_absent(self):
        self.project["config"]["sourceArchive"] = "build/sources.json"
        write_json(self.root / "project.json", self.project["config"])

        result = build_project(self.root)

        self.assertEqual("error", result["status"], result)
        self.assertFalse((self.root / "build").exists())

    def test_explicit_output_cannot_replace_rules(self):
        output = self.root / "publication"
        output.mkdir()
        rules = output / "report.json"
        rules.write_text("Keep these authoring rules.\n")
        (output / "index.html").write_text("keep previous viewer")
        self.project["config"]["rules"] = "publication/report.json"
        write_json(self.root / "project.json", self.project["config"])
        before = {path.name: path.read_bytes() for path in output.iterdir()}

        result = build_project(self.root, output)

        self.assertEqual("error", result["status"], result)
        self.assertEqual(before, {path.name: path.read_bytes() for path in output.iterdir()})

    def test_input_aliases_cannot_be_overwritten(self):
        for alias in ("symlink", "hardlink"):
            with self.subTest(alias=alias):
                output = self.root / alias
                output.mkdir()
                source = self.root / "nodes" / "main.json"
                target = output / "model.json"
                if alias == "symlink":
                    source.rename(target)
                    source.symlink_to(target)
                else:
                    target.hardlink_to(source)
                (output / "index.html").write_text("keep previous viewer")
                before = {path.name: path.read_bytes() for path in output.iterdir()}

                result = build_project(self.root, output)

                self.assertEqual("error", result["status"], result)
                self.assertEqual(before, {path.name: path.read_bytes() for path in output.iterdir()})
                if alias == "symlink":
                    source.unlink()
                    target.rename(source)

    def test_output_cannot_enter_an_entity_directory_through_an_alias(self):
        nodes = self.root / "nodes"
        external = Path(self.temporary.name) / "external-nodes"
        nodes.rename(external)
        nodes.symlink_to(external, target_is_directory=True)
        before = {path.name: path.read_bytes() for path in external.iterdir()}

        result = build_project(self.root, external / "nested")

        self.assertEqual("error", result["status"], result)
        self.assertEqual(before, {path.name: path.read_bytes() for path in external.iterdir()})

    def test_external_json_symlinks_are_hashed_under_logical_input_names(self):
        names = ("project.json", "view.json", "nodes/main.json")
        external = {}
        for name in names:
            source = self.root / name
            target = Path(self.temporary.name) / (name.replace("/", "-") + ".external")
            source.rename(target)
            source.symlink_to(target)
            external[name] = target
        output = self.root / "build"
        self.assertEqual("ok", build_project(self.root)["status"])
        first = json.loads((output / "manifest.json").read_text())["inputs"]
        for name, target in external.items():
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), first[name])

        self.project["config"]["name"] = "Revised fixture"
        self.project["view"]["layout"] = {"columns": 2}
        self.project["nodes"][0]["role"] = "Starts a revised request."
        for name, value in zip(names, (self.project["config"], self.project["view"], self.project["nodes"])):
            write_json(external[name], value)
        self.assertEqual("ok", build_project(self.root)["status"])
        second = json.loads((output / "manifest.json").read_text())["inputs"]
        for name, target in external.items():
            self.assertNotEqual(first[name], second[name])
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), second[name])
        for path in output.iterdir():
            self.assertNotIn(self.temporary.name, path.read_text(), path.name)

    def test_absolute_rules_path_is_published_as_a_relative_path(self):
        rules = self.root / "AUTHORING.md"
        rules.write_text("Fixture authoring rules.\n")
        self.project["config"]["rules"] = str(rules)
        write_json(self.root / "project.json", self.project["config"])

        result = build_project(self.root)

        self.assertEqual("ok", result["status"], result)
        manifest = json.loads((self.root / "build" / "manifest.json").read_text())
        self.assertEqual("AUTHORING.md", manifest["rules"]["path"])
        self.assertIn("AUTHORING.md", manifest["inputs"])
        for path in (self.root / "build").iterdir():
            self.assertNotIn(self.temporary.name, path.read_text(), path.name)


if __name__ == "__main__":
    unittest.main()
