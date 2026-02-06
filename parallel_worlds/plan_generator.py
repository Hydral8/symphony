import json
import os
import re
from datetime import datetime
from typing import Any, Dict, List, Tuple

from .common import run_shell
from .execution import build_codex_command
from .state import plans_dir


EXCLUDED_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".parallel_worlds",
}

KEY_FILE_NAMES = {
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "cargo.toml",
    "gemfile",
    "pom.xml",
    "composer.json",
    "deno.json",
    "makefile",
}

MAX_TREE_SAMPLE = 200
MAX_FILE_SNIPPET_BYTES = 12_000
MAX_TOTAL_SNIPPET_BYTES = 120_000


def _is_excluded_dir(name: str) -> bool:
    return name in EXCLUDED_DIRS


def scan_repo_summary(repo_root: str) -> Dict[str, Any]:
    top_level_dirs: List[str] = []
    top_level_files: List[str] = []

    for entry in os.scandir(repo_root):
        if _is_excluded_dir(entry.name):
            continue
        if entry.is_dir():
            top_level_dirs.append(entry.name)
        elif entry.is_file():
            top_level_files.append(entry.name)

    top_level_dirs.sort()
    top_level_files.sort()

    ext_hist: Dict[str, int] = {}
    tree_sample: List[str] = []
    file_count = 0

    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if not _is_excluded_dir(d)]
        dirs.sort()
        files.sort()
        for fname in files:
            file_count += 1
            ext = os.path.splitext(fname)[1].lower() or "(none)"
            ext_hist[ext] = ext_hist.get(ext, 0) + 1
            if len(tree_sample) < MAX_TREE_SAMPLE:
                rel = os.path.relpath(os.path.join(root, fname), repo_root)
                tree_sample.append(rel)

    ext_hist_sorted = dict(sorted(ext_hist.items(), key=lambda item: (-item[1], item[0])))

    return {
        "root_name": os.path.basename(os.path.abspath(repo_root)),
        "top_level_dirs": top_level_dirs,
        "top_level_files": top_level_files,
        "file_count": file_count,
        "extension_histogram": ext_hist_sorted,
        "tree_sample": tree_sample,
    }


def read_key_files(repo_root: str) -> List[Dict[str, str]]:
    candidates: List[str] = []

    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if not _is_excluded_dir(d)]
        for fname in files:
            lower = fname.lower()
            if lower.startswith("readme"):
                pass
            elif lower in KEY_FILE_NAMES:
                pass
            elif lower.startswith("build.gradle"):
                pass
            else:
                continue
            rel = os.path.relpath(os.path.join(root, fname), repo_root)
            candidates.append(rel)

    candidates = sorted(dict.fromkeys(candidates))

    snippets: List[Dict[str, str]] = []
    total_bytes = 0

    for rel in candidates:
        if total_bytes >= MAX_TOTAL_SNIPPET_BYTES:
            break
        abs_path = os.path.join(repo_root, rel)
        if not os.path.isfile(abs_path):
            continue
        try:
            with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                chunk = f.read(MAX_FILE_SNIPPET_BYTES)
        except OSError:
            continue
        total_bytes += len(chunk.encode("utf-8", errors="ignore"))
        if len(chunk) >= MAX_FILE_SNIPPET_BYTES:
            chunk += "\n... (truncated)\n"
        snippets.append({"path": rel, "snippet": chunk})

    return snippets


