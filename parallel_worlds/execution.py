import json
import os
import re
import signal
import subprocess
import time
from typing import Any, Dict, List, Optional, Tuple

from .common import die, git, now_utc, run_shell
from .runtime_control import (
    finish_active_process,
    force_kill_if_stop_requested,
    get_active_runtime,
    list_steering_comments,
    register_active_process,
)


def load_agents_skills(repo: str) -> List[str]:
    agents_path = os.path.join(repo, "AGENTS.md")
    if not os.path.exists(agents_path):
        return []

    found: List[str] = []
    seen = set()
    with open(agents_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            match = re.match(r"\s*-\s*([a-zA-Z0-9-]+)\s*:", line)
            if not match:
                continue
            skill = match.group(1).strip()
            if not skill or skill in seen:
                continue
            seen.add(skill)
            found.append(skill)
    return found


def suggest_skills(intent: str, notes: str, available_skills: List[str]) -> List[str]:
    text = f"{intent} {notes}".lower()
    skill_map: List[Tuple[Tuple[str, ...], Tuple[str, ...]]] = [
        (("deploy", "host", "publish"), ("cloudflare-deploy", "vercel-deploy")),
        (("game", "web game"), ("develop-web-game", "playwright")),
        (("figma", "design"), ("figma",)),
        (("ci", "actions", "check"), ("gh-fix-ci",)),
        (("pr comment", "review comment"), ("gh-address-comments",)),
        (("pdf",), ("pdf",)),
        (("docx", "word document"), ("doc",)),
        (("screenshot",), ("screenshot",)),
        (("image", "inpaint", "background"), ("imagegen",)),
        (("speech", "tts", "voice"), ("speech",)),
        (("sentry", "production error"), ("sentry",)),
    ]

    chosen: List[str] = []
    for keywords, skills in skill_map:
        if any(keyword in text for keyword in keywords):
            for skill in skills:
                if skill in available_skills and skill not in chosen:
                    chosen.append(skill)

    if not chosen:
        defaults = ["playwright", "gh-fix-ci", "gh-address-comments", "skill-creator"]
        for skill in defaults:
            if skill in available_skills and skill not in chosen:
                chosen.append(skill)
            if len(chosen) >= 3:
                break
    return chosen


def _coerce_string_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        cleaned = value.strip()
        return [cleaned] if cleaned else []
    if isinstance(value, list):
        out: List[str] = []
        for item in value:
            if item is None:
                continue
            text = str(item).strip()
            if text:
                out.append(text)
        return out
    text = str(value).strip()
    return [text] if text else []


def json_dumps_pretty(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=True) + "\n"


def codex_control_files(meta_dir: str) -> Dict[str, str]:
    return {
        "pause": os.path.join(meta_dir, "codex.pause"),
        "stop": os.path.join(meta_dir, "codex.stop"),
    }


def set_codex_pause(meta_dir: str, paused: bool) -> Optional[str]:
    os.makedirs(meta_dir, exist_ok=True)
    pause_file = codex_control_files(meta_dir)["pause"]
    if paused:
        with open(pause_file, "w", encoding="utf-8") as f:
            f.write("paused\n")
        return pause_file
    if os.path.exists(pause_file):
        os.remove(pause_file)
    return None


def set_codex_stop(meta_dir: str, reason: str = "operator requested stop") -> str:
    os.makedirs(meta_dir, exist_ok=True)
    stop_file = codex_control_files(meta_dir)["stop"]
    with open(stop_file, "w", encoding="utf-8") as f:
        f.write((reason or "operator requested stop").strip() + "\n")
    return stop_file


def clear_codex_control_signals(meta_dir: str) -> None:
    controls = codex_control_files(meta_dir)
    for path in controls.values():
        if os.path.exists(path):
            os.remove(path)


def read_codex_stop_reason(meta_dir: str) -> Optional[str]:
    stop_file = codex_control_files(meta_dir)["stop"]
    if not os.path.exists(stop_file):
        return None
    with open(stop_file, "r", encoding="utf-8", errors="replace") as f:
        reason = f.read().strip()
    return reason or "operator requested stop"


def build_codex_prompt(
    world: Dict[str, Any],
    branchpoint: Dict[str, Any],
    chosen_skills: List[str],
    automation_enabled: bool,
    automation_name_prefix: str,
    steering_comments: Optional[List[Dict[str, Any]]] = None,
) -> str:
    lines: List[str] = []
    lines.append("# Parallel World Task")
    lines.append("")
    lines.append(f"Intent: {branchpoint.get('intent', '')}")
    lines.append(f"World: {world.get('name', '')}")
    lines.append(f"Strategy: {world.get('notes', '') or '(not provided)'}")
    lines.append(f"Branch: {world.get('branch', '')}")
    lines.append("")

    objective = str(world.get("objective") or branchpoint.get("objective") or branchpoint.get("intent", "")).strip()
    acceptance_criteria = _coerce_string_list(world.get("acceptance_criteria") or branchpoint.get("acceptance_criteria"))
    inline_steering_comments = _coerce_string_list(world.get("steering_comments") or branchpoint.get("steering_comments"))

    if objective:
        lines.append("## Task Objective")
        lines.append("")
        lines.append(objective)
        lines.append("")

    if acceptance_criteria:
        lines.append("## Acceptance Criteria")
        lines.append("")
        for item in acceptance_criteria:
            lines.append(f"- {item}")
        lines.append("")

    if inline_steering_comments:
        lines.append("## Steering Comments")
        lines.append("")
        for comment in inline_steering_comments:
            lines.append(f"- {comment}")
        lines.append("")

    if steering_comments:
        lines.append("## Steering Updates")
        lines.append("")
        for row in steering_comments:
            created = str(row.get("created_at", "")).strip()
            author = str(row.get("author", "operator")).strip() or "operator"
            comment = str(row.get("comment", "") or "").strip()
            patch = str(row.get("prompt_patch", "") or "").strip()
            prefix = f"- [{created}] {author}: " if created else f"- {author}: "
            if comment:
                lines.append(prefix + comment)
            if patch:
                lines.append(f"  prompt_patch: {patch}")
        lines.append("")

    lines.append("## Requirements")
    lines.append("")
    lines.append("- Implement this world strategy in the current worktree.")
    lines.append("- Keep changes scoped to this intent.")
    lines.append("- After edits, run relevant tests or checks for this repo.")
    lines.append("- Summarize what changed, tradeoffs, and residual risks.")

    if chosen_skills:
        lines.append("")
        lines.append("## Skill Hints")
        lines.append("")
        lines.append("Use these skills if they match your implementation path:")
        for skill in chosen_skills:
            lines.append(f"- ${skill}")

    if automation_enabled:
        lines.append("")
        lines.append("## Automation")
        lines.append("")
        lines.append("If recurring follow-up work is useful, include one suggested automation directive.")
        lines.append("Use this exact format in your final response:")
        lines.append("")
        lines.append("```text")
        lines.append(
            f"::automation-update{{mode=\"suggested create\" name=\"{automation_name_prefix} - {world.get('name', '')}\" prompt=\"Describe the repeat task\" rrule=\"FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0\" cwds=\"{world.get('worktree', '')}\" status=\"ACTIVE\"}}"
        )
        lines.append("```")

    lines.append("")
    lines.append("## Output")
    lines.append("")
    lines.append("- List exact files changed.")
    lines.append("- Include commands executed and their outcomes.")
    lines.append("- If blocked, state what is missing and stop.")
    lines.append("")
    return "\n".join(lines)


def write_text_snapshot(meta_dir: str, filename: str, contents: str) -> str:
    os.makedirs(meta_dir, exist_ok=True)
    path = os.path.join(meta_dir, filename)
    with open(path, "w", encoding="utf-8") as f:
        f.write(contents)
    return path


def write_codex_prompt(world_meta_dir: str, prompt_text: str, filename: str = "CODEX_PROMPT.md") -> str:
    os.makedirs(world_meta_dir, exist_ok=True)
    return write_text_snapshot(world_meta_dir, filename, prompt_text)


def build_codex_command(command_template: str, prompt_file: str, world: Dict[str, Any], branchpoint: Dict[str, Any]) -> str:
    replacements = {
        "{prompt_file}": prompt_file,
        "{world_id}": str(world.get("id", "")),
        "{world_name}": str(world.get("name", "")),
        "{worktree}": str(world.get("worktree", "")),
        "{intent}": str(branchpoint.get("intent", "")),
        "{strategy}": str(world.get("notes", "")),
    }
    command = command_template
    for key, value in replacements.items():
        command = command.replace(key, value)
    if "{prompt_file}" not in command_template:
        command = f'{command} < "{prompt_file}"'
    return command


def save_named_log(meta_dir: str, filename: str, stdout: str, stderr: str) -> str:
    os.makedirs(meta_dir, exist_ok=True)
    path = os.path.join(meta_dir, filename)
    with open(path, "w", encoding="utf-8") as f:
        if stdout:
            f.write(stdout)
        if stderr:
            if stdout:
                f.write("\n--- STDERR ---\n")
            f.write(stderr)
    return path


def save_trace(meta_dir: str, stdout: str, stderr: str) -> str:
    return save_named_log(meta_dir, "trace.log", stdout, stderr)


def _send_process_signal(process: subprocess.Popen, sig: int) -> bool:
    if process.poll() is not None:
        return False
    try:
        if hasattr(os, "killpg") and process.pid > 0:
            os.killpg(process.pid, sig)
            return True
        process.send_signal(sig)
        return True
    except (ProcessLookupError, PermissionError, OSError, ValueError):
        return False


def _terminate_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return

    terminated = _send_process_signal(process, signal.SIGTERM)
    if not terminated:
        process.terminate()

    try:
        process.wait(timeout=2)
        return
    except subprocess.TimeoutExpired:
        pass

    killed = _send_process_signal(process, signal.SIGKILL)
    if not killed:
        process.kill()


def _execute_logged_command_with_control(
    command: str,
    cwd: str,
    timeout_sec: int,
    meta_dir: str,
    log_filename: str,
    control_meta_dir: str,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "exit_code": None,
        "duration_sec": None,
        "log_file": None,
        "error": None,
        "status": "pending",
        "was_paused": False,
        "was_cancelled": False,
    }

    controls = codex_control_files(control_meta_dir)
    pause_file = controls["pause"]

    start = time.time()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        text=True,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )

    paused = False
    timed_out = False
    cancelled_reason: Optional[str] = None
    last_pause_seen = os.path.exists(pause_file)
    if last_pause_seen:
        payload["was_paused"] = True

    while True:
        if process.poll() is not None:
            break

        elapsed = time.time() - start
        if elapsed > timeout_sec:
            timed_out = True
            _terminate_process(process)
            break

        stop_reason = read_codex_stop_reason(control_meta_dir)
        if stop_reason:
            cancelled_reason = stop_reason
            payload["was_cancelled"] = True
            _terminate_process(process)
            break

        pause_requested = os.path.exists(pause_file)
        if pause_requested:
            payload["was_paused"] = True
        if pause_requested != last_pause_seen:
            if pause_requested:
                if _send_process_signal(process, signal.SIGSTOP):
                    paused = True
            else:
                if _send_process_signal(process, signal.SIGCONT):
                    paused = False
            last_pause_seen = pause_requested

        time.sleep(0.2)

    if paused:
        _send_process_signal(process, signal.SIGCONT)

    stdout = ""
    stderr = ""
    try:
        out, err = process.communicate(timeout=2)
        stdout = out or ""
        stderr = err or ""
    except subprocess.TimeoutExpired:
        _terminate_process(process)
        out, err = process.communicate()
        stdout = out or ""
        stderr = err or ""

    duration = time.time() - start
    payload["duration_sec"] = round(duration, 2)
    payload["log_file"] = save_named_log(meta_dir, log_filename, stdout, stderr)

    if timed_out:
        payload["exit_code"] = -1
        payload["error"] = f"timeout after {timeout_sec}s"
        payload["status"] = "timeout"
        return payload

    if cancelled_reason is not None:
        payload["exit_code"] = -2
        payload["error"] = f"cancelled: {cancelled_reason}"
        payload["status"] = "cancelled"
        return payload

    payload["exit_code"] = process.returncode
    payload["status"] = "ok" if process.returncode == 0 else "error"
    return payload


