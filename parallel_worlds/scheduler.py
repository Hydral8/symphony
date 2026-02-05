import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .common import die, now_utc
from .state import (
    append_orchestrator_event,
    ensure_metadata_dirs,
    save_orchestrator_run,
    save_task_graph,
)

Task = Dict[str, Any]
TaskState = Dict[str, Any]
RunState = Dict[str, Any]
ExecutorContext = Dict[str, Any]
TaskExecutor = Callable[[Task, ExecutorContext], Dict[str, Any]]

BLOCKABLE_TASK_STATUSES = {"pending", "blocked"}


def build_task_index(tasks: Iterable[Task]) -> Dict[str, Task]:
    index: Dict[str, Task] = {}
    for task in tasks:
        task_id = task.get("task_id")
        if not task_id:
            die("task missing task_id")
        if task_id in index:
            die(f"duplicate task_id: {task_id}")
        index[task_id] = task
    return index


def build_hard_dependencies(graph: Dict[str, Any]) -> Dict[str, List[str]]:
    deps: Dict[str, List[str]] = {task["task_id"]: [] for task in graph.get("tasks", [])}
    for dep in graph.get("dependencies", []):
        if dep.get("type", "hard_block") != "hard_block":
            continue
        to_task = dep.get("to_task_id")
        from_task = dep.get("from_task_id")
        if not to_task or not from_task:
            continue
        deps.setdefault(to_task, [])
        if from_task not in deps[to_task]:
            deps[to_task].append(from_task)
    return deps


def _task_max_attempts(task: Task, retry_limit: int) -> int:
    max_attempts = task.get("execution", {}).get("budget", {}).get("max_attempts")
    try:
        max_attempts = int(max_attempts) if max_attempts is not None else None
    except (TypeError, ValueError):
        max_attempts = None
    configured = retry_limit + 1
    if max_attempts is None:
        return configured
    return max(1, min(configured, max_attempts))


def _initial_task_state(task: Task, retry_limit: int) -> TaskState:
    status = task.get("status") or "pending"
    if status not in {"pending", "running", "blocked", "paused", "done", "failed", "stopped"}:
        status = "pending"
    return {
        "task_id": task["task_id"],
        "status": status,
        "attempts": 0,
        "max_attempts": _task_max_attempts(task, retry_limit),
        "last_error": None,
        "last_exit_code": None,
        "last_started_at": None,
        "last_finished_at": None,
        "blocked_by": [],
        "blocked_reason": None,
    }


def create_run_state(
    graph: Dict[str, Any],
    run_id: Optional[str],
    max_parallel_agents: Optional[int],
    retry_limit: Optional[int],
) -> RunState:
    orchestrator = graph.get("orchestrator") or {}
    resolved_retry_limit = retry_limit if retry_limit is not None else int(orchestrator.get("retry_limit", 0))
    resolved_parallel = max_parallel_agents if max_parallel_agents is not None else int(
        orchestrator.get("max_parallel_agents", 1)
    )
    if resolved_parallel < 1:
        die("max_parallel_agents must be >= 1")

    tasks = graph.get("tasks", [])
    if not tasks:
        die("task graph has no tasks")

    task_states = {task["task_id"]: _initial_task_state(task, resolved_retry_limit) for task in tasks}
    return {
        "id": run_id or str(uuid.uuid4()),
        "graph_id": graph.get("graph_id"),
        "status": "running",
        "max_parallel_agents": resolved_parallel,
        "retry_limit": resolved_retry_limit,
        "started_at": now_utc(),
        "finished_at": None,
        "task_states": task_states,
        "updated_at": now_utc(),
    }


def _dependencies_satisfied(task_id: str, hard_deps: Dict[str, List[str]], task_states: Dict[str, TaskState]) -> bool:
    for dep_id in hard_deps.get(task_id, []):
        dep_state = task_states.get(dep_id)
        if not dep_state or dep_state.get("status") != "done":
            return False
    return True


