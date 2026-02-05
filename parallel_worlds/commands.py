import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

from .common import die, ensure_git_repo, git, now_utc, read_json, relative_to_repo, slugify, worktree_is_clean, write_json
from .config import load_config, write_default_config
from .execution import load_agents_skills, run_codex_world, run_render_world, run_world, tail_file
from .state import (
    codex_run_file,
    ensure_metadata_dirs,
    get_latest_branchpoint,
    list_branchpoints,
    load_branchpoint,
    load_codex_run,
    load_render,
    load_run,
    load_world,
    metadata_root,
    render_file,
    resolve_branchpoint_id,
    run_file,
    save_branchpoint,
    save_codex_run,
    save_render,
    save_run,
    save_world,
    set_latest_branchpoint,
)
from .strategy import choose_strategies, make_branchpoint_id
from .worlds import add_worktree, ensure_base_branch, ensure_worlds_dir, matches_world_filter, resolve_start_ref, write_world_notes


def _autocommit_world_changes(world: Dict[str, Any], branchpoint_id: str, prefix: str) -> Optional[str]:
    worktree = world.get("worktree", "")
    status = git(["status", "--porcelain"], cwd=worktree, check=False)
    lines = (status.stdout or "").splitlines()
    paths: List[str] = []
    for line in lines:
        text = line.rstrip()
        if len(text) < 4:
            continue
        path_part = text[3:]
        if " -> " in path_part:
            path_part = path_part.split(" -> ", 1)[1]
        path = path_part.strip()
        if not path:
            continue
        if path.startswith(".parallel_worlds/"):
            continue
        if path in {"report.md", "play.md"}:
            continue
        paths.append(path)

    unique_paths = sorted(set(paths))
    if not unique_paths:
        return None

    git(["add", "-A", "--"] + unique_paths, cwd=worktree, check=True)
    message = f"{prefix}: {branchpoint_id} {world.get('name', world.get('id', 'world'))}"
    commit = git(
        [
            "-c",
            "user.name=Parallel Worlds",
            "-c",
            "user.email=parallel-worlds@local",
            "commit",
            "-m",
            message,
        ],
        cwd=worktree,
        check=False,
    )
    if commit.returncode != 0:
        return None
    head = git(["rev-parse", "HEAD"], cwd=worktree, check=False)
    return (head.stdout or "").strip() or None


def create_project(
    project_path: str,
    project_name: Optional[str],
    base_branch: str,
    config_name: str,
) -> Tuple[str, str]:
    path = os.path.abspath(project_path)
    if os.path.exists(path) and not os.path.isdir(path):
        die(f"project path exists and is not a directory: {path}")

    os.makedirs(path, exist_ok=True)
    entries = [name for name in os.listdir(path) if name not in {".DS_Store"}]
    if entries:
        die(f"project directory must be empty: {path}")

    base = (base_branch or "main").strip() or "main"
    init = git(["init", "-b", base], cwd=path, check=False)
    if init.returncode != 0:
        git(["init"], cwd=path, check=True)
        git(["checkout", "-b", base], cwd=path, check=True)

    title = (project_name or os.path.basename(path)).strip() or "Parallel Worlds Project"
    readme_path = os.path.join(path, "README.md")
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(f"# {title}\n\nBootstrapped with Parallel Worlds.\n")

    git(["add", "README.md"], cwd=path, check=True)
    git(
        [
            "-c",
            "user.name=Parallel Worlds",
            "-c",
            "user.email=parallel-worlds@local",
            "commit",
            "-m",
            "Initial commit",
        ],
        cwd=path,
        check=True,
    )

    cfg_name = os.path.basename((config_name or "parallel_worlds.json").strip() or "parallel_worlds.json")
    cfg_path = os.path.join(path, cfg_name)
    if not os.path.exists(cfg_path):
        write_default_config(cfg_path, force=False)

    cfg_payload = read_json(cfg_path)
    if cfg_payload.get("base_branch") != base:
        cfg_payload["base_branch"] = base
        write_json(cfg_path, cfg_payload)

    ensure_metadata_dirs(path)

    print(f"created project: {path}")
    print(f"base branch: {base}")
    print(f"config: {cfg_path}")
    return path, cfg_path


