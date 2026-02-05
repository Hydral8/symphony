# Parallel Worlds

Parallel Worlds is a local tool for exploring multiple implementation branches ("worlds") for the same intent, then comparing and selecting one.

This README is web-first and focused on clean startup.

## What you can do in web mode

- Create branchpoints and worlds
- Run Codex + test/runner workflows across worlds
- Run render/playback workflows across worlds
- Compare world outcomes and logs
- Select a winning world
- Refork from an existing world
- Use prompt-driven autopilot (`kickoff` + optional `run` + optional `play`)

## Prerequisites

- Python 3.9+
- Git (repo must already have at least one commit on your base branch, usually `main`)
- Node.js + npm

## Required files in repo root

These must exist in the same repo root where you run commands:

- `pw.py`
- `pw_web.py`
- `parallel_worlds/`
- `parallel_worlds.json`
- `webapp/`

## 1) Configure once

```bash
python3 pw.py init -c parallel_worlds.json
```

Then edit `parallel_worlds.json` for your repo:

- `runner.command` for tests/checks
- `codex.enabled` and `codex.command` if using Codex stage
- `render.command` if using `play`
- `execution.workspace_mode: "worktree"` for true parallel branch execution
- `execution.max_parallel_worlds` to cap concurrent branch runs

## 2) Start web app (recommended dev mode)

Terminal 1 (API backend):

```bash
python3 pw.py web --host 127.0.0.1 --port 8787
```

Terminal 2 (React frontend):

```bash
npm --prefix webapp install
npm --prefix webapp run dev
```

Open:

- [http://127.0.0.1:5173](http://127.0.0.1:5173)

Vite proxies `/api` to `127.0.0.1:8787`.

## 3) Optional single-server mode

Build UI once, then let Python serve both API + static UI:

```bash
npm --prefix webapp run build
python3 pw.py web --host 127.0.0.1 --port 8787
```

Open:

- [http://127.0.0.1:8787](http://127.0.0.1:8787)

## 4) First-use flow in the UI

1. Use **Kickoff** or **Prompt Agent** to create worlds.
2. Click **Run Branchpoint**.
3. Click **Play Branchpoint** (if `render.command` is configured).
4. Review logs/artifacts (`report.md`, `play.md`, per-world logs).
5. Select a winner.

## Troubleshooting

- `ModuleNotFoundError: No module named 'pw'`
  - Run from the repo root and use `python3 pw.py web` (not `python3 pw_web.py`).

- `error: not a git repository`
  - Start from inside the target project git repo.

- `UI build missing`
  - Run `npm --prefix webapp run dev` for dev mode, or `npm --prefix webapp run build` for single-server mode.

- `no render command configured`
  - Set `render.command` in `parallel_worlds.json` or pass a render override in UI before playing.

- Port in use
  - Change port, for example:

```bash
python3 pw.py web --host 127.0.0.1 --port 8899
```

## Additional docs

- `SETUP.md` for full CLI references
- `HOW_IT_WORKS.md` for architecture details
- `prd.md` for product framing
