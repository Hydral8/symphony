# Symphony One-Page Spec (v0.1)

## 1) PRD (One Page)

### Product
Symphony is an AI-native project planner and builder where users stay focused on high-level product vision while orchestrated coding agents execute implementation tasks in parallel.

### Problem
- Teams lose time translating product intent into technical tasks.
- Planning artifacts (docs, diagrams, tickets) are disconnected from implementation.
- Multi-agent coding workflows are opaque, hard to steer, and difficult to trust.

### Target Users
- Product-minded founders and tech leads.
- Engineering teams shipping fast with AI pair-programmers/agents.
- Solo builders who need planning + execution in one place.

### Core Value Proposition
- Plan visually at multiple abstraction layers (vision -> modules -> UX/UI -> backend -> tasks).
- Convert visual plans into machine-executable task graphs.
- Run parallel Codex agents in isolated git branches/worktrees.
- Observe, steer, pause, and refine agent execution in real time.

### In Scope (MVP)
- Multi-layer planning canvas (nodes/edges, notes, acceptance criteria).
- Plan-to-task compiler that creates a dependency graph (DAG).
- Orchestrator that schedules tasks and runs Codex agents in isolated git workspaces.
- Progress view showing DAG, task states, running agent count, logs, and artifacts.
- Human control loop: stop/start agent, edit task prompt, inject comments/steering hints.
- Branch iteration workflow: compare outcomes, pick winners, merge to target branch.

### Out of Scope (MVP)
- Marketplace of third-party agents.
- Full auto-merge across complex monorepos without human approval.
- Enterprise RBAC/audit beyond basic project-level roles.

### Success Metrics
- Median time from approved plan to first merged task.
- Task success rate (passes acceptance criteria without manual rewrite).
- Human interventions per 10 tasks.
- Lead time from feature idea to production-ready PR.

---

## 2) API Contract Draft (v1)

Base path: `/api/v1`

### Projects and Plans
- `POST /projects`
  - Create project.
  - Body: `{ "name": "string", "vision": "string" }`
  - Returns: `{ "project_id": "uuid" }`
- `GET /projects/{project_id}`
  - Returns project summary and latest plan version.
- `POST /projects/{project_id}/plans`
  - Save canvas plan version.
  - Body: `{ "nodes": [], "edges": [], "metadata": {} }`
  - Returns: `{ "plan_id": "uuid", "version": 1 }`
- `POST /plans/{plan_id}/compile`
  - Compile plan into task DAG.
  - Body: `{ "mode": "mvp|full" }`
  - Returns: `{ "graph_id": "uuid", "tasks": [...] }`
- `POST /plans/{plan_id}/confirm`
  - Freeze plan version and open execution window.
  - Returns: `{ "status": "confirmed" }`

### Orchestration and Tasks
- `POST /graphs/{graph_id}/run`
  - Start orchestration.
  - Body: `{ "max_agents": 5, "target_branch": "main" }`
  - Returns: `{ "run_id": "uuid", "status": "running" }`
- `GET /runs/{run_id}`
  - Returns run state, counts, progress, timing.
- `GET /runs/{run_id}/diagram`
  - Returns DAG with node status (`pending|running|blocked|done|failed|paused`).
- `POST /tasks/{task_id}/pause`
- `POST /tasks/{task_id}/resume`
- `POST /tasks/{task_id}/stop`
- `POST /tasks/{task_id}/steer`
  - Body: `{ "comment": "string", "prompt_patch": "string" }`
  - Appends steering input to task context.

### Agent Runs and Artifacts
- `POST /tasks/{task_id}/agent-runs`
  - Start/Retry agent for a task.
  - Body: `{ "agent": "codex", "model": "gpt-5-codex" }`
  - Returns: `{ "agent_run_id": "uuid" }`
- `GET /agent-runs/{agent_run_id}`
  - Returns command, status, exit code, token/cost, timing.
- `GET /tasks/{task_id}/artifacts`
  - Returns logs, diffs, test reports, generated files.