def _blocked_by_terminal(task_id: str, hard_deps: Dict[str, List[str]], task_states: Dict[str, TaskState]) -> List[str]:
    blocked: List[str] = []
    for dep_id in hard_deps.get(task_id, []):
        dep_state = task_states.get(dep_id)
        if not dep_state:
            continue
        if dep_state.get("status") in {"failed", "stopped"}:
            blocked.append(dep_id)
    return blocked


def refresh_blocked_states(task_states: Dict[str, TaskState], hard_deps: Dict[str, List[str]]) -> None:
    for task_id, state in task_states.items():
        if state.get("status") not in BLOCKABLE_TASK_STATUSES:
            continue
        blocked_by = [dep for dep in hard_deps.get(task_id, []) if task_states.get(dep, {}).get("status") != "done"]
        if blocked_by:
            terminal_blockers = _blocked_by_terminal(task_id, hard_deps, task_states)
            state["status"] = "blocked"
            state["blocked_by"] = blocked_by
            state["blocked_reason"] = "failed_dependency" if terminal_blockers else "dependency"
        else:
            state["status"] = "pending"
            state["blocked_by"] = []
            state["blocked_reason"] = None


def select_runnable_tasks(
    tasks_by_id: Dict[str, Task],
    task_states: Dict[str, TaskState],
    hard_deps: Dict[str, List[str]],
    running_task_ids: Iterable[str],
    max_to_schedule: int,
) -> List[str]:
    running = set(running_task_ids)
    candidates = []
    for task_id, state in task_states.items():
        if task_id in running:
            continue
        if state.get("status") != "pending":
            continue
        if not _dependencies_satisfied(task_id, hard_deps, task_states):
            continue
        candidates.append(task_id)

    if not candidates:
        return []

    def _sort_key(tid: str) -> Tuple[int, str]:
        priority = tasks_by_id.get(tid, {}).get("priority", 3)
        try:
            priority_val = int(priority)
        except (TypeError, ValueError):
            priority_val = 3
        return (-priority_val, tid)

    candidates.sort(key=_sort_key)
    non_parallel = [tid for tid in candidates if not tasks_by_id.get(tid, {}).get("parallelizable", True)]

    if non_parallel:
        if running:
            return []
        return non_parallel[:1]

    return candidates[:max_to_schedule]


def _emit_event(repo: str, run_id: str, event_type: str, task_id: Optional[str], payload: Dict[str, Any]) -> None:
    event = {
        "event_id": str(uuid.uuid4()),
        "run_id": run_id,
        "task_id": task_id,
        "event_type": event_type,
        "payload": payload,
        "created_at": now_utc(),
    }
    append_orchestrator_event(repo, run_id, event)


def _safe_execute(executor: TaskExecutor, task: Task, context: ExecutorContext) -> Dict[str, Any]:
    try:
        result = executor(task, context)
    except Exception as exc:  # pragma: no cover - safety wrapper
        return {"status": "failed", "error": f"executor error: {exc}"}
    if not isinstance(result, dict):
        return {"status": "failed", "error": "executor returned non-dict result"}
    return result


def _apply_result(task_state: TaskState, result: Dict[str, Any]) -> None:
    status = result.get("status") or "failed"
    if status not in {"done", "failed", "stopped", "paused"}:
        status = "failed"
    task_state["last_error"] = result.get("error")
    task_state["last_exit_code"] = result.get("exit_code")
    task_state["last_finished_at"] = result.get("finished_at") or now_utc()
    if status == "failed":
        if task_state["attempts"] < task_state["max_attempts"]:
            task_state["status"] = "pending"
        else:
            task_state["status"] = "failed"
    elif status == "paused":
        task_state["status"] = "paused"
    elif status == "stopped":
        task_state["status"] = "stopped"
    else:
        task_state["status"] = "done"