def _execute_logged_command_with_runtime_control(
    command: str,
    cwd: str,
    timeout_sec: int,
    meta_dir: str,
    log_filename: str,
    repo: str,
    task_id: str,
    phase: str,
    attempt: int,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "exit_code": None,
        "duration_sec": None,
        "log_file": None,
        "error": None,
        "status": "pending",
        "was_paused": False,
        "was_cancelled": False,
    }

    start = time.time()
    deadline = start + timeout_sec
    paused_since: Optional[float] = None
    process: Optional[subprocess.Popen] = None
    stopped_by_operator = False

    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            text=True,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        register_active_process(repo=repo, task_id=task_id, phase=phase, attempt=attempt, process=process)

        timed_out = False
        while process.poll() is None:
            runtime = get_active_runtime(task_id) or {}
            paused = bool(runtime.get("paused"))
            if paused:
                payload["was_paused"] = True
            if paused and paused_since is None:
                paused_since = time.time()
            if not paused and paused_since is not None:
                deadline += time.time() - paused_since
                paused_since = None

            force_kill_if_stop_requested(task_id)

            if time.time() >= deadline:
                timed_out = True
                _terminate_process(process)
                break
            time.sleep(0.1)

        stdout = ""
        stderr = ""
        if process is not None:
            out, err = process.communicate()
            stdout = out or ""
            stderr = err or ""

        payload["duration_sec"] = round(time.time() - start, 2)
        payload["log_file"] = save_named_log(meta_dir, log_filename, stdout, stderr)

        if timed_out:
            payload["exit_code"] = -1
            payload["error"] = f"timeout after {timeout_sec}s"
            payload["status"] = "timeout"
        else:
            payload["exit_code"] = process.returncode if process is not None else None
            payload["status"] = "ok" if payload["exit_code"] == 0 else "error"
    finally:
        runtime = get_active_runtime(task_id) or {}
        stopped_by_operator = bool(runtime.get("stop_requested"))
        finish_active_process(repo, task_id, payload.get("exit_code"), payload.get("error"))

    if stopped_by_operator:
        payload["error"] = "stopped by operator"
        payload["status"] = "cancelled"
        payload["was_cancelled"] = True
        if payload.get("exit_code") is None:
            payload["exit_code"] = -2

    return payload