- `POST /tasks/{task_id}/promote`
  - Mark task output as selected for merge queue.

### Realtime
- `GET /runs/{run_id}/events` (SSE/WebSocket)
  - Streams task status changes, agent events, and log tails.

### Error Model
- Standard response:
  - Success: `{ "ok": true, "data": ... }`
  - Error: `{ "ok": false, "error": { "code": "STRING", "message": "..." } }`

---

## 3) Database Schema Draft (PostgreSQL)

### Core Tables
- `projects`
  - `id uuid pk`
  - `name text not null`
  - `vision text`
  - `created_at timestamptz`
  - `updated_at timestamptz`

- `plans`
  - `id uuid pk`
  - `project_id uuid fk -> projects.id`
  - `version int not null`
  - `status text check (status in ('draft','confirmed','archived'))`
  - `canvas_json jsonb not null`
  - `created_by text`
  - `created_at timestamptz`

- `task_graphs`
  - `id uuid pk`
  - `plan_id uuid fk -> plans.id`
  - `graph_json jsonb not null`
  - `compiled_at timestamptz`
  - `compiler_version text`

- `tasks`
  - `id uuid pk`
  - `graph_id uuid fk -> task_graphs.id`
  - `key text unique`
  - `title text not null`
  - `description text`
  - `acceptance_criteria jsonb`
  - `priority int default 3`
  - `status text check (status in ('pending','running','blocked','paused','done','failed','stopped'))`
  - `branch_name text`
  - `worktree_path text`
  - `created_at timestamptz`
  - `updated_at timestamptz`

- `task_dependencies`
  - `task_id uuid fk -> tasks.id`
  - `depends_on_task_id uuid fk -> tasks.id`
  - `primary key (task_id, depends_on_task_id)`

- `orchestrator_runs`
  - `id uuid pk`
  - `graph_id uuid fk -> task_graphs.id`
  - `status text check (status in ('queued','running','paused','completed','failed','cancelled'))`
  - `max_agents int not null`
  - `target_branch text`
  - `started_at timestamptz`
  - `finished_at timestamptz`

- `agent_runs`
  - `id uuid pk`
  - `task_id uuid fk -> tasks.id`
  - `run_id uuid fk -> orchestrator_runs.id`
  - `agent_type text` 
  - `model text`
  - `status text check (status in ('queued','running','succeeded','failed','timeout','cancelled'))`
  - `prompt_snapshot text`
  - `context_snapshot jsonb`
  - `command text`
  - `exit_code int`
  - `duration_sec numeric`
  - `token_input int`
  - `token_output int`
  - `cost_usd numeric`
  - `started_at timestamptz`
  - `finished_at timestamptz`

- `task_comments`
  - `id uuid pk`
  - `task_id uuid fk -> tasks.id`
  - `author text`
  - `comment text not null`
  - `prompt_patch text`
  - `created_at timestamptz`

- `artifacts`
  - `id uuid pk`
  - `task_id uuid fk -> tasks.id`
  - `agent_run_id uuid fk -> agent_runs.id`
  - `kind text check (kind in ('log','diff','test_report','report','file'))`
  - `path text`
  - `content_type text`
  - `size_bytes bigint`
  - `metadata jsonb`
  - `created_at timestamptz`

- `events`
  - `id bigserial pk`
  - `run_id uuid fk -> orchestrator_runs.id`
  - `task_id uuid fk -> tasks.id null`
  - `agent_run_id uuid fk -> agent_runs.id null`
  - `event_type text not null`
  - `payload jsonb not null`
  - `created_at timestamptz`

### Recommended Indexes
- `plans(project_id, version desc)`
- `tasks(graph_id, status)`
- `agent_runs(task_id, created_at desc)`
- `events(run_id, created_at)`
- `artifacts(task_id, kind)`

### Notes
- Keep `canvas_json` and `graph_json` as source-of-truth snapshots for reproducibility.
- Use `events` as an append-only timeline for progress UI and auditing.
- Persist prompt/context snapshots per `agent_runs` for deterministic replay/debugging.