def switch_project(project_path: str, config_name: str) -> Tuple[str, str]:
    probe = os.path.abspath(project_path)
    if not os.path.isdir(probe):
        die(f"project path not found: {probe}")

    root_result = git(["rev-parse", "--show-toplevel"], cwd=probe, check=False)
    if root_result.returncode != 0:
        die(f"not a git repository: {probe}")

    repo = root_result.stdout.strip()
    if not repo:
        die(f"unable to resolve git root: {probe}")

    cfg_name = os.path.basename((config_name or "parallel_worlds.json").strip() or "parallel_worlds.json")
    cfg_path = os.path.join(repo, cfg_name)
    if not os.path.exists(cfg_path):
        write_default_config(cfg_path, force=False)

    ensure_metadata_dirs(repo)

    print(f"switched project: {repo}")
    print(f"config: {cfg_path}")
    return repo, cfg_path


def resolve_worlds_for_branchpoint(repo: str, branchpoint: Dict[str, Any], world_filters: Optional[List[str]]) -> List[Dict[str, Any]]:
    world_ids = branchpoint.get("world_ids", [])
    if not world_ids:
        die(f"branchpoint has no worlds: {branchpoint['id']}")

    selected_worlds: List[Dict[str, Any]] = []
    for wid in world_ids:
        world = load_world(repo, wid)
        if matches_world_filter(world, world_filters):
            selected_worlds.append(world)

    if not selected_worlds:
        die("no worlds matched provided --world filters")
    return selected_worlds


def kickoff_worlds(
    config_path: str,
    intent: str,
    count: Optional[int],
    from_ref: Optional[str],
    cli_strategies: Optional[List[str]],
) -> None:
    repo = ensure_git_repo()
    cfg = load_config(config_path)
    ensure_metadata_dirs(repo)

    base_branch = cfg["base_branch"]
    ensure_base_branch(base_branch, repo)

    start_ref = resolve_start_ref(repo, base_branch, from_ref)
    worlds_root = ensure_worlds_dir(cfg["worlds_dir"], repo)

    strategies = choose_strategies(cfg, intent=intent, count=count, cli_strategies=cli_strategies)

    branchpoint_id = make_branchpoint_id(intent, repo)
    created_at = now_utc()

    branchpoint: Dict[str, Any] = {
        "id": branchpoint_id,
        "created_at": created_at,
        "intent": intent,
        "base_branch": base_branch,
        "source_ref": start_ref,
        "worlds_root": worlds_root,
        "runner": cfg["runner"]["command"],
        "codex": cfg["codex"]["command"],
        "status": "created",
        "world_ids": [],
        "selected_world_id": None,
    }

    for index, strategy in enumerate(strategies, start=1):
        name = strategy["name"]
        notes = strategy.get("notes", "")
        strategy_slug = slugify(name)

        world_id = f"{branchpoint_id}-{index:02d}-{strategy_slug}"
        branch = f"{cfg['branch_prefix']}/{branchpoint_id}/{index:02d}-{strategy_slug}"
        worktree = os.path.join(worlds_root, branchpoint_id, f"{index:02d}-{strategy_slug}")

        add_worktree(branch=branch, start_ref=start_ref, worktree_path=worktree, repo=repo)

        world: Dict[str, Any] = {
            "id": world_id,
            "branchpoint_id": branchpoint_id,
            "index": index,
            "name": name,
            "notes": notes,
            "slug": strategy_slug,
            "branch": branch,
            "worktree": worktree,
            "created_at": created_at,
            "status": "ready",
            "last_run_file": None,
            "last_exit_code": None,
            "last_duration_sec": None,
            "last_codex_file": None,
            "last_codex_exit_code": None,
            "last_codex_duration_sec": None,
            "last_render_file": None,
            "last_render_exit_code": None,
            "last_render_duration_sec": None,
        }

        write_world_notes(os.path.join(worktree, ".parallel_worlds"), world, branchpoint)
        save_world(repo, world)
        branchpoint["world_ids"].append(world_id)

    save_branchpoint(repo, branchpoint)
    set_latest_branchpoint(repo, branchpoint_id)

    print(f"created branchpoint: {branchpoint_id}")
    print(f"intent: {intent}")
    print(f"source ref: {start_ref}")
    print(f"worlds: {len(branchpoint['world_ids'])}")
    for wid in branchpoint["world_ids"]:
        world = load_world(repo, wid)
        print(f"- {world['id']} -> branch={world['branch']} worktree={world['worktree']}")


