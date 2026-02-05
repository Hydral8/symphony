# Parallel Worlds for Software

`pw.py` is a local CLI that implements the core product loop from `prd.md`:

Intent -> Parallel Worlds -> Execution Traces -> Comparison -> Selection.

It creates Git worktree-based worlds, can run Codex in each world with skill-aware prompts, runs shared harnesses, captures artifacts, and produces chooser-friendly reports.

## What you get

- Branchpoint creation from intent (`kickoff`)
- Multiple isolated world branches/worktrees
- Optional Codex implementation stage per world (`run` with `config.codex.enabled=true`)
- Codex prompt generation with skill hints from repo `AGENTS.md`
- Optional automation directive guidance in world prompts
- Shared runner execution across worlds (`run`)
- Configurable parallel world execution (`execution.max_parallel_worlds`)
- Shared playback/render execution across worlds (`play`)
- Per-world traces, diffs, and structured metadata
- Side-by-side `report.md` with branch graph/ranking plus playback outcomes
- `play.md` with execution previews per world
- World selection and optional merge (`select`)
- Re-fork from any world branch (`refork`)
- Prompt-driven kickoff + run/play orchestration (`autopilot`)
- Shared metadata in `<main-repo-root>/.parallel_worlds` so `run`/`play` works from any branch/worktree
- Local web dashboard + API for kickoff/run/play/select/refork/autopilot (`web`)

## Quick start

0. Ensure your `base_branch` (default `main`) has at least one commit.

1. Configure Codex and runner commands in `parallel_worlds.json`.
2. Create worlds:

```bash
python3 pw.py kickoff --intent "Fix checkout timeout bug"
```

3. Run the shared harness in each world:

```bash
python3 pw.py run
```

Run tests only (no Codex stage):

```bash
python3 pw.py run --skip-codex
```

4. Inspect report:

```bash
cat report.md
```

5. Render/play each world and inspect actual execution:

```bash
python3 pw.py play
cat play.md
```

6. Select winner:

```bash
python3 pw.py select --world <world-id-or-name>
```

Optional browser UI:

```bash
# Terminal 1: API/backend
python3 pw.py web --host 127.0.0.1 --port 8787

# Terminal 2: React/Vite frontend
npm --prefix webapp install
npm --prefix webapp run dev
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173).

Single-server mode (serves built UI from Python server):

```bash
npm --prefix webapp run build
python3 pw.py web --host 127.0.0.1 --port 8787
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

## Docs

- Setup and command reference: `SETUP.md`
- Full architecture and workflow: `HOW_IT_WORKS.md`
- Product requirements: `prd.md`
