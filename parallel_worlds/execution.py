import os
import re
import subprocess
import time
from typing import Any, Dict, List, Tuple

from .common import die, git, now_utc, run_shell


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


def build_codex_prompt(
    world: Dict[str, Any],
    branchpoint: Dict[str, Any],
    chosen_skills: List[str],
    automation_enabled: bool,
    automation_name_prefix: str,
) -> str:
    lines: List[str] = []
    lines.append("# Parallel World Task")
    lines.append("")
    lines.append(f"Intent: {branchpoint.get('intent', '')}")
    lines.append(f"World: {world.get('name', '')}")
    lines.append(f"Strategy: {world.get('notes', '') or '(not provided)'}")
    lines.append(f"Branch: {world.get('branch', '')}")
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


def write_codex_prompt(world_meta_dir: str, prompt_text: str) -> str:
    os.makedirs(world_meta_dir, exist_ok=True)
    path = os.path.join(world_meta_dir, "CODEX_PROMPT.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(prompt_text)
    return path


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


def execute_logged_command(
    command: str,
    cwd: str,
    timeout_sec: int,
    meta_dir: str,
    log_filename: str,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "exit_code": None,
        "duration_sec": None,
        "log_file": None,
        "error": None,
    }

    if not command.strip():
        payload["error"] = "command not configured"
        return payload

    start = time.time()
    try:
        result = run_shell(command, cwd=cwd, timeout_sec=timeout_sec)
        duration = time.time() - start
        payload["exit_code"] = result.returncode
        payload["duration_sec"] = round(duration, 2)
        payload["log_file"] = save_named_log(meta_dir, log_filename, result.stdout, result.stderr)
    except subprocess.TimeoutExpired:
        duration = time.time() - start
        payload["exit_code"] = -1
        payload["duration_sec"] = round(duration, 2)
        payload["error"] = f"timeout after {timeout_sec}s"
        payload["log_file"] = save_named_log(meta_dir, log_filename, "", payload["error"])

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
) -> Dict[str, Any]:
    ensure_world_exists(world["worktree"])
    world_meta_dir = os.path.join(world["worktree"], ".parallel_worlds")
    os.makedirs(world_meta_dir, exist_ok=True)

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
    )
    prompt_file = write_codex_prompt(world_meta_dir, prompt_text)

    payload: Dict[str, Any] = {
        "branchpoint_id": branchpoint["id"],
        "world_id": world["id"],
        "world_name": world["name"],
        "branch": world["branch"],
        "worktree": world["worktree"],
        "codex_command_template": codex_cfg.get("command", ""),
        "codex_command": None,
        "prompt_file": prompt_file,
        "skills_used": chosen_skills,
        "started_at": now_utc(),
        "exit_code": None,
        "duration_sec": None,
        "log_file": None,
        "error": None,
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

    cmd_result = execute_logged_command(
        command=command,
        cwd=world["worktree"],
        timeout_sec=timeout_sec,
        meta_dir=world_meta_dir,
        log_filename="codex.log",
    )
    payload["exit_code"] = cmd_result["exit_code"]
    payload["duration_sec"] = cmd_result["duration_sec"]
    payload["log_file"] = cmd_result["log_file"]
    payload["error"] = cmd_result["error"]

    payload["finished_at"] = now_utc()
    return payload


def run_world(world: Dict[str, Any], branchpoint: Dict[str, Any], runner_cmd: str, timeout_sec: int, skip_runner: bool) -> Dict[str, Any]:
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