def execute_logged_command(
    command: str,
    cwd: str,
    timeout_sec: int,
    meta_dir: str,
    log_filename: str,
    control_meta_dir: Optional[str] = None,
    repo: Optional[str] = None,
    task_id: Optional[str] = None,
    phase: str = "runner",
    attempt: int = 1,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "exit_code": None,
        "duration_sec": None,
        "log_file": None,
        "error": None,
        "status": "pending",
        "was_paused": False,
        "was_cancelled": False,
    }

    if not command.strip():
        payload["error"] = "command not configured"
        payload["status"] = "error"
        return payload

    if repo and task_id:
        return _execute_logged_command_with_runtime_control(
            command=command,
            cwd=cwd,
            timeout_sec=timeout_sec,
            meta_dir=meta_dir,
            log_filename=log_filename,
            repo=repo,
            task_id=task_id,
            phase=phase,
            attempt=attempt,
        )

    if control_meta_dir:
        return _execute_logged_command_with_control(
            command=command,
            cwd=cwd,
            timeout_sec=timeout_sec,
            meta_dir=meta_dir,
            log_filename=log_filename,
            control_meta_dir=control_meta_dir,
        )

    start = time.time()
    try:
        result = run_shell(command, cwd=cwd, timeout_sec=timeout_sec)
        duration = time.time() - start
        payload["exit_code"] = result.returncode
        payload["duration_sec"] = round(duration, 2)
        payload["log_file"] = save_named_log(meta_dir, log_filename, result.stdout, result.stderr)
        payload["status"] = "ok" if result.returncode == 0 else "error"
    except subprocess.TimeoutExpired:
        duration = time.time() - start
        payload["exit_code"] = -1
        payload["duration_sec"] = round(duration, 2)
        payload["error"] = f"timeout after {timeout_sec}s"
        payload["log_file"] = save_named_log(meta_dir, log_filename, "", payload["error"])
        payload["status"] = "timeout"

    return payload


