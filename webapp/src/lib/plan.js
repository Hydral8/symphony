import {
  EDGE_RELATIONS,
  LAYER_KINDS,
  NODE_PRIORITIES,
  NODE_STATUSES,
  NODE_TYPES,
  POVS,
} from "./constants";
import { EDGE_ID_RE, LAYER_ID_RE, NODE_ID_RE, UUID_RE, randomId, safeUUID } from "./ids";

export function nowIso() {
  return new Date().toISOString();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parseStrategies(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function asInt(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function statusTone(status) {
  if (status === "pass") return "pass";
  if (status === "fail" || status === "error") return "fail";
  if (status === "played") return "play";
  if (status === "ready") return "ready";
  return "muted";
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "n/a";
  return `${seconds}s`;
}

export function splitLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function defaultPlan() {
  const created = nowIso();
  return {
    schema_version: "1.0",
    project_id: safeUUID(),
    plan_id: safeUUID(),
    version: 1,
    created_at: created,
    updated_at: created,
    metadata: {
      name: "Untitled Plan",
      vision: "Describe the product vision.",
      goals: ["Define goals"],
      default_target_branch: "main",
      constraints: {
        tech_stack: ["python", "react", "postgres"],
        non_functional_requirements: ["Deterministic replay"],
        excluded_paths: ["webapp/node_modules"],
      },
    },
    layers: [
      {
        id: randomId("layer"),
        name: "UI",
        kind: "uxui",
        pov: "design",
        order: 1,
        nodes: [],
        edges: [],
      },
      {
        id: randomId("layer"),
        name: "Modules",
        kind: "module",
        pov: "engineering",
        order: 2,
        nodes: [],
        edges: [],
      },
      {
        id: randomId("layer"),
        name: "Backend",
        kind: "backend",
        pov: "engineering",
        order: 3,
        nodes: [],
        edges: [],
      },
    ],
    cross_layer_edges: [],
    orchestrator_preferences: {
      max_parallel_agents: 4,
      retry_limit: 2,
      quality_gates: ["unit-tests", "lint"],
    },
  };
}

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["Plan is missing or invalid."];
  if (plan.schema_version !== "1.0") errors.push("schema_version must be '1.0'.");
  if (!UUID_RE.test(plan.project_id || "")) errors.push("project_id must be a UUID.");
  if (!UUID_RE.test(plan.plan_id || "")) errors.push("plan_id must be a UUID.");
  if (!Number.isInteger(plan.version) || plan.version < 1) errors.push("version must be an integer >= 1.");
  if (!plan.metadata || typeof plan.metadata !== "object") errors.push("metadata is required.");

  const metadata = plan.metadata || {};
  if (!metadata.name || !String(metadata.name).trim()) errors.push("metadata.name is required.");
  if (!metadata.vision || !String(metadata.vision).trim()) errors.push("metadata.vision is required.");
  if (!Array.isArray(metadata.goals) || metadata.goals.length < 1) errors.push("metadata.goals must have at least 1 item.");

  if (!Array.isArray(plan.layers) || plan.layers.length < 1) errors.push("layers must contain at least one layer.");

  const layerIds = new Set();
  const nodeIds = new Set();

  (plan.layers || []).forEach((layer, idx) => {
    if (!layer || typeof layer !== "object") {
      errors.push(`layers[${idx}] is invalid.`);
      return;
    }
    if (!LAYER_ID_RE.test(layer.id || "")) errors.push(`layer id ${layer.id || "(missing)"} is invalid.`);
    if (!layer.name || !String(layer.name).trim()) errors.push(`layer ${layer.id || idx} name is required.`);
    if (!LAYER_KINDS.includes(layer.kind)) errors.push(`layer ${layer.id || idx} kind is invalid.`);
    if (!POVS.includes(layer.pov)) errors.push(`layer ${layer.id || idx} pov is invalid.`);
    if (!Number.isInteger(layer.order) || layer.order < 1) errors.push(`layer ${layer.id || idx} order must be >= 1.`);
    if (!Array.isArray(layer.nodes)) errors.push(`layer ${layer.id || idx} nodes array is required.`);
    if (!Array.isArray(layer.edges)) errors.push(`layer ${layer.id || idx} edges array is required.`);
    if (layer.id) layerIds.add(layer.id);

    (layer.nodes || []).forEach((node) => {
      if (!NODE_ID_RE.test(node.id || "")) errors.push(`node id ${node.id || "(missing)"} is invalid.`);
      if (!layer.id || node.layer_id !== layer.id) errors.push(`node ${node.id || "(missing)"} layer_id mismatch.`);
      if (!NODE_TYPES.includes(node.type)) errors.push(`node ${node.id || "(missing)"} type is invalid.`);
      if (!node.label || !String(node.label).trim()) errors.push(`node ${node.id || "(missing)"} label is required.`);
      if (!node.summary || !String(node.summary).trim()) errors.push(`node ${node.id || "(missing)"} summary is required.`);
      if (!NODE_STATUSES.includes(node.status)) errors.push(`node ${node.id || "(missing)"} status is invalid.`);
      if (node.priority && !NODE_PRIORITIES.includes(node.priority)) errors.push(`node ${node.id || "(missing)"} priority is invalid.`);
      if (!node.position || typeof node.position.x !== "number" || typeof node.position.y !== "number") {
        errors.push(`node ${node.id || "(missing)"} position is invalid.`);
      }
      if (!node.size || typeof node.size.w !== "number" || typeof node.size.h !== "number") {
        errors.push(`node ${node.id || "(missing)"} size is invalid.`);
      }
      if (node.size && (node.size.w <= 0 || node.size.h <= 0)) errors.push(`node ${node.id || "(missing)"} size must be > 0.`);
      if (node.id) nodeIds.add(node.id);
    });

    (layer.edges || []).forEach((edge) => {
      if (!EDGE_ID_RE.test(edge.id || "")) errors.push(`edge id ${edge.id || "(missing)"} is invalid.`);
      if (!NODE_ID_RE.test(edge.source || "")) errors.push(`edge ${edge.id || "(missing)"} source is invalid.`);
      if (!NODE_ID_RE.test(edge.target || "")) errors.push(`edge ${edge.id || "(missing)"} target is invalid.`);
      if (!EDGE_RELATIONS.includes(edge.relation)) errors.push(`edge ${edge.id || "(missing)"} relation is invalid.`);
    });
  });

  const crossEdges = plan.cross_layer_edges || [];
  if (!Array.isArray(crossEdges)) {
    errors.push("cross_layer_edges must be an array.");
  } else {
    crossEdges.forEach((edge) => {
      if (!EDGE_ID_RE.test(edge.id || "")) errors.push(`cross edge id ${edge.id || "(missing)"} is invalid.`);
      if (!NODE_ID_RE.test(edge.source || "")) errors.push(`cross edge ${edge.id || "(missing)"} source is invalid.`);
      if (!NODE_ID_RE.test(edge.target || "")) errors.push(`cross edge ${edge.id || "(missing)"} target is invalid.`);
      if (!EDGE_RELATIONS.includes(edge.relation)) errors.push(`cross edge ${edge.id || "(missing)"} relation is invalid.`);
    });
  }

  (plan.layers || []).forEach((layer) => {
    (layer.edges || []).forEach((edge) => {
      if (edge.source && !nodeIds.has(edge.source)) errors.push(`edge ${edge.id || "(missing)"} source node not found.`);
      if (edge.target && !nodeIds.has(edge.target)) errors.push(`edge ${edge.id || "(missing)"} target node not found.`);
    });
  });
  (crossEdges || []).forEach((edge) => {
    if (edge.source && !nodeIds.has(edge.source)) errors.push(`cross edge ${edge.id || "(missing)"} source node not found.`);
    if (edge.target && !nodeIds.has(edge.target)) errors.push(`cross edge ${edge.id || "(missing)"} target node not found.`);
  });

  return errors;
}
