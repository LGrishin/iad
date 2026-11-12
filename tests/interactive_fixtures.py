"""Temporary synthetic projects for integration tests; never shipped diagrams.

Every revision and source anchor comes from a Git repository made by the test.
The fixtures exercise the format, not the architecture of a user's project.
"""

from copy import deepcopy
import os
from pathlib import Path

from fixtures import git, write_json


SOURCE = """def start(value):
    return decide(value)

def decide(value):
    if value is None:
        return rejected()
    return finish(value)

def finish(value):
    return value + 1

def rejected():
    return None

def inspect(value):
    return finish(value)
"""


def write_project(root, model):
    root = Path(root)
    write_json(root / "project.json", model["config"])
    write_json(root / "view.json", model["view"])
    for category in ("nodes", "edges", "contracts", "scenarios", "evidence"):
        write_json(root / category / "main.json", model[category])


def step(identifier, sender, receiver, title, source, successor=None):
    return {"id": identifier, "from": sender, "to": receiver, "title": title,
            "input": "A synthetic integer request.", "action": title + ".",
            "output": "The fixture's next result.", "next": successor,
            "sources": [source], "verification": {"status": "reviewed"}}


def node(identifier, label, source, parent=None, **fields):
    return {"id": identifier, "label": label,
            "role": "Handles one responsibility in the synthetic integration fixture.",
            "details": "This temporary participant exists only while the framework tests run.",
            "sources": [source], **({"parent": parent} if parent else {}), **fields}


def interactive_fixture(directory, identifier="interactive", with_observer=False):
    """A flat, source-backed map with two scenarios and a two-way branch."""
    base = Path(directory)
    root, checkout = base / "diagram", base / "checkout"
    checkout.mkdir(parents=True)
    source_text = SOURCE + ("\ndef observe(value):\n    return inspect(value)\n" if with_observer else "")
    (checkout / "service.py").write_text(source_text, encoding="utf-8")
    git(checkout, "init", "--quiet")
    git(checkout, "add", "service.py")
    git(checkout, "commit", "--quiet", "-m", "Create synthetic integration source")
    revision = git(checkout, "rev-parse", "HEAD")
    evidence = [{"id": "ev-" + name, "repo": "source", "revision": revision,
                 "path": "service.py", "line": line, "symbol": name,
                 "support": {"kind": "callsite", "status": "reviewed",
                             "note": "The test generated and controls this synthetic call site."}}
                for name, line in [("start", 2), ("decide", 7), ("reject", 6), ("inspect", 16)]]
    first = step("receive", "entry", "decision", "Receive the value", "ev-start", "choose")
    choose = step("choose", "decision", "result", "Choose the result", "ev-decide")
    choose["branch"] = {"options": [
        {"id": "accepted", "label": "Accept", "condition": "The value is an integer.", "result": "Apply the increment.", "next": "accepted"},
        {"id": "rejected", "label": "Reject", "condition": "The value is absent.", "result": "Return no value.", "next": "rejected"},
    ]}
    accepted = step("accepted", "result", "entry", "Return the incremented value", "ev-decide")
    accepted["output"] = "Input 1 returns integer 2."
    rejected = step("rejected", "result", "entry", "Return no value", "ev-reject")
    model = {
        "config": {"schemaVersion": 1, "id": identifier, "name": identifier.title(),
                   "primaryRepository": "source", "repositories": [{"id": "source", "path": "../checkout", "revision": revision,
                   "webUrlTemplate": "https://source.example.invalid/{revision}/{path}#L{line}"}], "limitations": []},
        "view": {"rootOrder": ["entry", "decision", "result"], "initialScenario": "process"},
        "nodes": [node("entry", "Entry", "ev-start"), node("decision", "Decision", "ev-decide"),
                  node("result", "Result", "ev-inspect", ownedData=[{"name": "value", "description": "An integer input retained until a result is returned.", "sources": ["ev-start", "ev-inspect"]}])],
        "edges": [{"id": "dispatch", "from": "entry", "to": "decision", "label": "Dispatch input", "kind": "call", "sources": ["ev-start"], "verification": {"status": "reviewed"}},
                  {"id": "apply", "from": "decision", "to": "result", "label": "Apply increment", "kind": "call", "sources": ["ev-decide"], "verification": {"status": "reviewed"}}],
        "contracts": [{"id": "increment", "node": "result", "name": "Increment API", "sources": ["ev-decide"], "operations": [{"name": "finish(value)", "description": "Add one to an integer.", "input": "An integer.", "output": "The next integer.", "errors": "No expected errors.", "sources": ["ev-decide"]}]}],
        "scenarios": [{"id": "process", "title": "Process a value", "goal": "Exercise a confirmed branch.", "basis": "code", "entry": "receive", "steps": [first, choose, accepted, rejected]},
                      {"id": "inspect", "title": "Inspect a value", "goal": "Exercise independent progress.", "basis": "code", "entry": "inspect", "steps": [step("inspect", "entry", "result", "Inspect the result", "ev-inspect", "return"), step("return", "result", "entry", "Return the result", "ev-inspect")]}],
        "evidence": evidence,
    }
    if with_observer:
        model["evidence"].append({"id": "ev-observe", "repo": "source", "revision": revision,
                                  "path": "service.py", "line": 19, "symbol": "observe",
                                  "support": {"kind": "callsite", "status": "reviewed", "note": "The generated observer calls inspect(value)."}})
        model["nodes"].append(node("observer", "Observer", "ev-observe"))
        model["view"]["rootOrder"].append("observer")
        model["edges"].append({"id": "observe", "from": "observer", "to": "result", "label": "Inspect the value", "kind": "call", "sources": ["ev-observe"], "verification": {"status": "reviewed"}})
        model["scenarios"][1]["steps"] = [step("inspect", "entry", "observer", "Request inspection", "ev-observe", "observe"), step("observe", "observer", "result", "Inspect the result", "ev-observe", "return"), step("return", "result", "entry", "Return the result", "ev-inspect")]
    write_project(root, model)
    return root, checkout, model


