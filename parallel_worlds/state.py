import json
import os
from typing import Any, Dict, List, Optional

from .common import die, git_common_dir, read_json, write_json


def metadata_root(repo: str) -> str:
    # Shared per repository (works across worktrees/branches).
    return os.path.join(os.path.dirname(git_common_dir(repo)), ".parallel_worlds")


def branchpoints_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "branchpoints")


def worlds_meta_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "worlds")


def runs_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "runs")


def codex_runs_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "codex_runs")


def renders_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "renders")


def latest_branchpoint_path(repo: str) -> str:
    return os.path.join(metadata_root(repo), "latest_branchpoint.txt")


def ensure_metadata_dirs(repo: str) -> None:
    os.makedirs(branchpoints_dir(repo), exist_ok=True)
    os.makedirs(worlds_meta_dir(repo), exist_ok=True)
    os.makedirs(runs_dir(repo), exist_ok=True)
    os.makedirs(codex_runs_dir(repo), exist_ok=True)
    os.makedirs(renders_dir(repo), exist_ok=True)


def set_latest_branchpoint(repo: str, branchpoint_id: str) -> None:
    with open(latest_branchpoint_path(repo), "w", encoding="utf-8") as f:
        f.write(branchpoint_id + "\n")


def get_latest_branchpoint(repo: str) -> Optional[str]:
    path = latest_branchpoint_path(repo)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        value = f.read().strip()
    return value or None


def branchpoint_file(repo: str, branchpoint_id: str) -> str:
    return os.path.join(branchpoints_dir(repo), f"{branchpoint_id}.json")


def world_meta_file(repo: str, world_id: str) -> str:
    return os.path.join(worlds_meta_dir(repo), f"{world_id}.json")


def run_file(repo: str, branchpoint_id: str, world_id: str) -> str:
    return os.path.join(runs_dir(repo), branchpoint_id, f"{world_id}.json")


def codex_run_file(repo: str, branchpoint_id: str, world_id: str) -> str:
    return os.path.join(codex_runs_dir(repo), branchpoint_id, f"{world_id}.json")


def render_file(repo: str, branchpoint_id: str, world_id: str) -> str:
    return os.path.join(renders_dir(repo), branchpoint_id, f"{world_id}.json")


def list_branchpoints(repo: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    root = branchpoints_dir(repo)
    if not os.path.exists(root):
        return out
    for name in sorted(os.listdir(root)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(root, name)
        try:
            out.append(read_json(path))
        except json.JSONDecodeError:
            continue
    out.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return out


def load_branchpoint(repo: str, branchpoint_id: str) -> Dict[str, Any]:
    path = branchpoint_file(repo, branchpoint_id)
    if not os.path.exists(path):
        die(f"branchpoint not found: {branchpoint_id}")
    return read_json(path)


def load_world(repo: str, world_id: str) -> Dict[str, Any]:
    path = world_meta_file(repo, world_id)
    if not os.path.exists(path):
        die(f"world metadata missing: {world_id}")
    return read_json(path)


def load_run(repo: str, branchpoint_id: str, world_id: str) -> Optional[Dict[str, Any]]:
    path = run_file(repo, branchpoint_id, world_id)
    if not os.path.exists(path):
        return None
    return read_json(path)


def load_codex_run(repo: str, branchpoint_id: str, world_id: str) -> Optional[Dict[str, Any]]:
    path = codex_run_file(repo, branchpoint_id, world_id)
    if not os.path.exists(path):
        return None
    return read_json(path)


def load_render(repo: str, branchpoint_id: str, world_id: str) -> Optional[Dict[str, Any]]:
    path = render_file(repo, branchpoint_id, world_id)
    if not os.path.exists(path):
        return None
    return read_json(path)


def save_branchpoint(repo: str, payload: Dict[str, Any]) -> None:
    write_json(branchpoint_file(repo, payload["id"]), payload)


def save_world(repo: str, payload: Dict[str, Any]) -> None:
    write_json(world_meta_file(repo, payload["id"]), payload)


def save_run(repo: str, branchpoint_id: str, world_id: str, payload: Dict[str, Any]) -> None:
    write_json(run_file(repo, branchpoint_id, world_id), payload)


def save_codex_run(repo: str, branchpoint_id: str, world_id: str, payload: Dict[str, Any]) -> None:
    write_json(codex_run_file(repo, branchpoint_id, world_id), payload)


def save_render(repo: str, branchpoint_id: str, world_id: str, payload: Dict[str, Any]) -> None:
    write_json(render_file(repo, branchpoint_id, world_id), payload)


def resolve_branchpoint_id(repo: str, explicit_id: Optional[str]) -> str:
    if explicit_id:
        return explicit_id
    latest = get_latest_branchpoint(repo)
    if not latest:
        die("no branchpoint found. Run kickoff first.")
    return latest
