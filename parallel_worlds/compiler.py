import hashlib
import json
import os
import uuid
from typing import Any, Dict, List, Optional, Tuple

from .common import now_utc, slugify

try:
    from jsonschema import Draft202012Validator
except ImportError:  # pragma: no cover - optional dependency
    Draft202012Validator = None


TASK_NODE_TYPES = {
    "module",
    "component",
    "screen",
    "ux_flow",
    "api",
    "db_model",
    "workflow",
    "task",
}

PRIORITY_MAP = {
    "critical": 5,
    "high": 4,
    "medium": 3,
    "low": 2,
}


def _canonical_json(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _sha256(payload: Dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _load_schema(path: str) -> Optional[Dict[str, Any]]:
    if not path or not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _format_schema_error(err) -> str:
    if not err:
        return "unknown schema validation error"
    path = ".".join([str(p) for p in err.path]) if err.path else "$"
    return f"{path}: {err.message}"


def _validate_with_schema(payload: Dict[str, Any], schema: Dict[str, Any]) -> List[str]:
    if Draft202012Validator is None:
        return []
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.path))
    return [_format_schema_error(err) for err in errors]


def _ensure_list(value: Any, name: str, errors: List[str]) -> List[Any]:
    if not isinstance(value, list):
        errors.append(f"{name} must be a list")
        return []
    return value


def _ensure_str(value: Any, name: str, errors: List[str]) -> Optional[str]:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{name} must be a non-empty string")
        return None
    return value


