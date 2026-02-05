import os
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


def add_worktree(branch: str, start_ref: str, worktree_path: str, repo: str) -> None:
    if os.path.exists(worktree_path):
        if os.path.exists(os.path.join(worktree_path, ".git")):
            return
        die(f"worktree path already exists and is not a git worktree: {worktree_path}")

    os.makedirs(os.path.dirname(worktree_path), exist_ok=True)

    if branch_exists(branch, repo):
        git(["worktree", "add", worktree_path, branch], cwd=repo, check=True)
    else:
        git(["worktree", "add", "-b", branch, worktree_path, start_ref], cwd=repo, check=True)


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
