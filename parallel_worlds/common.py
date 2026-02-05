import copy
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional


def now_utc() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def run_cmd(cmd: List[str], cwd: Optional[str] = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=check)


def run_shell(cmd: str, cwd: str, timeout_sec: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=True,
        shell=True,
        timeout=timeout_sec,
    )


def git(args: List[str], cwd: Optional[str] = None, check: bool = True) -> subprocess.CompletedProcess:
    return run_cmd(["git"] + args, cwd=cwd, check=check)


def repo_root() -> str:
    result = git(["rev-parse", "--show-toplevel"], check=True)
    return result.stdout.strip()


def ensure_git_repo() -> str:
    try:
        return repo_root()
    except subprocess.CalledProcessError:
        die("not a git repository")


def read_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str, payload: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "world"


def is_subpath(path: str, parent: str) -> bool:
    path = os.path.realpath(path)
    parent = os.path.realpath(parent)
    return os.path.commonpath([path, parent]) == parent


def git_common_dir(repo: str) -> str:
    common = git(["rev-parse", "--git-common-dir"], cwd=repo, check=True).stdout.strip()
    if not os.path.isabs(common):
        common = os.path.abspath(os.path.join(repo, common))
    return common


def relative_to_repo(path: str, repo: str) -> str:
    try:
        return os.path.relpath(path, repo)
    except ValueError:
        return path


def branch_exists(name: str, repo: str) -> bool:
    result = git(["show-ref", "--verify", "--quiet", f"refs/heads/{name}"], cwd=repo, check=False)
    return result.returncode == 0


def ref_exists(ref: str, repo: str) -> bool:
    result = git(["rev-parse", "--verify", "--quiet", ref], cwd=repo, check=False)
    return result.returncode == 0


def commit_exists(ref: str, repo: str) -> bool:
    result = git(["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], cwd=repo, check=False)
    return result.returncode == 0


def current_branch(repo: str) -> Optional[str]:
    result = git(["branch", "--show-current"], cwd=repo, check=False)
    value = result.stdout.strip()
    return value or None


def worktree_is_clean(repo: str) -> bool:
    result = git(["status", "--porcelain"], cwd=repo, check=False)
    return result.returncode == 0 and not result.stdout.strip()