def _failed_run_payload(world: Dict[str, Any], branchpoint: Dict[str, Any], message: str) -> Dict[str, Any]:
    return {
        "branchpoint_id": branchpoint["id"],
        "world_id": world["id"],
        "world_name": world["name"],
        "branch": world["branch"],
        "worktree": world["worktree"],
        "runner": "",
        "started_at": now_utc(),
        "exit_code": None,
        "duration_sec": None,
        "trace_log": None,
        "error": message,
        "diff_patch": None,
        "diff_stats": {"files": 0, "added": 0, "deleted": 0},
        "changed_files": [],
        "finished_at": now_utc(),
    }


def _failed_render_payload(world: Dict[str, Any], branchpoint: Dict[str, Any], message: str) -> Dict[str, Any]:
    return {
        "branchpoint_id": branchpoint["id"],
        "world_id": world["id"],
        "world_name": world["name"],
        "branch": world["branch"],
        "worktree": world["worktree"],
        "render_command": "",
        "started_at": now_utc(),
        "exit_code": None,
        "duration_sec": None,
        "render_log": None,
        "error": message,
        "finished_at": now_utc(),
    }


def _run_world_pipeline(
    repo: str,
    world: Dict[str, Any],
    branchpoint: Dict[str, Any],
    codex_enabled: bool,
    codex_cfg: Dict[str, Any],
    available_skills: List[str],
    runner_cmd: str,
    timeout_sec: int,
    skip_runner: bool,
) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]], Dict[str, Any]]:
    codex_result: Optional[Dict[str, Any]] = None
    try:
        if codex_enabled:
            codex_result = run_codex_world(
                repo=repo,
                world=world,
                branchpoint=branchpoint,
                codex_cfg=codex_cfg,
                available_skills=available_skills,
            )
        run_result = run_world(
            repo=repo,
            world=world,
            branchpoint=branchpoint,
            runner_cmd=runner_cmd,
            timeout_sec=timeout_sec,
            skip_runner=skip_runner,
        )
        return world, codex_result, run_result
    except Exception as exc:  # pragma: no cover - safety wrapper
        return world, codex_result, _failed_run_payload(world, branchpoint, f"world execution failed: {exc}")


