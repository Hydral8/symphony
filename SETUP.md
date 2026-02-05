# Setup Guide

## Requirements

- Git (with worktree support)
- Python 3.9+
- Repository must have at least one commit on `base_branch`

## 1) Initialize

From repo root:

```bash
python3 pw.py init -c parallel_worlds.json
```

This creates/refreshes config and initializes metadata storage at:
`<main-repo-root>/.parallel_worlds`.
That path is shared across worktrees, so commands work from any branch/worktree.

If `parallel_worlds.json` already exists and you want to overwrite it:

```bash
python3 pw.py init -c parallel_worlds.json --force
```

## 2) Configure Codex + runner + render commands

Edit `parallel_worlds.json`:

```json
{
  "codex": {
    "enabled": true,
    "command": "codex exec --model gpt-5-codex --sandbox workspace-write --auto-edit --file {prompt_file}",
    "timeout_sec": 900,
    "use_agents_md_skills": true,
    "automation": {
      "enabled": true,
      "name_prefix": "Parallel Worlds"
    }
  },
  "runner": {
    "command": "python3 -m pytest -q",
    "timeout_sec": 300
  },
  "render": {
    "command": "npm run dev:smoke",
    "timeout_sec": 180,
    "preview_lines": 25
  },
  "execution": {
    "max_parallel_worlds": 3
  }
}
```

Notes:
- `codex.enabled=true` makes `pw.py run` call Codex in each world before tests.
- Use `{prompt_file}` in `codex.command`; it resolves to `<worktree>/.parallel_worlds/CODEX_PROMPT.md`.
- If your Codex CLI syntax differs, change only `codex.command`.
- With `use_agents_md_skills=true`, skill hints are inferred from `AGENTS.md`.
- With `automation.enabled=true`, the prompt includes an automation directive template.
- `runner.command` runs inside each world worktree.
- `render.command` runs inside each world worktree and is used for playback/experience comparison.
- `execution.max_parallel_worlds` controls how many worlds run/play concurrently.
- Leave `command` empty if you only want to fork worlds first.

## 3) Create a branchpoint and worlds

```bash
python3 pw.py kickoff --intent "Fix checkout bug"
```

Useful options:

```bash
python3 pw.py kickoff \
  --intent "Reduce search latency" \
  --count 4 \
  --from-ref main
```

Explicit strategies:

```bash
python3 pw.py kickoff \
  --intent "Refactor auth module" \
  --strategy "thin-refactor::Extract module with minimal API churn" \
  --strategy "interface-first::Define interfaces then move internals" \
  --strategy "incremental-migration::Migrate callsites in phases"
```

## 4) Run worlds

Run all worlds in latest branchpoint:

```bash
python3 pw.py run
```

Execution order:
1. Codex implementation stage per world (if enabled)
2. Runner/test stage per world
3. Report rebuild

Run only selected worlds:

```bash
python3 pw.py run --world <world-id-or-name> --world <second-world>
```

Skip runner and only refresh diffs/artifacts:

```bash
python3 pw.py run --skip-runner
```

Skip Codex stage:

```bash
python3 pw.py run --skip-codex
```

## 5) Play/render worlds and inspect execution

Run playback for all worlds in latest branchpoint:

```bash
python3 pw.py play
```

Run playback for specific worlds:

```bash
python3 pw.py play --world <world-id-or-name>
```

Override render command for one session:

```bash
python3 pw.py play --render-command "npm run e2e:preview" --timeout 240
```

Playback markdown output:

```bash
cat play.md
```

## 6) Compare and inspect

Rebuild report:

```bash
python3 pw.py report
```

View status:

```bash
python3 pw.py status
```

List branchpoints:

```bash
python3 pw.py list
```

List branchpoints + worlds:

```bash
python3 pw.py list --worlds
```

## 7) Prompt-driven autopilot + refork

Kickoff + run with one prompt:

```bash
python3 pw.py autopilot --prompt "Fix checkout timeout bug and harden retries"
```

Kickoff + run + play:

```bash
python3 pw.py autopilot --prompt "Improve search performance" --play
```

Fork a new branchpoint from an existing world branch:

```bash
python3 pw.py refork --branchpoint <bp-id> --world <world-id-or-name> --intent "Try a different architecture"
```

## 8) Run as a web app

Launch local dashboard:

```bash
# Terminal 1: API/backend
python3 pw.py web --host 127.0.0.1 --port 8787

# Terminal 2: React/Vite frontend
npm --prefix webapp install
npm --prefix webapp run dev
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173).

Optional single-server mode (serve built UI from Python):

```bash
npm --prefix webapp run build
python3 pw.py web --host 127.0.0.1 --port 8787
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

The UI supports:
- kickoff worlds
- run (codex + runner)
- play/render
- select/merge
- refork from a world branch
- prompt-driven autopilot
- viewing `report.md`, `play.md`, and per-world logs

## 9) Select winner

Mark selected world:

```bash
python3 pw.py select --world <world-id-or-name>
```

Select and merge immediately:

```bash
python3 pw.py select --world <world-id-or-name> --merge
```

Optional merge target:

```bash
python3 pw.py select --world <world-id-or-name> --target-branch main --merge
```

## Output locations

- Product metadata: `<main-repo-root>/.parallel_worlds`
  - `branchpoints/<id>.json`
  - `worlds/<world-id>.json`
  - `codex_runs/<branchpoint-id>/<world-id>.json`
  - `runs/<branchpoint-id>/<world-id>.json`
  - `renders/<branchpoint-id>/<world-id>.json`
- Comparison report: `report.md`
- Playback report: `play.md`
- Worktrees: path from `parallel_worlds.json -> worlds_dir` (default `/tmp/parallel_worlds_worlds`)
- Per-world local artifacts: `<worktree>/.parallel_worlds/`
  - `CODEX_PROMPT.md`
  - `codex.log`
  - `WORLD_NOTES.md`
  - `trace.log`
  - `render.log`
  - `diff.patch`

## Operational notes

- Keep `worlds_dir` outside the repo root (required).
- Use `--from-ref` if you want to fork from a branch other than current checkout.
- `select --merge` requires a clean root repo working tree.