def _final_run_status(task_states: Dict[str, TaskState]) -> str:
    statuses = {state.get("status") for state in task_states.values()}
    if statuses.issubset({"done"}):
        return "completed"
    if "failed" in statuses:
        return "failed"
    if "stopped" in statuses:
        return "cancelled"
    if "paused" in statuses and not (statuses & {"pending", "blocked", "running"}):
        return "paused"
    if statuses.issubset({"blocked"}):
        return "failed"
    return "running"


def run_task_graph(
    repo: str,
    graph: Dict[str, Any],
    executor: Optional[TaskExecutor] = None,
    run_id: Optional[str] = None,
    max_parallel_agents: Optional[int] = None,
    retry_limit: Optional[int] = None,
) -> RunState:
    ensure_metadata_dirs(repo)
    save_task_graph(repo, graph)

    tasks_by_id = build_task_index(graph.get("tasks", []))
    hard_deps = build_hard_dependencies(graph)
    run = create_run_state(graph, run_id, max_parallel_agents, retry_limit)
    save_orchestrator_run(repo, run)
    _emit_event(repo, run["id"], "run_started", None, {"graph_id": run.get("graph_id")})

    task_states = run["task_states"]
    refresh_blocked_states(task_states, hard_deps)
    save_orchestrator_run(repo, run)

    if executor is None:
        def executor(task: Task, context: ExecutorContext) -> Dict[str, Any]:
            return {"status": "done"}

    running: Dict[Any, str] = {}
    max_parallel = int(run["max_parallel_agents"])

    with ThreadPoolExecutor(max_workers=max_parallel) as pool:
        while True:
            refresh_blocked_states(task_states, hard_deps)
            available_slots = max_parallel - len(running)
            if available_slots > 0:
                runnable = select_runnable_tasks(
                    tasks_by_id,
                    task_states,
                    hard_deps,
                    running_task_ids=running.values(),
                    max_to_schedule=available_slots,
                )
                for task_id in runnable:
                    state = task_states[task_id]
                    if state["status"] != "pending":
                        continue
                    state["status"] = "running"
                    state["attempts"] += 1
                    state["last_started_at"] = now_utc()
                    state["blocked_by"] = []
                    state["blocked_reason"] = None
                    context = {
                        "run_id": run["id"],
                        "task_id": task_id,
                        "attempt": state["attempts"],
                        "max_attempts": state["max_attempts"],
                        "graph_id": run.get("graph_id"),
                    }
                    _emit_event(
                        repo,
                        run["id"],
                        "task_started",
                        task_id,
                        {"attempt": state["attempts"]},
                    )
                    future = pool.submit(_safe_execute, executor, tasks_by_id[task_id], context)
                    running[future] = task_id
                run["updated_at"] = now_utc()
                save_orchestrator_run(repo, run)

            if not running:
                refresh_blocked_states(task_states, hard_deps)
                if not select_runnable_tasks(
                    tasks_by_id,
                    task_states,
                    hard_deps,
                    running_task_ids=[],
                    max_to_schedule=1,
                ):
                    break
                continue

            done, _ = wait(running.keys(), return_when=FIRST_COMPLETED)
            for future in done:
                task_id = running.pop(future)
                result = future.result()
                _apply_result(task_states[task_id], result)
                _emit_event(
                    repo,
                    run["id"],
                    "task_finished",
                    task_id,
                    {
                        "status": task_states[task_id]["status"],
                        "attempt": task_states[task_id]["attempts"],
                        "error": task_states[task_id]["last_error"],
                    },
                )
                run["updated_at"] = now_utc()
                save_orchestrator_run(repo, run)

    run["status"] = _final_run_status(task_states)
    run["finished_at"] = now_utc()
    run["updated_at"] = now_utc()
    save_orchestrator_run(repo, run)
    _emit_event(repo, run["id"], "run_finished", None, {"status": run["status"]})
    return run
