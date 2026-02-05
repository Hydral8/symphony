import threading
import time
import subprocess

from parallel_worlds.execution import build_codex_prompt, execute_logged_command
from parallel_worlds.runtime_control import (
    append_steering_comment,
    apply_task_action,
    get_task_control,
    list_steering_comments,
)
from pw_web import _parse_task_control_route


def _init_repo(tmp_path) -> str:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=str(repo), check=True, capture_output=True, text=True)
    return str(repo)


def test_parse_task_control_route() -> None:
    assert _parse_task_control_route("/api/v1/tasks/task_123/pause") == ("task_123", "pause")
    assert _parse_task_control_route("/tasks/task_123/steer") == ("task_123", "steer")
    assert _parse_task_control_route("/api/v1/tasks/task_123/unknown") is None
    assert _parse_task_control_route("/api/v1/runs/run_1") is None


def test_steering_persists_and_appears_in_prompt(tmp_path) -> None:
    repo = _init_repo(tmp_path)
    task_id = "task_backend_control_api_v1"

    row = append_steering_comment(
        repo=repo,
        task_id=task_id,
        comment="Prioritize cancellation semantics.",
        prompt_patch="Add explicit handling for paused state transitions.",
        author="operator",
    )
    assert row["task_id"] == task_id

    steering = list_steering_comments(repo, task_id, limit=20)["items"]
    prompt = build_codex_prompt(
        world={"name": "Control API", "branch": "world/symphony/task_backend_control_api_v1", "notes": "api wiring"},
        branchpoint={"intent": "Implement task controls"},
        chosen_skills=[],
        automation_enabled=False,
        automation_name_prefix="Parallel Worlds",
        steering_comments=steering,
    )

    assert "Steering Updates" in prompt
    assert "Prioritize cancellation semantics." in prompt
    assert "paused state transitions" in prompt


def test_pause_resume_stop_without_active_process_updates_control(tmp_path) -> None:
    repo = _init_repo(tmp_path)
    task_id = "task_backend_control_api_v1"

    pause = apply_task_action(repo=repo, task_id=task_id, action="pause")
    assert pause["ok"] is True
    assert get_task_control(repo, task_id)["status"] == "paused"

    resume = apply_task_action(repo=repo, task_id=task_id, action="resume")
    assert resume["ok"] is True
    assert get_task_control(repo, task_id)["status"] == "pending"

    stop = apply_task_action(repo=repo, task_id=task_id, action="stop")
    assert stop["ok"] is True
    state = get_task_control(repo, task_id)
    assert state["status"] == "stopped"
    assert state["stop_requested"] is True


def test_stop_action_terminates_active_process(tmp_path) -> None:
    repo = _init_repo(tmp_path)
    task_id = "task_backend_control_api_v1"
    meta_dir = tmp_path / "meta"
    result_holder = {}

    def _run() -> None:
        result_holder["result"] = execute_logged_command(
            command="sleep 5",
            cwd=repo,
            timeout_sec=30,
            meta_dir=str(meta_dir),
            log_filename="trace.log",
            repo=repo,
            task_id=task_id,
            phase="runner",
            attempt=1,
        )

    thread = threading.Thread(target=_run)
    thread.start()
    time.sleep(0.4)

    action = apply_task_action(repo=repo, task_id=task_id, action="stop")
    assert action["ok"] is True
    assert action["data"]["applied_to_active"] is True

    thread.join(timeout=10)
    assert thread.is_alive() is False

    result = result_holder["result"]
    assert result["error"] == "stopped by operator"
    assert isinstance(result["exit_code"], int)
    assert get_task_control(repo, task_id)["status"] == "stopped"