def _play_world_pipeline(
    world: Dict[str, Any],
    branchpoint: Dict[str, Any],
    render_cmd: str,
    timeout_sec: int,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    try:
        result = run_render_world(
            world=world,
            branchpoint=branchpoint,
            render_cmd=render_cmd,
            timeout_sec=timeout_sec,
        )
        return world, result
    except Exception as exc:  # pragma: no cover - safety wrapper
        return world, _failed_render_payload(world, branchpoint, f"render failed: {exc}")


def _apply_run_result(
    repo: str,
    bp_id: str,
    world: Dict[str, Any],
    codex_result: Optional[Dict[str, Any]],
    run_result: Dict[str, Any],
    commit_mode: str,
    commit_prefix: str,
) -> None:
    if codex_result:
        save_codex_run(repo, bp_id, world["id"], codex_result)
        world["last_codex_file"] = codex_run_file(repo, bp_id, world["id"])
        world["last_codex_exit_code"] = codex_result.get("exit_code")
        world["last_codex_duration_sec"] = codex_result.get("duration_sec")
        print(
            f"codex {world['id']}: exit={codex_result.get('exit_code')} "
            f"duration={codex_result.get('duration_sec')} error={codex_result.get('error')}"
        )

    save_run(repo, bp_id, world["id"], run_result)
    world["last_run_file"] = run_file(repo, bp_id, world["id"])
    world["last_exit_code"] = run_result.get("exit_code")
    world["last_duration_sec"] = run_result.get("duration_sec")
    if run_result.get("error"):
        world["status"] = "error"
    elif run_result.get("exit_code") == 0:
        world["status"] = "pass"
    elif run_result.get("exit_code") is None:
        world["status"] = "skipped"
    else:
        world["status"] = "fail"

    if codex_result:
        codex_failed = (codex_result.get("exit_code") not in (0, None)) or bool(codex_result.get("error"))
        if codex_failed and run_result.get("exit_code") is None:
            world["status"] = "error"
        commit_count = int(codex_result.get("commit_count") or 0)
        if commit_mode == "series" and commit_count <= 0:
            print(
                f"codex {world['id']}: no intermediate commits detected; applying fallback commit"
            )
            commit_sha = _autocommit_world_changes(world, bp_id, commit_prefix)
            if commit_sha:
                world["last_commit"] = commit_sha
                print(f"committed {world['id']}: {commit_sha}")

    save_world(repo, world)
    print(
        f"ran {world['id']}: exit={run_result.get('exit_code')} "
        f"duration={run_result.get('duration_sec')} error={run_result.get('error')}"
    )


def run_branchpoint(
    config_path: str,
    branchpoint_id: Optional[str],
    skip_runner: bool,
    skip_codex: bool,
    world_filters: Optional[List[str]],
) -> None:
    repo = ensure_git_repo()
    cfg = load_config(config_path)
    ensure_metadata_dirs(repo)

    bp_id = resolve_branchpoint_id(repo, branchpoint_id)
    branchpoint = load_branchpoint(repo, bp_id)

    runner_cmd = cfg["runner"]["command"]
    timeout_sec = int(cfg["runner"]["timeout_sec"])
    codex_cfg = cfg.get("codex", {})
    codex_enabled = bool(codex_cfg.get("enabled", False)) and not skip_codex
    commit_mode = str(codex_cfg.get("commit_mode", "series")).strip().lower() or "series"
    commit_prefix = str(codex_cfg.get("commit_prefix", "pw-step")).strip() or "pw-step"

    selected_worlds = resolve_worlds_for_branchpoint(repo, branchpoint, world_filters)
    available_skills: List[str] = []
    if codex_enabled and bool(codex_cfg.get("use_agents_md_skills", True)):
        available_skills = load_agents_skills(repo)
    max_parallel = int(cfg.get("execution", {}).get("max_parallel_worlds", 1))
    worker_count = min(max_parallel, len(selected_worlds))

    if worker_count <= 1:
        for world in selected_worlds:
            world["status"] = "running"
            save_world(repo, world)
            _, codex_result, run_result = _run_world_pipeline(
                repo=repo,
                world=world,
                branchpoint=branchpoint,
                codex_enabled=codex_enabled,
                codex_cfg=codex_cfg,
                available_skills=available_skills,
                runner_cmd=runner_cmd,
                timeout_sec=timeout_sec,
                skip_runner=skip_runner,
            )
            _apply_run_result(
                repo,
                bp_id,
                world,
                codex_result,
                run_result,
                commit_mode=commit_mode,
                commit_prefix=commit_prefix,
            )
    else:
        for world in selected_worlds:
            world["status"] = "running"
            save_world(repo, world)
        print(f"running {len(selected_worlds)} worlds with parallelism={worker_count}")
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(
                    _run_world_pipeline,
                    repo,
                    world,
                    branchpoint,
                    codex_enabled,
                    codex_cfg,
                    available_skills,
                    runner_cmd,
                    timeout_sec,
                    skip_runner,
                ): world["id"]
                for world in selected_worlds
            }
            for future in as_completed(futures):
                world, codex_result, run_result = future.result()
                _apply_run_result(
                    repo,
                    bp_id,
                    world,
                    codex_result,
                    run_result,
                    commit_mode=commit_mode,
                    commit_prefix=commit_prefix,
                )

    branchpoint["status"] = "ran"
    branchpoint["last_ran_at"] = now_utc()
    save_branchpoint(repo, branchpoint)
    set_latest_branchpoint(repo, bp_id)

    build_report(config_path=config_path, branchpoint_id=bp_id)


