#!/usr/bin/env python3
"""API backend for Parallel Worlds Vite/React dashboard."""

import argparse
import io
import json
import mimetypes
import os
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

import pw
from parallel_worlds.runtime_control import (
    apply_task_action,
    append_steering_comment,
    get_task_control,
    list_steering_comments,
)


def _split_worlds(raw: str) -> Optional[List[str]]:
    text = (raw or "").strip()
    if not text:
        return None
    tokens = [x.strip() for x in text.replace(",", " ").split()]
    tokens = [x for x in tokens if x]
    return tokens or None


def _read_text(path: str) -> str:
    if not path or not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def _tail_text(path: str, lines: int) -> str:
    if not path or not os.path.exists(path):
        return ""
    if lines <= 0:
        return ""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        all_lines = f.read().splitlines()
    return "\n".join(all_lines[-lines:])


def _run_action(fn, *args, **kwargs) -> Tuple[bool, str]:
    out = io.StringIO()
    err = io.StringIO()
    ok = True
    try:
        with redirect_stdout(out), redirect_stderr(err):
            fn(*args, **kwargs)
    except SystemExit:
        pass
    except Exception:
        ok = False
        traceback.print_exc(file=err)

    output = (out.getvalue() + err.getvalue()).strip()
    if "error:" in output.lower():
        ok = False
    return ok, output


def _parse_task_control_route(path: str) -> Optional[Tuple[str, str]]:
    raw = unquote((path or "").split("?", 1)[0])
    parts = [x for x in raw.split("/") if x]
    task_id = ""
    action = ""

    if len(parts) == 5 and parts[0] == "api" and parts[1] == "v1" and parts[2] == "tasks":
        task_id = parts[3].strip()
        action = parts[4].strip()
    elif len(parts) == 3 and parts[0] == "tasks":
        task_id = parts[1].strip()
        action = parts[2].strip()
    else:
        return None

    if action not in {"pause", "resume", "stop", "steer"}:
        return None
    if not task_id:
        return None
    return task_id, action


def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _fmt_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _duration_seconds(start: Optional[datetime], end: Optional[datetime]) -> Optional[float]:
    if start is None or end is None:
        return None
    return max(round((end - start).total_seconds(), 2), 0.0)


def _map_task_status(world: Dict[str, Any], run: Optional[Dict[str, Any]]) -> str:
    run_started = bool((run or {}).get("started_at"))
    run_finished = bool((run or {}).get("finished_at"))
    if run_started and not run_finished:
        return "running"

    if run:
        if run.get("exit_code") == 0 and not run.get("error"):
            return "done"
        if run.get("error") and run.get("exit_code") is None:
            return "blocked"
        if run.get("exit_code") not in (None, 0):
            return "failed"

    world_status = str(world.get("status", "ready")).strip().lower()
    if world_status == "pass":
        return "done"
    if world_status in {"fail", "error"}:
        return "failed"
    if world_status == "skipped":
        return "blocked"
    return "pending"