def hierarchy_fixture(directory):
    """Three temporary repository peers with nested diagrams and scoped journeys."""
    base = Path(directory)
    root = base / "diagram"
    model = {"config": {"schemaVersion": 1, "id": "synthetic-hierarchy", "name": "Synthetic hierarchy",
                        "primaryRepository": "alpha", "target": {"id": "synthetic-hierarchy", "name": "Synthetic hierarchy", "type": "repository-set"}, "repositories": [], "limitations": []},
             "view": {"rootOrder": ["alpha", "beta", "gamma"], "initialScope": None, "initialScenario": "overview"},
             "nodes": [], "edges": [], "contracts": [], "scenarios": [], "evidence": []}
    for name in ("alpha", "beta", "gamma"):
        _, checkout, flat = interactive_fixture(base / name, name)
        repo = deepcopy(flat["config"]["repositories"][0])
        repo.update(id=name, path=os.path.relpath(checkout, root), included=True)
        model["config"]["repositories"].append(repo)
        for anchor in flat["evidence"]:
            model["evidence"].append({**anchor, "id": name + "-" + anchor["id"], "repo": name})
        source = name + "-ev-start"
        model["nodes"].append(node(name, name.title(), source, kind="repository", repository=name))
        ids = [name + "-entry", name + "-processing", name + "-output"]
        model["nodes"].extend(node(identifier, identifier.title(), source, parent=name) for identifier in ids)
        for i, (sender, receiver) in enumerate(zip(ids, ids[1:] + ids[:1])):
            model["edges"].append({"id": f"{name}-relation-{i}", "from": sender, "to": receiver, "label": "Pass the synthetic value", "kind": "call", "sources": [source], "verification": {"status": "reviewed"}})
        model["scenarios"].append({"id": name + "-internal", "scope": name, "trigger": {"kind": "internal", "label": "A request arrives", "sources": [source]},
                                   "title": name.title() + " internal processing", "goal": "Follow three local operations.", "basis": "code", "entry": "receive", "steps": [step("receive", ids[0], ids[1], "Receive input", source, "process"), step("process", ids[1], ids[2], "Process input", source, "finish"), step("finish", ids[2], ids[0], "Return output", source)]})
    source = "alpha-ev-decide"
    model["nodes"].extend([node("check", "Check", source, parent="alpha-processing"), node("apply", "Apply", source, parent="alpha-processing")])
    for sender, receiver in [("check", "apply"), ("apply", "check")]:
        model["edges"].append({"id": sender + "-relation", "from": sender, "to": receiver, "label": "Pass the local result", "kind": "call", "sources": [source], "verification": {"status": "reviewed"}})
    branch = step("choose", "check", "apply", "Check the local value", source)
    branch["branch"] = {"options": [{"id": "apply", "label": "Apply", "condition": "The input is present.", "result": "Return the increment.", "next": "applied"}, {"id": "skip", "label": "Skip", "condition": "The input is missing.", "result": "Return an empty result.", "next": "skipped"}]}
    model["scenarios"].append({"id": "nested-choice", "scope": "alpha-processing", "trigger": {"kind": "internal", "label": "Validate the request", "sources": [source]}, "title": "Choose a local result", "goal": "Keep branch state while navigating diagram scopes.", "basis": "code", "entry": "choose", "steps": [branch, step("applied", "apply", "check", "Return the accepted result", source), step("skipped", "apply", "check", "Return an empty result", source)]})
    model["scenarios"].insert(0, {"id": "overview", "scope": None, "trigger": {"kind": "user", "label": "Press Process", "sources": ["alpha-ev-start"]}, "title": "Press Process", "goal": "Follow a user journey across repository boundaries.", "basis": "code", "entry": "send", "steps": [step("send", "alpha", "beta", "Send the request", "alpha-ev-start", "reply"), step("reply", "beta", "alpha", "Receive the response", "beta-ev-start")]})
    model["edges"].append({"id": "cross-repository", "from": "alpha", "to": "beta", "label": "Request a result", "kind": "call", "sources": ["alpha-ev-start"], "verification": {"status": "reviewed"}})
    model["contracts"].extend([
        {"id": "beta-request-api", "node": "beta", "name": "Request API", "description": "Accept a value from another repository.", "sources": ["beta-ev-start"],
         "operations": [{"name": "start(value)", "description": "Start processing the provided integer.", "input": "An integer supplied by the caller.", "output": "The processed value or no value when rejected.", "sources": ["beta-ev-start"]}]},
        {"id": "apply-api", "node": "apply", "name": "Apply API", "description": "Apply the local integer transformation.", "sources": ["alpha-ev-decide"],
         "operations": [{"name": "finish(value)", "description": "Add one to an integer.", "input": "An integer accepted by the local check.", "output": "The next integer.", "sources": ["alpha-ev-decide"]}]},
    ])
    next(edge for edge in model["edges"] if edge["id"] == "cross-repository")["targetContract"] = "beta-request-api"
    next(edge for edge in model["edges"] if edge["id"] == "check-relation")["targetContract"] = "apply-api"
    next(scenario for scenario in model["scenarios"] if scenario["id"] == "overview")["steps"][0]["targetContract"] = "beta-request-api"
    branch["targetContract"] = "apply-api"
    write_project(root, model)
    return root