def build_playbook(config_path: str, branchpoint_id: Optional[str]) -> None:
    repo = ensure_git_repo()
    cfg = load_config(config_path)
    ensure_metadata_dirs(repo)

    bp_id = resolve_branchpoint_id(repo, branchpoint_id)
    branchpoint = load_branchpoint(repo, bp_id)
    worlds = [load_world(repo, wid) for wid in branchpoint.get("world_ids", [])]

    path = os.path.join(repo, "play.md")
    lines: List[str] = []
    lines.append("# Parallel Worlds Playback")
    lines.append("")
    lines.append(f"Generated: {now_utc()}")
    lines.append(f"Branchpoint: `{bp_id}`")
    lines.append(f"Intent: {branchpoint.get('intent', '')}")
    lines.append(f"Render command: `{branchpoint.get('render') or cfg['render']['command']}`")
    lines.append("")

    for world in worlds:
        render = load_render(repo, bp_id, world["id"])
        lines.append(f"## {world['index']:02d} {world['name']}")
        lines.append("")
        lines.append(f"- World ID: `{world['id']}`")
        lines.append(f"- Branch: `{world['branch']}`")
        lines.append(f"- Worktree: `{world['worktree']}`")
        if not render:
            lines.append("- Render: not run")
            lines.append("")
            continue

        lines.append(f"- Exit: `{render.get('exit_code')}`")
        lines.append(f"- Duration: `{render.get('duration_sec')}` sec")
        if render.get("error"):
            lines.append(f"- Error: `{render.get('error')}`")
        log_path = format_path(render.get("render_log"), repo)
        lines.append(f"- Log: `{log_path}`")
        lines.append("")

        preview = tail_file(render.get("render_log", ""), int(cfg["render"]["preview_lines"]))
        if preview:
            lines.append("Execution preview:")
            lines.append("")
            lines.append("```text")
            lines.extend(preview)
            lines.append("```")
            lines.append("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"playbook written: {path}")


def _apply_render_result(
    repo: str,
    bp_id: str,
    world: Dict[str, Any],
    result: Dict[str, Any],
    preview_lines: int,
) -> None:
    save_render(repo, bp_id, world["id"], result)

    world["last_render_file"] = render_file(repo, bp_id, world["id"])
    world["last_render_exit_code"] = result.get("exit_code")
    world["last_render_duration_sec"] = result.get("duration_sec")
    save_world(repo, world)

    print(
        f"played {world['id']}: exit={result.get('exit_code')} "
        f"duration={result.get('duration_sec')} error={result.get('error')}"
    )
    preview = tail_file(result.get("render_log", "") or "", preview_lines)
    if preview:
        print(f"--- preview: {world['id']} ---")
        for line in preview:
            print(line)
        print("--- end preview ---")


def play_branchpoint(
    config_path: str,
    branchpoint_id: Optional[str],
    world_filters: Optional[List[str]],
    render_command_override: Optional[str],
    timeout_override: Optional[int],
    preview_lines_override: Optional[int],
) -> None:
    repo = ensure_git_repo()
    cfg = load_config(config_path)
    ensure_metadata_dirs(repo)

    bp_id = resolve_branchpoint_id(repo, branchpoint_id)
    branchpoint = load_branchpoint(repo, bp_id)
    selected_worlds = resolve_worlds_for_branchpoint(repo, branchpoint, world_filters)

    render_cmd = (render_command_override or cfg["render"]["command"] or "").strip()
    if not render_cmd:
        die("no render command configured. Set config.render.command or pass --render-command.")

    timeout_sec = int(timeout_override or cfg["render"]["timeout_sec"])
    preview_lines = int(preview_lines_override if preview_lines_override is not None else cfg["render"]["preview_lines"])
    if timeout_sec <= 0:
        die("render timeout must be > 0")
    if preview_lines < 0:
        die("preview lines must be >= 0")

    max_parallel = int(cfg.get("execution", {}).get("max_parallel_worlds", 1))
    worker_count = min(max_parallel, len(selected_worlds))

    if worker_count <= 1:
        for world in selected_worlds:
            _, result = _play_world_pipeline(
                world=world,
                branchpoint=branchpoint,
                render_cmd=render_cmd,
                timeout_sec=timeout_sec,
            )
            _apply_render_result(repo, bp_id, world, result, preview_lines)
    else:
        print(f"playing {len(selected_worlds)} worlds with parallelism={worker_count}")
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(
                    _play_world_pipeline,
                    world,
                    branchpoint,
                    render_cmd,
                    timeout_sec,
                ): world["id"]
                for world in selected_worlds
            }
            for future in as_completed(futures):
                world, result = future.result()
                _apply_render_result(repo, bp_id, world, result, preview_lines)

    branchpoint["status"] = "played"
    branchpoint["last_played_at"] = now_utc()
    branchpoint["render"] = render_cmd
    save_branchpoint(repo, branchpoint)
    set_latest_branchpoint(repo, bp_id)

    build_playbook(config_path=config_path, branchpoint_id=bp_id)
    build_report(config_path=config_path, branchpoint_id=bp_id)


