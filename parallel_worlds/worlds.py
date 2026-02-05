import os
import shutil
from typing import Any, Dict, List, Optional

from .common import branch_exists, commit_exists, current_branch, die, git, is_subpath


def ensure_base_branch(base_branch: str, repo: str) -> None:
    if not commit_exists(base_branch, repo):
        die(
            f"base branch '{base_branch}' is missing or has no commits. "
            "Create an initial commit before kickoff."
        )


def ensure_worlds_dir(worlds_dir: str, repo: str) -> str:
    abs_worlds = os.path.abspath(os.path.join(repo, worlds_dir))
    if is_subpath(abs_worlds, repo):
        die("worlds_dir must be outside repo to avoid nested worktrees")
    os.makedirs(abs_worlds, exist_ok=True)
    return abs_worlds


def resolve_start_ref(repo: str, base_branch: str, from_ref: Optional[str]) -> str:
    if from_ref:
        if not commit_exists(from_ref, repo):
            die(f"start ref missing or has no commits: {from_ref}")
        return from_ref

    current = current_branch(repo)
    if current and commit_exists(current, repo):
        return current

    if commit_exists(base_branch, repo):
        return base_branch

    die("unable to resolve start ref")
    return ""


def _remove_worktree_path(repo: str, worktree_path: str) -> None:
    git(["worktree", "remove", "--force", worktree_path], cwd=repo, check=False)
    if os.path.exists(worktree_path):
        shutil.rmtree(worktree_path, ignore_errors=True)


def _ensure_existing_worktree_matches(repo: str, worktree_path: str, branch: str, start_ref: str) -> bool:
    probe = git(["-C", worktree_path, "rev-parse", "--is-inside-work-tree"], check=False)
    if probe.returncode != 0:
        _remove_worktree_path(repo, worktree_path)
        return False

    current = git(["-C", worktree_path, "branch", "--show-current"], check=False).stdout.strip()
    if current == branch:
        return True

    status = git(["-C", worktree_path, "status", "--porcelain"], check=False)
    if status.returncode == 0 and not (status.stdout or "").strip():
        if branch_exists(branch, repo):
            checkout = git(["-C", worktree_path, "checkout", branch], check=False)
        else:
            checkout = git(["-C", worktree_path, "checkout", "-b", branch, start_ref], check=False)
        if checkout.returncode == 0:
            return True

    _remove_worktree_path(repo, worktree_path)
    return False


def _add_new_worktree(repo: str, branch: str, start_ref: str, worktree_path: str) -> None:
    def _args() -> List[str]:
        if branch_exists(branch, repo):
            return ["worktree", "add", worktree_path, branch]
        return ["worktree", "add", "-b", branch, worktree_path, start_ref]

    first_args = _args()
    first = git(first_args, cwd=repo, check=False)
    if first.returncode == 0:
        return

    # Recover from stale worktree metadata and retry once.
    git(["worktree", "prune"], cwd=repo, check=False)
    second_args = _args()
    second = git(second_args, cwd=repo, check=False)
    if second.returncode != 0:
        message = (second.stderr or first.stderr or second.stdout or first.stdout or "").strip()
        die(f"failed to add worktree {worktree_path}: {message}")


def add_worktree(branch: str, start_ref: str, worktree_path: str, repo: str) -> None:
    if os.path.exists(worktree_path):
        if os.path.exists(os.path.join(worktree_path, ".git")):
            if _ensure_existing_worktree_matches(repo, worktree_path, branch, start_ref):
                return
        else:
            die(f"worktree path already exists and is not a git worktree: {worktree_path}")

    os.makedirs(os.path.dirname(worktree_path), exist_ok=True)
    _add_new_worktree(repo, branch, start_ref, worktree_path)


def write_world_notes(world_meta_dir: str, world: Dict[str, Any], branchpoint: Dict[str, Any]) -> None:
    os.makedirs(world_meta_dir, exist_ok=True)
    path = os.path.join(world_meta_dir, "WORLD_NOTES.md")
    text = (
        f"# World: {world['name']}\n\n"
        f"- Branchpoint: `{branchpoint['id']}`\n"
        f"- Intent: {branchpoint['intent']}\n"
        f"- Branch: `{world['branch']}`\n"
        f"- Worktree: `{world['worktree']}`\n"
        f"- Created: {world['created_at']}\n\n"
        f"## Strategy\n\n"
        f"{world['notes'] or '(none)'}\n"
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def matches_world_filter(world: Dict[str, Any], filters: Optional[List[str]]) -> bool:
    if not filters:
        return True
    lookup = {
        world.get("id", ""),
        world.get("slug", ""),
        world.get("name", ""),
        world.get("branch", ""),
    }
    return any(f in lookup for f in filters)