def _minimal_canvas_validation(canvas: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    nodes = _ensure_list(canvas.get("nodes"), "nodes", errors)
    edges = _ensure_list(canvas.get("edges"), "edges", errors)
    for idx, node in enumerate(nodes):
        if not isinstance(node, dict):
            errors.append(f"nodes[{idx}] must be an object")
            continue
        _ensure_str(node.get("id"), f"nodes[{idx}].id", errors)
        _ensure_str(node.get("type"), f"nodes[{idx}].type", errors)
        _ensure_str(node.get("label"), f"nodes[{idx}].label", errors)
        _ensure_str(node.get("summary"), f"nodes[{idx}].summary", errors)
    for idx, edge in enumerate(edges):
        if not isinstance(edge, dict):
            errors.append(f"edges[{idx}] must be an object")
            continue
        _ensure_str(edge.get("source"), f"edges[{idx}].source", errors)
        _ensure_str(edge.get("target"), f"edges[{idx}].target", errors)
        _ensure_str(edge.get("relation"), f"edges[{idx}].relation", errors)
    return errors


def _minimal_layer_validation(canvas: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    layers = _ensure_list(canvas.get("layers"), "layers", errors)
    for lidx, layer in enumerate(layers):
        if not isinstance(layer, dict):
            errors.append(f"layers[{lidx}] must be an object")
            continue
        nodes = _ensure_list(layer.get("nodes"), f"layers[{lidx}].nodes", errors)
        edges = _ensure_list(layer.get("edges"), f"layers[{lidx}].edges", errors)
        for nidx, node in enumerate(nodes):
            if not isinstance(node, dict):
                errors.append(f"layers[{lidx}].nodes[{nidx}] must be an object")
                continue
            _ensure_str(node.get("id"), f"layers[{lidx}].nodes[{nidx}].id", errors)
            _ensure_str(node.get("type"), f"layers[{lidx}].nodes[{nidx}].type", errors)
            _ensure_str(node.get("label"), f"layers[{lidx}].nodes[{nidx}].label", errors)
            _ensure_str(node.get("summary"), f"layers[{lidx}].nodes[{nidx}].summary", errors)
        for eidx, edge in enumerate(edges):
            if not isinstance(edge, dict):
                errors.append(f"layers[{lidx}].edges[{eidx}] must be an object")
                continue
            _ensure_str(edge.get("source"), f"layers[{lidx}].edges[{eidx}].source", errors)
            _ensure_str(edge.get("target"), f"layers[{lidx}].edges[{eidx}].target", errors)
            _ensure_str(edge.get("relation"), f"layers[{lidx}].edges[{eidx}].relation", errors)
    return errors


def _collect_nodes_edges(canvas: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    if "layers" not in canvas:
        nodes = list(canvas.get("nodes") or [])
        edges = list(canvas.get("edges") or [])
        return nodes, edges, {}

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    node_layer: Dict[str, Dict[str, Any]] = {}
    for layer in canvas.get("layers") or []:
        if not isinstance(layer, dict):
            continue
        layer_nodes = layer.get("nodes") or []
        layer_edges = layer.get("edges") or []
        for node in layer_nodes:
            if isinstance(node, dict):
                node_layer[node.get("id")] = layer
                nodes.append(node)
        for edge in layer_edges:
            if isinstance(edge, dict):
                edges.append(edge)
    for edge in canvas.get("cross_layer_edges") or []:
        if isinstance(edge, dict):
            edges.append(edge)
    return nodes, edges, node_layer


def _task_id_for_node(node_id: str) -> str:
    if node_id.startswith("node_"):
        return "task_" + node_id[len("node_") :]
    return "task_" + slugify(node_id)


def _infer_capabilities(node_type: str, layer_kind: Optional[str]) -> List[str]:
    caps = set()
    if node_type in {"screen", "ux_flow", "component"}:
        caps.add("frontend")
    if node_type in {"api", "workflow"}:
        caps.add("backend")
    if node_type == "db_model":
        caps.add("database")
    if not caps:
        if layer_kind == "uxui":
            caps.add("frontend")
        elif layer_kind == "backend":
            caps.add("backend")
        elif layer_kind == "data":
            caps.add("database")
        elif layer_kind == "infra":
            caps.add("infra")
        else:
            caps.add("product")
    caps.add("testing")
    return sorted(caps)


def _infer_size(node: Dict[str, Any]) -> Optional[str]:
    estimate = node.get("estimate") or {}
    if not isinstance(estimate, dict):
        return None
    tshirt = estimate.get("tshirt")
    if tshirt in {"XS", "S", "M", "L", "XL"}:
        return tshirt
    return None


def _budget_for_size(size: Optional[str]) -> Dict[str, int]:
    table = {
        "XS": {"max_attempts": 2, "timeout_sec": 900, "max_input_tokens": 8000, "max_output_tokens": 2000},
        "S": {"max_attempts": 2, "timeout_sec": 1200, "max_input_tokens": 12000, "max_output_tokens": 3000},
        "M": {"max_attempts": 3, "timeout_sec": 1800, "max_input_tokens": 16000, "max_output_tokens": 4000},
        "L": {"max_attempts": 3, "timeout_sec": 2400, "max_input_tokens": 20000, "max_output_tokens": 5000},
        "XL": {"max_attempts": 4, "timeout_sec": 3000, "max_input_tokens": 24000, "max_output_tokens": 6000},
    }
    return table.get(size or "M", table["M"]).copy()


def _build_instructions(node: Dict[str, Any]) -> Optional[str]:
    details = node.get("details_markdown")
    if isinstance(details, str) and details.strip():
        return details.strip()
    ai_context = node.get("ai_context") or {}
    if isinstance(ai_context, dict):
        prompt_intent = ai_context.get("prompt_intent")
        if isinstance(prompt_intent, str) and prompt_intent.strip():
            constraints = ai_context.get("constraints")
            if isinstance(constraints, list) and constraints:
                constraint_text = "; ".join([str(c).strip() for c in constraints if str(c).strip()])
                if constraint_text:
                    return f"{prompt_intent.strip()} Constraints: {constraint_text}."
            return prompt_intent.strip()
    return None


def _build_inputs(node: Dict[str, Any]) -> List[Dict[str, str]]:
    inputs = [{"kind": "node", "value": node.get("id", "")}]
    ai_context = node.get("ai_context") or {}
    if isinstance(ai_context, dict):
        refs = ai_context.get("references")
        if isinstance(refs, list):
            for ref in refs:
                if not isinstance(ref, dict):
                    continue
                kind = ref.get("kind")
                value = ref.get("value")
                if isinstance(kind, str) and isinstance(value, str):
                    item = {"kind": kind, "value": value}
                    note = ref.get("note")
                    if isinstance(note, str) and note.strip():
                        item["note"] = note.strip()
                    inputs.append(item)
    return inputs


def _normalize_acceptance(node: Dict[str, Any]) -> List[str]:
    criteria = node.get("acceptance_criteria")
    if isinstance(criteria, list):
        cleaned = [str(item).strip() for item in criteria if str(item).strip()]
        if cleaned:
            return cleaned
    summary = str(node.get("summary") or "").strip()
    label = str(node.get("label") or "").strip()
    if summary:
        return [f"Objective achieved: {summary}"]
    if label:
        return [f"Objective achieved for {label}"]
    return ["Objective achieved."]


def _build_task(
    node: Dict[str, Any],
    layer: Optional[Dict[str, Any]],
    project_slug: str,
    task_id: str,
) -> Dict[str, Any]:
    node_type = str(node.get("type") or "")
    layer_kind = None
    if isinstance(layer, dict):
        layer_kind = layer.get("kind")
    size = _infer_size(node)
    budget = _budget_for_size(size)
    title = str(node.get("label") or node.get("id") or task_id)
    objective = str(node.get("summary") or node.get("label") or node.get("id") or task_id)
    task = {
        "task_id": task_id,
        "source_node_id": node.get("id"),
        "title": title,
        "objective": objective,
        "acceptance_criteria": _normalize_acceptance(node),
        "priority": PRIORITY_MAP.get(str(node.get("priority") or "").lower(), 3),
        "parallelizable": False,
        "capabilities": _infer_capabilities(node_type, layer_kind),
        "execution": {
            "agent": {"type": "codex", "model": "gpt-5-codex", "temperature": 0.1},
            "workspace": {
                "base_ref": "main",
                "branch": f"world/{project_slug}/{task_id}",
                "worktree_hint": f"/tmp/{project_slug}/{task_id}",
            },
            "budget": budget,
        },
        "status": "pending",
    }
    instructions = _build_instructions(node)
    if instructions:
        task["instructions"] = instructions
    inputs = _build_inputs(node)
    if inputs:
        task["inputs"] = inputs
    tags = node.get("tags")
    if isinstance(tags, list):
        labels = [str(tag).strip() for tag in tags if str(tag).strip()]
        if labels:
            task["labels"] = labels
    if size:
        task["size"] = size
    return task


def _orchestrator_from_canvas(canvas: Dict[str, Any], metadata: Dict[str, Any]) -> Dict[str, Any]:
    prefs = canvas.get("orchestrator_preferences") or {}
    max_parallel = 4
    retry_limit = 2
    quality_gates: List[str] = []
    if isinstance(prefs, dict):
        max_parallel = int(prefs.get("max_parallel_agents") or max_parallel)
        retry_limit = int(prefs.get("retry_limit") or retry_limit)
        gates = prefs.get("quality_gates")
        if isinstance(gates, list):
            quality_gates = [str(g).strip() for g in gates if str(g).strip()]
    target_branch = "main"
    if isinstance(metadata, dict):
        target_branch = str(metadata.get("default_target_branch") or target_branch)
    return {
        "max_parallel_agents": max_parallel,
        "retry_limit": retry_limit,
        "target_branch": target_branch,
        "merge_strategy": "squash",
        "quality_gates": quality_gates,
    }


def compile_plan(
    repo: str,
    plan_record: Dict[str, Any],
    project_record: Optional[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    if not isinstance(plan_record, dict):
        return None, ["plan record must be an object"]

    canvas = plan_record.get("canvas")
    if isinstance(plan_record.get("schema_version"), str) and "layers" in plan_record:
        canvas = plan_record
    if not isinstance(canvas, dict):
        return None, ["plan canvas missing or invalid"]

    metadata = canvas.get("metadata") if isinstance(canvas.get("metadata"), dict) else {}

    errors: List[str] = []
    schema_dir = os.path.join(repo, "symphony", "schemas")
    canvas_schema = _load_schema(os.path.join(schema_dir, "canvas-plan.schema.json"))
    use_schema = canvas_schema is not None and Draft202012Validator is not None
    if use_schema and "layers" in canvas and "schema_version" in canvas:
        errors.extend(_validate_with_schema(canvas, canvas_schema))
    else:
        if "layers" in canvas:
            errors.extend(_minimal_layer_validation(canvas))
        else:
            errors.extend(_minimal_canvas_validation(canvas))

    if errors:
        return None, errors

    nodes, edges, node_layers = _collect_nodes_edges(canvas)

    task_nodes = [node for node in nodes if str(node.get("type")) in TASK_NODE_TYPES]
    task_nodes.sort(key=lambda n: str(n.get("id") or ""))

    project_name = None
    if isinstance(project_record, dict):
        project_name = project_record.get("name")
    if not project_name:
        project_name = metadata.get("name") if isinstance(metadata, dict) else None
    project_slug = slugify(str(project_name or plan_record.get("project_id") or "project"))

    tasks: List[Dict[str, Any]] = []
    node_to_task: Dict[str, str] = {}
    for node in task_nodes:
        node_id = str(node.get("id") or "")
        if not node_id:
            continue
        task_id = _task_id_for_node(node_id)
        node_to_task[node_id] = task_id
        layer = node_layers.get(node_id)
        tasks.append(_build_task(node, layer, project_slug, task_id))

    dependencies: List[Dict[str, Any]] = []
    seen_deps = set()
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        relation = str(edge.get("relation") or "")
        if relation not in {"depends_on", "blocks", "informs"}:
            continue
        source_id = str(edge.get("source") or "")
        target_id = str(edge.get("target") or "")
        if not source_id or not target_id:
            continue
        source_task = node_to_task.get(source_id)
        target_task = node_to_task.get(target_id)
        if not source_task or not target_task:
            continue
        if relation == "depends_on":
            from_task, to_task, dep_type = target_task, source_task, "hard_block"
        elif relation == "blocks":
            from_task, to_task, dep_type = source_task, target_task, "hard_block"
        else:
            from_task, to_task, dep_type = source_task, target_task, "soft_block"
        if from_task == to_task:
            continue
        key = (from_task, to_task, dep_type)
        if key in seen_deps:
            continue
        seen_deps.add(key)
        dep = {"from_task_id": from_task, "to_task_id": to_task, "type": dep_type}
        reason = edge.get("notes")
        if isinstance(reason, str) and reason.strip():
            dep["reason"] = reason.strip()
        dependencies.append(dep)

    dependencies.sort(key=lambda d: (d.get("from_task_id", ""), d.get("to_task_id", ""), d.get("type", "")))

    incoming_hard = {task["task_id"]: 0 for task in tasks}
    for dep in dependencies:
        if dep.get("type") == "hard_block":
            incoming_hard[dep["to_task_id"]] = incoming_hard.get(dep["to_task_id"], 0) + 1
    for task in tasks:
        task_id = task.get("task_id")
        task["parallelizable"] = incoming_hard.get(task_id, 0) == 0

    plan_version = plan_record.get("version") or canvas.get("version") or 1
    source_plan = {
        "project_id": plan_record.get("project_id") or canvas.get("project_id"),
        "plan_id": plan_record.get("id") or plan_record.get("plan_id") or canvas.get("plan_id"),
        "plan_version": plan_version,
        "plan_hash": _sha256(canvas),
    }

    compiled = {
        "schema_version": "1.0",
        "graph_id": str(uuid.uuid4()),
        "compiler_version": "symphony-compiler-0.1.0",
        "compiled_at": now_utc(),
        "source_plan": source_plan,
        "orchestrator": _orchestrator_from_canvas(canvas, metadata),
        "tasks": tasks,
        "dependencies": dependencies,
    }

    graph_schema = _load_schema(os.path.join(schema_dir, "compiled-task-graph.schema.json"))
    if graph_schema and Draft202012Validator is not None:
        graph_errors = _validate_with_schema(compiled, graph_schema)
        if graph_errors:
            return None, graph_errors

    return compiled, []
