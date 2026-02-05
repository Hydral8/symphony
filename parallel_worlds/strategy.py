import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from .common import die, slugify
from .config import PLACEHOLDER_STRATEGY_NAMES
from .state import branchpoint_file


def strategy_list_is_placeholder(strategies: List[Dict[str, Any]]) -> bool:
    names = set()
    for item in strategies:
        if not isinstance(item, dict):
            return False
        names.add(str(item.get("name", "")).strip())
    return names == PLACEHOLDER_STRATEGY_NAMES


def parse_strategy_arg(raw: str) -> Dict[str, str]:
    if "::" in raw:
        name, notes = raw.split("::", 1)
    else:
        name, notes = raw, ""
    name = name.strip()
    notes = notes.strip()
    if not name:
        die("strategy name cannot be empty")
    return {"name": name, "notes": notes}


def infer_strategy_templates(intent: str) -> List[Tuple[str, str]]:
    lower = intent.lower()

    if any(k in lower for k in ["latency", "performance", "slow", "throughput"]):
        return [
            ("quick-win-perf", "Low-risk performance optimization with minimal surface area changes."),
            ("algorithmic-perf", "Improve algorithmic efficiency and hot paths with measurable speedup."),
            ("cache-and-guard", "Introduce caching and protective limits; verify correctness under load."),
            ("observability-first", "Add instrumentation first, then optimize bottlenecks based on traces."),
        ]

    if any(k in lower for k in ["bug", "fix", "failing", "error", "regression"]):
        return [
            ("surgical-fix", "Smallest code change to resolve the failing behavior safely."),
            ("root-cause-fix", "Resolve root cause and add guard conditions to prevent recurrence."),
            ("defensive-hardening", "Add validation/error handling around failure boundaries."),
            ("fix-plus-tests", "Address bug and strengthen tests for adjacent edge cases."),
        ]

    if any(k in lower for k in ["refactor", "cleanup", "module", "separate"]):
        return [
            ("thin-refactor", "Extract minimal module boundaries while preserving current behavior."),
            ("layered-refactor", "Reorganize into clearer layers and dependency direction."),
            ("interface-first", "Define stable interfaces then move implementation behind them."),
            ("incremental-migration", "Add new module path and migrate usage gradually in small steps."),
        ]

    return [
        ("conservative-path", "Low-risk implementation with minimal changes and fast validation."),
        ("balanced-path", "Moderate refactor for maintainability while satisfying intent."),
        ("ambitious-path", "Higher-upside design exploring broader simplification or performance gains."),
        ("test-driven-path", "Implementation guided by expanded tests and explicit behavior contracts."),
    ]


def normalize_strategy_list(strategies: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for item in strategies:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        notes = str(item.get("notes", "")).strip()
        if not name:
            continue
        out.append({"name": name, "notes": notes})
    return out


def choose_strategies(
    config: Dict[str, Any],
    intent: str,
    count: Optional[int],
    cli_strategies: Optional[List[str]],
) -> List[Dict[str, str]]:
    requested_count = count or int(config.get("default_world_count", 3))
    if requested_count < 1:
        die("world count must be >= 1")

    if cli_strategies:
        chosen = [parse_strategy_arg(x) for x in cli_strategies]
    else:
        cfg_strategies = normalize_strategy_list(config.get("strategies", []))
        if cfg_strategies and not strategy_list_is_placeholder(cfg_strategies):
            chosen = cfg_strategies
        else:
            chosen = []

    if not chosen:
        templates = infer_strategy_templates(intent)
        chosen = [{"name": name, "notes": notes} for name, notes in templates]

    if len(chosen) < requested_count:
        templates = infer_strategy_templates(intent)
        i = 0
        while len(chosen) < requested_count:
            base_name, base_notes = templates[i % len(templates)]
            candidate = f"{base_name}-{len(chosen) + 1}"
            chosen.append({"name": candidate, "notes": base_notes})
            i += 1

    return chosen[:requested_count]


def make_branchpoint_id(intent: str, repo: str) -> str:
    base = f"bp-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{slugify(intent)[:18]}"
    candidate = base
    i = 2
    while os.path.exists(branchpoint_file(repo, candidate)):
        candidate = f"{base}-{i}"
        i += 1
    return candidate
