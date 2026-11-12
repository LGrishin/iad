import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from iadkit.project import load_project, validate_project
from iadkit.schema import SchemaDefinitionError, validate_schema

SHA = "d" * 40


def fixture():
    return {
        "root": Path("."),
        "config": {"schemaVersion": 1, "id": "sample", "name": "Sample", "primaryRepository": "source", "repositories": [{"id": "source", "path": "./src", "revision": SHA}]},
        "view": {"rootOrder": ["app"], "initialScenario": "run"},
        "nodes": [{"id": "app", "label": "Application", "role": "Accepts requests.", "sources": ["ev"]}, {"id": "service", "parent": "app", "kind": "class", "label": "Service", "role": "Completes a request.", "sources": ["ev"]}],
        "edges": [{"id": "call", "from": "app", "to": "service", "label": "Complete request", "kind": "call", "sources": ["ev"], "verification": {"status": "reviewed"}}],
        "contracts": [{"id": "api", "node": "service", "name": "Service API", "operations": [{"name": "complete(request)", "description": "Completes the request.", "input": "Request data.", "output": "Completion status.", "sources": ["ev"]}]}],
        "evidence": [{"id": "ev", "repo": "source", "revision": SHA, "path": "service.py", "line": 1, "symbol": "complete", "support": {"kind": "callsite", "status": "reviewed"}}],
        "scenarios": [{"id": "run", "title": "Complete a request", "goal": "Trace the completion.", "entry": "call", "steps": [{"id": "call", "from": "app", "to": "service", "title": "Call service", "input": "Request.", "action": "Invoke complete(request).", "output": "Status.", "next": None, "contracts": ["api"], "sources": ["ev"], "verification": {"status": "reviewed"}}]}],
    }


def codes(project):
    return {issue["code"] for issue in validate_project(project)}


def repository_set_fixture():
    project = fixture()
    project["config"]["target"] = {"id": "platform", "name": "Platform", "type": "repository-set"}
    project["config"]["repositories"][0]["included"] = True
    project["config"]["repositories"].append({"id": "backend", "path": "./backend", "revision": "b" * 40, "included": True, "scope": "repository"})
    project["nodes"][0]["parent"] = "client"
    project["nodes"][1]["parent"] = "server"
    project["nodes"].extend([
        {"id": "client", "kind": "repository", "repository": "source", "label": "Client", "role": "Owns the user interface.", "sources": ["ev"]},
        {"id": "server", "kind": "repository", "repository": "backend", "label": "Server", "role": "Completes remote operations.", "sources": ["ev"]},
        {"id": "widget", "parent": "client", "kind": "component", "label": "Widget", "role": "Collects request input.", "sources": ["ev"]},
        {"id": "store", "parent": "server", "kind": "component", "label": "Store", "role": "Keeps request results.", "sources": ["ev"]},
        {"id": "person", "kind": "actor", "label": "Person", "role": "Starts the action.", "sources": ["ev"]},
    ])
    for identifier, start, end in [("collect", "app", "widget"), ("persist", "service", "store")]:
        edge = copy.deepcopy(project["edges"][0])
        edge.update(id=identifier, **{"from": start, "to": end})
        project["edges"].append(edge)
    project["scenarios"][0].update(scope=None, trigger={"kind": "user", "label": "Press Complete", "sources": ["ev"]})
    for scope in ("client", "server"):
        scenario = copy.deepcopy(project["scenarios"][0])
        scenario.update(id=f"{scope}-run", scope=scope, trigger={"kind": "internal", "label": "Handle request"})
        project["scenarios"].append(scenario)
    project["view"].update(rootOrder=["client", "server", "person"], initialScope=None)
    return project


