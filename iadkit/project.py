"""Portable IAD authoring loader and structural/claim validation.

Validation checks the document's internal consistency. A 'reviewed' flag is an
explicit author assertion; it never proves that the code supports a claim.
Source bytes and pinned revisions are checked separately by iadkit.sources.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .jsonio import loads
from .schema import validate_schema

CATEGORIES = ("nodes", "edges", "contracts", "scenarios", "evidence")
SINGULAR = {"nodes": "node", "edges": "edge", "contracts": "contract", "scenarios": "scenario", "evidence": "evidence"}

# Explicit data/artifact categories cannot be architectural participants. Do not
# infer responsibility from labels: a real ConfigService may be a component,
# and a Strategy extension point may be declared by a single class.
NON_PARTICIPANT_KINDS = frozenset({
    "artifact", "file", "directory", "path", "config", "configuration",
    "settings", "schema", "dto", "payload", "parameter", "data", "data-object",
    "example", "example-instance", "instance", "environment",
})


def load_project(path: str | Path) -> dict:
    """Read one project; return parse diagnostics instead of hiding bad files.

    Repository paths are left relative in authored data. ``root`` is the sole
    absolute path, for local file lookup; builders must not serialize it.
    """
    root = Path(path).expanduser().resolve()
    if root.name == "project.json" and root.is_file():
        root = root.parent
    diagnostics: list[dict] = []
    locations: dict[str, list[str]] = {category: [] for category in CATEGORIES}

    missing = object()

    def read(file: Path, *, optional=False, fallback=None):
        relative = str(file.relative_to(root))
        try:
            return loads(file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            if not optional:
                diagnostics.append({"severity": "error", "code": "file.missing", "path": relative, "message": "Required file does not exist"})
        except (ValueError, UnicodeError) as error:
            diagnostics.append({"severity": "error", "code": "file.json", "path": relative, "message": str(error)})
        except OSError as error:
            diagnostics.append({"severity": "error", "code": "file.read", "path": relative, "message": str(error)})
        return fallback

    project = {"root": root, "config": read(root / "project.json", fallback={}), "view": read(root / "view.json", optional=True, fallback={})}
    for category in CATEGORIES:
        items = []
        directory = root / category
        try:
            files = sorted(directory.glob("*.json")) if directory.is_dir() else []
        except OSError as error:
            diagnostics.append({"severity": "error", "code": "file.read", "path": category, "message": str(error)})
            files = []
        if files:
            for file in files:
                value = read(file, fallback=missing)
                if value is missing:
                    continue
                sequence = value if isinstance(value, list) else [value]
                for index, item in enumerate(sequence):
                    items.append(item)
                    locations[category].append(str(file.relative_to(root)) + (f"[{index}]" if isinstance(value, list) else ""))
        project[category] = items
    project["_diagnostics"] = diagnostics
    project["_locations"] = locations
    return project


def validate_project(project: dict) -> list[dict]:
    """Return schema, graph, reference, and semantic-review diagnostics.

    All output is deterministic. Warnings permit draft work; ``--strict`` can
    reject them. Evidence integrity is not a substitute for claim review.
    """
    issues = list(project.get("_diagnostics", []))
    config = project.get("config", {})
    view = project.get("view", {})
    issues.extend(validate_schema(config, "project.schema.json", "project.json"))
    issues.extend(validate_schema(view, "view.schema.json", "view.json"))

    def issue(code: str, path: str, message: str, severity="error") -> None:
        issues.append({"severity": severity, "code": code, "path": path, "message": message})

    def location(category: str, index: int) -> str:
        places = project.get("_locations", {}).get(category, [])
        return places[index] if index < len(places) else f"{category}[{index}]"

    groups: dict[str, list[dict]] = {}
    by_id: dict[str, dict[str, dict]] = {}
    where: dict[str, dict[str, str]] = {}
    for category in CATEGORIES:
        value = project.get(category, [])
        if not isinstance(value, list):
            issue("schema", category, "Category must be an array of entities")
            value = []
        groups[category] = []
        by_id[category] = {}
        where[category] = {}
        for index, entity in enumerate(value):
            at = location(category, index)
            issues.extend(validate_schema(entity, SINGULAR[category] + ".schema.json", at))
            if not isinstance(entity, dict):
                continue
            groups[category].append(entity)
            identifier = entity.get("id")
            if not isinstance(identifier, str):
                continue
            if identifier in by_id[category]:
                issue("id.duplicate", at + ".id", f"Duplicate {SINGULAR[category]} ID {identifier!r}; first declared at {where[category][identifier]}")
            else:
                by_id[category][identifier] = entity
                where[category][identifier] = at
    if not groups["nodes"]:
        issue("project.empty_nodes", "nodes", "Add architecture participants before building a diagram")
    if not groups["scenarios"]:
        issue("project.empty_scenarios", "scenarios", "Add at least one executable scenario before building a diagram")

    # Complete the shape pass for every entity before following references.
    # The graph phase can then rely on schema-enforced scalar IDs/enums; a bad
    # LLM edit such as kind:{} is a diagnostic, never a Python TypeError.
    if any(item.get("code") == "schema" or item.get("code", "").startswith("file.") for item in issues):
        return issues

    repos: dict[str, dict] = {}
    if isinstance(config, dict):
        for index, repo in enumerate(config.get("repositories", []) if isinstance(config.get("repositories"), list) else []):
            if not isinstance(repo, dict) or not isinstance(repo.get("id"), str):
                continue
            if repo["id"] in repos:
                issue("id.duplicate", f"project.json.repositories[{index}].id", f"Duplicate repository ID {repo['id']!r}")
            else:
                repos[repo["id"]] = repo
        if isinstance(config.get("primaryRepository"), str) and config["primaryRepository"] not in repos:
            issue("ref.repository", "project.json.primaryRepository", "Primary repository is not declared in repositories")

    nodes = by_id["nodes"]
    evidence = by_id["evidence"]
    contracts = by_id["contracts"]

    def reference(identifier: Any, targets: dict, path: str, kind: str) -> None:
        if isinstance(identifier, str) and identifier not in targets:
            issue("ref." + kind, path, f"Unknown {kind} ID {identifier!r}")

    def walk_sources(value: Any, at: str) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = f"{at}.{key}"
                if key == "sources" or key.endswith("Sources"):
                    if not isinstance(child, list) or any(not isinstance(item, str) for item in child):
                        issue("schema", child_path, "Source references must be an array of evidence IDs")
                    else:
                        for index, identifier in enumerate(child):
                            reference(identifier, evidence, f"{child_path}[{index}]", "evidence")
                else:
                    walk_sources(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk_sources(child, f"{at}[{index}]")

    # Source ID references may occur in owned data, terms, operations, and prose
    # extensions ending in Sources, as well as directly on an entity.
    for category in CATEGORIES:
        for index, entity in enumerate(project.get(category, []) if isinstance(project.get(category, []), list) else []):
            walk_sources(entity, location(category, index))

    for identifier, node in nodes.items():
        at = where["nodes"][identifier]
        if node.get("kind", "").casefold().replace("_", "-") in NON_PARTICIPANT_KINDS:
            issue("architecture.non_participant", at + ".kind",
                  "Data, files, examples, instances, and environment are not architectural participants. "
                  "Describe them as inputs, outputs, owned data, types, or implementation notes of their owner.")
        if "repository" in node:
            reference(node["repository"], repos, at + ".repository", "repository")
        if node.get("kind") == "repository" and "repository" not in node:
            issue("hierarchy.repository_missing", at + ".repository", "A repository container must identify its pinned repository")
        parent = node.get("parent")
        if parent is not None:
            reference(parent, nodes, at + ".parent", "node")
        for index, owned in enumerate(node.get("ownedData", []) if isinstance(node.get("ownedData"), list) else []):
            if isinstance(owned, dict) and "target" in owned:
                reference(owned["target"], nodes, f"{at}.ownedData[{index}].target", "node")
        if not node.get("sources"):
            issue("source.missing", at + ".sources", "Participant has no linked source evidence", "warning")

    # Every participant has at most one parent, so iterative ancestor walks
    # detect cycles without recursion or an arbitrary architecture depth limit.
    finished: set[str] = set()
    for start in nodes:
        path: list[str] = []
        offsets: dict[str, int] = {}
        current: Any = start
        while isinstance(current, str) and current in nodes and current not in finished:
            if current in offsets:
                cycle = path[offsets[current]:] + [current]
                issue("hierarchy.cycle", where["nodes"][current] + ".parent", "Parent cycle: " + " → ".join(cycle))
                break
            offsets[current] = len(path)
            path.append(current)
            current = nodes[current].get("parent")
        finished.update(path)

    def ancestors(identifier: str) -> list[str]:
        """Return self then ancestors, remaining safe after hierarchy errors."""
        result: list[str] = []
        seen: set[str] = set()
        while identifier in nodes and identifier not in seen:
            result.append(identifier)
            seen.add(identifier)
            identifier = nodes[identifier].get("parent")
        return result

    ancestry = {identifier: ancestors(identifier) for identifier in nodes}

    def within(identifier: str, container: str) -> bool:
        return container in ancestry.get(identifier, [])

    def api_endpoints(entity: dict, at: str) -> None:
        for field, endpoint in (("sourceContract", "from"), ("targetContract", "to")):
            if field not in entity:
                continue
            contract_id = entity[field]
            reference(contract_id, contracts, at + "." + field, "contract")
            contract = contracts.get(contract_id)
            if contract and not within(entity.get(endpoint), contract.get("node")):
                issue("api.contract_owner", at + "." + field,
                      "Endpoint API must belong to that participant or one of its enclosing containers")

    repository_set = config.get("target", {}).get("type") == "repository-set"
    # Unmarked repositories are included by default. Explicit dependency
    # boundaries must opt out; a pinned alternate version is a distinct ID.
    included_repos = {
        identifier for identifier, repo in repos.items()
        if repo.get("included", True) and repo.get("scope", "repository") == "repository"
    }
    repository_roots: dict[str, list[str]] = {}
    if repository_set:
        for identifier, node in nodes.items():
            at = where["nodes"][identifier]
            if node.get("kind") == "repository":
                if node.get("parent") is not None:
                    issue("hierarchy.repository_nested", at + ".parent", "Repository containers are peers at the repository-set overview")
                elif node.get("repository") in included_repos:
                    repository_roots.setdefault(node["repository"], []).append(identifier)
                elif node.get("repository") in repos:
                    issue("hierarchy.external_repository", at + ".repository", "A contract-only dependency cannot be presented as an included repository")
            elif node.get("parent") is None and node.get("kind") not in {"external", "actor"}:
                issue("hierarchy.mixed_levels", at, "The repository-set overview contains repository containers and external actors, not internal modules; put this participant inside its repository")

        for repository in sorted(included_repos):
            roots = repository_roots.get(repository, [])
            if not roots:
                issue("hierarchy.repository_root", "nodes", f"Included repository {repository!r} needs one root kind:repository container")
            elif len(roots) > 1:
                issue("hierarchy.repository_duplicate", "nodes", f"Included repository {repository!r} has multiple root containers: {', '.join(roots)}")

        for identifier, node in nodes.items():
            at = where["nodes"][identifier]
            lineage = ancestry[identifier]
            home = next((nodes[item] for item in lineage if nodes[item].get("kind") == "repository" and nodes[item].get("parent") is None), None)
            owner = next((nodes[item]["repository"] for item in lineage if "repository" in nodes[item]), None)
            boundary = node.get("kind") in {"external", "actor"}
            if home is None:
                if node.get("parent") is not None and not boundary:
                    issue("hierarchy.repository_owner", at + ".parent", "An internal participant must belong to an included repository container")
                if owner in included_repos and node.get("kind") != "repository":
                    issue("hierarchy.repository_owner", at + ".repository", "An included repository participant must be inside its own repository container")
            elif owner != home.get("repository"):
                # A boundary may name an excluded dependency at another exact
                # version. Its implementation is not part of this subtree.
                if not boundary or owner in included_repos:
                    issue("hierarchy.repository_mismatch", at + ".repository", "Internal participants must inherit their repository home; only external boundaries may identify a contract-only dependency")

        for repository, roots in repository_roots.items():
            for identifier in roots:
                descendants = {item for item in nodes if item != identifier and within(item, identifier)}
                at = where["nodes"][identifier]
                if not descendants:
                    issue("coverage.repository_children", at, f"Repository {repository!r} has no internal participants; describe responsibilities or record the analysis boundary", "warning")
                elif not any(edge.get("from") in descendants and edge.get("to") in descendants and edge.get("from") != edge.get("to") for edge in by_id["edges"].values()):
                    issue("coverage.repository_relations", at, f"Repository {repository!r} has no relationships between its internal participants", "warning")
                if not any(scenario.get("scope") is not None and within(scenario["scope"], identifier) for scenario in by_id["scenarios"].values()):
                    issue("coverage.repository_scenarios", at, f"Repository {repository!r} has no scenario in its own catalogue context", "warning")

    for identifier, contract in contracts.items():
        reference(contract.get("node"), nodes, where["contracts"][identifier] + ".node", "node")

    for identifier, proof in evidence.items():
        at = where["evidence"][identifier]
        reference(proof.get("repo"), repos, at + ".repo", "repository")
        repo = repos.get(proof.get("repo")) if isinstance(proof.get("repo"), str) else None
        if repo and isinstance(proof.get("revision"), str) and proof["revision"] != repo.get("revision"):
            issue("source.revision", at + ".revision", "Evidence revision differs from the pinned repository revision")
        support = proof.get("support")
        if not isinstance(support, dict) or support.get("status") != "reviewed":
            issue("evidence.unreviewed", at + ".support", "Semantic support for this anchor has not been reviewed", "warning")
        elif support.get("kind") == "reference":
            issue("evidence.reference_only", at + ".support", "A reference anchor does not establish a specific architectural claim", "warning")

    def verify_claim(claim: dict, at: str, execution: bool, allow_implementation=False) -> None:
        verification = claim.get("verification")
        reviewed = isinstance(verification, dict) and verification.get("status") == "reviewed"
        if not reviewed:
            issue("claim.unreviewed", at + ".verification", "Architectural claim has not been reviewed against code or a trace", "warning")
        if not claim.get("sources"):
            issue("source.missing", at + ".sources", "Claim has no linked source evidence", "warning")
        if reviewed and execution:
            proofs = [evidence[item] for item in claim.get("sources", []) if isinstance(item, str) and item in evidence] if isinstance(claim.get("sources", []), list) else []
            kinds = {"callsite", "registration", "trace"}
            if allow_implementation:
                kinds.add("implementation")
            accepted = [proof for proof in proofs if isinstance(proof.get("support"), dict) and proof["support"].get("status") == "reviewed" and proof["support"].get("kind") in kinds]
            if not accepted:
                issue("claim.execution_support", at + ".sources", "Reviewed execution claims need reviewed " + ("implementation, " if allow_implementation else "") + "callsite, registration, or trace evidence; a declaration/file alone is insufficient", "warning")

    for identifier, edge in by_id["edges"].items():
        at = where["edges"][identifier]
        reference(edge.get("from"), nodes, at + ".from", "node")
        reference(edge.get("to"), nodes, at + ".to", "node")
        api_endpoints(edge, at)
        for ci, cid in enumerate(edge.get("contracts", [])):
            reference(cid, contracts, f"{at}.contracts[{ci}]", "contract")
        verify_claim(edge, at, edge.get("kind") in {"call", "stage", "event"})

    for scenario_id, scenario in by_id["scenarios"].items():
        at = where["scenarios"][scenario_id]
        if scenario.get("scope") is not None:
            reference(scenario["scope"], nodes, at + ".scope", "node")
        if repository_set:
            if "scope" not in scenario:
                issue("scenario.scope_missing", at + ".scope", "Repository-set scenarios need an explicit catalogue scope; use null only for overview journeys")
            trigger = scenario.get("trigger")
            if trigger is None:
                issue("scenario.trigger_missing", at + ".trigger", "Describe what starts this journey so its abstraction level can be reviewed", "warning")
            elif scenario.get("scope") is None and trigger["kind"] != "user" and not scenario.get("overviewReason", "").strip():
                issue("scenario.overview_trigger", at + ".trigger", "Overview journeys normally start with a user action; move implementation work to its scope or explain the intentional overview in overviewReason", "warning")
        raw_steps = scenario.get("steps", [])
        raw_steps = raw_steps if isinstance(raw_steps, list) else []
        steps: dict[str, dict] = {}
        locations: dict[str, str] = {}
        for index, step in enumerate(raw_steps):
            step_at = f"{at}.steps[{index}]"
            if not isinstance(step, dict):
                continue
            identifier = step.get("id")
            if not isinstance(identifier, str):
                continue
            if identifier in steps:
                issue("id.duplicate", step_at + ".id", f"Duplicate step ID {identifier!r} within scenario {scenario_id!r}")
            else:
                steps[identifier] = step
                locations[identifier] = step_at
            reference(step.get("from"), nodes, step_at + ".from", "node")
            reference(step.get("to"), nodes, step_at + ".to", "node")
            api_endpoints(step, step_at)
            for ci, cid in enumerate(step.get("contracts", []) if isinstance(step.get("contracts"), list) else []):
                reference(cid, contracts, f"{step_at}.contracts[{ci}]", "contract")
            verify_claim(step, step_at, True, step.get("kind", "operation") not in {"call", "stage", "event"})
            if step.get("basis") == "trace":
                issue("trace.unsupported", step_at + ".basis", "IAD Kit 0.1 supports code-based scenarios only; trace playback needs an implemented adapter")
        reference(scenario.get("entry"), steps, at + ".entry", "step")
        successors: dict[str, list[str]] = {}
        for identifier, step in steps.items():
            step_at = locations[identifier]
            options = step.get("branch", {}).get("options", []) if isinstance(step.get("branch"), dict) else None
            nexts = []
            if isinstance(options, list):
                seen_options = set()
                for index, option in enumerate(options):
                    if not isinstance(option, dict):
                        continue
                    option_at = f"{step_at}.branch.options[{index}]"
                    option_id = option.get("id")
                    if isinstance(option_id, str):
                        if option_id in seen_options:
                            issue("id.duplicate", option_at + ".id", f"Duplicate branch option ID {option_id!r}")
                        seen_options.add(option_id)
                    if option.get("next") is not None:
                        reference(option.get("next"), steps, option_at + ".next", "step")
                        if isinstance(option.get("next"), str):
                            nexts.append(option["next"])
                if step.get("next") is not None:
                    issue("branch.ambiguous_next", step_at + ".next", "A branch step must use next:null; each option owns its next step")
            elif step.get("next") is not None:
                reference(step.get("next"), steps, step_at + ".next", "step")
                if isinstance(step.get("next"), str):
                    nexts.append(step["next"])
            successors[identifier] = nexts
        # Directed acyclic paths are required by this viewer's finite playback.
        colors: dict[str, int] = {}
        for start in steps:
            if colors.get(start):
                continue
            stack = [(start, False)]
            while stack:
                current, exiting = stack.pop()
                if exiting:
                    colors[current] = 2
                    continue
                if colors.get(current) == 2:
                    continue
                if colors.get(current) == 1:
                    issue("scenario.cycle", locations[current], f"Scenario path contains a cycle at {current!r}; unfold repeated actions into finite steps")
                    continue
                colors[current] = 1
                stack.append((current, True))
                for successor in reversed(successors.get(current, [])):
                    if successor in steps:
                        if colors.get(successor) == 1:
                            issue("scenario.cycle", locations[current], f"Scenario path cycles from {current!r} to {successor!r}")
                        elif colors.get(successor) != 2:
                            stack.append((successor, False))
        reached = set()
        pending = [scenario.get("entry")]
        while pending:
            current = pending.pop()
            if not isinstance(current, str) or current in reached or current not in steps:
                continue
            reached.add(current)
            pending.extend(successors.get(current, []))
        for identifier in sorted(steps.keys() - reached):
            issue("scenario.unreachable", locations[identifier], f"Step {identifier!r} is unreachable from the scenario entry")
        if scenario.get("mode") == "trace" or scenario.get("basis") == "trace":
            field = "mode" if scenario.get("mode") == "trace" else "basis"
            issue("trace.unsupported", at + "." + field, "IAD Kit 0.1 supports code-based scenarios only; trace metadata does not enable trace playback without an implemented adapter")

    if isinstance(view, dict):
        if view.get("initialScope") is not None:
            reference(view["initialScope"], nodes, "view.json.initialScope", "node")
        for index, identifier in enumerate(view.get("rootOrder", []) if isinstance(view.get("rootOrder"), list) else []):
            reference(identifier, nodes, f"view.json.rootOrder[{index}]", "node")
            if isinstance(identifier, str) and identifier in nodes and nodes[identifier].get("parent") is not None:
                issue("view.root_order", f"view.json.rootOrder[{index}]", "rootOrder may contain only root participants")
        if "initialScenario" in view:
            reference(view["initialScenario"], by_id["scenarios"], "view.json.initialScenario", "scenario")
            initial = by_id["scenarios"].get(view["initialScenario"])
            active_scope = view.get("initialScope")
            if initial and (active_scope is None or active_scope in nodes):
                scenario_scope = initial.get("scope")
                if active_scope is None:
                    visible = scenario_scope is None
                else:
                    own_or_descendant = scenario_scope is not None and within(scenario_scope, active_scope)
                    ancestor_journey = scenario_scope is None or within(active_scope, scenario_scope)
                    crossing = any(within(step[endpoint], active_scope) for step in initial["steps"] for endpoint in ("from", "to"))
                    visible = own_or_descendant or (ancestor_journey and crossing)
                if not visible:
                    issue("view.initial_scenario_scope", "view.json.initialScenario", "The initial scenario is unavailable in initialScope; choose an overview journey or set its catalogue context explicitly")
    return issues