def world_score(run: Optional[Dict[str, Any]]) -> Tuple[int, int, float, int]:
    if run is None:
        return (3, 1, 999999.0, 999999)

    exit_code = run.get("exit_code")
    error = run.get("error")
    duration = float(run.get("duration_sec") or 999999.0)
    diff_stats = run.get("diff_stats") or {}
    churn = int(diff_stats.get("added", 0)) + int(diff_stats.get("deleted", 0))

    if exit_code == 0 and not error:
        tier = 0
    elif exit_code is None and error:
        tier = 2
    else:
        tier = 1

    return (tier, 0 if error is None else 1, duration, churn)


def format_path(path: Optional[str], repo: str) -> str:
    if not path:
        return ""
    return relative_to_repo(path, repo)


def build_report(config_path: str, branchpoint_id: Optional[str]) -> None:
    repo = ensure_git_repo()
    cfg = load_config(config_path)
    ensure_metadata_dirs(repo)

    bp_id = resolve_branchpoint_id(repo, branchpoint_id)
    branchpoint = load_branchpoint(repo, bp_id)

    worlds: List[Dict[str, Any]] = [load_world(repo, wid) for wid in branchpoint.get("world_ids", [])]

    ranked = []
    for world in worlds:
        run = load_run(repo, bp_id, world["id"])
        codex_run = load_codex_run(repo, bp_id, world["id"])
        render = load_render(repo, bp_id, world["id"])
        ranked.append((world_score(run), world, run, codex_run, render))
    ranked.sort(key=lambda x: x[0])

    report_path = os.path.join(repo, "report.md")
    lines: List[str] = []
    lines.append("# Parallel Worlds Report")
    lines.append("")
    lines.append(f"Generated: {now_utc()}")
    lines.append(f"Branchpoint: `{bp_id}`")
    lines.append(f"Intent: {branchpoint.get('intent', '')}")
    lines.append(f"Source ref: `{branchpoint.get('source_ref', '')}`")
    lines.append(f"Base branch: `{branchpoint.get('base_branch', cfg['base_branch'])}`")
    lines.append(f"Runner: `{cfg['runner']['command']}`")
    lines.append(f"Codex: `{cfg['codex']['command']}` (enabled={cfg['codex']['enabled']})")
    lines.append(f"Render: `{cfg['render']['command']}`")
    lines.append("")

    lines.append("## Branch Graph")
    lines.append("")
    lines.append("```mermaid")
    lines.append("graph TD")
    lines.append(f"  SRC[\"{branchpoint.get('source_ref', 'source')}\"]")
    lines.append(f"  BP[\"{bp_id}\"]")
    lines.append("  SRC --> BP")
    for _, world, _, _, _ in ranked:
        label = f"{world['index']:02d} {world['name']}"
        node = f"W{world['index']:02d}"
        lines.append(f"  BP --> {node}[\"{label}\"]")
    lines.append("```")
    lines.append("")

    lines.append("## Comparison")
    lines.append("")
    lines.append("| Rank | World | Branch | Status | Codex Exit | Codex Duration (s) | Test Exit | Test Duration (s) | Render Exit | Render Duration (s) | Files | +Lines | -Lines | Strategy | Prompt | Codex Log | Trace | Render Log | Diff |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")

    for rank, (_, world, run, codex_run, render) in enumerate(ranked, start=1):
        status = world.get("status", "ready")
        codex_exit = ""
        codex_duration = ""
        run_exit = ""
        run_duration = ""
        render_exit = ""
        render_duration = ""
        files = ""
        added = ""
        deleted = ""
        trace = ""
        render_log = ""
        prompt = ""
        codex_log = ""
        diff = ""

        if codex_run:
            codex_exit = str(codex_run.get("exit_code", ""))
            codex_duration = str(codex_run.get("duration_sec", ""))
            prompt = f"`{format_path(codex_run.get('prompt_file'), repo)}`" if codex_run.get("prompt_file") else ""
            codex_log = f"`{format_path(codex_run.get('log_file'), repo)}`" if codex_run.get("log_file") else ""
        if run:
            run_exit = str(run.get("exit_code", ""))
            run_duration = str(run.get("duration_sec", ""))
            stats = run.get("diff_stats") or {}
            files = str(stats.get("files", ""))
            added = str(stats.get("added", ""))
            deleted = str(stats.get("deleted", ""))
            trace = f"`{format_path(run.get('trace_log'), repo)}`" if run.get("trace_log") else ""
            diff = f"`{format_path(run.get('diff_patch'), repo)}`" if run.get("diff_patch") else ""
        if render:
            render_exit = str(render.get("exit_code", ""))
            render_duration = str(render.get("duration_sec", ""))
            render_log = f"`{format_path(render.get('render_log'), repo)}`" if render.get("render_log") else ""

        lines.append(
            f"| {rank} | {world['name']} | `{world['branch']}` | {status} | {codex_exit} | {codex_duration} | {run_exit} | {run_duration} | {render_exit} | {render_duration} | {files} | {added} | {deleted} | {world.get('notes','')} | {prompt} | {codex_log} | {trace} | {render_log} | {diff} |"
        )

    lines.append("")
    lines.append("Playback details: `play.md` (generated by `pw.py play`).")
    lines.append("")
    selected_world_id = branchpoint.get("selected_world_id")
    if selected_world_id:
        selected = None
        for _, world, _, _, _ in ranked:
            if world["id"] == selected_world_id:
                selected = world
                break
        if selected:
            lines.append("## Selected World")
            lines.append("")
            lines.append(f"Selected: `{selected['id']}`")
            lines.append(f"Branch: `{selected['branch']}`")
            lines.append("")
            lines.append("Suggested merge command:")
            lines.append("")
            lines.append("```bash")
            lines.append(f"git checkout {branchpoint.get('base_branch', cfg['base_branch'])}")
            lines.append(f"git merge --no-ff {selected['branch']}")
            lines.append("```")
            lines.append("")

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"report written: {report_path}")