def parse_numstat(output: str) -> Dict[str, int]:
    added = 0
    deleted = 0
    files = 0
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        a_raw, d_raw = parts[0], parts[1]
        try:
            a = int(a_raw) if a_raw != "-" else 0
            d = int(d_raw) if d_raw != "-" else 0
        except ValueError:
            continue
        added += a
        deleted += d
        files += 1
    return {"files": files, "added": added, "deleted": deleted}


def collect_diff(meta_dir: str, base_branch: str, worktree_path: str) -> Dict[str, Any]:
    os.makedirs(meta_dir, exist_ok=True)

    patch_path = os.path.join(meta_dir, "diff.patch")
    patch = git(["-C", worktree_path, "diff", f"{base_branch}...HEAD"], check=False)
    with open(patch_path, "w", encoding="utf-8") as f:
        f.write(patch.stdout or "")

    numstat = git(["-C", worktree_path, "diff", "--numstat", f"{base_branch}...HEAD"], check=False)
    stats = parse_numstat(numstat.stdout or "")

    files_changed = git(["-C", worktree_path, "diff", "--name-only", f"{base_branch}...HEAD"], check=False)
    names = [x.strip() for x in (files_changed.stdout or "").splitlines() if x.strip()]

    return {
        "diff_patch": patch_path,
        "diff_stats": stats,
        "changed_files": names,
    }


