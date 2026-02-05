# How Parallel Worlds Works

This document explains the implemented v1 product in `pw.py` and how each part maps to `prd.md`.

## Core loop

1. Intent is provided with `kickoff --intent "..."`.
2. A branchpoint is created.
3. Multiple worlds are forked as Git branches + worktrees.
4. Optional Codex implementation can run in each world.
5. A shared runner command is executed in each world.
6. A shared render/playback command can be executed in each world.
7. Traces/diffs/playback logs are collected.
8. Comparison reports are generated.
9. User selects a world and optionally merges it.
10. Optional web UI provides browser-based control and artifact viewing.

## Data model

All persistent control-plane state lives at:
`<main-repo-root>/.parallel_worlds`.
This makes the tool usable from any branch/worktree in the same repository.

### Branchpoint

Stored at `parallel_worlds/branchpoints/<branchpoint-id>.json`.

Main fields:
- `id`: unique branchpoint id (`bp-<timestamp>-<intent-slug>`)
- `intent`: user task
- `source_ref`: git ref used for forking
- `base_branch`: branch used for diff comparison and merge target default
- `world_ids`: worlds belonging to the branchpoint
- `selected_world_id`: chosen winner (optional)
- `status`, `created_at`, `last_ran_at`

### World metadata

Stored at `parallel_worlds/worlds/<world-id>.json`.

Main fields:
- `id`, `branchpoint_id`, `index`
- `name`, `notes`, `slug`
- `branch`: actual git branch name
- `worktree`: absolute path to world worktree
- `status`: `ready`, `pass`, `fail`, `error`, `skipped`
- `last_codex_exit_code`, `last_codex_duration_sec`, `last_codex_file`
- `last_exit_code`, `last_duration_sec`, `last_run_file`

### Run record

Stored at `parallel_worlds/runs/<branchpoint-id>/<world-id>.json`.

Main fields:
- runner execution metadata (`started_at`, `finished_at`, `exit_code`, `duration_sec`)
- trace path (`trace_log`)
- diff artifacts (`diff_patch`, `diff_stats`, `changed_files`)
- runtime error (`error`) for timeout/misconfiguration/skips

### Codex run record

Stored at `parallel_worlds/codex_runs/<branchpoint-id>/<world-id>.json`.

Main fields:
- codex command metadata (`codex_command_template`, `codex_command`)
- generated prompt path (`prompt_file`)
- selected skill hints (`skills_used`)
- execution metadata (`exit_code`, `duration_sec`, `log_file`, `error`)

### Render record

Stored at `parallel_worlds/renders/<branchpoint-id>/<world-id>.json`.

Main fields:
- render execution metadata (`started_at`, `finished_at`, `exit_code`, `duration_sec`)
- render command used (`render_command`)
- render log path (`render_log`)
- runtime error (`error`) for timeout/misconfiguration

## World creation flow (`kickoff`)

`kickoff` does the following:

1. Loads config and validates required values.
2. Resolves start ref:
   - `--from-ref` if provided
   - otherwise current checked out branch
   - fallback to `base_branch`
3. Resolves strategies:
   - explicit `--strategy` list if provided
   - else `config.strategies`
   - else infer templates from intent keywords (bug/perf/refactor/general)
4. Creates one branch + worktree per strategy.
5. Writes per-world `WORLD_NOTES.md` under `<worktree>/.parallel_worlds/`.
6. Saves branchpoint/world metadata and marks this branchpoint as latest.

## Runner flow (`run`)

`run` executes Codex + runner in selected worlds:

1. Loads branchpoint (latest by default).
2. Selects all worlds or a `--world` subset.
3. If `config.codex.enabled=true` and not `--skip-codex`:
   - parses repo `AGENTS.md` for available skills
   - generates `<worktree>/.parallel_worlds/CODEX_PROMPT.md`
   - executes `config.codex.command` in the world
   - captures stdout/stderr into `<worktree>/.parallel_worlds/codex.log`
4. Executes `runner.command` with timeout in each world worktree.
5. Captures stdout/stderr into `<worktree>/.parallel_worlds/trace.log`.
6. Captures git diff vs `base_branch` into `diff.patch` and computes diff stats.
7. Writes codex/run records and updates world statuses.
8. Regenerates `report.md`.

## Playback flow (`play`)

`play` executes a render/playback command in selected worlds:

1. Loads branchpoint (latest by default).
2. Selects all worlds or a `--world` subset.
3. Resolves render command from `--render-command` or `config.render.command`.
4. Executes command with timeout in each world worktree.
5. Captures stdout/stderr into `<worktree>/.parallel_worlds/render.log`.
6. Writes render records under shared metadata.
7. Generates `play.md` with per-world execution previews.
8. Refreshes `report.md` with render outcome columns.

## Report generation (`report`)

`report.md` includes:
- Branchpoint metadata (intent/source/base/runner/codex/render)
- Mermaid branch graph
- Ranked comparison table with:
  - codex exit/duration
  - world name and branch
  - status + test exit/duration
  - render exit/duration
  - diff stats (files, added/deleted)
  - prompt/log/trace/render/diff artifact paths
- Selected-world section (if one is selected)

`play.md` includes:
- per-world execution summaries
- render log paths
- tail previews of actual execution output

Ranking heuristic prioritizes:
1. successful run (`exit_code == 0`, no error)
2. fewer errors
3. shorter duration
4. lower code churn

## Selection and merge (`select`)

`select --world <token>`:
- records winner in branchpoint metadata
- refreshes report with selected-world section
- prints merge commands

`select --merge` also performs merge:
- requires clean root repo working tree
- runs:
  - `git checkout <target-branch>`
  - `git merge --no-ff <world-branch>`

## Command summary

- `python3 pw.py init`
- `python3 pw.py kickoff --intent "..."`
- `python3 pw.py run`
- `python3 pw.py run --skip-codex` (tests only)
- `python3 pw.py play`
- `python3 pw.py web`
- `python3 pw.py report`
- `python3 pw.py status`
- `python3 pw.py list [--worlds]`
- `python3 pw.py select --world <world>`

## Mapping to PRD components

- Worlds: implemented with Git branches + worktrees.
- Branchpoints: explicit metadata objects with lifecycle state.
- Execution traces: trace logs + diff artifacts + run metadata.
- Execution playback: per-world render logs + `play.md`.
- Comparison panel (CLI/Markdown v1): generated `report.md` + `play.md`.
- Selection & merge: implemented in `select`.
- Visual interface (v1): local dashboard (`pw_web.py`, launched by `pw.py web`).

## Known v1 boundaries

- Codex stage depends on local Codex CLI configuration.
- No GUI; comparison is markdown/table based.
- Runner executes sequentially, not parallelized.
- No cloud/distributed orchestration (repo-local workflow only).

These boundaries align with the local-first v1 implementation scope while delivering the full branchpoint-to-selection workflow.