class ProjectValidationTests(unittest.TestCase):
    def test_data_and_artifact_categories_are_not_participants(self):
        for kind in ("config", "configuration", "Settings", "schema", "dto", "payload",
                     "parameter", "data", "data_object", "artifact", "file", "directory",
                     "path", "example", "example-instance", "instance", "environment"):
            with self.subTest(kind=kind):
                project = fixture()
                project["nodes"][1]["kind"] = kind
                diagnostics = validate_project(project)
                self.assertTrue(any(item["code"] == "architecture.non_participant"
                                    and item["path"] == "nodes[1].kind" for item in diagnostics))

    def test_component_names_and_extension_points_are_not_artifact_heuristics(self):
        project = fixture()
        project["nodes"][0].update(kind="component", label="ConfigService")
        project["nodes"][0]["ownedData"] = [{"name": "Settings", "description": "Configuration input.", "sources": ["ev"]}]
        project["nodes"][1].update(kind="extension-point", label="Strategy")
        project["scenarios"][0]["steps"][0]["input"] = "Settings loaded from a YAML file."
        self.assertEqual(validate_project(project), [])

    def test_build_refuses_artifact_participant_in_both_modes(self):
        from fixtures import project_fixture, write_json
        from iadkit.builder import build_project
        for strict in (False, True):
            with self.subTest(strict=strict), tempfile.TemporaryDirectory() as temp:
                project, _, _ = project_fixture(temp)
                project["nodes"][1]["kind"] = "settings"
                write_json(project["root"] / "nodes" / "main.json", project["nodes"])
                report = build_project(project["root"], strict=strict)
                self.assertEqual(report["status"], "error")
                self.assertTrue(any(item["code"] == "architecture.non_participant" for item in report["diagnostics"]))
                self.assertFalse((project["root"] / "build" / "index.html").exists())

    def test_api_endpoint_contract_references_and_ownership(self):
        project = fixture()
        project["edges"][0]["targetContract"] = "api"
        project["scenarios"][0]["steps"][0]["targetContract"] = "api"
        self.assertEqual(validate_project(project), [])
        project["edges"][0]["sourceContract"] = "api"
        self.assertIn("api.contract_owner", codes(project))
        project["edges"][0]["sourceContract"] = "unknown"
        self.assertIn("ref.contract", codes(project))
        project["edges"][0].pop("sourceContract")
        project["edges"][0]["contracts"] = ["unknown"]
        self.assertIn("ref.contract", codes(project))

    def test_enclosing_api_allowed_and_malformed_api_reference_rejected(self):
        project = fixture()
        project["contracts"][0]["node"] = "app"
        project["edges"][0]["targetContract"] = "api"
        self.assertEqual(validate_project(project), [])
        project["scenarios"][0]["steps"][0]["sourceContract"] = ["api"]
        self.assertIn("schema", codes(project))

    def test_reviewed_project_is_clean_without_source_io(self):
        self.assertEqual(validate_project(fixture()), [])

    def test_invalid_enum_and_boolean_integer_rejected(self):
        project = fixture()
        project["evidence"][0]["support"]["kind"] = "file-exists"
        project["evidence"][0]["line"] = True
        errors = validate_project(project)
        self.assertTrue(any(i["code"] == "schema" and i["path"].endswith("support.kind") for i in errors))
        self.assertTrue(any(i["code"] == "schema" and i["path"].endswith(".line") for i in errors))

    def test_malformed_entity_rejected_without_crashing_references(self):
        project = fixture()
        project["nodes"].extend([None, "wrong", {"id": ["unhashable"]}])
        project["scenarios"][0]["steps"].extend([None, {"id": "broken", "branch": {"options": [None, 7]}}])
        self.assertIn("schema", codes(project))

    def test_wrong_scalar_types_stop_before_graph_checks(self):
        for bad in ({}, [], ["unhashable"]):
            mutations = [
                ("edges", 0, "kind"), ("edges", 0, "from"),
                ("evidence", 0, "repo"), ("nodes", 0, "id"),
                ("scenarios", 0, "entry"),
            ]
            for category, index, field in mutations:
                with self.subTest(category=category, field=field, bad=bad):
                    project = fixture()
                    project[category][index][field] = copy.deepcopy(bad)
                    self.assertIn("schema", codes(project))
            project = fixture()
            project["scenarios"][0]["steps"][0]["kind"] = copy.deepcopy(bad)
            project["evidence"][0]["support"]["kind"] = copy.deepcopy(bad)
            self.assertIn("schema", codes(project))

    def test_build_reports_wrong_kind_type_instead_of_traceback(self):
        from iadkit.builder import build_project
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = fixture()
            project["edges"][0]["kind"] = {}
            project["scenarios"][0]["steps"][0]["kind"] = []
            (root / "project.json").write_text(json.dumps(project["config"]))
            for category in ("nodes", "edges", "contracts", "scenarios", "evidence"):
                (root / category).mkdir()
                (root / category / "entities.json").write_text(json.dumps(project[category]))
            report = build_project(root)
            self.assertEqual(report["status"], "error")
            self.assertTrue(any(i["code"] == "schema" and i["path"].endswith(".kind") for i in report["diagnostics"]))
            self.assertFalse((root / "build" / "index.html").exists())

    def test_empty_scaffold_cannot_pretend_to_be_diagram(self):
        project = fixture()
        project["nodes"] = []
        project["scenarios"] = []
        self.assertTrue({"project.empty_nodes", "project.empty_scenarios"} <= codes(project))

    def test_nested_source_refs_and_owned_targets_checked(self):
        project = fixture()
        project["nodes"][0]["ownedData"] = [{"name": "cache", "description": "Stores status.", "target": "missing", "sources": ["unknown"]}]
        project["contracts"][0]["operations"][0]["sources"] = ["unknown"]
        self.assertTrue({"ref.node", "ref.evidence"} <= codes(project))

    def test_duplicate_and_unknown_ids(self):
        project = fixture()
        project["nodes"].append(copy.deepcopy(project["nodes"][0]))
        project["edges"][0]["to"] = "missing"
        project["scenarios"][0]["steps"][0]["contracts"] = ["missing"]
        self.assertTrue({"id.duplicate", "ref.node", "ref.contract"} <= codes(project))

    def test_hierarchy_cycles_and_nonroot_view_order(self):
        project = fixture()
        project["nodes"][0]["parent"] = "service"
        project["view"]["rootOrder"] = ["service"]
        self.assertTrue({"hierarchy.cycle", "view.root_order"} <= codes(project))

    def test_long_hierarchy_is_not_recursive(self):
        project = fixture()
        project["view"] = {}
        project["nodes"] = [{"id": f"n{i}", "parent": f"n{i + 1}" if i < 1199 else None, "label": "Node", "role": "Owns data.", "sources": ["ev"]} for i in range(1200)]
        project["nodes"].extend(fixture()["nodes"])
        self.assertNotIn("hierarchy.cycle", codes(project))

    def test_scenario_cycles_missing_targets_and_unreachable(self):
        project = fixture()
        step = project["scenarios"][0]["steps"][0]
        step["next"] = step["id"]
        dead = copy.deepcopy(step)
        dead["id"] = "dead"
        dead["next"] = "missing"
        project["scenarios"][0]["steps"].append(dead)
        self.assertTrue({"scenario.cycle", "scenario.unreachable", "ref.step"} <= codes(project))

    def test_all_branch_paths_reachable_and_finite(self):
        project = fixture()
        scenario = project["scenarios"][0]
        step = scenario["steps"][0]
        done = copy.deepcopy(step)
        done["id"] = "done"
        step["branch"] = {"options": [{"id": "yes", "label": "Allowed", "condition": "Allowed.", "result": "Continue.", "next": "done"}, {"id": "no", "label": "Denied", "condition": "Denied.", "result": "Stop.", "next": None}]}
        scenario["steps"].append(done)
        self.assertEqual(validate_project(project), [])
        step["next"] = "done"
        step["branch"]["options"][1]["id"] = "yes"
        self.assertTrue({"branch.ambiguous_next", "id.duplicate"} <= codes(project))

    def test_semantic_review_not_inferred_from_file_integrity(self):
        project = fixture()
        proof = project["evidence"][0]
        proof["sourceIntegrity"] = {"status": "git-verified", "sha256": "e" * 64}
        proof["support"] = {"kind": "declaration", "status": "unreviewed"}
        project["edges"][0].pop("verification")
        self.assertTrue({"evidence.unreviewed", "claim.unreviewed", "claim.execution_support"} <= codes(project))
        proof["support"]["status"] = "reviewed"
        project["edges"][0]["verification"] = {"status": "reviewed"}
        self.assertIn("claim.execution_support", codes(project))
        proof["support"]["kind"] = "callsite"
        self.assertEqual(validate_project(project), [])

    def test_implementation_supports_body_steps_but_does_not_prove_calls(self):
        project = fixture()
        project["evidence"][0]["support"]["kind"] = "implementation"
        project["edges"] = []
        self.assertEqual(validate_project(project), [])
        project["scenarios"][0]["steps"][0]["kind"] = "call"
        self.assertIn("claim.execution_support", codes(project))
        project["evidence"][0]["support"]["kind"] = "callsite"
        self.assertEqual(validate_project(project), [])

    def test_sha_mismatch_and_unknown_repository(self):
        project = fixture()
        project["evidence"][0]["revision"] = "a" * 40
        self.assertIn("source.revision", codes(project))
        project["evidence"][0]["repo"] = "unknown"
        project["config"]["primaryRepository"] = "unknown"
        self.assertIn("ref.repository", codes(project))

    def test_unsafe_source_path_and_invalid_layout(self):
        project = fixture()
        project["evidence"][0]["path"] = "../outside.py"
        project["view"]["layout"] = {"columns": 0, "cardWidth": 10}
        project["view"]["theme"] = {"preset": "anything", "colors": {"--unknown": "red"}}
        self.assertIn("schema", codes(project))

    def test_extensions_preserved_but_view_typos_rejected(self):
        project = fixture()
        project["nodes"][0]["registration"] = {"custom": "legacy retained"}
        project["config"]["metadata"] = {"host": "custom"}
        self.assertEqual(validate_project(project), [])
        project["view"]["initialSenario"] = "run"
        self.assertIn("schema", codes(project))

    def test_trace_playback_rejected_even_with_declared_run_metadata(self):
        for field in ("mode", "basis"):
            project = fixture()
            project["scenarios"][0][field] = "trace"
            self.assertIn("trace.unsupported", codes(project))
            project["scenarios"][0]["trace"] = {"runId": "run-1", "source": "trace.json"}
            issues = validate_project(project)
            self.assertTrue(any(i["code"] == "trace.unsupported" and i["severity"] == "error" for i in issues))
        project = fixture()
        project["scenarios"][0]["mode"] = "code"
        project["scenarios"][0]["steps"][0]["basis"] = "trace"
        self.assertIn("trace.unsupported", codes(project))

    def test_layout_gaps_cannot_trap_an_interior_routing_card(self):
        # With 20px gaps the router's 20px stubs enter the 12px padding of
        # every neighboring card in a 3x3 layout, leaving no legal port.
        project = fixture()
        for field in ("columnGap", "rowGap"):
            project["view"]["layout"] = {field: 20}
            self.assertIn("schema", codes(project))
            project["view"]["layout"] = {field: 40}
            self.assertEqual(validate_project(project), [])