def comparison_fixture(directory):
    """Two pinned revisions of the same temporary interactive source."""
    base = Path(directory)
    _, checkout, model = interactive_fixture(base / "source", "synthetic-comparison")
    root = base / "comparison"
    before = deepcopy(model)
    after = deepcopy(model)
    (checkout / "service.py").write_text(SOURCE.replace("value + 1", "value + 2"), encoding="utf-8")
    git(checkout, "add", "service.py")
    git(checkout, "commit", "--quiet", "-m", "Change the synthetic increment")
    revision = git(checkout, "rev-parse", "HEAD")
    after["config"]["repositories"][0]["revision"] = revision
    for anchor in after["evidence"]:
        anchor["revision"] = revision
    after["contracts"][0]["operations"][0]["description"] = "Add two to an integer."
    after["contracts"][0]["operations"][0]["output"] = "The integer after two increments."
    after["scenarios"][0]["steps"][2]["output"] = "Input 1 returns integer 3."
    for side, content in [("before", before), ("after", after)]:
        content["config"]["repositories"][0]["path"] = os.path.relpath(checkout, root / side)
        write_project(root / side, content)
    write_json(root / "comparison.json", {"schemaVersion": 1, "id": "synthetic-increment", "title": "Synthetic increment change", "summary": "The generated service changes from one increment to two.", "before": "before", "after": "after", "changes": [{"id": "increment", "title": "Increase the increment", "summary": "One becomes two.", "consequence": "Input 1 now returns 3.", "scenarioId": "process", "beforeSources": ["ev-decide"], "afterSources": ["ev-decide"], "beforeNodes": ["result"], "afterNodes": ["result"]}]})
    return root
