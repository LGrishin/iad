"""Resolve exact source revisions without confusing integrity with semantic proof."""

from copy import deepcopy
import hashlib
from pathlib import Path, PurePosixPath
import re
import string
import subprocess
from urllib.parse import quote, urlsplit

from .jsonio import loads


def diagnostic(code, path, message, severity="error"):
    return {"severity": severity, "code": code, "path": path, "message": message}


def source_key(repo, revision, path):
    return f"{repo}@{revision}:{path}"


def _digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _safe_file(path):
    if not isinstance(path, str) or not path or "\\" in path or "\x00" in path:
        return False
    value = PurePosixPath(path)
    return bool(value.parts) and not value.is_absolute() and ".." not in value.parts and path == value.as_posix()


def _run_git(path, *args):
    try:
        return subprocess.run(
            ["git", "-C", str(path), *args], capture_output=True, timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def _git_state(path, revision):
    """Return whether this is the requested Git root and has the pinned commit."""
    root = _run_git(path, "rev-parse", "--show-toplevel")
    if not root or root.returncode:
        return False
    try:
        if Path(root.stdout.decode("utf-8").strip()).resolve() != path.resolve():
            return False  # A fixture subdirectory must not silently use a parent repository.
    except (UnicodeDecodeError, OSError):
        return False
    commit = _run_git(path, "cat-file", "-e", f"{revision}^{{commit}}")
    return bool(commit and commit.returncode == 0)


def _read_archive(project):
    diagnostics = []
    config = project["config"]
    archive_name = config.get("sourceArchive", "snapshots.json")
    if not _safe_file(archive_name):
        return {}, [diagnostic("archive.path", "project.sourceArchive", "Archive path must be a relative path without '..'.")]
    root = Path(project["root"]).resolve()
    path = root / archive_name
    try:
        if not path.exists():
            return {}, []
        if not path.resolve().is_relative_to(root):
            return {}, [diagnostic("archive.path", "project.sourceArchive", "Archive symlink leaves the project directory.")]
        archive = loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        return {}, [diagnostic("archive.read", "project.sourceArchive", f"Cannot read source archive: {exc}")]
    if not isinstance(archive, dict):
        return {}, [diagnostic("archive.type", "project.sourceArchive", "Source archive must be an object keyed by repo@revision:path.")]
    valid = {}
    for key, item in sorted(archive.items()):
        location = f"archive[{key}]"
        if not isinstance(item, dict) or not all(isinstance(item.get(field), str) for field in ("repo", "revision", "path", "text", "sha256")):
            diagnostics.append(diagnostic("archive.entry", location, "Archive entry requires string repo, revision, path, text and sha256."))
            continue
        if key != source_key(item["repo"], item["revision"], item["path"]) or not _safe_file(item["path"]):
            diagnostics.append(diagnostic("archive.identity", location, "Archive key or path does not match its declared source identity."))
            continue
        if item["sha256"] != _digest(item["text"]):
            diagnostics.append(diagnostic("archive.hash", location, "Source archive SHA-256 does not match its text; restore or regenerate the snapshot."))
            continue
        valid[key] = item
    return valid, diagnostics


def _source_url(repository, evidence, diagnostics, location):
    template = repository.get("webUrlTemplate")
    if not template:
        return None
    if not isinstance(template, str):
        diagnostics.append(diagnostic("source.url", location, "webUrlTemplate must be a string."))
        return None
    values = {"revision": quote(evidence["revision"], safe=""), "path": quote(evidence["path"], safe="/"), "line": evidence["line"]}
    try:
        placeholders = set()
        for _, name, format_spec, conversion in string.Formatter().parse(template):
            if name is not None and (name not in values or format_spec or conversion):
                raise ValueError("Only {revision}, {path} and {line} placeholders are supported")
            if name is not None:
                placeholders.add(name)
        if placeholders != set(values):
            raise ValueError("Exact-source links require all three placeholders: {revision}, {path} and {line}")
        result = template.format(**values)
        parsed = urlsplit(result)
        if parsed.scheme not in {"https", "http"} or not parsed.netloc:
            raise ValueError("Source URL must use http or https")
        return result
    except (KeyError, ValueError, IndexError) as exc:
        diagnostics.append(diagnostic("source.url", location, f"Invalid webUrlTemplate: {exc}."))
        return None


def collect_sources(project, repo_overrides=None):
    """Return (compiled evidence, used exact source snapshots, diagnostics).

    An archive's hash proves its internal integrity, not that its bytes originated
    from Git. The different status remains visible in the compiled model.
    Authored ``support`` is copied unchanged and never promoted here.
    """
    diagnostics = []
    archive, archive_diagnostics = _read_archive(project)
    diagnostics.extend(archive_diagnostics)
    repositories = {repo["id"]: repo for repo in project["config"].get("repositories", []) if isinstance(repo, dict) and "id" in repo}
    overrides = repo_overrides or {}
    for repo in sorted(set(overrides) - set(repositories)):
        diagnostics.append(diagnostic("source.override", "repositories", f"Unknown repository override: {repo}."))
    root = Path(project["root"])
    repo_paths = {key: Path(overrides[key]).expanduser().resolve() if key in overrides else (root / repo.get("path", ".")).resolve() for key, repo in repositories.items()}
    git_states = {}
    snapshots = {}
    compiled = []
    failures = set()
    for index, original in enumerate(project.get("evidence", [])):
        item = deepcopy(original)
        location = f"evidence[{index}]"
        item["sourceIntegrity"] = {"status": "unavailable"}
        compiled.append(item)
        repo_id = item.get("repo")
        repo = repositories.get(repo_id)
        revision = item.get("revision")
        path = item.get("path")
        line = item.get("line")
        if not repo:
            diagnostics.append(diagnostic("source.repository", location, f"Unknown repository: {repo_id}."))
            continue
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
            diagnostics.append(diagnostic("source.revision", location, "Source revision must be a full lowercase Git object ID."))
            continue
        if revision != repo.get("revision"):
            diagnostics.append(diagnostic("source.revision", location, "Evidence revision differs from its repository's pinned revision."))
            continue
        if not _safe_file(path):
            diagnostics.append(diagnostic("source.path", location, "Source path must be a relative POSIX path without '..'."))
            continue
        key = source_key(repo_id, revision, path)
        item["sourceKey"] = key
        item["url"] = _source_url(repo, item, diagnostics, location)
        if key not in snapshots and key not in failures:
            state_key = (repo_id, revision)
            if state_key not in git_states:
                git_states[state_key] = _git_state(repo_paths[repo_id], revision)
            if git_states[state_key]:
                result = _run_git(repo_paths[repo_id], "cat-file", "blob", f"{revision}:{path}")
                if not result or result.returncode:
                    failures.add(key)
                    diagnostics.append(diagnostic("source.missing", location, f"UTF-8 source file '{path}' is not a blob at the pinned Git revision."))
                else:
                    try:
                        text = result.stdout.decode("utf-8")
                    except UnicodeDecodeError:
                        failures.add(key)
                        diagnostics.append(diagnostic("source.encoding", location, "Source file is not UTF-8 text."))
                        continue
                    record = {"repo": repo_id, "revision": revision, "path": path, "text": text, "sha256": _digest(text)}
                    if key in archive and record["sha256"] != archive[key]["sha256"]:
                        diagnostics.append(diagnostic("archive.git_mismatch", location, "Archived source differs from the exact Git blob at the pinned revision."))
                    snapshots[key] = (record, "git-verified", "git")
            elif key in archive:
                snapshots[key] = (deepcopy(archive[key]), "archive-verified", "archive")
            else:
                failures.add(key)
                diagnostics.append(diagnostic("source.unavailable", location, f"Pinned source unavailable for '{repo_id}:{path}'; provide the repository with --repo or a valid source archive."))
        if key not in snapshots:
            continue
        record, status, origin = snapshots[key]
        item["sourceIntegrity"] = {"status": status, "sha256": record["sha256"], "origin": origin}
        # Git/file links and the browser number LF-delimited physical lines.
        # Unicode separators and form feeds inside source text are not new lines.
        text = record["text"]
        line_count = text.count("\n") + int(bool(text) and not text.endswith("\n"))
        if isinstance(line, bool) or not isinstance(line, int) or line < 1 or line > line_count:
            diagnostics.append(diagnostic("source.line", location + ".line", f"Line {line} is outside the exact source snapshot ({line_count} lines)."))
    return compiled, {key: value[0] for key, value in sorted(snapshots.items())}, diagnostics
