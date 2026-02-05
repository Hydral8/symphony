#!/usr/bin/env python3
"""API backend for Parallel Worlds Vite/React dashboard."""

import argparse
import io
import json
import mimetypes
import os
import re
import shutil
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse

import pw
from parallel_worlds.common import branch_exists, git


_ACTION_LOCK = threading.RLock()
_ACTION_JOBS_LOCK = threading.RLock()
_ACTION_JOBS: Dict[str, Dict[str, Any]] = {}
_MAX_ACTION_JOBS = 100
_MAX_ACTION_LOG_CHARS = 250_000
_LAUNCH_LOCK = threading.RLock()
_WORLD_LAUNCHES: Dict[str, Dict[str, Any]] = {}
_LAUNCH_HOST = "127.0.0.1"


def _now_utc() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _create_action_job(action: str) -> str:
    job_id = f"job-{uuid.uuid4().hex[:12]}"
    with _ACTION_JOBS_LOCK:
        _ACTION_JOBS[job_id] = {
            "id": job_id,
            "action": action,
            "status": "running",
            "started_at": _now_utc(),
            "finished_at": None,
            "log": "",
            "result": None,
        }
        if len(_ACTION_JOBS) > _MAX_ACTION_JOBS:
            removable = [jid for jid, row in _ACTION_JOBS.items() if row.get("status") != "running"]
            for jid in removable[: max(0, len(_ACTION_JOBS) - _MAX_ACTION_JOBS)]:
                _ACTION_JOBS.pop(jid, None)
    return job_id


def _append_action_job_log(job_id: str, chunk: str) -> None:
    if not chunk:
        return
    with _ACTION_JOBS_LOCK:
        row = _ACTION_JOBS.get(job_id)
        if not row:
            return
        text = str(row.get("log", "")) + chunk
        if len(text) > _MAX_ACTION_LOG_CHARS:
            text = text[-_MAX_ACTION_LOG_CHARS :]
        row["log"] = text


def _finish_action_job(job_id: str, result: Dict[str, Any]) -> None:
    with _ACTION_JOBS_LOCK:
        row = _ACTION_JOBS.get(job_id)
        if not row:
            return
        row["result"] = result
        row["finished_at"] = _now_utc()
        ok = bool(result.get("ok"))
        row["status"] = "completed" if ok else "failed"

        output = str(result.get("output", "") or "")
        if output:
            text = str(row.get("log", ""))
            if output not in text:
                text = f"{text}\n{output}" if text else output
            if len(text) > _MAX_ACTION_LOG_CHARS:
                text = text[-_MAX_ACTION_LOG_CHARS :]
            row["log"] = text


def _get_action_job(job_id: str) -> Optional[Dict[str, Any]]:
    with _ACTION_JOBS_LOCK:
        row = _ACTION_JOBS.get(job_id)
        if not row:
            return None
        return {
            "id": row.get("id"),
            "action": row.get("action"),
            "status": row.get("status"),
            "started_at": row.get("started_at"),
            "finished_at": row.get("finished_at"),
            "log": row.get("log", ""),
            "result": row.get("result"),
        }


def _launch_key(repo: str, branchpoint_id: str, world_id: str) -> str:
    return f"{os.path.realpath(repo)}::{branchpoint_id}::{world_id}"


def _is_process_alive(proc: Any) -> bool:
    try:
        return proc is not None and proc.poll() is None
    except Exception:
        return False


def _is_port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=0.4):
            return True
    except OSError:
        return False


def _find_free_port(host: str = _LAUNCH_HOST) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


def _wait_for_port(host: str, port: int, timeout_sec: float = 18.0, proc: Any = None) -> bool:
    deadline = time.time() + float(timeout_sec)
    while time.time() < deadline:
        if _is_port_open(host, port):
            return True
        if proc is not None and not _is_process_alive(proc):
            return False
        time.sleep(0.2)
    return _is_port_open(host, port)


def _cleanup_launch_entry(entry: Dict[str, Any]) -> None:
    for item in entry.get("processes", []) or []:
        proc = item.get("proc")
        handle = item.get("log_handle")
        if _is_process_alive(proc):
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            if handle:
                handle.close()
        except Exception:
            pass


def _start_launch_process(
    cmd: List[str],
    cwd: str,
    log_path: str,
    label: str,
    wait_port: Optional[int] = None,
) -> Tuple[Optional[subprocess.Popen], Optional[Any], Optional[str]]:
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    handle = open(log_path, "w", encoding="utf-8")
    handle.write(f"$ {' '.join(shlex.quote(part) for part in cmd)}\n\n")
    handle.flush()
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            text=True,
            stdout=handle,
            stderr=subprocess.STDOUT,
        )
    except OSError as exc:
        handle.write(f"{label} failed to start: {exc}\n")
        handle.flush()
        handle.close()
        return None, None, f"{label} failed to start: {exc}"

    if wait_port is not None and not _wait_for_port(_LAUNCH_HOST, wait_port, timeout_sec=18.0, proc=proc):
        try:
            proc.terminate()
        except Exception:
            pass
        handle.write(f"{label} failed to bind {_LAUNCH_HOST}:{wait_port}\n")
        handle.flush()
        handle.close()
        return None, None, f"{label} failed to bind {_LAUNCH_HOST}:{wait_port}"

    return proc, handle, None


