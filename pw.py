#!/usr/bin/env python3
"""Parallel Worlds for Software (v1 CLI)."""

import argparse

from parallel_worlds.commands import (
    autopilot_worlds,
    build_report,
    init_workspace,
    kickoff_worlds,
    list_objects,
    play_branchpoint,
    print_status,
    refork_world,
    run_branchpoint,
    select_world,
)
from parallel_worlds.common import ensure_git_repo, relative_to_repo
from parallel_worlds.config import load_config
from parallel_worlds.state import (
    ensure_metadata_dirs,
    get_latest_branchpoint,
    list_branchpoints,
    load_branchpoint,
    load_codex_run,
    load_render,
    load_run,
    load_world,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Parallel Worlds for Software (v1 CLI)")
    sub = parser.add_subparsers(dest="cmd")

    init_p = sub.add_parser("init", help="initialize config + metadata")
    init_p.add_argument("-c", "--config", default="parallel_worlds.json")
    init_p.add_argument("--force", action="store_true", help="overwrite existing config")

    kickoff_p = sub.add_parser("kickoff", help="create a branchpoint and worlds")
    kickoff_p.add_argument("-c", "--config", default="parallel_worlds.json")
    kickoff_p.add_argument("--intent", required=True, help="goal/task for this branchpoint")
    kickoff_p.add_argument("--count", type=int, help="number of worlds")
    kickoff_p.add_argument("--from-ref", help="git ref to branch from (default: current branch)")
    kickoff_p.add_argument(
        "--strategy",
        action="append",
        help="world strategy as 'name::notes' (repeat flag for multiple)",
    )

    run_p = sub.add_parser("run", help="run configured runner in worlds and capture traces")
    run_p.add_argument("-c", "--config", default="parallel_worlds.json")
    run_p.add_argument("--branchpoint", help="branchpoint id (default: latest)")
    run_p.add_argument("--skip-runner", action="store_true", help="skip command execution")
    run_p.add_argument("--skip-codex", action="store_true", help="skip codex implementation stage")
    run_p.add_argument(
        "--world",
        action="append",
        help="run a subset of worlds by id/slug/name/branch (repeat flag)",
    )

    play_p = sub.add_parser("play", help="run per-world render/playback command and capture execution logs")
    play_p.add_argument("-c", "--config", default="parallel_worlds.json")
    play_p.add_argument("--branchpoint", help="branchpoint id (default: latest)")
    play_p.add_argument(
        "--world",
        action="append",
        help="play a subset of worlds by id/slug/name/branch (repeat flag)",
    )
    play_p.add_argument("--render-command", help="override config render command for this run")
    play_p.add_argument("--timeout", type=int, help="override render timeout seconds")
    play_p.add_argument("--preview-lines", type=int, help="override console preview line count")

    report_p = sub.add_parser("report", help="build markdown report")
    report_p.add_argument("-c", "--config", default="parallel_worlds.json")
    report_p.add_argument("--branchpoint", help="branchpoint id (default: latest)")

    status_p = sub.add_parser("status", help="show status for a branchpoint")
    status_p.add_argument("-c", "--config", default="parallel_worlds.json")
    status_p.add_argument("--branchpoint", help="branchpoint id (default: latest)")

    list_p = sub.add_parser("list", help="list branchpoints (and optional worlds)")
    list_p.add_argument("-c", "--config", default="parallel_worlds.json")
    list_p.add_argument("--worlds", action="store_true", help="include worlds per branchpoint")

    select_p = sub.add_parser("select", help="select a winning world and optionally merge")
    select_p.add_argument("-c", "--config", default="parallel_worlds.json")
    select_p.add_argument("--branchpoint", help="branchpoint id (default: latest)")
    select_p.add_argument("--world", required=True, help="world id/slug/name/branch")
    select_p.add_argument("--target-branch", help="merge target branch")
    select_p.add_argument("--merge", action="store_true", help="perform merge immediately")

    refork_p = sub.add_parser("refork", help="fork a new branchpoint from an existing world branch")
    refork_p.add_argument("-c", "--config", default="parallel_worlds.json")
    refork_p.add_argument("--branchpoint", help="source branchpoint id (default: latest)")
    refork_p.add_argument("--world", required=True, help="source world id/slug/name/branch")
    refork_p.add_argument("--intent", required=True, help="new branchpoint intent")
    refork_p.add_argument("--count", type=int, help="number of worlds")
    refork_p.add_argument(
        "--strategy",
        action="append",
        help="world strategy as 'name::notes' (repeat flag for multiple)",
    )

    auto_p = sub.add_parser("autopilot", help="prompt-driven kickoff + optional run/play workflow")
    auto_p.add_argument("-c", "--config", default="parallel_worlds.json")
    auto_p.add_argument("--prompt", required=True, help="task prompt/intent")
    auto_p.add_argument("--count", type=int, help="number of worlds")
    auto_p.add_argument("--from-ref", help="git ref to branch from (default: current branch)")
    auto_p.add_argument(
        "--strategy",
        action="append",
        help="world strategy as 'name::notes' (repeat flag for multiple)",
    )
    auto_p.add_argument("--no-run", action="store_true", help="only kickoff, skip run stage")
    auto_p.add_argument("--play", action="store_true", help="run play/render after run stage")
    auto_p.add_argument("--skip-runner", action="store_true", help="skip runner command during run stage")
    auto_p.add_argument("--skip-codex", action="store_true", help="skip codex implementation during run stage")
    auto_p.add_argument("--render-command", help="override render command when --play is used")
    auto_p.add_argument("--timeout", type=int, help="override render timeout when --play is used")
    auto_p.add_argument("--preview-lines", type=int, help="override render preview lines when --play is used")

    web_p = sub.add_parser("web", help="run local web API backend")
    web_p.add_argument("-c", "--config", default="parallel_worlds.json")
    web_p.add_argument("--host", default="127.0.0.1")
    web_p.add_argument("--port", type=int, default=8787)

    args = parser.parse_args()

    if args.cmd == "init":
        init_workspace(config_path=args.config, force=args.force)
        return

    if args.cmd == "kickoff":
        kickoff_worlds(
            config_path=args.config,
            intent=args.intent,
            count=args.count,
            from_ref=args.from_ref,
            cli_strategies=args.strategy,
        )
        return

    if args.cmd == "run":
        run_branchpoint(
            config_path=args.config,
            branchpoint_id=args.branchpoint,
            skip_runner=args.skip_runner,
            skip_codex=args.skip_codex,
            world_filters=args.world,
        )
        return

    if args.cmd == "play":
        play_branchpoint(
            config_path=args.config,
            branchpoint_id=args.branchpoint,
            world_filters=args.world,
            render_command_override=args.render_command,
            timeout_override=args.timeout,
            preview_lines_override=args.preview_lines,
        )
        return

    if args.cmd == "report":
        build_report(config_path=args.config, branchpoint_id=args.branchpoint)
        return

    if args.cmd == "status":
        print_status(config_path=args.config, branchpoint_id=args.branchpoint)
        return

    if args.cmd == "list":
        list_objects(config_path=args.config, show_worlds=args.worlds)
        return

    if args.cmd == "select":
        select_world(
            config_path=args.config,
            branchpoint_id=args.branchpoint,
            world_token=args.world,
            merge=args.merge,
            target_branch=args.target_branch,
        )
        return

    if args.cmd == "refork":
        refork_world(
            config_path=args.config,
            branchpoint_id=args.branchpoint,
            world_token=args.world,
            intent=args.intent,
            count=args.count,
            cli_strategies=args.strategy,
        )
        return

    if args.cmd == "autopilot":
        autopilot_worlds(
            config_path=args.config,
            prompt=args.prompt,
            count=args.count,
            from_ref=args.from_ref,
            cli_strategies=args.strategy,
            run_after_kickoff=not args.no_run,
            play_after_run=args.play,
            skip_runner=args.skip_runner,
            skip_codex=args.skip_codex,
            render_command_override=args.render_command,
            timeout_override=args.timeout,
            preview_lines_override=args.preview_lines,
        )
        return

    if args.cmd == "web":
        import pw_web

        pw_web.serve(config_path=args.config, host=args.host, port=args.port)
        return

    parser.print_help()


if __name__ == "__main__":
    main()
