import json
import threading
import time
from pathlib import Path

from parallel_worlds.execution import (
    build_codex_prompt,
    execute_logged_command,
    run_codex_world,
    set_codex_pause,
    set_codex_stop,
)


def _world_payload(worktree: Path) -> dict:
    return {
        "id": "world-1",
        "name": "World One",
        "branch": "world/test",
        "worktree": str(worktree),
        "notes": "Implement with runtime adapter",
        "objective": "Run a task in an isolated workspace.",
        "acceptance_criteria": ["capture logs", "persist prompt snapshot"],
        "steering_comments": ["prefer simple implementation"],
    }


def _branchpoint_payload() -> dict:
    return {
        "id": "bp-1",
        "intent": "Ship runtime adapter",
        "base_branch": "main",
    }


def test_prompt_contains_objective_acceptance_and_steering() -> None:
    prompt = build_codex_prompt(
        world=_world_payload(Path("/tmp/world")),
        branchpoint=_branchpoint_payload(),
        chosen_skills=[],
        automation_enabled=False,
        automation_name_prefix="Parallel Worlds",
    )

    assert "## Task Objective" in prompt
    assert "Run a task in an isolated workspace." in prompt
    assert "## Acceptance Criteria" in prompt
    assert "- capture logs" in prompt
    assert "## Steering Comments" in prompt
    assert "- prefer simple implementation" in prompt


def test_run_codex_world_persists_snapshots_and_artifacts(tmp_path: Path) -> None:
    worktree = tmp_path / "world"
    worktree.mkdir(parents=True)

    payload = run_codex_world(
        world=_world_payload(worktree),
        branchpoint=_branchpoint_payload(),
        codex_cfg={
            "command": "printf 'runtime-ok\\n'",
            "timeout_sec": 5,
            "automation": {"enabled": False, "name_prefix": "Parallel Worlds"},
        },
        available_skills=[],
    )

    assert payload["exit_code"] == 0
    assert payload["error"] is None
    assert payload["status"] == "ok"
    assert Path(payload["prompt_snapshot_file"]).exists()
    assert Path(payload["context_snapshot_file"]).exists()
    assert Path(payload["command_file"]).exists()
    assert Path(payload["log_file"]).exists()

    prompt_text = Path(payload["prompt_snapshot_file"]).read_text(encoding="utf-8")
    assert "Run a task in an isolated workspace." in prompt_text
    assert "capture logs" in prompt_text
    assert "prefer simple implementation" in prompt_text

    context_payload = json.loads(Path(payload["context_snapshot_file"]).read_text(encoding="utf-8"))
    assert context_payload["objective"] == "Run a task in an isolated workspace."
    assert context_payload["acceptance_criteria"] == ["capture logs", "persist prompt snapshot"]
    assert context_payload["steering_comments"] == ["prefer simple implementation"]


def test_execute_logged_command_can_cancel_with_stop_signal(tmp_path: Path) -> None:
    meta_dir = tmp_path / "meta"
    meta_dir.mkdir(parents=True)

    set_codex_stop(str(meta_dir), "operator stop request")
    payload = execute_logged_command(
        command="sleep 5",
        cwd=str(tmp_path),
        timeout_sec=5,
        meta_dir=str(meta_dir),
        log_filename="codex.log",
        control_meta_dir=str(meta_dir),
    )

    assert payload["exit_code"] == -2
    assert payload["was_cancelled"] is True
    assert "operator stop request" in str(payload["error"])


def test_execute_logged_command_tracks_pause_state(tmp_path: Path, monkeypatch) -> None:
    meta_dir = tmp_path / "meta"
    meta_dir.mkdir(parents=True)

    set_codex_pause(str(meta_dir), True)

    def _remove_pause() -> None:
        time.sleep(0.4)
        set_codex_pause(str(meta_dir), False)

    monkeypatch.setattr("parallel_worlds.execution._send_process_signal", lambda process, sig: True)
    remover = threading.Thread(target=_remove_pause, daemon=True)
    remover.start()
    payload = execute_logged_command(
        command="sleep 1",
        cwd=str(tmp_path),
        timeout_sec=5,
        meta_dir=str(meta_dir),
        log_filename="codex.log",
        control_meta_dir=str(meta_dir),
    )
    remover.join(timeout=1)

    assert payload["exit_code"] == 0
    assert payload["was_paused"] is True
    assert payload["was_cancelled"] is False