def _launch_world_app(repo: str, branchpoint_id: str, world_id: str) -> Dict[str, Any]:
    world = pw.load_world(repo, world_id)
    worktree = os.path.realpath(str(world.get("worktree", "")).strip())
    if not worktree or not os.path.isdir(worktree):
        raise ValueError(f"world worktree missing: {worktree}")

    meta_dir = os.path.join(worktree, ".parallel_worlds")
    os.makedirs(meta_dir, exist_ok=True)

    key = _launch_key(repo, branchpoint_id, world_id)
    with _LAUNCH_LOCK:
        existing = _WORLD_LAUNCHES.get(key)
        if existing:
            url = str(existing.get("url", "")).strip()
            port = int(existing.get("port", 0) or 0)
            proc_items = existing.get("processes", []) or []
            alive = bool(proc_items) and all(_is_process_alive(item.get("proc")) for item in proc_items)
            if url and port > 0 and alive and _is_port_open(_LAUNCH_HOST, port):
                return {
                    "ok": True,
                    "url": url,
                    "world": world_id,
                    "mode": existing.get("mode"),
                    "message": "reused existing app launch",
                    "logs": existing.get("logs", []),
                }
            _cleanup_launch_entry(existing)
            _WORLD_LAUNCHES.pop(key, None)

        processes: List[Dict[str, Any]] = []
        logs: List[str] = []

        has_root_package = os.path.isfile(os.path.join(worktree, "package.json"))
        has_webapp = os.path.isfile(os.path.join(worktree, "webapp", "package.json"))
        has_pw_backend = os.path.isfile(os.path.join(worktree, "pw.py")) and os.path.isfile(os.path.join(worktree, "pw_web.py"))
        has_index = os.path.isfile(os.path.join(worktree, "index.html"))

        mode = ""
        app_url = ""
        app_port = 0

        if has_webapp and shutil.which("npm"):
            frontend_port = _find_free_port(_LAUNCH_HOST)
            frontend_log = os.path.join(meta_dir, "launch-frontend.log")
            frontend_cmd = ["npm", "--prefix", "webapp", "run", "dev", "--", "--host", _LAUNCH_HOST, "--port", str(frontend_port)]
            proc, handle, err = _start_launch_process(frontend_cmd, worktree, frontend_log, "frontend", wait_port=frontend_port)
            if err:
                raise ValueError(err)
            processes.append({"proc": proc, "log_handle": handle})
            logs.append(frontend_log)

            if has_pw_backend:
                backend_port = _find_free_port(_LAUNCH_HOST)
                backend_log = os.path.join(meta_dir, "launch-backend.log")
                backend_cmd = [sys.executable, "pw.py", "web", "--host", _LAUNCH_HOST, "--port", str(backend_port)]
                proc_b, handle_b, err_b = _start_launch_process(
                    backend_cmd,
                    worktree,
                    backend_log,
                    "backend",
                    wait_port=backend_port,
                )
                if err_b:
                    for p in processes:
                        _cleanup_launch_entry({"processes": [p]})
                    raise ValueError(err_b)
                processes.append({"proc": proc_b, "log_handle": handle_b})
                logs.append(backend_log)

            mode = "webapp-dev"
            app_port = frontend_port
            app_url = f"http://{_LAUNCH_HOST}:{frontend_port}"
        elif has_root_package and shutil.which("npm"):
            port = _find_free_port(_LAUNCH_HOST)
            log_path = os.path.join(meta_dir, "launch-dev.log")
            cmd = ["npm", "run", "dev", "--", "--host", _LAUNCH_HOST, "--port", str(port)]
            proc, handle, err = _start_launch_process(cmd, worktree, log_path, "dev server", wait_port=port)
            if err:
                raise ValueError(err)
            processes.append({"proc": proc, "log_handle": handle})
            logs.append(log_path)
            mode = "node-dev"
            app_port = port
            app_url = f"http://{_LAUNCH_HOST}:{port}"
        elif has_index:
            port = _find_free_port(_LAUNCH_HOST)
            log_path = os.path.join(meta_dir, "launch-static.log")
            cmd = [sys.executable, "-m", "http.server", str(port), "--bind", _LAUNCH_HOST]
            proc, handle, err = _start_launch_process(cmd, worktree, log_path, "static server", wait_port=port)
            if err:
                raise ValueError(err)
            processes.append({"proc": proc, "log_handle": handle})
            logs.append(log_path)
            mode = "static-http"
            app_port = port
            app_url = f"http://{_LAUNCH_HOST}:{port}"
        else:
            raise ValueError(
                "unable to launch app: expected webapp/package.json, package.json with dev script, or index.html"
            )

        entry = {
            "world": world_id,
            "mode": mode,
            "url": app_url,
            "port": app_port,
            "logs": logs,
            "processes": processes,
            "started_at": _now_utc(),
        }
        _WORLD_LAUNCHES[key] = entry

    return {
        "ok": True,
        "url": app_url,
        "world": world_id,
        "mode": mode,
        "message": "app launched",
        "logs": logs,
    }


class _TeeWriter(io.TextIOBase):
    def __init__(self, sink: io.StringIO, callback: Optional[Callable[[str], None]] = None):
        super().__init__()
        self._sink = sink
        self._callback = callback

    def write(self, s: str) -> int:
        self._sink.write(s)
        if self._callback:
            self._callback(s)
        return len(s)

    def flush(self) -> None:
        self._sink.flush()


def _split_worlds(raw: str) -> Optional[List[str]]:
    text = (raw or "").strip()
    if not text:
        return None
    tokens = [x.strip() for x in text.replace(",", " ").split()]
    tokens = [x for x in tokens if x]
    return tokens or None


def _parse_optional_text(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or text.lower() == "none":
        return None
    return text


def _parse_optional_int(raw: Any, field: str, minimum: int = 1) -> Optional[int]:
    if raw in (None, ""):
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc
    if value < minimum:
        raise ValueError(f"{field} must be >= {minimum}")
    return value


def _extract_model_world_count(output: str) -> Tuple[Optional[int], Optional[str]]:
    text = (output or "").strip()
    if not text:
        return None, None

    if re.fullmatch(r"\d+", text):
        return int(text), None

    candidates: List[Dict[str, Any]] = []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            candidates.append(parsed)
    except json.JSONDecodeError:
        pass

    for match in re.finditer(r"\{[\s\S]*?\}", text):
        blob = match.group(0)
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            candidates.append(parsed)

    for item in candidates:
        raw_count = item.get("count")
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        reason = str(item.get("reason", "")).strip() or None
        return count, reason

    match = re.search(r'"count"\s*:\s*(\d+)', text)
    if match:
        return int(match.group(1)), None

    return None, None


def _build_model_selection_command(template: str, prompt_file: str, workdir: str, intent: str) -> str:
    replacements = {
        "{prompt_file}": prompt_file,
        "{world_id}": "selector",
        "{world_name}": "selector",
        "{worktree}": workdir,
        "{intent}": intent,
        "{strategy}": "auto-world-count-selection",
    }
    command = template
    for key, value in replacements.items():
        command = command.replace(key, value)
    if "{prompt_file}" not in template:
        command = f'{command} < "{prompt_file}"'
    return command


def _model_world_count(
    repo: str,
    config_path: str,
    intent: str,
    max_count: int,
    cli_strategies: Optional[List[str]],
) -> Tuple[int, str]:
    if max_count < 1:
        raise ValueError("max_count must be >= 1")

    cfg = pw.load_config(config_path)
    codex_cfg = cfg.get("codex", {}) if isinstance(cfg, dict) else {}
    command_template = str(codex_cfg.get("command", "")).strip()
    if not command_template:
        raise ValueError(
            "max_count auto-selection requires codex.command in parallel_worlds.json, or provide explicit count."
        )

    timeout_sec = int(codex_cfg.get("timeout_sec", 900) or 900)
    timeout_sec = max(15, min(timeout_sec, 120))

    strategies_text = "\n".join(f"- {item}" for item in (cli_strategies or [])) or "- (none provided)"
    prompt_lines = [
        "You are selecting a branch count for parallel software implementation.",
        "Return only compact JSON with this exact shape:",
        '{"count": <integer>, "reason": "<short reason>"}',
        f"count must be between 1 and {max_count}.",
        "Prefer fewer branches for simple tasks; more for uncertain or tradeoff-heavy tasks.",
        "",
        "Intent:",
        intent,
        "",
        "Strategies:",
        strategies_text,
    ]
    prompt_text = "\n".join(prompt_lines) + "\n"

    prompt_path = ""
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".md") as tmp:
            tmp.write(prompt_text)
            prompt_path = tmp.name

        with tempfile.TemporaryDirectory(prefix="pw-model-count-") as workdir:
            command = _build_model_selection_command(command_template, prompt_path, workdir, intent)
            result = subprocess.run(
                command,
                cwd=workdir,
                text=True,
                capture_output=True,
                shell=True,
                timeout=timeout_sec,
            )
        output = ((result.stdout or "") + "\n" + (result.stderr or "")).strip()
        raw_count, reason = _extract_model_world_count(output)
        if raw_count is None:
            raise ValueError("model did not return a parseable count JSON")

        count = max(1, min(max_count, int(raw_count)))
        if reason:
            return count, f"model-selected {count} world(s) (max={max_count}, reason={reason})"
        return count, f"model-selected {count} world(s) (max={max_count})"
    except subprocess.TimeoutExpired as exc:
        raise ValueError(f"model auto-selection timed out after {timeout_sec}s") from exc
    except OSError as exc:
        raise ValueError(f"failed to run model auto-selection command: {exc}") from exc
    finally:
        if prompt_path and os.path.exists(prompt_path):
            try:
                os.remove(prompt_path)
            except OSError:
                pass