class HierarchyScopeValidationTests(unittest.TestCase):
    def test_explicit_repository_homes_are_clean_and_sources_do_not_assign_owner(self):
        # Both repositories intentionally use the same fixture anchor here:
        # anchor references are not an ownership declaration.
        self.assertEqual(validate_project(repository_set_fixture()), [])

    def test_unknown_repository_scope_and_trigger_evidence_are_rejected(self):
        project = repository_set_fixture()
        project["nodes"][0]["repository"] = "missing"
        project["scenarios"][0]["scope"] = "missing"
        project["scenarios"][0]["trigger"]["sources"] = ["missing"]
        self.assertTrue({"ref.repository", "ref.node", "ref.evidence"} <= codes(project))

    def test_scope_owner_and_trigger_schema_reject_bad_types_without_crashing(self):
        for target, field, value in [
            ("node", "repository", {}), ("scenario", "scope", []),
            ("scenario", "trigger", {"kind": "button"}), ("view", "initialScope", False),
        ]:
            with self.subTest(field=field):
                project = repository_set_fixture()
                entity = project["nodes"][0] if target == "node" else project["scenarios"][0] if target == "scenario" else project["view"]
                entity[field] = value
                self.assertIn("schema", codes(project))

    def test_repository_set_cannot_mix_repository_containers_with_internal_roots(self):
        project = repository_set_fixture()
        del project["nodes"][0]["parent"]
        self.assertIn("hierarchy.mixed_levels", codes(project))
        project["nodes"] = [node for node in project["nodes"] if node["id"] != "client"]
        self.assertIn("hierarchy.repository_root", codes(project))

    def test_repository_container_needs_an_owner_and_cannot_be_nested_or_duplicated(self):
        project = repository_set_fixture()
        client = next(node for node in project["nodes"] if node["id"] == "client")
        del client["repository"]
        self.assertIn("hierarchy.repository_missing", codes(project))
        client["repository"] = "source"
        duplicate = copy.deepcopy(client)
        duplicate["id"] = "client2"
        project["nodes"].append(duplicate)
        self.assertIn("hierarchy.repository_duplicate", codes(project))
        duplicate["parent"] = "client"
        self.assertIn("hierarchy.repository_nested", codes(project))

    def test_internal_nodes_cannot_claim_another_included_repository(self):
        project = repository_set_fixture()
        project["nodes"][0]["repository"] = "backend"
        self.assertIn("hierarchy.repository_mismatch", codes(project))
        del project["nodes"][0]["repository"]
        self.assertEqual(validate_project(project), [])

    def test_an_alternate_pinned_version_remains_an_external_boundary(self):
        project = repository_set_fixture()
        project["config"]["repositories"].append({"id": "backend-client-lock", "path": "./backend", "revision": "a" * 40, "included": False, "scope": "external-contract-only"})
        boundary = {"id": "locked-api", "parent": "client", "kind": "external", "repository": "backend-client-lock", "label": "Locked API", "role": "Documents the client dependency contract.", "sources": ["ev"]}
        project["nodes"].append(boundary)
        self.assertEqual(validate_project(project), [])
        boundary["kind"] = "component"
        self.assertIn("hierarchy.repository_mismatch", codes(project))
        boundary["kind"] = "external"
        boundary["repository"] = "backend"
        self.assertIn("hierarchy.repository_mismatch", codes(project))

    def test_excluded_dependency_cannot_be_a_repository_container(self):
        project = repository_set_fixture()
        project["config"]["repositories"][1]["included"] = False
        self.assertIn("hierarchy.external_repository", codes(project))

    def test_repository_set_requires_explicit_scenario_scope(self):
        project = repository_set_fixture()
        del project["scenarios"][0]["scope"]
        self.assertIn("scenario.scope_missing", codes(project))
        # Legacy one-repository maps may keep their flat, unscoped catalogue.
        self.assertEqual(validate_project(fixture()), [])

    def test_scope_is_catalogue_context_and_does_not_limit_step_endpoints(self):
        project = repository_set_fixture()
        local = project["scenarios"][1]
        self.assertEqual(local["scope"], "client")
        self.assertEqual(local["steps"][0]["to"], "service")
        self.assertEqual(validate_project(project), [])

    def test_non_user_overview_requires_review_or_explicit_reason(self):
        project = repository_set_fixture()
        project["scenarios"][0]["trigger"]["kind"] = "system"
        issues = validate_project(project)
        self.assertTrue(any(item["code"] == "scenario.overview_trigger" and item["severity"] == "warning" for item in issues))
        project["scenarios"][0]["overviewReason"] = "Show a platform-wide recovery operation after a server restart."
        self.assertEqual(validate_project(project), [])
        del project["scenarios"][0]["trigger"]
        self.assertIn("scenario.trigger_missing", codes(project))

    def test_initial_scenario_must_be_available_in_the_initial_catalogue(self):
        project = repository_set_fixture()
        project["view"]["initialScenario"] = "server-run"
        self.assertIn("view.initial_scenario_scope", codes(project))
        project["view"]["initialScope"] = "server"
        self.assertEqual(validate_project(project), [])
        project["view"]["initialScope"] = "client"
        self.assertIn("view.initial_scenario_scope", codes(project))
        project["view"]["initialScenario"] = "run"
        self.assertEqual(validate_project(project), [])
        project["view"].update(initialScenario="client-run", initialScope="widget")
        # The parent journey does not touch this nested widget.
        self.assertIn("view.initial_scenario_scope", codes(project))
        project["scenarios"][1]["steps"][0]["from"] = "widget"
        self.assertEqual(validate_project(project), [])

    def test_missing_repository_detail_produces_actionable_warnings_without_counts(self):
        project = repository_set_fixture()
        project["edges"] = [edge for edge in project["edges"] if edge["id"] != "persist"]
        project["scenarios"] = [scenario for scenario in project["scenarios"] if scenario["scope"] != "server"]
        issues = validate_project(project)
        self.assertTrue({"coverage.repository_relations", "coverage.repository_scenarios"} <= {item["code"] for item in issues})
        self.assertTrue(all(item["severity"] == "warning" for item in issues))
        project["nodes"].append({"id": "empty-repo", "kind": "repository", "repository": "empty", "label": "Empty", "role": "Awaiting analysis.", "sources": ["ev"]})
        project["config"]["repositories"].append({"id": "empty", "path": "./empty", "revision": SHA, "included": True})
        self.assertIn("coverage.repository_children", codes(project))

    def test_hierarchy_errors_do_not_make_scope_checks_loop(self):
        project = repository_set_fixture()
        project["nodes"][0]["parent"] = "widget"
        next(node for node in project["nodes"] if node["id"] == "widget")["parent"] = "app"
        project["scenarios"][0]["scope"] = "widget"
        project["view"]["initialScope"] = "widget"
        self.assertIn("hierarchy.cycle", codes(project))