def ensure_world_exists(worktree_path: str) -> None:
    if not os.path.exists(worktree_path):
        die(f"world worktree missing: {worktree_path}")


def run_codex_world(
    world: Dict[str, Any],
    branchpoint: Dict[str, Any],
    codex_cfg: Dict[str, Any],
    available_skills: List[str],
    repo: Optional[str] = None,
) -> Dict[str, Any]:
    ensure_world_exists(world["worktree"])
    world_meta_dir = os.path.join(world["worktree"], ".parallel_worlds")
    os.makedirs(world_meta_dir, exist_ok=True)

    objective = str(world.get("objective") or branchpoint.get("objective") or branchpoint.get("intent", "")).strip()
    acceptance_criteria = _coerce_string_list(world.get("acceptance_criteria") or branchpoint.get("acceptance_criteria"))
    steering_comments = _coerce_string_list(world.get("steering_comments") or branchpoint.get("steering_comments"))
    steering_updates: List[Dict[str, Any]] = []
    if repo:
        steering_updates = list_steering_comments(repo, world["id"], limit=20).get("items", [])
        for row in steering_updates:
            comment = str(row.get("comment", "") or "").strip()
            patch = str(row.get("prompt_patch", "") or "").strip()
            if comment:
                steering_comments.append(comment)
            if patch:
                steering_comments.append(patch)

    chosen_skills = suggest_skills(
        intent=str(branchpoint.get("intent", "")),
        notes=str(world.get("notes", "")),
        available_skills=available_skills,
    )
    prompt_text = build_codex_prompt(
        world=world,
        branchpoint=branchpoint,
        chosen_skills=chosen_skills,
        automation_enabled=bool(codex_cfg.get("automation", {}).get("enabled", False)),
        automation_name_prefix=str(codex_cfg.get("automation", {}).get("name_prefix", "Parallel Worlds")),
        steering_comments=steering_updates,
    )
    prompt_file = write_codex_prompt(world_meta_dir, prompt_text)
    prompt_snapshot_file = write_codex_prompt(world_meta_dir, prompt_text, filename="codex.prompt.snapshot.md")
    context_snapshot = {
        "objective": objective,
        "acceptance_criteria": acceptance_criteria,
        "steering_comments": steering_comments,
        "intent": str(branchpoint.get("intent", "")),
        "strategy": str(world.get("notes", "")),
    }
    context_snapshot_file = write_text_snapshot(
        world_meta_dir,
        "codex.context.snapshot.json",
        json_dumps_pretty(context_snapshot),
    )

    payload: Dict[str, Any] = {
        "branchpoint_id": branchpoint["id"],
        "world_id": world["id"],
        "world_name": world["name"],
        "branch": world["branch"],
        "worktree": world["worktree"],
        "codex_command_template": codex_cfg.get("command", ""),
        "codex_command": None,
        "prompt_file": prompt_file,
        "prompt_snapshot_file": prompt_snapshot_file,
        "context_snapshot_file": context_snapshot_file,
        "context_snapshot": context_snapshot,
        "steering_updates": steering_updates,
        "command_file": None,
        "control_files": codex_control_files(world_meta_dir),
        "skills_used": chosen_skills,
        "started_at": now_utc(),
        "exit_code": None,
        "duration_sec": None,
        "log_file": None,
        "error": None,
        "status": "pending",
        "was_paused": False,
        "was_cancelled": False,
        "finished_at": None,
    }

    template = str(codex_cfg.get("command", "")).strip()
    if not template:
        payload["error"] = "codex.command not configured"
        payload["finished_at"] = now_utc()
        return payload

    timeout_sec = int(codex_cfg.get("timeout_sec", 900))
    command = build_codex_command(template, prompt_file, world, branchpoint)
    payload["codex_command"] = command
    payload["command_file"] = write_text_snapshot(world_meta_dir, "codex.command.sh", command + "\n")

    cmd_result = execute_logged_command(
        command=command,
        cwd=world["worktree"],
        timeout_sec=timeout_sec,
        meta_dir=world_meta_dir,
        log_filename="codex.log",
        control_meta_dir=world_meta_dir,
        repo=repo,
        task_id=world["id"] if repo else None,
        phase="codex",
        attempt=1,
    )
    payload["exit_code"] = cmd_result["exit_code"]
    payload["duration_sec"] = cmd_result["duration_sec"]
    payload["log_file"] = cmd_result["log_file"]
    payload["error"] = cmd_result["error"]
    payload["status"] = cmd_result.get("status")
    payload["was_paused"] = cmd_result.get("was_paused", False)
    payload["was_cancelled"] = cmd_result.get("was_cancelled", False)

    payload["finished_at"] = now_utc()
    return payload


