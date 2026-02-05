#!/usr/bin/env python3
"""API backend for Parallel Worlds Vite/React dashboard."""

import argparse
import io
import json
import mimetypes
import os
import traceback
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import pw


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

    def _bytes(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