class LoaderTests(unittest.TestCase):
    def test_bundles_singletons_and_stable_file_order(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            f = fixture()
            (root / "project.json").write_text(json.dumps(f["config"]))
            (root / "nodes").mkdir()
            (root / "nodes" / "b.json").write_text(json.dumps(f["nodes"][1:]))
            (root / "nodes" / "a.json").write_text(json.dumps(f["nodes"][0]))
            project = load_project(root)
            self.assertEqual([n["id"] for n in project["nodes"]], ["app", "service"])
            self.assertEqual(project["config"]["repositories"][0]["path"], "./src")
            self.assertEqual(project["_locations"]["nodes"], ["nodes/a.json", "nodes/b.json[0]"])
            self.assertEqual(project["root"], root.resolve())

    def test_parse_diagnostics_locate_actual_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "project.json").write_text("{")
            (root / "nodes").mkdir()
            (root / "nodes" / "bad.json").write_text("[bad]")
            issues = validate_project(load_project(root))
            paths = {i["path"] for i in issues if i["code"] == "file.json"}
            self.assertEqual(paths, {"project.json", "nodes/bad.json"})

    def test_null_entity_and_nonfinite_or_duplicate_json_are_errors(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "project.json").write_text(json.dumps(fixture()["config"]))
            (root / "nodes").mkdir()
            (root / "nodes" / "null.json").write_text("null")
            (root / "nodes" / "nan.json").write_text('{"x": NaN}')
            (root / "nodes" / "duplicate.json").write_text('{"id":"a","id":"b"}')
            issues = validate_project(load_project(root))
            self.assertTrue(any(i["code"] == "schema" and i["path"] == "nodes/null.json" for i in issues))
            self.assertEqual(sum(i["code"] == "file.json" for i in issues), 2)

    def test_overflowing_numbers_are_rejected_in_all_authoring_inputs(self):
        for relative in ("project.json", "view.json", "nodes/main.json"):
            for number in ("1e999", "-1e999", str(10**309), str(-(10**309))):
                with self.subTest(relative=relative, number=number), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    (root / "project.json").write_text(json.dumps(fixture()["config"]))
                    target = root / relative
                    target.parent.mkdir(exist_ok=True)
                    target.write_text('{"extension": {"number": ' + number + '}}')
                    issues = validate_project(load_project(root))
                    self.assertTrue(any(i["code"] == "file.json" and i["path"] == relative
                                        and "Non-finite" in i["message"] for i in issues), issues)

    def test_finite_float_extensions_remain_supported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = fixture()["config"]
            config["metadata"] = {"large": 1e308, "small": 1e-308, "largeInteger": 10**308}
            (root / "project.json").write_text(json.dumps(config))
            project = load_project(root)
            self.assertEqual([], project["_diagnostics"])
            self.assertEqual(config["metadata"], project["config"]["metadata"])

    def test_unreadable_file_and_directory_instead_of_json_are_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "project.json").mkdir()
            self.assertIn("file.read", codes(load_project(root)))
            with patch.object(Path, "read_text", side_effect=PermissionError("denied")):
                project = load_project(root)
            self.assertIn("file.read", codes(project))

    def test_missing_project_diagnostic(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertIn("file.missing", codes(load_project(temp)))


class SchemaTests(unittest.TestCase):
    def test_compiled_model_schema_enforces_manifest(self):
        f = fixture()
        model = {k: f[k] for k in ["view", "nodes", "edges", "contracts", "scenarios", "evidence"]}
        model.update(schemaVersion=1, limitations=[], manifest={"format": "IAD", "formatVersion": 1, "kitVersion": "0.1.0", "target": {"id": "sample", "name": "Sample", "type": "repository"}, "revision": SHA, "primaryRepository": "source", "repositories": f["config"]["repositories"]})
        self.assertEqual(validate_schema(model, "model.schema.json"), [])
        model["manifest"]["formatVersion"] = 2
        self.assertTrue(validate_schema(model, "model.schema.json"))

    def test_unsupported_keyword_fails_explicitly(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "custom.json").write_text(json.dumps({"type": "string", "format": "email"}))
            with patch("iadkit.schema.schema_directory", return_value=root):
                with self.assertRaisesRegex(SchemaDefinitionError, "Unsupported.*format"):
                    validate_schema("x", "custom.json")

    def test_unused_unsupported_keyword_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "custom.json").write_text(json.dumps({"type": "object", "properties": {"optional": {"format": "email"}}}))
            with patch("iadkit.schema.schema_directory", return_value=root):
                with self.assertRaisesRegex(SchemaDefinitionError, "Unsupported.*format"):
                    validate_schema({}, "custom.json")

    def test_remote_ref_not_fetched(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "custom.json").write_text(json.dumps({"$ref": "https://example.invalid/schema.json"}))
            with patch("iadkit.schema.schema_directory", return_value=root):
                with self.assertRaisesRegex(SchemaDefinitionError, "Remote/absolute"):
                    validate_schema({}, "custom.json")


if __name__ == "__main__":
    unittest.main()