def _resolve_world_count(
    repo: str,
    config_path: str,
    intent: str,
    count: Optional[int],
    max_count: Optional[int],
    cli_strategies: Optional[List[str]],
) -> Tuple[Optional[int], str]:
    if count is not None:
        if max_count is None:
            return count, f"using explicit world count={count}"
        clamped = min(count, max_count)
        if clamped != count:
            return clamped, f"explicit count={count} exceeded max_count={max_count}; clamped to {clamped}"
        return clamped, f"using explicit world count={clamped} (max={max_count})"

    if max_count is None:
        return None, ""

    try:
        return _model_world_count(repo, config_path, intent, max_count, cli_strategies)
    except ValueError as exc:
        fallback_default = 3
        try:
            cfg = pw.load_config(config_path)
            fallback_default = int(cfg.get("default_world_count", 3) or 3)
        except Exception:
            fallback_default = 3
        fallback = max(1, min(max_count, fallback_default))
        message = str(exc).strip()
        if "codex.command" in message:
            return fallback, f"codex auto-selection unavailable; using default world count={fallback} (max={max_count})"
        return fallback, f"auto-selection unavailable ({message}); using default world count={fallback} (max={max_count})"


def _pick_folder_path(prompt: str, default_path: Optional[str]) -> Tuple[bool, Optional[str], str]:
    if sys.platform != "darwin":
        return False, None, "Finder picker is only supported on macOS."

    script: List[str] = []
    safe_prompt = (prompt or "Choose a folder").replace('"', '\\"')
    base = default_path or ""
    default_dir = os.path.realpath(base) if base else ""
    if default_dir and not os.path.isdir(default_dir):
        default_dir = os.path.dirname(default_dir)
    if default_dir and os.path.isdir(default_dir):
        safe_default = default_dir.replace("\\", "\\\\").replace('"', '\\"')
        script.append(f'set chosenFolder to choose folder with prompt "{safe_prompt}" default location (POSIX file "{safe_default}")')
    else:
        script.append(f'set chosenFolder to choose folder with prompt "{safe_prompt}"')
    script.append("POSIX path of chosenFolder")

    try:
        result = subprocess.run(["osascript"] + [arg for line in script for arg in ("-e", line)], text=True, capture_output=True, check=False)
    except OSError as exc:
        return False, None, str(exc)
    if result.returncode == 0:
        chosen = (result.stdout or "").strip()
        if chosen:
            return True, chosen, ""
        return False, None, "No folder was selected."

    combined = ((result.stderr or "") + "\n" + (result.stdout or "")).strip()
    if "-128" in combined:
        return False, None, "selection canceled"
    return False, None, combined or "Unable to open Finder folder picker."


def _resolve_git_root(path: str) -> Optional[str]:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=path,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    root = (result.stdout or "").strip()
    return root or None


