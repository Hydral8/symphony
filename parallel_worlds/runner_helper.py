import json
import os


DEFAULT_RUNNER_COMMAND = "python3 .parallel_worlds/runner_auto.py"


FALLBACK_RUNNER_AUTO_SCRIPT = """#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

IGNORE_DIRS = {".git", ".parallel_worlds", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"}


def _has_python_tests(root: Path) -> bool:
    if (root / "pytest.ini").exists() or (root / "pyproject.toml").exists() or (root / "tox.ini").exists():
        return True
    if (root / "tests").is_dir():
        return True
    for path in root.rglob("*_test.py"):
        if any(part in IGNORE_DIRS for part in path.parts):
            continue
        return True
    return False


def _iter_package_json_roots(root: Path):
    candidates = [root]
    for child in root.iterdir():
        if child.is_dir() and child.name not in IGNORE_DIRS:
            candidates.append(child)
    for candidate in candidates:
        pkg = candidate / "package.json"
        if pkg.exists() and pkg.is_file():
            yield candidate, pkg


def _npm_test_command(pkg_root: Path, pkg_file: Path):
    if not shutil.which("npm"):
        return None
    try:
        payload = json.loads(pkg_file.read_text(encoding="utf-8"))
    except Exception:
        return None
    scripts = payload.get("scripts", {})
    if not isinstance(scripts, dict):
        return None
    test_script = scripts.get("test")
    if not isinstance(test_script, str) or not test_script.strip():
        return None
    if pkg_root == Path.cwd():
        return ["npm", "test"]
    return ["npm", "--prefix", str(pkg_root), "test"]


def _choose_command(root: Path):
    if shutil.which("pytest") and _has_python_tests(root):
        return ["pytest", "-q"], "pytest -q"

    for pkg_root, pkg_file in _iter_package_json_roots(root):
        cmd = _npm_test_command(pkg_root, pkg_file)
        if cmd:
            rel = "." if pkg_root == root else str(pkg_root.relative_to(root))
            return cmd, f"npm test ({rel})"

    if shutil.which("go") and (root / "go.mod").exists():
        return ["go", "test", "./..."], "go test ./..."

    if shutil.which("cargo") and (root / "Cargo.toml").exists():
        return ["cargo", "test", "--quiet"], "cargo test --quiet"

    return None, "no suitable test command detected"


def main() -> int:
    root = Path.cwd()
    cmd, label = _choose_command(root)
    if not cmd:
        print(f"auto-runner: {label}; skipping checks.")
        return 0

    print(f"auto-runner: running {label}")
    env = os.environ.copy()
    env.setdefault("CI", "1")
    result = subprocess.run(cmd, cwd=str(root), env=env)
    print(f"auto-runner: exit={result.returncode}")
    return int(result.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
"""


def _repo_root_for_module() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _source_script_text() -> str:
    repo_root = _repo_root_for_module()
    candidate = os.path.join(repo_root, ".parallel_worlds", "runner_auto.py")
    if os.path.exists(candidate):
        try:
            with open(candidate, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            if text.strip():
                return text
        except OSError:
            pass
    return FALLBACK_RUNNER_AUTO_SCRIPT


def ensure_runner_helper(world_meta_dir: str) -> str:
    os.makedirs(world_meta_dir, exist_ok=True)
    script_path = os.path.join(world_meta_dir, "runner_auto.py")
    text = _source_script_text()
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(text)
    try:
        os.chmod(script_path, 0o755)
    except OSError:
        pass
    return script_path
