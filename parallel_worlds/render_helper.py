import os


DEFAULT_RENDER_COMMAND = "python3 .parallel_worlds/render_auto.py"


FALLBACK_RENDER_AUTO_SCRIPT = """#!/usr/bin/env python3
import datetime
import html
from pathlib import Path

IGNORE_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
MAX_FILES = 36
MAX_README_LINES = 14


def iter_repo_files(root: Path):
    count = 0
    for path in sorted(root.rglob("*")):
        if any(part in IGNORE_DIRS for part in path.parts):
            continue
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if str(rel).startswith(".parallel_worlds/"):
            continue
        yield str(rel)
        count += 1
        if count >= MAX_FILES:
            break


def read_readme(root: Path):
    for name in ("README.md", "readme.md", "README.txt"):
        path = root / name
        if not path.exists() or not path.is_file():
            continue
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return lines[:MAX_README_LINES]
    return []


def build_lines(root: Path):
    lines = []
    lines.append("Parallel Worlds Auto Render")
    lines.append(f"Generated: {datetime.datetime.utcnow().replace(microsecond=0).isoformat()}Z")
    lines.append(f"Repo: {root}")
    lines.append("")
    lines.append("Top files:")
    files = list(iter_repo_files(root))
    if files:
        lines.extend([f"- {item}" for item in files])
    else:
        lines.append("- (no files found)")

    readme = read_readme(root)
    if readme:
        lines.append("")
        lines.append("README preview:")
        lines.extend(readme)
    return lines


def write_svg(lines, output_path: Path):
    width = 1280
    line_height = 20
    pad = 20
    height = max(320, (len(lines) + 3) * line_height + (pad * 2))

    escaped = [html.escape(line, quote=False) for line in lines]
    text_rows = []
    for idx, line in enumerate(escaped):
        y = pad + 28 + idx * line_height
        text_rows.append(
            f'<text x="{pad}" y="{y}" font-family="Menlo, Consolas, monospace" font-size="15" fill="#12333A">{line}</text>'
        )

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
        '<defs>'
        '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0%" stop-color="#E7F8F5"/>'
        '<stop offset="100%" stop-color="#F8F1DA"/>'
        "</linearGradient>"
        "</defs>"
        f'<rect x="0" y="0" width="{width}" height="{height}" fill="url(#bg)"/>'
        f'<rect x="10" y="10" width="{width - 20}" height="{height - 20}" rx="10" fill="#FFFFFFCC" stroke="#C5D8D5"/>'
        + "".join(text_rows)
        + "</svg>"
    )
    output_path.write_text(svg, encoding="utf-8")


def main():
    root = Path.cwd()
    meta = root / ".parallel_worlds"
    meta.mkdir(parents=True, exist_ok=True)
    output = meta / "render-overview.svg"
    lines = build_lines(root)
    write_svg(lines, output)
    print(f"render artifact: {output}")


if __name__ == "__main__":
    main()
"""


def _repo_root_for_module() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _source_script_text() -> str:
    repo_root = _repo_root_for_module()
    candidate = os.path.join(repo_root, ".parallel_worlds", "render_auto.py")
    if os.path.exists(candidate):
        try:
            with open(candidate, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            if text.strip():
                return text
        except OSError:
            pass
    return FALLBACK_RENDER_AUTO_SCRIPT


def ensure_render_helper(world_meta_dir: str) -> str:
    os.makedirs(world_meta_dir, exist_ok=True)
    script_path = os.path.join(world_meta_dir, "render_auto.py")
    text = _source_script_text()
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(text)
    try:
        os.chmod(script_path, 0o755)
    except OSError:
        pass
    return script_path
