# Symphony Schema Contract (v1)

This folder defines the canonical JSON contracts for Symphony planning and execution.

- `canvas-plan.schema.json`
  - Input from the visual planner.
  - Encodes layers, nodes, edges, cross-layer relations, and orchestrator preferences.
- `compiled-task-graph.schema.json`
  - Output from the plan compiler.
  - Encodes executable tasks, dependencies, orchestration policies, and stage grouping.

Examples:
- `../examples/canvas-plan.example.json`
- `../examples/compiled-task-graph.example.json`

## Compiler Mapping Rules (deterministic v1)

1. Node to task conversion
- Convert every `node.type` in `["module", "component", "screen", "api", "db_model", "workflow", "task"]` into one task.
- Exclude `["vision", "goal", "note"]` from direct task generation.

2. Dependency conversion
- Convert edge relation `depends_on` and `blocks` into `hard_block` dependencies.
- Convert edge relation `informs` into `soft_block` dependencies.
- Ignore `contains` for execution dependencies unless explicitly configured.

3. Capability inference
- `screen`, `ux_flow`, `component` -> `frontend`
- `api`, `workflow` -> `backend`
- `db_model` -> `database`
- Add `testing` to all tasks by default.

4. Priority inference
- `critical` -> `5`
- `high` -> `4`
- `medium` -> `3`
- `low` -> `2`
- Missing priority defaults to `3`.

5. Parallelization rules
- Task is `parallelizable=true` when it has no incoming `hard_block` dependencies.
- Otherwise `parallelizable=false`.

6. Branch/worktree convention
- Branch pattern: `world/<project-slug>/<task_id>`
- Worktree hint pattern: `/tmp/<project-slug>/<task_id>`

7. Acceptance criteria propagation
- Task `acceptance_criteria` comes directly from source node `acceptance_criteria`.
- If empty, compiler must generate at least one objective-aligned criterion.
