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


def task_controls_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "task_controls")


def task_steering_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "task_steering")


def task_graphs_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "task_graphs")


def orchestrator_runs_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "orchestrator_runs")


def orchestrator_events_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "orchestrator_events")


def projects_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "projects")


def plans_dir(repo: str) -> str:
    return os.path.join(metadata_root(repo), "plans")


def latest_branchpoint_path(repo: str) -> str:
    return os.path.join(metadata_root(repo), "latest_branchpoint.txt")


def ensure_metadata_dirs(repo: str) -> None:
    os.makedirs(branchpoints_dir(repo), exist_ok=True)
    os.makedirs(worlds_meta_dir(repo), exist_ok=True)
    os.makedirs(runs_dir(repo), exist_ok=True)
    os.makedirs(codex_runs_dir(repo), exist_ok=True)
    os.makedirs(renders_dir(repo), exist_ok=True)
    os.makedirs(task_controls_dir(repo), exist_ok=True)
    os.makedirs(task_steering_dir(repo), exist_ok=True)
    os.makedirs(task_graphs_dir(repo), exist_ok=True)
    os.makedirs(orchestrator_runs_dir(repo), exist_ok=True)
    os.makedirs(orchestrator_events_dir(repo), exist_ok=True)
    os.makedirs(projects_dir(repo), exist_ok=True)
    os.makedirs(plans_dir(repo), exist_ok=True)


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


def task_control_file(repo: str, task_id: str) -> str:
    return os.path.join(task_controls_dir(repo), f"{task_id}.json")


def task_steering_file(repo: str, task_id: str) -> str:
    return os.path.join(task_steering_dir(repo), f"{task_id}.json")


def task_graph_file(repo: str, graph_id: str) -> str:
    return os.path.join(task_graphs_dir(repo), f"{graph_id}.json")


def orchestrator_run_file(repo: str, run_id: str) -> str:
    return os.path.join(orchestrator_runs_dir(repo), f"{run_id}.json")


def orchestrator_events_file(repo: str, run_id: str) -> str:
    return os.path.join(orchestrator_events_dir(repo), f"{run_id}.jsonl")


def project_file(repo: str, project_id: str) -> str:
    return os.path.join(projects_dir(repo), f"{project_id}.json")


def plan_file(repo: str, plan_id: str) -> str:
    return os.path.join(plans_dir(repo), f"{plan_id}.json")


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


def load_task_graph(repo: str, graph_id: str) -> Optional[Dict[str, Any]]:
    path = task_graph_file(repo, graph_id)
    if not os.path.exists(path):
        return None
    return read_json(path)


def load_orchestrator_run(repo: str, run_id: str) -> Optional[Dict[str, Any]]:
    path = orchestrator_run_file(repo, run_id)
    if not os.path.exists(path):
        return None
    return read_json(path)


def load_orchestrator_events(repo: str, run_id: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    path = orchestrator_events_file(repo, run_id)
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()
    if limit is not None and limit > 0:
        lines = lines[-limit:]
    out: List[Dict[str, Any]] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def load_project(repo: str, project_id: str) -> Optional[Dict[str, Any]]:
    path = project_file(repo, project_id)
    if not os.path.exists(path):
        return None
    return read_json(path)


def load_plan(repo: str, plan_id: str) -> Optional[Dict[str, Any]]:
    path = plan_file(repo, plan_id)
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


def load_task_control(repo: str, task_id: str) -> Optional[Dict[str, Any]]:
    path = task_control_file(repo, task_id)
    if not os.path.exists(path):
        return None
    return read_json(path)


def save_task_control(repo: str, task_id: str, payload: Dict[str, Any]) -> None:
    write_json(task_control_file(repo, task_id), payload)


def load_task_steering(repo: str, task_id: str) -> List[Dict[str, Any]]:
    path = task_steering_file(repo, task_id)
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, list):
        return []
    out: List[Dict[str, Any]] = []
    for row in payload:
        if isinstance(row, dict):
            out.append(row)
    return out


def save_task_steering(repo: str, task_id: str, payload: List[Dict[str, Any]]) -> None:
    path = task_steering_file(repo, task_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def save_task_graph(repo: str, payload: Dict[str, Any]) -> None:
    graph_id = payload.get("graph_id")
    if not graph_id:
        die("task graph missing graph_id")
    write_json(task_graph_file(repo, graph_id), payload)


def save_orchestrator_run(repo: str, payload: Dict[str, Any]) -> None:
    run_id = payload.get("id")
    if not run_id:
        die("orchestrator run missing id")
    write_json(orchestrator_run_file(repo, run_id), payload)


def append_orchestrator_event(repo: str, run_id: str, payload: Dict[str, Any]) -> None:
    path = orchestrator_events_file(repo, run_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload))
        f.write("\n")


def save_project(repo: str, payload: Dict[str, Any]) -> None:
    write_json(project_file(repo, payload["id"]), payload)


def save_plan(repo: str, payload: Dict[str, Any]) -> None:
    write_json(plan_file(repo, payload["id"]), payload)


def resolve_branchpoint_id(repo: str, explicit_id: Optional[str]) -> str:
    if explicit_id:
        return explicit_id
    latest = get_latest_branchpoint(repo)
    if not latest:
        die("no branchpoint found. Run kickoff first.")
    return latest