def _slugify_project_dir(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", (name or "").strip().lower()).strip("._-")
    return slug or "new-project"


def _resolve_project_path(
    raw_path: str,
    raw_name: str,
    raw_base_path: str,
    fallback_base_path: str,
) -> Tuple[str, Optional[str]]:
    explicit = (raw_path or "").strip()
    if explicit:
        return os.path.abspath(explicit), None

    name = (raw_name or "").strip()
    if not name:
        raise ValueError("path or name is required")

    base = (raw_base_path or "").strip() or (fallback_base_path or "").strip()
    if not base:
        raise ValueError("base path is required when path is omitted")

    target = os.path.join(os.path.abspath(base), _slugify_project_dir(name))
    return target, f"derived project path: {target}"


def _read_text(path: str) -> str:
    if not path or not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def _tail_text(path: str, lines: int) -> str:
    if not path or not os.path.exists(path):
        return ""
    if lines <= 0:
        return ""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        all_lines = f.read().splitlines()
    return "\n".join(all_lines[-lines:])


def _visual_kind(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in {".mp4", ".webm", ".mov"}:
        return "video"
    return "image"


@contextmanager
def _pushd(path: Optional[str]):
    previous = os.getcwd()
    try:
        if path:
            os.chdir(path)
        yield
    finally:
        os.chdir(previous)


def _run_action(
    fn,
    *args,
    cwd: Optional[str] = None,
    log_callback: Optional[Callable[[str], None]] = None,
    **kwargs,
) -> Tuple[bool, str, Any]:
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    out = _TeeWriter(out_buf, callback=log_callback)
    err = _TeeWriter(err_buf, callback=log_callback)
    ok = True
    result: Any = None
    try:
        with _ACTION_LOCK:
            with _pushd(cwd):
                with redirect_stdout(out), redirect_stderr(err):
                    result = fn(*args, **kwargs)
    except SystemExit:
        pass
    except Exception:
        ok = False
        traceback.print_exc(file=err)

    output = (out_buf.getvalue() + err_buf.getvalue()).strip()
    if "error:" in output.lower():
        ok = False
    return ok, output, result


def _live_branch_state(repo: str, world: Dict[str, Any], branchpoint: Dict[str, Any]) -> Dict[str, Any]:
    branch = str(world.get("branch", "")).strip()
    source_ref = str(branchpoint.get("source_ref", "")).strip()
    worktree = str(world.get("worktree", "")).strip()

    if not branch:
        return {
            "branch_exists": False,
            "head": None,
            "ahead_commits": None,
            "worktree_ok": False,
            "dirty_files": None,
            "source_head": None,
            "commit_nodes": [],
            "commit_nodes_truncated": False,
        }

    exists = branch_exists(branch, repo)
    head = None
    ahead = None
    source_head = None
    commit_nodes: List[Dict[str, str]] = []
    commit_nodes_truncated = False

    # Prefer worktree-local git state (supports both worktree mode and branch/local repo mode).
    git_scope = repo
    branch_for_scope = branch
    source_for_scope = source_ref
    if worktree and os.path.isdir(worktree):
        inside = git(["-C", worktree, "rev-parse", "--is-inside-work-tree"], check=False)
        if inside.returncode == 0:
            git_scope = worktree
            local_branch = git(["-C", worktree, "branch", "--show-current"], check=False).stdout.strip()
            if local_branch:
                branch_for_scope = local_branch

            if source_ref:
                source_probe = git(["-C", worktree, "rev-parse", "--verify", "--quiet", source_ref], check=False)
                if source_probe.returncode == 0:
                    source_for_scope = source_ref
                else:
                    origin_probe = git(["-C", worktree, "rev-parse", "--verify", "--quiet", f"origin/{source_ref}"], check=False)
                    if origin_probe.returncode == 0:
                        source_for_scope = f"origin/{source_ref}"
                    else:
                        source_for_scope = ""

    if git_scope == worktree:
        exists = bool(branch_for_scope)

    if exists:
        if git_scope == worktree:
            head_proc = git(["-C", worktree, "rev-parse", "--short", "HEAD"], check=False)
        else:
            head_proc = git(["rev-parse", "--short", branch_for_scope], cwd=repo, check=False)
        if head_proc.returncode == 0:
            head = (head_proc.stdout or "").strip() or None

        if source_for_scope:
            if git_scope == worktree:
                source_head_proc = git(["-C", worktree, "rev-parse", "--short", source_for_scope], check=False)
            else:
                source_head_proc = git(["rev-parse", "--short", source_for_scope], cwd=repo, check=False)
            if source_head_proc.returncode == 0:
                source_head = (source_head_proc.stdout or "").strip() or None

            if git_scope == worktree:
                ahead_proc = git(["-C", worktree, "rev-list", "--count", f"{source_for_scope}..HEAD"], check=False)
            else:
                ahead_proc = git(["rev-list", "--count", f"{source_for_scope}..{branch_for_scope}"], cwd=repo, check=False)
            if ahead_proc.returncode == 0:
                raw = (ahead_proc.stdout or "").strip()
                try:
                    ahead = int(raw)
                except ValueError:
                    ahead = None

            if git_scope == worktree:
                log_proc = git(
                    ["-C", worktree, "log", "--reverse", "--max-count", "12", "--pretty=format:%h%x1f%s", f"{source_for_scope}..HEAD"],
                    check=False,
                )
            else:
                log_proc = git(
                    [
                        "log",
                        "--reverse",
                        "--max-count",
                        "12",
                        "--pretty=format:%h%x1f%s",
                        f"{source_for_scope}..{branch_for_scope}",
                    ],
                    cwd=repo,
                    check=False,
                )
        else:
            if git_scope == worktree:
                log_proc = git(["-C", worktree, "log", "--reverse", "--max-count", "12", "--pretty=format:%h%x1f%s", "HEAD"], check=False)
            else:
                log_proc = git(
                    [
                        "log",
                        "--reverse",
                        "--max-count",
                        "12",
                        "--pretty=format:%h%x1f%s",
                        branch_for_scope,
                    ],
                    cwd=repo,
                    check=False,
                )

        if log_proc.returncode == 0:
            for line in (log_proc.stdout or "").splitlines():
                item = line.strip()
                if not item:
                    continue
                if "\x1f" in item:
                    sha, subject = item.split("\x1f", 1)
                else:
                    parts = item.split(" ", 1)
                    sha = parts[0]
                    subject = parts[1] if len(parts) > 1 else ""
                commit_nodes.append({"sha": sha.strip(), "subject": subject.strip()})
        if isinstance(ahead, int) and ahead > len(commit_nodes):
            commit_nodes_truncated = True

    worktree_ok = False
    dirty_files = None
    if worktree and os.path.isdir(worktree):
        status_proc = git(["-C", worktree, "status", "--porcelain"], check=False)
        if status_proc.returncode == 0:
            worktree_ok = True
            dirty_files = len([line for line in (status_proc.stdout or "").splitlines() if line.strip()])

    return {
        "branch_exists": exists,
        "head": head,
        "ahead_commits": ahead,
        "worktree_ok": worktree_ok,
        "dirty_files": dirty_files,
        "source_head": source_head,
        "commit_nodes": commit_nodes,
        "commit_nodes_truncated": commit_nodes_truncated,
    }


def _serialize_world_row(repo: str, branchpoint: Dict[str, Any], world_id: str) -> Dict[str, Any]:
    branchpoint_id = str(branchpoint.get("id", "")).strip()
    world = pw.load_world(repo, world_id)
    run = pw.load_run(repo, branchpoint_id, world_id)
    codex = pw.load_codex_run(repo, branchpoint_id, world_id)
    render = pw.load_render(repo, branchpoint_id, world_id)

    def _map_run(record: Optional[Dict[str, Any]], log_key: str) -> Optional[Dict[str, Any]]:
        if not record:
            return None
        log_path = record.get(log_key)
        return {
            "exit_code": record.get("exit_code"),
            "duration_sec": record.get("duration_sec"),
            "error": record.get("error"),
            "log_path": pw.relative_to_repo(log_path, repo) if log_path else None,
            "raw": record,
        }

    codex_row = None
    if codex:
        codex_log = codex.get("log_file")
        codex_row = {
            "exit_code": codex.get("exit_code"),
            "duration_sec": codex.get("duration_sec"),
            "error": codex.get("error"),
            "log_path": pw.relative_to_repo(codex_log, repo) if codex_log else None,
            "prompt_path": pw.relative_to_repo(codex.get("prompt_file"), repo) if codex.get("prompt_file") else None,
            "raw": codex,
        }

    render_row = _map_run(render, "render_log")
    if render_row and render:
        assets = render.get("visual_artifacts") or []
        visual_assets: List[Dict[str, Any]] = []
        if isinstance(assets, list):
            for idx, asset_path in enumerate(assets):
                path = str(asset_path).strip()
                if not path:
                    continue
                qs = urlencode({"branchpoint": branchpoint_id, "world": world_id, "index": idx})
                visual_assets.append(
                    {
                        "index": idx,
                        "path": pw.relative_to_repo(path, repo),
                        "kind": _visual_kind(path),
                        "url": f"/api/render_asset?{qs}",
                    }
                )
        render_row["visual_assets"] = visual_assets

    return {
        "world": world,
        "codex": codex_row,
        "run": _map_run(run, "trace_log"),
        "render": render_row,
        "live": _live_branch_state(repo, world, branchpoint),
    }


def _dashboard_branchpoint_worlds(repo: str, branchpoints: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {}
    for branchpoint in branchpoints:
        bp_id = str(branchpoint.get("id", "")).strip()
        if not bp_id:
            continue
        world_ids = branchpoint.get("world_ids") or []
        if not isinstance(world_ids, list):
            continue

        worlds: List[Dict[str, Any]] = []
        for world_id in world_ids:
            wid = str(world_id).strip()
            if not wid:
                continue
            try:
                world = pw.load_world(repo, wid)
            except (SystemExit, Exception):  # pragma: no cover - tolerate stale metadata rows.
                continue
            worlds.append(
                {
                    "id": wid,
                    "name": str(world.get("name", "")).strip() or "world",
                    "index": world.get("index"),
                    "branch": str(world.get("branch", "")).strip(),
                    "status": str(world.get("status", "")).strip() or "ready",
                }
            )

        worlds.sort(
            key=lambda item: (
                int(item.get("index", 0)) if isinstance(item.get("index"), int) else 10_000,
                str(item.get("name", "")),
            )
        )
        out[bp_id] = worlds

    return out


def _is_merged_into(repo: str, source_branch: str, target_branch: str) -> bool:
    if not source_branch or not target_branch:
        return False
    result = git(["merge-base", "--is-ancestor", source_branch, target_branch], cwd=repo, check=False)
    return result.returncode == 0


def _dashboard_branch_summary(repo: str, branchpoints: List[Dict[str, Any]], selected_branchpoint_id: Optional[str]) -> Dict[str, int]:
    summary = {
        "open_branches_total": 0,
        "awaiting_merge_total": 0,
        "open_branches_current": 0,
        "awaiting_merge_current": 0,
    }
    selected_id = (selected_branchpoint_id or "").strip()

    for branchpoint in branchpoints:
        bp_id = str(branchpoint.get("id", "")).strip()
        base_branch = str(branchpoint.get("base_branch", "")).strip()
        selected_world_id = str(branchpoint.get("selected_world_id", "")).strip()
        world_ids = branchpoint.get("world_ids") or []
        if not isinstance(world_ids, list):
            continue

        for world_id in world_ids:
            try:
                world = pw.load_world(repo, str(world_id))
            except (SystemExit, Exception):  # pragma: no cover - tolerate stale metadata rows.
                continue

            branch = str(world.get("branch", "")).strip()
            if not branch:
                continue

            is_open = branch_exists(branch, repo)
            is_feature_complete = (world.get("status") == "pass") or (
                selected_world_id and world.get("id") == selected_world_id
            )
            merged_into_base = _is_merged_into(repo, branch, base_branch) if base_branch else False
            awaiting_merge = is_open and is_feature_complete and not merged_into_base

            if is_open:
                summary["open_branches_total"] += 1
                if selected_id and bp_id == selected_id:
                    summary["open_branches_current"] += 1

            if awaiting_merge:
                summary["awaiting_merge_total"] += 1
                if selected_id and bp_id == selected_id:
                    summary["awaiting_merge_current"] += 1

    return summary


class ParallelWorldsHandler(BaseHTTPRequestHandler):
    server: "ParallelWorldsServer"

    def _repo(self) -> str:
        return self.server.repo

    def _cfg(self) -> str:
        return self.server.config_path

    def _set_project(self, repo: str, config_path: str) -> None:
        self.server.repo = repo
        self.server.config_path = config_path
        self.server.ui_dist = os.path.join(repo, "webapp", "dist")

    def _json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _start_async_action(self, action: str, runner: Callable[[str], Dict[str, Any]]) -> None:
        job_id = _create_action_job(action)

        def _target() -> None:
            try:
                result = runner(job_id)
                if not isinstance(result, dict):
                    result = {"ok": False, "error": "internal error: invalid action result payload"}
            except Exception as exc:  # pragma: no cover - safety wrapper
                tb = traceback.format_exc()
                _append_action_job_log(job_id, f"\n{tb}\n")
                result = {"ok": False, "error": str(exc), "traceback": tb}
            _finish_action_job(job_id, result)

        thread = threading.Thread(target=_target, daemon=True, name=f"pw-action-{action}-{job_id}")
        thread.start()
        self._json(202, {"ok": True, "job_id": job_id, "status": "running", "action": action})

    def _bytes(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path: str) -> bool:
        ui_dist = os.path.realpath(self.server.ui_dist)
        if not os.path.isdir(ui_dist):
            return False

        rel = path.lstrip("/") or "index.html"
        candidate = os.path.realpath(os.path.join(ui_dist, rel))
        if not candidate.startswith(ui_dist):
            return False

        if os.path.isdir(candidate):
            candidate = os.path.join(candidate, "index.html")

        if os.path.isfile(candidate):
            content_type = mimetypes.guess_type(candidate)[0] or "application/octet-stream"
            with open(candidate, "rb") as f:
                self._bytes(200, content_type, f.read())
            return True

        if "." not in rel:
            index_file = os.path.join(ui_dist, "index.html")
            if os.path.isfile(index_file):
                with open(index_file, "rb") as f:
                    self._bytes(200, "text/html; charset=utf-8", f.read())
                return True
        return False

    def _parse_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        if not raw.strip():
            return {}
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {}
        return data

    def _latest_branchpoint(self) -> Optional[str]:
        return pw.get_latest_branchpoint(self._repo())

    def _resolve_branchpoint(self, requested: Optional[str]) -> Optional[str]:
        return requested or self._latest_branchpoint()

    def do_OPTIONS(self) -> None:
        self._json(204, {})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        repo = self._repo()

        try:
            if parsed.path == "/api/health":
                self._json(
                    200,
                    {
                        "ok": True,
                        "repo": repo,
                        "config": self._cfg(),
                        "latest_branchpoint": self._latest_branchpoint(),
                    },
                )
                return

            if parsed.path == "/api/project":
                self._json(
                    200,
                    {
                        "ok": True,
                        "repo": repo,
                        "config": self._cfg(),
                        "latest_branchpoint": self._latest_branchpoint(),
                    },
                )
                return

            if parsed.path == "/api/action_status":
                job_id = (query.get("job") or [""])[0].strip()
                if not job_id:
                    self._json(400, {"ok": False, "error": "job is required"})
                    return
                job = _get_action_job(job_id)
                if not job:
                    self._json(404, {"ok": False, "error": f"job not found: {job_id}"})
                    return
                payload = {"ok": True}
                payload.update(job)
                self._json(200, payload)
                return

            if parsed.path == "/api/branchpoints":
                rows = pw.list_branchpoints(repo)
                self._json(200, {"ok": True, "items": rows, "latest": self._latest_branchpoint()})
                return

            if parsed.path == "/api/dashboard":
                requested = (query.get("branchpoint") or [None])[0]
                bp_id = self._resolve_branchpoint(requested)
                items = pw.list_branchpoints(repo)
                payload: Dict[str, Any] = {
                    "ok": True,
                    "repo": repo,
                    "config": self._cfg(),
                    "latest_branchpoint": self._latest_branchpoint(),
                    "branchpoints": items,
                    "branchpoint_worlds": _dashboard_branchpoint_worlds(repo, items),
                    "selected_branchpoint": bp_id,
                    "branchpoint": None,
                    "world_rows": [],
                    "summary": _dashboard_branch_summary(repo, items, bp_id),
                }

                if bp_id:
                    bp = pw.load_branchpoint(repo, bp_id)
                    payload["branchpoint"] = bp
                    rows = [_serialize_world_row(repo, bp, wid) for wid in bp.get("world_ids", [])]
                    rows.sort(key=lambda row: int(row["world"].get("index", 0)))
                    payload["world_rows"] = rows

                self._json(200, payload)
                return

            if parsed.path == "/api/artifact":
                name = (query.get("name") or [""])[0]
                if name not in {"report.md", "play.md"}:
                    self._json(400, {"ok": False, "error": "artifact name must be report.md or play.md"})
                    return
                path = os.path.join(repo, name)
                self._json(
                    200,
                    {
                        "ok": True,
                        "name": name,
                        "path": pw.relative_to_repo(path, repo),
                        "text": _read_text(path),
                    },
                )
                return

            if parsed.path == "/api/log":
                kind = (query.get("kind") or [""])[0]
                branchpoint_id = (query.get("branchpoint") or [""])[0]
                world_id = (query.get("world") or [""])[0]
                tail_n = int((query.get("tail") or ["0"])[0] or "0")
                if not kind or not branchpoint_id or not world_id:
                    self._json(400, {"ok": False, "error": "kind, branchpoint, world are required"})
                    return

                record: Optional[Dict[str, Any]] = None
                path = ""
                if kind == "run":
                    record = pw.load_run(repo, branchpoint_id, world_id)
                    path = (record or {}).get("trace_log", "")
                elif kind == "render":
                    record = pw.load_render(repo, branchpoint_id, world_id)
                    path = (record or {}).get("render_log", "")
                elif kind == "codex":
                    record = pw.load_codex_run(repo, branchpoint_id, world_id)
                    path = (record or {}).get("log_file", "")
                else:
                    self._json(400, {"ok": False, "error": "kind must be run|render|codex"})
                    return

                text = _tail_text(path, tail_n) if tail_n > 0 else _read_text(path)
                self._json(
                    200,
                    {
                        "ok": True,
                        "kind": kind,
                        "branchpoint": branchpoint_id,
                        "world": world_id,
                        "path": pw.relative_to_repo(path, repo) if path else None,
                        "text": text,
                        "record": record,
                    },
                )
                return

            if parsed.path == "/api/render_asset":
                branchpoint_id = (query.get("branchpoint") or [""])[0].strip()
                world_id = (query.get("world") or [""])[0].strip()
                index_raw = (query.get("index") or [""])[0].strip()
                if not branchpoint_id or not world_id or not index_raw:
                    self._json(400, {"ok": False, "error": "branchpoint, world, and index are required"})
                    return

                try:
                    index = int(index_raw)
                except ValueError:
                    self._json(400, {"ok": False, "error": "index must be an integer"})
                    return
                if index < 0:
                    self._json(400, {"ok": False, "error": "index must be >= 0"})
                    return

                world = pw.load_world(repo, world_id)
                worktree = os.path.realpath(str(world.get("worktree", "")))
                render = pw.load_render(repo, branchpoint_id, world_id) or {}
                artifacts = render.get("visual_artifacts") or []
                if not isinstance(artifacts, list) or index >= len(artifacts):
                    self._json(404, {"ok": False, "error": "visual artifact not found"})
                    return

                candidate = os.path.realpath(str(artifacts[index]))
                if not candidate.startswith(worktree + os.sep) and candidate != worktree:
                    self._json(403, {"ok": False, "error": "artifact path is outside worktree"})
                    return
                if not os.path.isfile(candidate):
                    self._json(404, {"ok": False, "error": "artifact file not found"})
                    return

                content_type = mimetypes.guess_type(candidate)[0] or "application/octet-stream"
                with open(candidate, "rb") as f:
                    self._bytes(200, content_type, f.read())
                return

            if self._serve_static(parsed.path):
                return

            self._json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self._json(500, {"ok": False, "error": str(exc), "traceback": traceback.format_exc()})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        repo = self._repo()
        cfg = self._cfg()

        if not parsed.path.startswith("/api/action/"):
            self._json(404, {"ok": False, "error": "not found"})
            return

        try:
            body = self._parse_json_body()
            action = parsed.path.rsplit("/", 1)[-1]

            if action == "pick_path":
                prompt = str(body.get("prompt", "")).strip() or "Choose a folder"
                default_path = str(body.get("default_path", "")).strip() or None
                ok, selected_path, message = _pick_folder_path(prompt=prompt, default_path=default_path)
                if ok and selected_path:
                    self._json(200, {"ok": True, "path": selected_path, "canceled": False})
                    return
                if message == "selection canceled":
                    self._json(200, {"ok": True, "path": None, "canceled": True})
                    return
                self._json(400, {"ok": False, "error": message or "Unable to select folder"})
                return

            if action == "open_or_create_project":
                raw_path = str(body.get("path") or "").strip()
                raw_name = str(body.get("name") or "").strip()
                raw_base_path = str(body.get("base_path") or "").strip()
                config_name = str(body.get("config_name", "parallel_worlds.json")).strip() or "parallel_worlds.json"
                project_name = raw_name or None
                base_branch = str(body.get("base_branch", "main")).strip() or "main"
                try:
                    probe, path_note = _resolve_project_path(
                        raw_path=raw_path,
                        raw_name=raw_name,
                        raw_base_path=raw_base_path,
                        fallback_base_path=os.path.dirname(repo),
                    )
                except ValueError as exc:
                    self._json(400, {"ok": False, "error": str(exc)})
                    return

                if os.path.exists(probe) and not os.path.isdir(probe):
                    self._json(400, {"ok": False, "error": f"project path exists and is not a directory: {probe}"})
                    return

                git_root = _resolve_git_root(probe) if os.path.isdir(probe) else None
                if git_root:
                    ok, output, result = _run_action(
                        pw.switch_project,
                        project_path=probe,
                        config_name=config_name,
                        cwd=None,
                    )
                    mode = "switched"
                else:
                    if os.path.isdir(probe):
                        entries = [name for name in os.listdir(probe) if name not in {".DS_Store"}]
                        if entries:
                            self._json(
                                400,
                                {
                                    "ok": False,
                                    "error": (
                                        "path is not a git repository and directory is not empty; "
                                        "choose an existing repo or an empty/new directory"
                                    ),
                                },
                            )
                            return
                    ok, output, result = _run_action(
                        pw.create_project,
                        project_path=probe,
                        project_name=project_name,
                        base_branch=base_branch,
                        config_name=config_name,
                        cwd=None,
                    )
                    mode = "created"

                if ok and isinstance(result, tuple) and len(result) == 2:
                    repo, cfg = str(result[0]), str(result[1])
                    self._set_project(repo, cfg)
                if ok and path_note:
                    output = f"{path_note}\n{output}" if output else path_note
                self._json(
                    200 if ok else 400,
                    {
                        "ok": ok,
                        "mode": mode if ok else None,
                        "output": output,
                        "repo": repo,
                        "config": cfg,
                        "latest_branchpoint": pw.get_latest_branchpoint(repo),
                    },
                )
                return

            if action == "new_project":
                raw_path = str(body.get("path") or "").strip()
                raw_name = str(body.get("name") or "").strip()
                raw_base_path = str(body.get("base_path") or "").strip()
                project_name = raw_name or None
                base_branch = str(body.get("base_branch", "main")).strip() or "main"
                config_name = str(body.get("config_name", "parallel_worlds.json")).strip() or "parallel_worlds.json"
                try:
                    project_path, path_note = _resolve_project_path(
                        raw_path=raw_path,
                        raw_name=raw_name,
                        raw_base_path=raw_base_path,
                        fallback_base_path=os.path.dirname(repo),
                    )
                except ValueError as exc:
                    self._json(400, {"ok": False, "error": str(exc)})
                    return
                ok, output, result = _run_action(
                    pw.create_project,
                    project_path=project_path,
                    project_name=project_name,
                    base_branch=base_branch,
                    config_name=config_name,
                    cwd=None,
                )
                if ok and isinstance(result, tuple) and len(result) == 2:
                    repo, cfg = str(result[0]), str(result[1])
                    self._set_project(repo, cfg)
                if ok and path_note:
                    output = f"{path_note}\n{output}" if output else path_note
                self._json(
                    200 if ok else 400,
                    {
                        "ok": ok,
                        "output": output,
                        "repo": repo,
                        "config": cfg,
                        "latest_branchpoint": pw.get_latest_branchpoint(repo),
                    },
                )
                return

            if action == "switch_project":
                project_path = str(body.get("path", "")).strip()
                if not project_path:
                    self._json(400, {"ok": False, "error": "path is required"})
                    return
                config_name = str(body.get("config_name", "parallel_worlds.json")).strip() or "parallel_worlds.json"
                ok, output, result = _run_action(
                    pw.switch_project,
                    project_path=project_path,
                    config_name=config_name,
                    cwd=None,
                )
                if ok and isinstance(result, tuple) and len(result) == 2:
                    repo, cfg = str(result[0]), str(result[1])
                    self._set_project(repo, cfg)
                self._json(
                    200 if ok else 400,
                    {
                        "ok": ok,
                        "output": output,
                        "repo": repo,
                        "config": cfg,
                        "latest_branchpoint": pw.get_latest_branchpoint(repo),
                    },
                )
                return

            if action == "kickoff":
                intent = str(body.get("intent", "")).strip()
                if not intent:
                    self._json(400, {"ok": False, "error": "intent is required"})
                    return
                try:
                    count = _parse_optional_int(body.get("count"), "count")
                    max_count = _parse_optional_int(body.get("max_count"), "max_count")
                except ValueError as exc:
                    self._json(400, {"ok": False, "error": str(exc)})
                    return
                from_ref = _parse_optional_text(body.get("from_ref"))
                strategies = body.get("strategies")
                cli_strategies = None
                if isinstance(strategies, list):
                    cli_strategies = [str(x).strip() for x in strategies if str(x).strip()]
                try:
                    resolved_count, count_note = _resolve_world_count(
                        repo=repo,
                        config_path=cfg,
                        intent=intent,
                        count=count,
                        max_count=max_count,
                        cli_strategies=cli_strategies,
                    )
                except ValueError as exc:
                    self._json(400, {"ok": False, "error": str(exc)})
                    return

                def _kickoff_job(job_id: str) -> Dict[str, Any]:
                    ok, output, _ = _run_action(
                        pw.kickoff_worlds,
                        config_path=cfg,
                        intent=intent,
                        count=resolved_count,
                        from_ref=from_ref,
                        cli_strategies=cli_strategies,
                        cwd=repo,
                        log_callback=lambda chunk: _append_action_job_log(job_id, chunk),
                    )
                    if count_note:
                        output = f"{count_note}\n{output}" if output else count_note
                    return {"ok": ok, "output": output, "latest_branchpoint": pw.get_latest_branchpoint(repo)}

                self._start_async_action("kickoff", _kickoff_job)
                return

            if action == "run":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or None
                world_filters = _split_worlds(str(body.get("worlds", "")))
                skip_runner = bool(body.get("skip_runner", False))
                skip_codex = bool(body.get("skip_codex", False))

                def _run_job(job_id: str) -> Dict[str, Any]:
                    ok, output, _ = _run_action(
                        pw.run_branchpoint,
                        config_path=cfg,
                        branchpoint_id=branchpoint_id,
                        skip_runner=skip_runner,
                        skip_codex=skip_codex,
                        world_filters=world_filters,
                        cwd=repo,
                        log_callback=lambda chunk: _append_action_job_log(job_id, chunk),
                    )
                    return {"ok": ok, "output": output}

                self._start_async_action("run", _run_job)
                return

            if action == "play":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or None
                world_filters = _split_worlds(str(body.get("worlds", "")))
                render_command = str(body.get("render_command", "")).strip() or None
                timeout_raw = body.get("timeout")
                timeout = int(timeout_raw) if timeout_raw not in (None, "") else None
                preview_raw = body.get("preview_lines")
                preview = int(preview_raw) if preview_raw not in (None, "") else None

                def _play_job(job_id: str) -> Dict[str, Any]:
                    ok, output, _ = _run_action(
                        pw.play_branchpoint,
                        config_path=cfg,
                        branchpoint_id=branchpoint_id,
                        world_filters=world_filters,
                        render_command_override=render_command,
                        timeout_override=timeout,
                        preview_lines_override=preview,
                        cwd=repo,
                        log_callback=lambda chunk: _append_action_job_log(job_id, chunk),
                    )
                    return {"ok": ok, "output": output}

                self._start_async_action("play", _play_job)
                return

            if action == "launch":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or pw.get_latest_branchpoint(repo)
                world_id = str(body.get("world", "")).strip()
                if not branchpoint_id:
                    self._json(400, {"ok": False, "error": "branchpoint is required"})
                    return
                if not world_id:
                    self._json(400, {"ok": False, "error": "world is required"})
                    return
                branchpoint = pw.load_branchpoint(repo, branchpoint_id)
                if world_id not in (branchpoint.get("world_ids") or []):
                    self._json(404, {"ok": False, "error": f"world not found in branchpoint: {world_id}"})
                    return

                def _launch_job(job_id: str) -> Dict[str, Any]:
                    try:
                        launched = _launch_world_app(repo=repo, branchpoint_id=branchpoint_id, world_id=world_id)
                    except Exception as exc:
                        return {"ok": False, "error": str(exc), "output": str(exc)}
                    output = f"{launched.get('message')}: {launched.get('url')}"
                    logs = launched.get("logs") or []
                    if logs:
                        output = output + "\n" + "\n".join(f"log: {pw.relative_to_repo(str(path), repo)}" for path in logs)
                    launched["output"] = output
                    return launched

                self._start_async_action("launch", _launch_job)
                return

            if action == "select":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or None
                world = str(body.get("world", "")).strip()
                if not world:
                    self._json(400, {"ok": False, "error": "world is required"})
                    return
                target_branch = str(body.get("target_branch", "")).strip() or None
                merge = bool(body.get("merge", False))

                def _select_job(job_id: str) -> Dict[str, Any]:
                    ok, output, _ = _run_action(
                        pw.select_world,
                        config_path=cfg,
                        branchpoint_id=branchpoint_id,
                        world_token=world,
                        merge=merge,
                        target_branch=target_branch,
                        cwd=repo,
                        log_callback=lambda chunk: _append_action_job_log(job_id, chunk),
                    )
                    return {"ok": ok, "output": output}

                self._start_async_action("select", _select_job)
                return

            if action == "refork":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or None
                world = str(body.get("world", "")).strip()
                intent = str(body.get("intent", "")).strip()
                if not world:
                    self._json(400, {"ok": False, "error": "world is required"})
                    return
                if not intent:
                    self._json(400, {"ok": False, "error": "intent is required"})
                    return
                try:
                    count = _parse_optional_int(body.get("count"), "count")
                    max_count = _parse_optional_int(body.get("max_count"), "max_count")
                except ValueError as exc:
                    self._json(400, {"ok": False, "error": str(exc)})
                    return
                strategies = body.get("strategies")
                cli_strategies = None
                if isinstance(strategies, list):
                    cli_strategies = [str(x).strip() for x in strategies if str(x).strip()]
                try:
                    resolved_count, count_note = _resolve_world_count(
                        repo=repo,
                        config_path=cfg,
                        intent=intent,
                        count=count,
                        max_count=max_count,
                        cli_strategies=cli_strategies,
                    )
                except ValueError as exc:
                    self._json(400, {"ok": False, "error": str(exc)})
                    return

                def _refork_job(job_id: str) -> Dict[str, Any]:
                    ok, output, _ = _run_action(
                        pw.refork_world,
                        config_path=cfg,
                        branchpoint_id=branchpoint_id,
                        world_token=world,
                        intent=intent,
                        count=resolved_count,
                        cli_strategies=cli_strategies,
                        cwd=repo,
                        log_callback=lambda chunk: _append_action_job_log(job_id, chunk),
                    )
                    if count_note:
                        output = f"{count_note}\n{output}" if output else count_note
                    return {"ok": ok, "output": output, "latest_branchpoint": pw.get_latest_branchpoint(repo)}

                self._start_async_action("refork", _refork_job)
                return

            if action == "autopilot":
                prompt = str(body.get("prompt", "")).strip() or str(body.get("intent", "")).strip()
                if not prompt:
                    self._json(400, {"ok": False, "error": "prompt is required"})
                    return
                try:
                    count = _parse_optional_int(body.get("count"), "count")
                    max_count = _parse_optional_int(body.get("max_count"), "max_count")
                except ValueError as exc:
                    self._json(400, {"ok": False, "error": str(exc)})
                    return
                from_ref = _parse_optional_text(body.get("from_ref"))
                run_after_kickoff = bool(body.get("run", True))
                play_after_run = bool(body.get("play", False))
                skip_runner = bool(body.get("skip_runner", False))
                skip_codex = bool(body.get("skip_codex", False))
                render_command = str(body.get("render_command", "")).strip() or None
                timeout_raw = body.get("timeout")
                timeout = int(timeout_raw) if timeout_raw not in (None, "") else None
                preview_raw = body.get("preview_lines")
                preview = int(preview_raw) if preview_raw not in (None, "") else None
                strategies = body.get("strategies")
                cli_strategies = None
                if isinstance(strategies, list):
                    cli_strategies = [str(x).strip() for x in strategies if str(x).strip()]
                try:
                    resolved_count, count_note = _resolve_world_count(
                        repo=repo,
                        config_path=cfg,
                        intent=prompt,
                        count=count,
                        max_count=max_count,
                        cli_strategies=cli_strategies,
                    )
                except ValueError as exc:
                    self._json(400, {"ok": False, "error": str(exc)})
                    return

                def _autopilot_job(job_id: str) -> Dict[str, Any]:
                    ok, output, _ = _run_action(
                        pw.autopilot_worlds,
                        config_path=cfg,
                        prompt=prompt,
                        count=resolved_count,
                        from_ref=from_ref,
                        cli_strategies=cli_strategies,
                        run_after_kickoff=run_after_kickoff,
                        play_after_run=play_after_run,
                        skip_runner=skip_runner,
                        skip_codex=skip_codex,
                        render_command_override=render_command,
                        timeout_override=timeout,
                        preview_lines_override=preview,
                        cwd=repo,
                        log_callback=lambda chunk: _append_action_job_log(job_id, chunk),
                    )
                    if count_note:
                        output = f"{count_note}\n{output}" if output else count_note
                    return {"ok": ok, "output": output, "latest_branchpoint": pw.get_latest_branchpoint(repo)}

                self._start_async_action("autopilot", _autopilot_job)
                return

            self._json(404, {"ok": False, "error": f"unknown action: {action}"})
        except Exception as exc:
            self._json(500, {"ok": False, "error": str(exc), "traceback": traceback.format_exc()})


class ParallelWorldsServer(ThreadingHTTPServer):
    def __init__(self, addr: Tuple[str, int], handler, repo: str, config_path: str, ui_dist: str):
        super().__init__(addr, handler)
        self.repo = repo
        self.config_path = config_path
        self.ui_dist = ui_dist


def serve(config_path: str, host: str, port: int) -> None:
    repo = pw.ensure_git_repo()
    cfg_path = config_path if os.path.isabs(config_path) else os.path.join(repo, config_path)
    pw.load_config(cfg_path)
    pw.ensure_metadata_dirs(repo)
    ui_dist = os.path.join(repo, "webapp", "dist")
    server = ParallelWorldsServer((host, port), ParallelWorldsHandler, repo=repo, config_path=cfg_path, ui_dist=ui_dist)
    print(f"Parallel Worlds API running on http://{host}:{port}", flush=True)
    print(f"Repo: {repo}", flush=True)
    print(f"Config: {cfg_path}", flush=True)
    if os.path.isdir(ui_dist):
        print(f"Serving built UI: {ui_dist}", flush=True)
    else:
        print("UI build missing: run `npm --prefix webapp run build` or `npm --prefix webapp run dev`.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Parallel Worlds API backend")
    parser.add_argument("-c", "--config", default="parallel_worlds.json")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    serve(config_path=args.config, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
