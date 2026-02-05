# Symphony v1 Codex Agent Context Pack

Use this with `symphony/plans/symphony-v1.compiled-task-graph.json`.
Each block is a ready-to-run task context for one Codex agent.

## Agent 1: `task_frontend_canvas_v1`
- Branch: `world/symphony/task_frontend_canvas_v1`
- Worktree: `/tmp/symphony/task_frontend_canvas_v1`
- Objective: Build multi-layer planning canvas UI.
- Scope:
  - Node and edge CRUD interactions.
  - Layer and POV filtering.
  - JSON export aligned with canvas plan schema.
- Key Context:
  - `symphony/schemas/canvas-plan.schema.json`
  - `webapp/src/App.jsx`
  - `webapp/src/styles.css`
- Done When:
  - Canvas interactions work end-to-end.
  - Exported payload structure follows schema contract.
- Verify:
  - `npm --prefix webapp run build`

## Agent 2: `task_backend_plan_api_v1`
- Branch: `world/symphony/task_backend_plan_api_v1`
- Worktree: `/tmp/symphony/task_backend_plan_api_v1`
- Objective: Implement project and plan CRUD/versioning APIs.
- Scope:
  - `POST /api/v1/projects`
  - `GET /api/v1/projects/{project_id}`
  - `POST /api/v1/projects/{project_id}/plans`
- Key Context:
  - `SYMPHONY_ONE_PAGE_SPEC.md`
  - `pw_web.py`
  - `parallel_worlds/state.py`
- Done When:
  - APIs create and return versioned plans.
  - Error responses follow `{ ok, error }` model.
- Verify:
  - `python3 -m pytest -q`

## Agent 3: `task_backend_compile_service_v1`
- Branch: `world/symphony/task_backend_compile_service_v1`
- Worktree: `/tmp/symphony/task_backend_compile_service_v1`
- Objective: Compile saved plan JSON to executable task graph JSON.
- Scope:
  - `POST /api/v1/plans/{plan_id}/compile`
  - Deterministic node->task and edge->dependency mapping.
  - Output validation against compiled graph schema.
- Key Context:
  - `symphony/schemas/README.md`
  - `symphony/schemas/canvas-plan.schema.json`
  - `symphony/schemas/compiled-task-graph.schema.json`
- Done When:
  - Valid plan compiles consistently.
  - Invalid plan returns clear validation errors.
- Verify:
  - `python3 -m pytest -q`

## Agent 4: `task_orchestrator_scheduler_v1`
- Branch: `world/symphony/task_orchestrator_scheduler_v1`
- Worktree: `/tmp/symphony/task_orchestrator_scheduler_v1`
- Objective: Build dependency-aware parallel scheduler.
- Scope:
  - Runnable task detection from hard dependencies.
  - Concurrency cap with max parallel agents.
  - Retry policy with terminal failure states.
- Key Context:
  - `parallel_worlds/commands.py`
  - `parallel_worlds/state.py`
  - `symphony/plans/symphony-v1.compiled-task-graph.json`
- Done When:
  - Scheduler dispatches only valid runnable tasks.
  - State transitions are persisted and queryable.
- Verify:
  - `python3 -m pytest -q`

## Agent 5: `task_orchestrator_agent_runtime_v1`
- Branch: `world/symphony/task_orchestrator_agent_runtime_v1`
- Worktree: `/tmp/symphony/task_orchestrator_agent_runtime_v1`
- Objective: Run Codex tasks with prompt/context snapshots and artifacts.
- Scope:
  - Build per-task prompt from objective, criteria, steering.
  - Execute Codex command in isolated workspace.
  - Persist logs, exit code, duration, prompt snapshot.
- Key Context:
  - `parallel_worlds/execution.py`
  - `parallel_worlds/commands.py`
  - `symphony/plans/symphony-v1.compiled-task-graph.json`
- Done When:
  - Each task run has complete observable artifacts.
  - Runtime supports cancellation semantics.
- Verify:
  - `python3 -m pytest -q`

## Agent 6: `task_backend_control_api_v1`
- Branch: `world/symphony/task_backend_control_api_v1`
- Worktree: `/tmp/symphony/task_backend_control_api_v1`
- Objective: Implement operator controls and steering APIs.
- Scope:
  - `POST /tasks/{task_id}/pause`
  - `POST /tasks/{task_id}/resume`
  - `POST /tasks/{task_id}/stop`
  - `POST /tasks/{task_id}/steer`
- Key Context:
  - `SYMPHONY_ONE_PAGE_SPEC.md`
  - Runtime and scheduler task lifecycle interfaces.
- Done When:
  - Controls affect active runs correctly.
  - Steering comments appear in subsequent attempts.
- Verify:
  - `python3 -m pytest -q`

## Agent 7: `task_backend_progress_events_v1`
- Branch: `world/symphony/task_backend_progress_events_v1`
- Worktree: `/tmp/symphony/task_backend_progress_events_v1`
- Objective: Expose progress APIs and SSE event stream.
- Scope:
  - `GET /runs/{run_id}`
  - `GET /runs/{run_id}/diagram`
  - `GET /runs/{run_id}/events`
- Key Context:
  - Orchestrator run state and agent event persistence.
  - Existing API patterns in `pw_web.py`.
- Done When:
  - UI can query live run progress and task graph state.
  - Events stream incrementally without polling loops.
- Verify:
  - `python3 -m pytest -q`

## Agent 8: `task_frontend_progress_view_v1`
- Branch: `world/symphony/task_frontend_progress_view_v1`
- Worktree: `/tmp/symphony/task_frontend_progress_view_v1`
- Objective: Build run progress diagram and control panel.
- Scope:
  - DAG node rendering with status colors and counters.
  - Task details drawer with logs/artifacts.
  - Pause/resume/stop/steer actions from UI.
- Key Context:
  - `webapp/src/App.jsx`
  - Backend progress and control APIs.
- Done When:
  - Operator can monitor and steer active runs in one view.
- Verify:
  - `npm --prefix webapp run build`

## Agent 9: `task_integration_e2e_v1`
- Branch: `world/symphony/task_integration_e2e_v1`
- Worktree: `/tmp/symphony/task_integration_e2e_v1`
- Objective: Add end-to-end workflow coverage.
- Scope:
  - Plan create -> compile -> run -> progress -> steer flow.
  - Happy path and retry/failure path coverage.
- Key Context:
  - All completed API/UI workflows from prior tasks.
- Done When:
  - E2E flow passes in local smoke validation.
- Verify:
  - `python3 -m pytest -q`
  - `npm --prefix webapp run build`

## Parallel Start Set
Start these agents at the same time:
- Agent 1 (`task_frontend_canvas_v1`)
- Agent 2 (`task_backend_plan_api_v1`)

Then unlock in order:
- Agent 3
- Agents 4 and 5
- Agents 6 and 7
- Agent 8
- Agent 9
