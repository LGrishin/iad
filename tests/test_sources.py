from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from iadkit.sources import collect_sources
from fixtures import git, project_fixture, write_json


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project, self.checkout, self.archive = project_fixture(self.temporary.name, archive=True)

    def test_git_uses_pinned_blob_despite_dirty_worktree_and_preserves_support(self):
        (self.checkout / "service.py").write_text("uncommitted changes\n")
        evidence, snapshots, diagnostics = collect_sources(self.project)
        self.assertEqual([], diagnostics)
        self.assertEqual("git-verified", evidence[0]["sourceIntegrity"]["status"])
        self.assertEqual(self.archive, snapshots)
        self.assertEqual(self.project["evidence"][0]["support"], evidence[0]["support"])
        self.assertNotIn("confirmed", evidence[0])

    def test_archive_fallback_has_distinct_integrity_status(self):
        self.project["config"]["repositories"][0]["path"] = "missing-checkout"
        evidence, snapshots, diagnostics = collect_sources(self.project)
        self.assertFalse(diagnostics)
        self.assertEqual("archive-verified", evidence[0]["sourceIntegrity"]["status"])
        self.assertEqual(self.archive, snapshots)

    def test_archive_tamper_is_error_even_when_git_is_available(self):
        next(iter(self.archive.values()))["text"] += "tampered\n"
        write_json(self.project["root"] / "snapshots.json", self.archive)
        _, _, diagnostics = collect_sources(self.project)
        self.assertIn("archive.hash", [item["code"] for item in diagnostics])

    def test_self_consistent_archive_cannot_disagree_with_available_git(self):
        record = next(iter(self.archive.values()))
        record["text"] += "tampered\n"
        record["sha256"] = hashlib.sha256(record["text"].encode()).hexdigest()
        write_json(self.project["root"] / "snapshots.json", self.archive)
        _, _, diagnostics = collect_sources(self.project)
        self.assertIn("archive.git_mismatch", [item["code"] for item in diagnostics])

    def test_archive_cannot_hide_missing_file_at_available_revision(self):
        ev = self.project["evidence"][0]
        ev["path"] = "removed.py"
        record = deepcopy(next(iter(self.archive.values())))
        record["path"] = "removed.py"
        write_json(self.project["root"] / "snapshots.json", {f"service@{ev['revision']}:removed.py": record})
        evidence, _, diagnostics = collect_sources(self.project)
        self.assertEqual("unavailable", evidence[0]["sourceIntegrity"]["status"])
        self.assertIn("source.missing", [item["code"] for item in diagnostics])

    def test_git_tree_listing_is_not_accepted_as_a_source_file(self):
        directory = self.checkout / "src"
        directory.mkdir()
        (directory / "child.py").write_text("value = 1\n")
        git(self.checkout, "add", "src/child.py")
        git(self.checkout, "commit", "--quiet", "-m", "nested source")
        revision = git(self.checkout, "rev-parse", "HEAD")
        self.project["config"]["repositories"][0]["revision"] = revision
        self.project["evidence"][0].update({"revision": revision, "path": "src"})
        evidence, _, diagnostics = collect_sources(self.project)
        self.assertEqual("unavailable", evidence[0]["sourceIntegrity"]["status"])
        self.assertIn("source.missing", [item["code"] for item in diagnostics])

    def test_line_is_checked_against_exact_snapshot(self):
        self.project["evidence"][0]["line"] = 100
        _, _, diagnostics = collect_sources(self.project)
        self.assertIn("source.line", [item["code"] for item in diagnostics])

    def test_source_lines_use_lf_boundaries_and_exclude_the_trailing_empty_line(self):
        (self.project["root"] / "snapshots.json").unlink()
        cases = [
            ("message = 'alpha\u2028beta\fformfeed\u0085next'\n", 1),
            ("first\rsecond\nthird\n", 2),
            ("first\r\nsecond\r\n", 2),
            ("first\nsecond", 2),
            ("", 0),
        ]
        for index, (text, count) in enumerate(cases):
            (self.checkout / "service.py").write_bytes(text.encode("utf-8"))
            git(self.checkout, "add", "service.py")
            git(self.checkout, "commit", "--quiet", "-m", f"Source line boundaries {index}")
            revision = git(self.checkout, "rev-parse", "HEAD")
            self.project["config"]["repositories"][0]["revision"] = revision
            self.project["evidence"][0]["revision"] = revision
            for line, valid in ((count, count > 0), (count + 1, False)):
                with self.subTest(text=repr(text), line=line):
                    self.project["evidence"][0]["line"] = line
                    _, _, diagnostics = collect_sources(self.project)
                    self.assertEqual(not valid, any(i["code"] == "source.line" for i in diagnostics), diagnostics)

    def test_archive_rejects_overflow_and_duplicate_json_properties(self):
        target = self.project["root"] / "snapshots.json"
        for text in ('{"extension": 1e999}', '{"extension": ' + str(10**309) + '}',
                     '{"extension": 1, "extension": 2}'):
            with self.subTest(text=text):
                target.write_text(text)
                _, _, diagnostics = collect_sources(self.project)
                self.assertIn("archive.read", [item["code"] for item in diagnostics])

    def test_missing_pinned_source_cannot_be_claimed_as_verified(self):
        self.project["config"]["repositories"][0]["path"] = "missing-checkout"
        (self.project["root"] / "snapshots.json").unlink()
        evidence, snapshots, diagnostics = collect_sources(self.project)
        self.assertEqual({}, snapshots)
        self.assertEqual("unavailable", evidence[0]["sourceIntegrity"]["status"])
        self.assertIn("source.unavailable", [item["code"] for item in diagnostics])

    def test_archive_identity_cannot_be_relabelled(self):
        record = next(iter(self.archive.values()))
        record["repo"] = "different"
        write_json(self.project["root"] / "snapshots.json", self.archive)
        _, _, diagnostics = collect_sources(self.project)
        self.assertIn("archive.identity", [item["code"] for item in diagnostics])

    def test_revision_and_path_must_match_pinned_identity(self):
        self.project["evidence"][0]["revision"] = "f" * 40
        _, _, diagnostics = collect_sources(self.project)
        self.assertIn("source.revision", [item["code"] for item in diagnostics])
        self.project["evidence"][0]["revision"] = self.project["config"]["repositories"][0]["revision"]
        self.project["evidence"][0]["path"] = "../secret.py"
        _, _, diagnostics = collect_sources(self.project)
        self.assertIn("source.path", [item["code"] for item in diagnostics])

    def test_unsafe_link_template_is_rejected_and_no_link_is_invented(self):
        repository = self.project["config"]["repositories"][0]
        repository["webUrlTemplate"] = "javascript:alert({line})"
        evidence, _, diagnostics = collect_sources(self.project)
        self.assertIsNone(evidence[0]["url"])
        self.assertIn("source.url", [item["code"] for item in diagnostics])
        del repository["webUrlTemplate"]
        evidence, _, diagnostics = collect_sources(self.project)
        self.assertIsNone(evidence[0]["url"])
        self.assertFalse(diagnostics)

    def test_repository_override_resolves_missing_local_checkout(self):
        self.project["config"]["repositories"][0]["path"] = "missing"
        evidence, _, diagnostics = collect_sources(self.project, {"service": self.checkout})
        self.assertFalse(diagnostics)
        self.assertEqual("git-verified", evidence[0]["sourceIntegrity"]["status"])
        _, _, diagnostics = collect_sources(self.project, {"unknown": self.checkout})
        self.assertIn("source.override", [item["code"] for item in diagnostics])

    def test_moving_branch_and_incomplete_source_url_templates_are_rejected(self):
        repository = self.project["config"]["repositories"][0]
        for template in (
            "https://code.example.invalid/source/main/{path}#L{line}",
            "https://code.example.invalid/source/{revision}/service.py#L{line}",
            "https://code.example.invalid/source/{revision}/{path}",
        ):
            with self.subTest(template=template):
                repository["webUrlTemplate"] = template
                evidence, _, diagnostics = collect_sources(self.project)
                self.assertIsNone(evidence[0]["url"])
                self.assertIn("source.url", [item["code"] for item in diagnostics])


if __name__ == "__main__":
    unittest.main()