def build_plan_prompt(summary: Dict[str, Any], snippets: List[Dict[str, str]]) -> str:
    enums = {
        "layer_kinds": ["vision", "module", "uxui", "backend", "data", "infra", "task"],
        "povs": ["product", "design", "engineering", "ops"],
        "node_types": [
            "vision",
            "goal",
            "module",
            "component",
            "screen",
            "ux_flow",
            "api",
            "db_model",
            "workflow",
            "task",
            "note",
        ],
        "node_statuses": ["draft", "validated", "approved", "deprecated"],
        "edge_relations": [
            "depends_on",
            "implements",
            "informs",
            "blocks",
            "contains",
            "uses_api",
            "reads_from",
            "writes_to",
            "tests",
        ],
    }

    summary_json = json.dumps(summary, indent=2)
    enums_json = json.dumps(enums, indent=2)

    snippet_blocks = []
    for item in snippets:
        snippet_blocks.append(f"Path: {item['path']}\n{item['snippet']}")
    snippets_text = "\n\n---\n\n".join(snippet_blocks) if snippet_blocks else "None"

    return (
        "You are Codex. Generate a Symphony canvas plan in JSON format.\n"
        "Return ONLY valid JSON. Do not include markdown or code fences.\n\n"
        "Schema requirements:\n"
        "- schema_version must be \"1.0\".\n"
        "- Required top-level fields: schema_version, project_id, plan_id, version, metadata, layers.\n"
        "- metadata must include: name, vision, goals (array).\n"
        "- layers must include: id, name, kind, pov, order, nodes, edges.\n"
        "- nodes must include: id, layer_id, type, label, summary, position {x,y}, size {w,h}, status.\n"
        "- edges must include: id, source, target, relation.\n\n"
        f"Allowed enums:\n{enums_json}\n\n"
        "Repository summary:\n"
        f"{summary_json}\n\n"
        "Key file snippets:\n"
        f"{snippets_text}\n\n"
        "Guidance:\n"
        "- Use 2-4 layers max.\n"
        "- Include modules, screens, APIs, and data models suggested by the repo.\n"
        "- Set all positions on a readable grid (e.g., x/y increments of 200).\n"
        "- Use status \"draft\" by default.\n"
    )


def run_codex_plan_generation(repo_root: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    summary = scan_repo_summary(repo_root)
    snippets = read_key_files(repo_root)
    prompt_text = build_plan_prompt(summary, snippets)

    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(plans_dir(repo_root), "generate", timestamp)
    os.makedirs(out_dir, exist_ok=True)

    prompt_path = os.path.join(out_dir, "prompt.md")
    with open(prompt_path, "w", encoding="utf-8") as f:
        f.write(prompt_text)

    world = {"id": "plan-gen", "name": "plan-generator", "worktree": repo_root}
    branchpoint = {"id": "plan-gen", "intent": "Generate a Symphony canvas plan from repository."}
    command_template = str(cfg.get("codex", {}).get("command", "")).strip()
    command = build_codex_command(command_template, prompt_path, world, branchpoint)

    result = run_shell(command, cwd=repo_root, timeout_sec=int(cfg.get("codex", {}).get("timeout_sec", 900)))

    stdout = result.stdout or ""
    stderr = result.stderr or ""

    log_path = os.path.join(out_dir, "codex-generate.log")
    with open(log_path, "w", encoding="utf-8") as f:
        if stdout:
            f.write(stdout)
        if stderr:
            if stdout:
                f.write("\n--- STDERR ---\n")
            f.write(stderr)

    return {
        "summary": summary,
        "snippets": snippets,
        "prompt_path": prompt_path,
        "command": command,
        "stdout": stdout,
        "stderr": stderr,
        "log_path": log_path,
    }


def extract_json(raw: str) -> Tuple[Dict[str, Any], str]:
    text = raw.strip()
    if not text:
        return {}, "empty stdout"

    fence_match = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text, re.IGNORECASE)
    if fence_match:
        text = fence_match.group(1).strip()

    decoder = json.JSONDecoder()
    for idx, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, _ = decoder.raw_decode(text[idx:])
            if isinstance(obj, dict):
                return obj, ""
        except json.JSONDecodeError:
            continue

    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj, ""
    except json.JSONDecodeError:
        pass

    return {}, "unable to parse JSON object from stdout"


def validate_minimal_plan(plan: Dict[str, Any]) -> str:
    if not isinstance(plan, dict):
        return "plan must be a JSON object"
    required = ["schema_version", "project_id", "plan_id", "version", "metadata", "layers"]
    missing = [key for key in required if key not in plan]
    if missing:
        return f"plan missing required fields: {', '.join(missing)}"
    if plan.get("schema_version") != "1.0":
        return "schema_version must be \"1.0\""
    if not isinstance(plan.get("metadata"), dict):
        return "metadata must be an object"
    if not isinstance(plan.get("layers"), list) or not plan.get("layers"):
        return "layers must be a non-empty array"
    meta = plan.get("metadata") or {}
    if not str(meta.get("name", "")).strip():
        return "metadata.name is required"
    if not str(meta.get("vision", "")).strip():
        return "metadata.vision is required"
    goals = meta.get("goals")
    if not isinstance(goals, list) or not goals:
        return "metadata.goals must be a non-empty array"
    return ""
