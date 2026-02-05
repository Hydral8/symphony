import os
import signal
import subprocess
import threading
import uuid
from typing import Any, Dict, Optional

from .common import now_utc
from .state import load_task_control, load_task_steering, save_task_control, save_task_steering

TASK_STATUSES = {"pending", "running", "blocked", "paused", "done", "failed", "stopped"}
TASK_ACTIONS = {"pause", "resume", "stop"}

_LOCK = threading.Lock()
_ACTIVE_PROCESSES: Dict[str, Dict[str, Any]] = {}


def _default_control(task_id: str) -> Dict[str, Any]:
    ts = now_utc()
    return {
        "task_id": task_id,
        "status": "pending",
        "pause_requested": False,
        "stop_requested": False,
        "active_phase": None,
        "attempt": 0,
        "last_action": None,
        "last_action_at": None,
        "updated_at": ts,
    }


def get_task_control(repo: str, task_id: str) -> Dict[str, Any]:
    payload = load_task_control(repo, task_id)
    if payload is None:
        payload = _default_control(task_id)
        save_task_control(repo, task_id, payload)
    return payload


def _save_control(repo: str, control: Dict[str, Any]) -> Dict[str, Any]:
    control["updated_at"] = now_utc()
    save_task_control(repo, control["task_id"], control)
    return control


def _signal_process(process: subprocess.Popen, signum: int) -> bool:
    try:
        if os.name != "posix":
            if signum == signal.SIGTERM:
                process.terminate()
            elif signum == signal.SIGKILL:
                process.kill()
            return True
        os.killpg(process.pid, signum)
        return True
    except ProcessLookupError:
        return False


def register_active_process(repo: str, task_id: str, phase: str, attempt: int, process: subprocess.Popen) -> None:
    with _LOCK:
        control = get_task_control(repo, task_id)
        control["status"] = "running"
        control["active_phase"] = phase
        control["attempt"] = max(int(control.get("attempt", 0) or 0), int(attempt))
        control["stop_requested"] = False
        control["last_action"] = "start"
        control["last_action_at"] = now_utc()

        active: Dict[str, Any] = {
            "process": process,
            "phase": phase,
            "attempt": control["attempt"],
            "paused": False,
            "stop_requested": False,
            "stop_requested_at": None,
        }
        _ACTIVE_PROCESSES[task_id] = active

        if control.get("pause_requested"):
            if _signal_process(process, signal.SIGSTOP):
                active["paused"] = True
                control["status"] = "paused"

        _save_control(repo, control)


def get_active_runtime(task_id: str) -> Optional[Dict[str, Any]]:
    with _LOCK:
        payload = _ACTIVE_PROCESSES.get(task_id)
        if not payload:
            return None
        return {
            "phase": payload["phase"],
            "attempt": payload["attempt"],
            "paused": bool(payload.get("paused", False)),
            "stop_requested": bool(payload.get("stop_requested", False)),
            "stop_requested_at": payload.get("stop_requested_at"),
        }


def finish_active_process(repo: str, task_id: str, exit_code: Optional[int], error: Optional[str]) -> Dict[str, Any]:
    with _LOCK:
        control = get_task_control(repo, task_id)
        active = _ACTIVE_PROCESSES.pop(task_id, None)

        stopped = bool((active or {}).get("stop_requested")) or bool(control.get("stop_requested"))
        if stopped:
            control["status"] = "stopped"
        elif exit_code == 0 and not error:
            control["status"] = "done"
        else:
            control["status"] = "failed"

        control["active_phase"] = None
        control["pause_requested"] = False
        control["stop_requested"] = False
        control["last_action"] = "finish"
        control["last_action_at"] = now_utc()
        return _save_control(repo, control)


def force_kill_if_stop_requested(task_id: str, grace_sec: float = 3.0) -> bool:
    with _LOCK:
        active = _ACTIVE_PROCESSES.get(task_id)
        if not active:
            return False
        stop_requested = bool(active.get("stop_requested"))
        stop_requested_at = active.get("stop_requested_at")
        if not stop_requested or not stop_requested_at:
            return False
        age = max(0.0, float(time_to_epoch(stop_requested_at)))
        if age < grace_sec:
            return False
        process = active["process"]
    return _signal_process(process, signal.SIGKILL)


def time_to_epoch(ts: Optional[str]) -> float:
    if not ts:
        return 0.0
    try:
        import datetime
        import time

        value = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return time.time() - value.timestamp()
    except Exception:
        return 0.0


def apply_task_action(repo: str, task_id: str, action: str) -> Dict[str, Any]:
    if action not in TASK_ACTIONS:
        return {
            "ok": False,
            "status_code": 400,
            "error_code": "INVALID_ACTION",
            "message": f"unsupported action: {action}",
        }

    with _LOCK:
        control = get_task_control(repo, task_id)
        active = _ACTIVE_PROCESSES.get(task_id)
        process = active["process"] if active else None
        applied = False

        if action == "pause":
            control["pause_requested"] = True
            control["status"] = "paused"
            if active and not bool(active.get("paused")):
                applied = _signal_process(process, signal.SIGSTOP)
                if applied:
                    active["paused"] = True

        elif action == "resume":
            control["pause_requested"] = False
            if active and bool(active.get("paused")):
                applied = _signal_process(process, signal.SIGCONT)
                if applied:
                    active["paused"] = False
                    control["status"] = "running"
            elif control.get("status") == "paused":
                control["status"] = "pending"

        elif action == "stop":
            control["stop_requested"] = True
            control["pause_requested"] = False
            control["status"] = "stopped"
            if active:
                if bool(active.get("paused")):
                    _signal_process(process, signal.SIGCONT)
                    active["paused"] = False
                applied = _signal_process(process, signal.SIGTERM)
                if applied:
                    active["stop_requested"] = True
                    active["stop_requested_at"] = now_utc()

        control["last_action"] = action
        control["last_action_at"] = now_utc()
        saved = _save_control(repo, control)
        return {"ok": True, "status_code": 200, "data": {"task_id": task_id, "action": action, "applied_to_active": applied, "control": saved}}


def append_steering_comment(repo: str, task_id: str, comment: str, prompt_patch: str, author: str = "operator") -> Dict[str, Any]:
    text_comment = (comment or "").strip()
    text_patch = (prompt_patch or "").strip()
    if not text_comment and not text_patch:
        raise ValueError("comment or prompt_patch is required")

    rows = load_task_steering(repo, task_id)
    row: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "author": (author or "operator").strip() or "operator",
        "comment": text_comment or None,
        "prompt_patch": text_patch or None,
        "created_at": now_utc(),
    }
    rows.append(row)
    save_task_steering(repo, task_id, rows)
    return row


def list_steering_comments(repo: str, task_id: str, limit: int = 20) -> Dict[str, Any]:
    rows = load_task_steering(repo, task_id)
    total = len(rows)
    if limit > 0:
        rows = rows[-limit:]
    return {"task_id": task_id, "total": total, "items": rows}

