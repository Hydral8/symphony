import unittest
from contextlib import ExitStack
from unittest.mock import patch

import pw_web


class ProgressEventsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = "/repo"
        self.run_id = "bp-20260205-demo"
        self.branchpoint = {
            "id": self.run_id,
            "intent": "demo intent",
            "status": "ran",
            "created_at": "2026-02-05T12:00:00Z",
            "last_ran_at": "2026-02-05T12:10:00Z",
            "world_ids": ["world-1", "world-2"],
            "base_branch": "main",
            "source_ref": "main",
        }
        self.worlds = {
            "world-1": {
                "id": "world-1",
                "name": "World One",
                "index": 1,
                "branch": "world/demo/1",
                "worktree": "/tmp/world-1",
                "status": "pass",
                "created_at": "2026-02-05T12:01:00Z",
            },
            "world-2": {
                "id": "world-2",
                "name": "World Two",
                "index": 2,
                "branch": "world/demo/2",
                "worktree": "/tmp/world-2",
                "status": "fail",
                "created_at": "2026-02-05T12:01:30Z",
            },
        }
        self.runs = {
            "world-1": {
                "started_at": "2026-02-05T12:02:00Z",
                "finished_at": "2026-02-05T12:05:00Z",
                "exit_code": 0,
                "duration_sec": 180.0,
                "error": None,
                "trace_log": "/tmp/world-1/.parallel_worlds/trace.log",
                "runner": "pytest -q",
            },
            "world-2": {
                "started_at": "2026-02-05T12:03:00Z",
                "finished_at": "2026-02-05T12:07:00Z",
                "exit_code": 1,
                "duration_sec": 240.0,
                "error": None,
                "trace_log": "/tmp/world-2/.parallel_worlds/trace.log",
                "runner": "pytest -q",
            },
        }
        self.codex_runs = {
            "world-1": {
                "started_at": "2026-02-05T12:01:10Z",
                "finished_at": "2026-02-05T12:01:50Z",
                "exit_code": 0,
                "duration_sec": 40.0,
                "error": None,
                "log_file": "/tmp/world-1/.parallel_worlds/codex.log",
                "codex_command": "codex exec",
            },
            "world-2": None,
        }
        self.renders = {"world-1": None, "world-2": None}

    def _patch_loaders(self):
        return [
            patch.object(pw_web.pw, "load_branchpoint", side_effect=lambda repo, run_id: self.branchpoint),
            patch.object(pw_web.pw, "load_world", side_effect=lambda repo, world_id: self.worlds[world_id]),
            patch.object(pw_web.pw, "load_run", side_effect=lambda repo, run_id, world_id: self.runs.get(world_id)),
            patch.object(
                pw_web.pw,
                "load_codex_run",
                side_effect=lambda repo, run_id, world_id: self.codex_runs.get(world_id),
            ),
            patch.object(pw_web.pw, "load_render", side_effect=lambda repo, run_id, world_id: self.renders.get(world_id)),
        ]

    def _call_with_patched_loaders(self, fn):
        with ExitStack() as stack:
            for patcher in self._patch_loaders():
                stack.enter_context(patcher)
            return fn()

    def test_build_run_payload_counts_and_progress(self) -> None:
        payload = self._call_with_patched_loaders(lambda: pw_web._build_run_payload(self.repo, self.run_id))

        self.assertEqual(payload["run_id"], self.run_id)
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["counts"]["total"], 2)
        self.assertEqual(payload["counts"]["done"], 1)
        self.assertEqual(payload["counts"]["failed"], 1)
        self.assertEqual(payload["progress_percent"], 100.0)

    def test_build_run_diagram_has_nodes(self) -> None:
        diagram = self._call_with_patched_loaders(lambda: pw_web._build_run_diagram(self.repo, self.run_id))

        self.assertEqual(diagram["run_id"], self.run_id)
        self.assertEqual(len(diagram["nodes"]), 2)
        self.assertEqual(diagram["edges"], [])
        node_statuses = {node["task_id"]: node["status"] for node in diagram["nodes"]}
        self.assertEqual(node_statuses["world-1"], "done")
        self.assertEqual(node_statuses["world-2"], "failed")

    def test_build_run_events_orders_and_ids(self) -> None:
        events = self._call_with_patched_loaders(lambda: pw_web._build_run_events(self.repo, self.run_id))

        self.assertGreaterEqual(len(events), 6)
        self.assertEqual(events[0]["id"], 1)
        self.assertTrue(all(int(evt["id"]) == index for index, evt in enumerate(events, start=1)))
        event_types = {evt["event_type"] for evt in events}
        self.assertIn("run.created", event_types)
        self.assertIn("task.finished", event_types)
        self.assertIn("agent.finished", event_types)

    def test_extract_run_route(self) -> None:
        run_id, suffix = pw_web._extract_run_route("/api/v1/runs/demo-id/events")
        self.assertEqual(run_id, "demo-id")
        self.assertEqual(suffix, "events")


if __name__ == "__main__":
    unittest.main()