def print_status(config_path: str, branchpoint_id: Optional[str]) -> None:
    repo = ensure_git_repo()
    load_config(config_path)
    ensure_metadata_dirs(repo)

    bp_id = resolve_branchpoint_id(repo, branchpoint_id)
    branchpoint = load_branchpoint(repo, bp_id)

    worlds = [load_world(repo, wid) for wid in branchpoint.get("world_ids", [])]

    counts = {"ready": 0, "pass": 0, "fail": 0, "error": 0, "skipped": 0}
    for w in worlds:
        counts[w.get("status", "ready")] = counts.get(w.get("status", "ready"), 0) + 1

    print(f"branchpoint: {bp_id}")
    print(f"intent: {branchpoint.get('intent','')}")
    print(f"created: {branchpoint.get('created_at','')}")
    print(
        "status counts: "
        f"ready={counts.get('ready',0)} pass={counts.get('pass',0)} "
        f"fail={counts.get('fail',0)} error={counts.get('error',0)} skipped={counts.get('skipped',0)}"
    )

    for w in worlds:
        print(
            f"- {w['id']} status={w.get('status','ready')} "
            f"codex_exit={w.get('last_codex_exit_code')} codex_duration={w.get('last_codex_duration_sec')} "
            f"exit={w.get('last_exit_code')} duration={w.get('last_duration_sec')} "
            f"render_exit={w.get('last_render_exit_code')} render_duration={w.get('last_render_duration_sec')}"
        )


def list_objects(config_path: str, show_worlds: bool) -> None:
    repo = ensure_git_repo()
    load_config(config_path)
    ensure_metadata_dirs(repo)

    branchpoints = list_branchpoints(repo)
    if not branchpoints:
        print("no branchpoints yet")
        return

    if not show_worlds:
        for bp in branchpoints:
            print(
                f"{bp['id']}\t{bp.get('created_at','')}\t{bp.get('status','')}\t"
                f"{len(bp.get('world_ids', []))} worlds\t{bp.get('intent','')}"
            )
        return

    for bp in branchpoints:
        print(f"{bp['id']}\t{bp.get('created_at','')}\t{bp.get('intent','')}")
        for wid in bp.get("world_ids", []):
            world = load_world(repo, wid)
            print(
                f"  - {world['id']}\t{world.get('status','ready')}\t"
                f"{world['branch']}\t{world['worktree']}\t"
                f"codex={world.get('last_codex_exit_code')} "
                f"run={world.get('last_exit_code')} render={world.get('last_render_exit_code')}"
            )