def run_world(
    world: Dict[str, Any],
    branchpoint: Dict[str, Any],
    runner_cmd: str,
    timeout_sec: int,
    skip_runner: bool,
    repo: Optional[str] = None,
) -> Dict[str, Any]:
    ensure_world_exists(world["worktree"])
    world_meta_dir = os.path.join(world["worktree"], ".parallel_worlds")
    os.makedirs(world_meta_dir, exist_ok=True)

    payload: Dict[str, Any] = {
        "branchpoint_id": branchpoint["id"],
        "world_id": world["id"],
        "world_name": world["name"],
        "branch": world["branch"],
        "worktree": world["worktree"],
        "runner": runner_cmd,
        "started_at": now_utc(),
        "exit_code": None,
        "duration_sec": None,
        "trace_log": None,
        "error": None,
        "diff_patch": None,
        "diff_stats": None,
        "changed_files": None,
        "finished_at": None,
    }

    if skip_runner:
        payload["error"] = "runner skipped via --skip-runner"
    elif not runner_cmd.strip():
        payload["error"] = "runner command not configured"
    else:
        cmd_result = execute_logged_command(
            command=runner_cmd,
            cwd=world["worktree"],
            timeout_sec=timeout_sec,
            meta_dir=world_meta_dir,
            log_filename="trace.log",
            repo=repo,
            task_id=world["id"] if repo else None,
            phase="runner",
            attempt=1,
        )
        payload["exit_code"] = cmd_result["exit_code"]
        payload["duration_sec"] = cmd_result["duration_sec"]
        payload["trace_log"] = cmd_result["log_file"]
        payload["error"] = cmd_result["error"]

    diff = collect_diff(world_meta_dir, branchpoint["base_branch"], world["worktree"])
    payload.update(diff)
    payload["finished_at"] = now_utc()
    return payload


def run_render_world(world: Dict[str, Any], branchpoint: Dict[str, Any], render_cmd: str, timeout_sec: int) -> Dict[str, Any]:
    ensure_world_exists(world["worktree"])
    world_meta_dir = os.path.join(world["worktree"], ".parallel_worlds")
    os.makedirs(world_meta_dir, exist_ok=True)

    payload: Dict[str, Any] = {
        "branchpoint_id": branchpoint["id"],
        "world_id": world["id"],
        "world_name": world["name"],
        "branch": world["branch"],
        "worktree": world["worktree"],
        "render_command": render_cmd,
        "started_at": now_utc(),
        "exit_code": None,
        "duration_sec": None,
        "render_log": None,
        "error": None,
        "finished_at": None,
    }

    if not render_cmd.strip():
        payload["error"] = "render command not configured"
        payload["finished_at"] = now_utc()
        return payload

    cmd_result = execute_logged_command(
        command=render_cmd,
        cwd=world["worktree"],
        timeout_sec=timeout_sec,
        meta_dir=world_meta_dir,
        log_filename="render.log",
    )
    payload["exit_code"] = cmd_result["exit_code"]
    payload["duration_sec"] = cmd_result["duration_sec"]
    payload["render_log"] = cmd_result["log_file"]
    payload["error"] = cmd_result["error"]

    payload["finished_at"] = now_utc()
    return payload


def tail_file(path: str, line_count: int) -> List[str]:
    if line_count <= 0 or not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    return lines[-line_count:]