def _sort_worlds(worlds: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(worlds, key=lambda row: (int(row.get("index", 0)), str(row.get("id", ""))))


def _build_run_tasks(repo: str, run_id: str, world_ids: List[str]) -> List[Dict[str, Any]]:
    tasks: List[Dict[str, Any]] = []
    worlds = [pw.load_world(repo, world_id) for world_id in world_ids]
    for world in _sort_worlds(worlds):
        task_id = str(world.get("id", ""))
        run = pw.load_run(repo, run_id, task_id)
        codex = pw.load_codex_run(repo, run_id, task_id)
        render = pw.load_render(repo, run_id, task_id)
        status = _map_task_status(world, run)
        tasks.append(
            {
                "task_id": task_id,
                "label": str(world.get("name", task_id)),
                "status": status,
                "world_index": world.get("index"),
                "branch": world.get("branch"),
                "worktree": world.get("worktree"),
                "started_at": (run or {}).get("started_at"),
                "finished_at": (run or {}).get("finished_at"),
                "run_exit_code": (run or {}).get("exit_code"),
                "run_error": (run or {}).get("error"),
                "world": world,
                "run": run,
                "codex": codex,
                "render": render,
            }
        )
    return tasks


def _build_run_counts(tasks: List[Dict[str, Any]]) -> Dict[str, int]:
    counts = {
        "pending": 0,
        "running": 0,
        "blocked": 0,
        "done": 0,
        "failed": 0,
        "paused": 0,
    }
    for task in tasks:
        status = str(task.get("status", "pending"))
        if status not in counts:
            counts[status] = 0
        counts[status] += 1
    counts["total"] = len(tasks)
    return counts


def _build_run_state(counts: Dict[str, int]) -> str:
    total = int(counts.get("total", 0))
    if total <= 0:
        return "queued"
    done = int(counts.get("done", 0))
    failed = int(counts.get("failed", 0))
    running = int(counts.get("running", 0))
    if done == total:
        return "completed"
    if done + failed == total:
        return "failed" if failed > 0 else "completed"
    if running > 0 or done > 0:
        return "running"
    return "queued"


def _build_run_payload(repo: str, run_id: str) -> Dict[str, Any]:
    branchpoint = pw.load_branchpoint(repo, run_id)
    tasks = _build_run_tasks(repo, run_id, branchpoint.get("world_ids", []))
    counts = _build_run_counts(tasks)

    started_candidates: List[datetime] = []
    finished_candidates: List[datetime] = []
    for field in ("created_at", "last_ran_at"):
        parsed = _parse_timestamp(branchpoint.get(field))
        if parsed:
            started_candidates.append(parsed)
    for task in tasks:
        for record_key in ("run", "codex", "render"):
            record = task.get(record_key) or {}
            started = _parse_timestamp(record.get("started_at"))
            finished = _parse_timestamp(record.get("finished_at"))
            if started:
                started_candidates.append(started)
            if finished:
                finished_candidates.append(finished)

    run_started = min(started_candidates) if started_candidates else None
    run_state = _build_run_state(counts)
    run_finished = max(finished_candidates) if finished_candidates and run_state in {"completed", "failed"} else None
    progress_numerator = int(counts.get("done", 0)) + int(counts.get("failed", 0))
    progress_denominator = int(counts.get("total", 0))
    progress = round((100.0 * progress_numerator / progress_denominator), 2) if progress_denominator else 0.0

    active_agents = 0
    for task in tasks:
        codex = task.get("codex") or {}
        if codex.get("started_at") and not codex.get("finished_at"):
            active_agents += 1

    task_rows: List[Dict[str, Any]] = []
    for task in tasks:
        task_rows.append(
            {
                "task_id": task.get("task_id"),
                "label": task.get("label"),
                "status": task.get("status"),
                "world_index": task.get("world_index"),
                "branch": task.get("branch"),
                "started_at": task.get("started_at"),
                "finished_at": task.get("finished_at"),
                "run_exit_code": task.get("run_exit_code"),
                "run_error": task.get("run_error"),
            }
        )

    return {
        "run_id": run_id,
        "status": run_state,
        "counts": counts,
        "progress_percent": progress,
        "active_agent_count": active_agents,
        "started_at": _fmt_iso(run_started),
        "finished_at": _fmt_iso(run_finished),
        "duration_sec": _duration_seconds(run_started, run_finished),
        "intent": branchpoint.get("intent"),
        "base_branch": branchpoint.get("base_branch"),
        "source_ref": branchpoint.get("source_ref"),
        "tasks": task_rows,
    }


def _build_run_diagram(repo: str, run_id: str) -> Dict[str, Any]:
    branchpoint = pw.load_branchpoint(repo, run_id)
    tasks = _build_run_tasks(repo, run_id, branchpoint.get("world_ids", []))
    nodes: List[Dict[str, Any]] = []
    for task in tasks:
        nodes.append(
            {
                "task_id": task.get("task_id"),
                "label": task.get("label"),
                "status": task.get("status"),
                "world_index": task.get("world_index"),
                "branch": task.get("branch"),
                "started_at": task.get("started_at"),
                "finished_at": task.get("finished_at"),
            }
        )
    return {"run_id": run_id, "nodes": nodes, "edges": []}


def _build_run_events(repo: str, run_id: str) -> List[Dict[str, Any]]:
    branchpoint = pw.load_branchpoint(repo, run_id)
    tasks = _build_run_tasks(repo, run_id, branchpoint.get("world_ids", []))

    events: List[Dict[str, Any]] = []

    def add_event(
        created_at: Optional[str],
        event_type: str,
        task_id: Optional[str],
        agent_run_id: Optional[str],
        payload: Dict[str, Any],
    ) -> None:
        if not created_at:
            return
        events.append(
            {
                "created_at": created_at,
                "event_type": event_type,
                "run_id": run_id,
                "task_id": task_id,
                "agent_run_id": agent_run_id,
                "payload": payload,
            }
        )

    add_event(
        branchpoint.get("created_at"),
        "run.created",
        None,
        None,
        {"intent": branchpoint.get("intent"), "status": branchpoint.get("status")},
    )
    add_event(
        branchpoint.get("last_ran_at"),
        "run.ran",
        None,
        None,
        {"status": branchpoint.get("status")},
    )
    add_event(
        branchpoint.get("last_played_at"),
        "run.played",
        None,
        None,
        {"status": branchpoint.get("status")},
    )

    for task in tasks:
        task_id = str(task.get("task_id"))
        world = task.get("world") or {}
        run = task.get("run") or {}
        codex = task.get("codex") or {}
        render = task.get("render") or {}
        agent_run_id = f"{task_id}:codex"

        add_event(
            world.get("created_at"),
            "task.created",
            task_id,
            None,
            {"label": task.get("label"), "branch": task.get("branch")},
        )
        add_event(
            codex.get("started_at"),
            "agent.started",
            task_id,
            agent_run_id,
            {"command": codex.get("codex_command"), "model": "codex"},
        )
        add_event(
            codex.get("finished_at"),
            "agent.finished",
            task_id,
            agent_run_id,
            {
                "exit_code": codex.get("exit_code"),
                "duration_sec": codex.get("duration_sec"),
                "error": codex.get("error"),
                "log_file": codex.get("log_file"),
            },
        )
        add_event(
            run.get("started_at"),
            "task.started",
            task_id,
            None,
            {"runner": run.get("runner")},
        )
        add_event(
            run.get("finished_at"),
            "task.finished",
            task_id,
            None,
            {
                "status": task.get("status"),
                "exit_code": run.get("exit_code"),
                "duration_sec": run.get("duration_sec"),
                "error": run.get("error"),
                "trace_log": run.get("trace_log"),
            },
        )
        add_event(
            render.get("started_at"),
            "render.started",
            task_id,
            None,
            {"render_command": render.get("render_command")},
        )
        add_event(
            render.get("finished_at"),
            "render.finished",
            task_id,
            None,
            {
                "exit_code": render.get("exit_code"),
                "duration_sec": render.get("duration_sec"),
                "error": render.get("error"),
                "render_log": render.get("render_log"),
            },
        )

    def event_sort_key(item: Dict[str, Any]) -> Tuple[str, str, str]:
        return (
            str(item.get("created_at", "")),
            str(item.get("event_type", "")),
            str(item.get("task_id", "")),
        )

    events.sort(key=event_sort_key)
    for index, event in enumerate(events, start=1):
        event["id"] = index
    return events


def _extract_run_route(path: str) -> Tuple[Optional[str], Optional[str]]:
    # Supports /api/v1/runs/{run_id} and /runs/{run_id}, with optional suffixes.
    parts = [part for part in path.split("/") if part]
    if not parts:
        return None, None
    if len(parts) >= 3 and parts[0] == "api" and parts[1] == "v1":
        parts = parts[2:]
    if len(parts) < 2 or parts[0] != "runs":
        return None, None
    run_id = parts[1]
    suffix = "/".join(parts[2:]) if len(parts) > 2 else ""
    return run_id, suffix


def _query_bool(query: Dict[str, List[str]], key: str, default: bool) -> bool:
    raw = (query.get(key) or [None])[0]
    if raw is None:
        return default
    value = str(raw).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def _query_int(query: Dict[str, List[str]], key: str, default: int, minimum: int, maximum: int) -> int:
    raw = (query.get(key) or [None])[0]
    if raw is None:
        return default
    try:
        value = int(str(raw))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def _serialize_world_row(repo: str, branchpoint_id: str, world_id: str) -> Dict[str, Any]:
    world = pw.load_world(repo, world_id)
    run = pw.load_run(repo, branchpoint_id, world_id)
    codex = pw.load_codex_run(repo, branchpoint_id, world_id)
    render = pw.load_render(repo, branchpoint_id, world_id)

    def _map_run(record: Optional[Dict[str, Any]], log_key: str) -> Optional[Dict[str, Any]]:
        if not record:
            return None
        log_path = record.get(log_key)
        return {
            "exit_code": record.get("exit_code"),
            "duration_sec": record.get("duration_sec"),
            "error": record.get("error"),
            "log_path": pw.relative_to_repo(log_path, repo) if log_path else None,
            "raw": record,
        }

    codex_row = None
    if codex:
        codex_log = codex.get("log_file")
        codex_row = {
            "exit_code": codex.get("exit_code"),
            "duration_sec": codex.get("duration_sec"),
            "error": codex.get("error"),
            "log_path": pw.relative_to_repo(codex_log, repo) if codex_log else None,
            "prompt_path": pw.relative_to_repo(codex.get("prompt_file"), repo) if codex.get("prompt_file") else None,
            "raw": codex,
        }

    return {
        "world": world,
        "codex": codex_row,
        "run": _map_run(run, "trace_log"),
        "render": _map_run(render, "render_log"),
    }


class ParallelWorldsHandler(BaseHTTPRequestHandler):
    server: "ParallelWorldsServer"

    def _repo(self) -> str:
        return self.server.repo

    def _cfg(self) -> str:
        return self.server.config_path

    def _json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _ok(self, data: Dict[str, Any], status: int = 200) -> None:
        self._json(status, {"ok": True, "data": data})

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"ok": False, "error": {"code": code, "message": message}})

    def _bytes(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, run_id: str, query: Dict[str, List[str]]) -> None:
        repo = self._repo()
        follow = _query_bool(query, "follow", True)
        heartbeat_sec = _query_int(query, "heartbeat", 10, 1, 60)
        poll_ms = _query_int(query, "poll_ms", 1000, 250, 5000)
        since_q = (query.get("since") or [None])[0]

        since = 0
        if since_q is not None:
            try:
                since = max(int(str(since_q)), 0)
            except ValueError:
                since = 0
        elif self.headers.get("Last-Event-ID"):
            try:
                since = max(int(str(self.headers.get("Last-Event-ID"))), 0)
            except ValueError:
                since = 0

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        last_event_id = since
        next_heartbeat_at = time.time() + heartbeat_sec

        while True:
            events = [evt for evt in _build_run_events(repo, run_id) if int(evt.get("id", 0)) > last_event_id]
            for event in events:
                event_id = int(event.get("id", 0))
                body = json.dumps(event, separators=(",", ":"))
                chunk = (
                    f"id: {event_id}\n"
                    f"event: {event.get('event_type', 'message')}\n"
                    f"data: {body}\n\n"
                )
                try:
                    self.wfile.write(chunk.encode("utf-8"))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    return
                last_event_id = event_id
                next_heartbeat_at = time.time() + heartbeat_sec

            if not follow:
                return

            now = time.time()
            if now >= next_heartbeat_at:
                try:
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    return
                next_heartbeat_at = now + heartbeat_sec
            time.sleep(poll_ms / 1000.0)

    def _serve_static(self, path: str) -> bool:
        ui_dist = os.path.realpath(self.server.ui_dist)
        if not os.path.isdir(ui_dist):
            return False

        rel = path.lstrip("/") or "index.html"
        candidate = os.path.realpath(os.path.join(ui_dist, rel))
        if not candidate.startswith(ui_dist):
            return False

        if os.path.isdir(candidate):
            candidate = os.path.join(candidate, "index.html")

        if os.path.isfile(candidate):
            content_type = mimetypes.guess_type(candidate)[0] or "application/octet-stream"
            with open(candidate, "rb") as f:
                self._bytes(200, content_type, f.read())
            return True

        # SPA fallback for route-style paths.
        if "." not in rel:
            index_file = os.path.join(ui_dist, "index.html")
            if os.path.isfile(index_file):
                with open(index_file, "rb") as f:
                    self._bytes(200, "text/html; charset=utf-8", f.read())
                return True
        return False

    def _parse_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        if not raw.strip():
            return {}
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {}
        return data

    def _query(self) -> Dict[str, List[str]]:
        return parse_qs(urlparse(self.path).query)

    def _latest_branchpoint(self) -> Optional[str]:
        return pw.get_latest_branchpoint(self._repo())

    def _resolve_branchpoint(self, requested: Optional[str]) -> Optional[str]:
        return requested or self._latest_branchpoint()

    def do_OPTIONS(self) -> None:
        self._json(204, {})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        repo = self._repo()

        try:
            run_id, run_suffix = _extract_run_route(parsed.path)
            if run_id:
                try:
                    pw.load_branchpoint(repo, run_id)
                except Exception:
                    self._json(404, {"ok": False, "error": f"run not found: {run_id}"})
                    return

                if run_suffix == "":
                    self._json(200, {"ok": True, "data": _build_run_payload(repo, run_id)})
                    return
                if run_suffix == "diagram":
                    self._json(200, {"ok": True, "data": _build_run_diagram(repo, run_id)})
                    return
                if run_suffix == "events":
                    self._sse(run_id, query)
                    return

                self._json(404, {"ok": False, "error": f"unknown run route: {run_suffix}"})
                return

            if parsed.path == "/api/health":
                self._json(
                    200,
                    {
                        "ok": True,
                        "repo": repo,
                        "config": self._cfg(),
                        "latest_branchpoint": self._latest_branchpoint(),
                    },
                )
                return

            if parsed.path == "/api/branchpoints":
                rows = pw.list_branchpoints(repo)
                self._json(200, {"ok": True, "items": rows, "latest": self._latest_branchpoint()})
                return

            if parsed.path == "/api/dashboard":
                requested = (query.get("branchpoint") or [None])[0]
                bp_id = self._resolve_branchpoint(requested)
                items = pw.list_branchpoints(repo)
                payload: Dict[str, Any] = {
                    "ok": True,
                    "repo": repo,
                    "config": self._cfg(),
                    "latest_branchpoint": self._latest_branchpoint(),
                    "branchpoints": items,
                    "selected_branchpoint": bp_id,
                    "branchpoint": None,
                    "world_rows": [],
                }

                if bp_id:
                    bp = pw.load_branchpoint(repo, bp_id)
                    payload["branchpoint"] = bp
                    rows = [_serialize_world_row(repo, bp_id, wid) for wid in bp.get("world_ids", [])]
                    rows.sort(key=lambda row: int(row["world"].get("index", 0)))
                    payload["world_rows"] = rows

                self._json(200, payload)
                return

            if parsed.path == "/api/artifact":
                name = (query.get("name") or [""])[0]
                if name not in {"report.md", "play.md"}:
                    self._json(400, {"ok": False, "error": "artifact name must be report.md or play.md"})
                    return
                path = os.path.join(repo, name)
                self._json(
                    200,
                    {
                        "ok": True,
                        "name": name,
                        "path": pw.relative_to_repo(path, repo),
                        "text": _read_text(path),
                    },
                )
                return

            if parsed.path == "/api/log":
                kind = (query.get("kind") or [""])[0]
                branchpoint_id = (query.get("branchpoint") or [""])[0]
                world_id = (query.get("world") or [""])[0]
                tail_n = int((query.get("tail") or ["0"])[0] or "0")
                if not kind or not branchpoint_id or not world_id:
                    self._json(400, {"ok": False, "error": "kind, branchpoint, world are required"})
                    return

                record: Optional[Dict[str, Any]] = None
                path = ""
                if kind == "run":
                    record = pw.load_run(repo, branchpoint_id, world_id)
                    path = (record or {}).get("trace_log", "")
                elif kind == "render":
                    record = pw.load_render(repo, branchpoint_id, world_id)
                    path = (record or {}).get("render_log", "")
                elif kind == "codex":
                    record = pw.load_codex_run(repo, branchpoint_id, world_id)
                    path = (record or {}).get("log_file", "")
                else:
                    self._json(400, {"ok": False, "error": "kind must be run|render|codex"})
                    return

                text = _tail_text(path, tail_n) if tail_n > 0 else _read_text(path)
                self._json(
                    200,
                    {
                        "ok": True,
                        "kind": kind,
                        "branchpoint": branchpoint_id,
                        "world": world_id,
                        "path": pw.relative_to_repo(path, repo) if path else None,
                        "text": text,
                        "record": record,
                    },
                )
                return

            if self._serve_static(parsed.path):
                return

            self._json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self._json(500, {"ok": False, "error": str(exc), "traceback": traceback.format_exc()})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        repo = self._repo()
        cfg = self._cfg()

        control_route = _parse_task_control_route(parsed.path)
        if control_route:
            try:
                task_id, action = control_route
                body = self._parse_json_body()

                if action == "steer":
                    comment = str(body.get("comment", "")).strip()
                    prompt_patch = str(body.get("prompt_patch", "")).strip()
                    author = str(body.get("author", "operator")).strip() or "operator"
                    if not comment and not prompt_patch:
                        self._error(400, "INVALID_REQUEST", "comment or prompt_patch is required")
                        return
                    row = append_steering_comment(
                        repo=repo,
                        task_id=task_id,
                        comment=comment,
                        prompt_patch=prompt_patch,
                        author=author,
                    )
                    control = get_task_control(repo, task_id)
                    steering = list_steering_comments(repo, task_id, limit=20)
                    self._ok(
                        {
                            "task_id": task_id,
                            "action": action,
                            "control": control,
                            "steering": row,
                            "steering_total": steering.get("total", 0),
                        }
                    )
                    return

                result = apply_task_action(repo=repo, task_id=task_id, action=action)
                if not result.get("ok"):
                    self._error(
                        int(result.get("status_code", 400)),
                        str(result.get("error_code", "CONTROL_ERROR")),
                        str(result.get("message", "control action failed")),
                    )
                    return
                data = result.get("data") if isinstance(result.get("data"), dict) else {}
                self._ok(data, status=int(result.get("status_code", 200)))
                return
            except Exception as exc:
                self._error(500, "INTERNAL_ERROR", str(exc))
                return

        if not parsed.path.startswith("/api/action/"):
            self._json(404, {"ok": False, "error": "not found"})
            return

        try:
            body = self._parse_json_body()
            action = parsed.path.rsplit("/", 1)[-1]

            if action == "kickoff":
                intent = str(body.get("intent", "")).strip()
                if not intent:
                    self._json(400, {"ok": False, "error": "intent is required"})
                    return
                count_raw = body.get("count")
                count = int(count_raw) if count_raw not in (None, "") else None
                from_ref = str(body.get("from_ref", "")).strip() or None
                strategies = body.get("strategies")
                cli_strategies = None
                if isinstance(strategies, list):
                    cli_strategies = [str(x).strip() for x in strategies if str(x).strip()]

                ok, output = _run_action(
                    pw.kickoff_worlds,
                    config_path=cfg,
                    intent=intent,
                    count=count,
                    from_ref=from_ref,
                    cli_strategies=cli_strategies,
                )
                self._json(200 if ok else 400, {"ok": ok, "output": output, "latest_branchpoint": pw.get_latest_branchpoint(repo)})
                return

            if action == "run":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or None
                world_filters = _split_worlds(str(body.get("worlds", "")))
                skip_runner = bool(body.get("skip_runner", False))
                skip_codex = bool(body.get("skip_codex", False))
                ok, output = _run_action(
                    pw.run_branchpoint,
                    config_path=cfg,
                    branchpoint_id=branchpoint_id,
                    skip_runner=skip_runner,
                    skip_codex=skip_codex,
                    world_filters=world_filters,
                )
                self._json(200 if ok else 400, {"ok": ok, "output": output})
                return

            if action == "play":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or None
                world_filters = _split_worlds(str(body.get("worlds", "")))
                render_command = str(body.get("render_command", "")).strip() or None
                timeout_raw = body.get("timeout")
                timeout = int(timeout_raw) if timeout_raw not in (None, "") else None
                preview_raw = body.get("preview_lines")
                preview = int(preview_raw) if preview_raw not in (None, "") else None

                ok, output = _run_action(
                    pw.play_branchpoint,
                    config_path=cfg,
                    branchpoint_id=branchpoint_id,
                    world_filters=world_filters,
                    render_command_override=render_command,
                    timeout_override=timeout,
                    preview_lines_override=preview,
                )
                self._json(200 if ok else 400, {"ok": ok, "output": output})
                return

            if action == "select":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or None
                world = str(body.get("world", "")).strip()
                if not world:
                    self._json(400, {"ok": False, "error": "world is required"})
                    return
                target_branch = str(body.get("target_branch", "")).strip() or None
                merge = bool(body.get("merge", False))
                ok, output = _run_action(
                    pw.select_world,
                    config_path=cfg,
                    branchpoint_id=branchpoint_id,
                    world_token=world,
                    merge=merge,
                    target_branch=target_branch,
                )
                self._json(200 if ok else 400, {"ok": ok, "output": output})
                return

            if action == "refork":
                branchpoint_id = str(body.get("branchpoint", "")).strip() or None
                world = str(body.get("world", "")).strip()
                intent = str(body.get("intent", "")).strip()
                if not world:
                    self._json(400, {"ok": False, "error": "world is required"})
                    return
                if not intent:
                    self._json(400, {"ok": False, "error": "intent is required"})
                    return
                count_raw = body.get("count")
                count = int(count_raw) if count_raw not in (None, "") else None
                strategies = body.get("strategies")
                cli_strategies = None
                if isinstance(strategies, list):
                    cli_strategies = [str(x).strip() for x in strategies if str(x).strip()]
                ok, output = _run_action(
                    pw.refork_world,
                    config_path=cfg,
                    branchpoint_id=branchpoint_id,
                    world_token=world,
                    intent=intent,
                    count=count,
                    cli_strategies=cli_strategies,
                )
                self._json(200 if ok else 400, {"ok": ok, "output": output, "latest_branchpoint": pw.get_latest_branchpoint(repo)})
                return

            if action == "autopilot":
                prompt = str(body.get("prompt", "")).strip() or str(body.get("intent", "")).strip()
                if not prompt:
                    self._json(400, {"ok": False, "error": "prompt is required"})
                    return
                count_raw = body.get("count")
                count = int(count_raw) if count_raw not in (None, "") else None
                from_ref = str(body.get("from_ref", "")).strip() or None
                run_after_kickoff = bool(body.get("run", True))
                play_after_run = bool(body.get("play", False))
                skip_runner = bool(body.get("skip_runner", False))
                skip_codex = bool(body.get("skip_codex", False))
                render_command = str(body.get("render_command", "")).strip() or None
                timeout_raw = body.get("timeout")
                timeout = int(timeout_raw) if timeout_raw not in (None, "") else None
                preview_raw = body.get("preview_lines")
                preview = int(preview_raw) if preview_raw not in (None, "") else None
                strategies = body.get("strategies")
                cli_strategies = None
                if isinstance(strategies, list):
                    cli_strategies = [str(x).strip() for x in strategies if str(x).strip()]
                ok, output = _run_action(
                    pw.autopilot_worlds,
                    config_path=cfg,
                    prompt=prompt,
                    count=count,
                    from_ref=from_ref,
                    cli_strategies=cli_strategies,
                    run_after_kickoff=run_after_kickoff,
                    play_after_run=play_after_run,
                    skip_runner=skip_runner,
                    skip_codex=skip_codex,
                    render_command_override=render_command,
                    timeout_override=timeout,
                    preview_lines_override=preview,
                )
                self._json(200 if ok else 400, {"ok": ok, "output": output, "latest_branchpoint": pw.get_latest_branchpoint(repo)})
                return

            self._json(404, {"ok": False, "error": f"unknown action: {action}"})
        except Exception as exc:
            self._json(500, {"ok": False, "error": str(exc), "traceback": traceback.format_exc()})


class ParallelWorldsServer(ThreadingHTTPServer):
    def __init__(self, addr: Tuple[str, int], handler, repo: str, config_path: str, ui_dist: str):
        super().__init__(addr, handler)
        self.repo = repo
        self.config_path = config_path
        self.ui_dist = ui_dist


def serve(config_path: str, host: str, port: int) -> None:
    repo = pw.ensure_git_repo()
    pw.load_config(config_path)
    pw.ensure_metadata_dirs(repo)
    ui_dist = os.path.join(repo, "webapp", "dist")
    server = ParallelWorldsServer((host, port), ParallelWorldsHandler, repo=repo, config_path=config_path, ui_dist=ui_dist)
    print(f"Parallel Worlds API running on http://{host}:{port}", flush=True)
    print(f"Repo: {repo}", flush=True)
    print(f"Config: {config_path}", flush=True)
    if os.path.isdir(ui_dist):
        print(f"Serving built UI: {ui_dist}", flush=True)
    else:
        print("UI build missing: run `npm --prefix webapp run build` or `npm --prefix webapp run dev`.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Parallel Worlds API backend")
    parser.add_argument("-c", "--config", default="parallel_worlds.json")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    serve(config_path=args.config, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