def resolve_world_choice(worlds: List[Dict[str, Any]], world_token: str) -> Dict[str, Any]:
    for world in worlds:
        if world_token in {world.get("id"), world.get("slug"), world.get("name"), world.get("branch")}:
            return world
    die(f"world not found in branchpoint: {world_token}")
    return {}


def select_world(config_path: str, branchpoint_id: Optional[str], world_token: str, merge: bool, target_branch: Optional[str]) -> None:
    repo = ensure_git_repo()
    cfg = load_config(config_path)
    ensure_metadata_dirs(repo)

    bp_id = resolve_branchpoint_id(repo, branchpoint_id)
    branchpoint = load_branchpoint(repo, bp_id)

    worlds = [load_world(repo, wid) for wid in branchpoint.get("world_ids", [])]
    selected = resolve_world_choice(worlds, world_token)

    branchpoint["selected_world_id"] = selected["id"]
    branchpoint["selected_at"] = now_utc()
    save_branchpoint(repo, branchpoint)

    target = target_branch or branchpoint.get("base_branch") or cfg["base_branch"]

    print(f"selected world: {selected['id']}")
    print(f"branch: {selected['branch']}")
    print("merge preview:")
    print(f"git checkout {target}")
    print(f"git merge --no-ff {selected['branch']}")

    if merge:
        if not worktree_is_clean(repo):
            die("repository has local changes; commit/stash first or rerun select without --merge")

        git(["checkout", target], cwd=repo, check=True)
        git(["merge", "--no-ff", selected["branch"]], cwd=repo, check=True)
        print(f"merged {selected['branch']} into {target}")

    build_report(config_path=config_path, branchpoint_id=bp_id)


def refork_world(
    config_path: str,
    branchpoint_id: Optional[str],
    world_token: str,
    intent: str,
    count: Optional[int],
    cli_strategies: Optional[List[str]],
) -> None:
    repo = ensure_git_repo()
    ensure_metadata_dirs(repo)

    bp_id = resolve_branchpoint_id(repo, branchpoint_id)
    branchpoint = load_branchpoint(repo, bp_id)
    worlds = [load_world(repo, wid) for wid in branchpoint.get("world_ids", [])]
    selected = resolve_world_choice(worlds, world_token)

    kickoff_worlds(
        config_path=config_path,
        intent=intent,
        count=count,
        from_ref=selected["branch"],
        cli_strategies=cli_strategies,
    )
    new_bp = get_latest_branchpoint(repo)
    if new_bp:
        print(f"reforked from `{selected['branch']}` into branchpoint `{new_bp}`")


def autopilot_worlds(
    config_path: str,
    prompt: str,
    count: Optional[int],
    from_ref: Optional[str],
    cli_strategies: Optional[List[str]],
    run_after_kickoff: bool,
    play_after_run: bool,
    skip_runner: bool,
    skip_codex: bool,
    render_command_override: Optional[str],
    timeout_override: Optional[int],
    preview_lines_override: Optional[int],
) -> None:
    repo = ensure_git_repo()
    ensure_metadata_dirs(repo)

    kickoff_worlds(
        config_path=config_path,
        intent=prompt,
        count=count,
        from_ref=from_ref,
        cli_strategies=cli_strategies,
    )
    bp_id = get_latest_branchpoint(repo)
    if not bp_id:
        die("autopilot failed to create a branchpoint")

    print(f"autopilot branchpoint: {bp_id}")

    if run_after_kickoff:
        run_branchpoint(
            config_path=config_path,
            branchpoint_id=bp_id,
            skip_runner=skip_runner,
            skip_codex=skip_codex,
            world_filters=None,
        )

    if play_after_run:
        play_branchpoint(
            config_path=config_path,
            branchpoint_id=bp_id,
            world_filters=None,
            render_command_override=render_command_override,
            timeout_override=timeout_override,
            preview_lines_override=preview_lines_override,
        )


def init_workspace(config_path: str, force: bool) -> None:
    repo = ensure_git_repo()
    write_default_config(config_path, force=force)
    ensure_metadata_dirs(repo)
    print(f"wrote config: {config_path}")
    print(f"initialized metadata: {metadata_root(repo)}")
