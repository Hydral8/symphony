import json
import os
from typing import Any, Dict

from .common import deep_merge, die


DEFAULT_CONFIG: Dict[str, Any] = {
    "base_branch": "main",
    "branch_prefix": "world",
    "worlds_dir": "/tmp/parallel_worlds_worlds",
    "default_world_count": 3,
    "runner": {
        "command": "",
        "timeout_sec": 300,
    },
    "codex": {
        "enabled": False,
        "command": "",
        "timeout_sec": 900,
        "use_agents_md_skills": True,
        "automation": {
            "enabled": False,
            "name_prefix": "Parallel Worlds",
        },
    },
    "render": {
        "command": "",
        "timeout_sec": 180,
        "preview_lines": 25,
    },
    "execution": {
        "max_parallel_worlds": 3,
    },
    "strategies": [
        {
            "name": "minimal-fix",
            "notes": "Smallest targeted change with low risk.",
        },
        {
            "name": "robust-fix",
            "notes": "Root-cause oriented implementation with guardrails.",
        },
        {
            "name": "refactor-path",
            "notes": "Refactor to improve maintainability while solving intent.",
        },
    ],
}

PLACEHOLDER_STRATEGY_NAMES = {"approach-a", "approach-b", "approach-c"}


def write_default_config(path: str, force: bool) -> None:
    if os.path.exists(path) and not force:
        die(f"config already exists: {path}. Use --force to overwrite.")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(DEFAULT_CONFIG, f, indent=2)
        f.write("\n")


def load_config(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        die(f"config not found: {path}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            user = json.load(f)
    except json.JSONDecodeError as exc:
        die(f"invalid config JSON: {exc}")

    if not isinstance(user, dict):
        die("config root must be an object")

    cfg = deep_merge(DEFAULT_CONFIG, user)

    if not isinstance(cfg.get("base_branch"), str) or not cfg["base_branch"].strip():
        die("config.base_branch must be a non-empty string")
    if not isinstance(cfg.get("branch_prefix"), str) or not cfg["branch_prefix"].strip():
        die("config.branch_prefix must be a non-empty string")
    if not isinstance(cfg.get("worlds_dir"), str) or not cfg["worlds_dir"].strip():
        die("config.worlds_dir must be a non-empty string")

    try:
        cfg["default_world_count"] = int(cfg.get("default_world_count", 3))
    except (TypeError, ValueError):
        die("config.default_world_count must be an integer")
    if cfg["default_world_count"] < 1:
        die("config.default_world_count must be >= 1")

    runner = cfg.get("runner", {})
    if not isinstance(runner, dict):
        die("config.runner must be an object")

    runner_cmd = runner.get("command", "")
    if not isinstance(runner_cmd, str):
        die("config.runner.command must be a string")

    try:
        timeout = int(runner.get("timeout_sec", 300))
    except (TypeError, ValueError):
        die("config.runner.timeout_sec must be an integer")
    if timeout <= 0:
        die("config.runner.timeout_sec must be > 0")
    cfg["runner"]["timeout_sec"] = timeout

    codex = cfg.get("codex", {})
    if not isinstance(codex, dict):
        die("config.codex must be an object")
    codex_enabled = bool(codex.get("enabled", False))
    codex_command = codex.get("command", "")
    if not isinstance(codex_command, str):
        die("config.codex.command must be a string")
    try:
        codex_timeout = int(codex.get("timeout_sec", 900))
    except (TypeError, ValueError):
        die("config.codex.timeout_sec must be an integer")
    if codex_timeout <= 0:
        die("config.codex.timeout_sec must be > 0")
    use_agents_md_skills = bool(codex.get("use_agents_md_skills", True))

    automation = codex.get("automation", {})
    if not isinstance(automation, dict):
        die("config.codex.automation must be an object")
    automation_enabled = bool(automation.get("enabled", False))
    automation_name_prefix = str(automation.get("name_prefix", "Parallel Worlds")).strip()
    if not automation_name_prefix:
        die("config.codex.automation.name_prefix must be a non-empty string")

    cfg["codex"]["enabled"] = codex_enabled
    cfg["codex"]["command"] = codex_command
    cfg["codex"]["timeout_sec"] = codex_timeout
    cfg["codex"]["use_agents_md_skills"] = use_agents_md_skills
    cfg["codex"]["automation"]["enabled"] = automation_enabled
    cfg["codex"]["automation"]["name_prefix"] = automation_name_prefix

    render = cfg.get("render", {})
    if not isinstance(render, dict):
        die("config.render must be an object")
    render_cmd = render.get("command", "")
    if not isinstance(render_cmd, str):
        die("config.render.command must be a string")
    try:
        render_timeout = int(render.get("timeout_sec", 180))
    except (TypeError, ValueError):
        die("config.render.timeout_sec must be an integer")
    if render_timeout <= 0:
        die("config.render.timeout_sec must be > 0")
    try:
        preview_lines = int(render.get("preview_lines", 25))
    except (TypeError, ValueError):
        die("config.render.preview_lines must be an integer")
    if preview_lines < 0:
        die("config.render.preview_lines must be >= 0")
    cfg["render"]["timeout_sec"] = render_timeout
    cfg["render"]["preview_lines"] = preview_lines

    execution = cfg.get("execution", {})
    if not isinstance(execution, dict):
        die("config.execution must be an object")
    try:
        max_parallel = int(execution.get("max_parallel_worlds", 3))
    except (TypeError, ValueError):
        die("config.execution.max_parallel_worlds must be an integer")
    if max_parallel < 1:
        die("config.execution.max_parallel_worlds must be >= 1")
    cfg["execution"]["max_parallel_worlds"] = max_parallel

    strategies = cfg.get("strategies", [])
    if not isinstance(strategies, list):
        die("config.strategies must be a list")

    return cfg
