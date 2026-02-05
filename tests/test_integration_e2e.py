import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PW_PY = PROJECT_ROOT / "pw.py"


def _run(cmd: list[str], cwd: Path, env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, env=env, text=True, capture_output=True, check=True)


def _write_config(repo: Path, worlds_dir: Path, runner_command: str) -> Path:
    config = {
        "base_branch": "main",
        "branch_prefix": "world",
        "worlds_dir": str(worlds_dir),
        "default_world_count": 1,
        "runner": {"command": runner_command, "timeout_sec": 60},
        "codex": {"enabled": False, "command": "", "timeout_sec": 60, "use_agents_md_skills": True},
        "render": {"command": "", "timeout_sec": 60, "preview_lines": 25},
        "execution": {"max_parallel_worlds": 1},
        "strategies": [
            {"name": "minimal-fix", "notes": "Smallest targeted change with low risk."},
        ],
    }
    path = repo / "parallel_worlds.json"
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return path


def _init_temp_repo(tmp_path: Path) -> tuple[Path, Dict[str, str]]:
    repo = tmp_path / "repo"
    repo.mkdir()
    _run(["git", "init"], cwd=repo)
    _run(["git", "checkout", "-b", "main"], cwd=repo)
    _run(["git", "config", "user.name", "e2e-test"], cwd=repo)
    _run(["git", "config", "user.email", "e2e-test@example.com"], cwd=repo)
    (repo / "README.md").write_text("temporary e2e repo\n", encoding="utf-8")
    _run(["git", "add", "README.md"], cwd=repo)
    _run(["git", "commit", "-m", "init"], cwd=repo)

    env = os.environ.copy()
    existing_path = env.get("PYTHONPATH", "").strip()
    env["PYTHONPATH"] = str(PROJECT_ROOT) if not existing_path else f"{PROJECT_ROOT}:{existing_path}"
    return repo, env


def _metadata_root(repo: Path) -> Path:
    return repo / ".parallel_worlds"


def _latest_branchpoint(repo: Path) -> str:
    return (_metadata_root(repo) / "latest_branchpoint.txt").read_text(encoding="utf-8").strip()


def _load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_e2e_happy_path_cli_flow(tmp_path: Path) -> None:
    repo, env = _init_temp_repo(tmp_path)
    worlds_dir = tmp_path / "worlds"
    config_path = _write_config(repo, worlds_dir=worlds_dir, runner_command='python3 -c "print(\'runner-ok\')"')

    _run(
        [sys.executable, str(PW_PY), "kickoff", "-c", str(config_path), "--intent", "e2e happy path", "--count", "1"],
        cwd=repo,
        env=env,
    )

    _run(
        [sys.executable, str(PW_PY), "run", "-c", str(config_path), "--skip-codex"],
        cwd=repo,
        env=env,
    )

    branchpoint_id = _latest_branchpoint(repo)
    branchpoint_path = _metadata_root(repo) / "branchpoints" / f"{branchpoint_id}.json"
    branchpoint = _load_json(branchpoint_path)
    assert branchpoint["intent"] == "e2e happy path"
    assert len(branchpoint["world_ids"]) == 1
    world_id = branchpoint["world_ids"][0]

    world_meta_path = _metadata_root(repo) / "worlds" / f"{world_id}.json"
    world_meta = _load_json(world_meta_path)
    assert world_meta["status"] == "pass"
    assert world_meta["last_exit_code"] == 0

    _run(
        [sys.executable, str(PW_PY), "report", "-c", str(config_path), "--branchpoint", branchpoint_id],
        cwd=repo,
        env=env,
    )
    report_text = (repo / "report.md").read_text(encoding="utf-8")
    assert branchpoint_id in report_text
    assert world_meta["branch"] in report_text

    _run(
        [
            sys.executable,
            str(PW_PY),
            "refork",
            "-c",
            str(config_path),
            "--branchpoint",
            branchpoint_id,
            "--world",
            world_id,
            "--intent",
            "e2e steering follow-up",
            "--count",
            "1",
        ],
        cwd=repo,
        env=env,
    )
    new_branchpoint = _latest_branchpoint(repo)
    assert new_branchpoint != branchpoint_id
    new_branchpoint_payload = _load_json(_metadata_root(repo) / "branchpoints" / f"{new_branchpoint}.json")
    assert new_branchpoint_payload["intent"] == "e2e steering follow-up"
    assert len(new_branchpoint_payload["world_ids"]) == 1


def test_e2e_failure_then_retry_flow(tmp_path: Path) -> None:
    repo, env = _init_temp_repo(tmp_path)
    worlds_dir = tmp_path / "worlds"
    config_path = _write_config(
        repo,
        worlds_dir=worlds_dir,
        runner_command='python3 -c "import pathlib,sys; sys.exit(0 if pathlib.Path(\'.pw_retry_ok\').exists() else 1)"',
    )

    _run(
        [sys.executable, str(PW_PY), "kickoff", "-c", str(config_path), "--intent", "e2e retry flow", "--count", "1"],
        cwd=repo,
        env=env,
    )
    _run(
        [sys.executable, str(PW_PY), "run", "-c", str(config_path), "--skip-codex"],
        cwd=repo,
        env=env,
    )

    branchpoint_id = _latest_branchpoint(repo)
    branchpoint = _load_json(_metadata_root(repo) / "branchpoints" / f"{branchpoint_id}.json")
    world_id = branchpoint["world_ids"][0]
    world_meta_path = _metadata_root(repo) / "worlds" / f"{world_id}.json"
    world_meta_first = _load_json(world_meta_path)
    assert world_meta_first["status"] == "fail"
    assert world_meta_first["last_exit_code"] != 0

    worktree = Path(world_meta_first["worktree"])
    (worktree / ".pw_retry_ok").write_text("ok\n", encoding="utf-8")

    _run(
        [sys.executable, str(PW_PY), "run", "-c", str(config_path), "--skip-codex"],
        cwd=repo,
        env=env,
    )

    world_meta_second = _load_json(world_meta_path)
    assert world_meta_second["status"] == "pass"
    assert world_meta_second["last_exit_code"] == 0

    run_record = _load_json(_metadata_root(repo) / "runs" / branchpoint_id / f"{world_id}.json")
    assert run_record["exit_code"] == 0
