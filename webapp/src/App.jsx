import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { postJson } from "./lib/api";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const RUNS_API_PREFIX = `${API_BASE}/api/v1`;
const TASK_STATES = [
  "pending",
  "running",
  "blocked",
  "done",
  "failed",
  "paused",
  "stopped",
];
const LOCAL_STORAGE_KEY = "symphony.canvasPlan.v1.draft";

const LAYER_KINDS = [
  "vision",
  "module",
  "uxui",
  "backend",
  "data",
  "infra",
  "task",
];
const POVS = ["product", "design", "engineering", "ops"];
const NODE_TYPES = [
  "vision",
  "goal",
  "module",
  "component",
  "screen",
  "ux_flow",
  "api",
  "db_model",
  "workflow",
  "task",
  "note",
];
const NODE_STATUSES = ["draft", "validated", "approved", "deprecated"];
const NODE_PRIORITIES = ["low", "medium", "high", "critical"];
const EDGE_RELATIONS = [
  "depends_on",
  "implements",
  "informs",
  "blocks",
  "contains",
  "uses_api",
  "reads_from",
  "writes_to",
  "tests",
];

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const NODE_ID_RE = /^node_[a-zA-Z0-9_-]+$/;
const EDGE_ID_RE = /^edge_[a-zA-Z0-9_-]+$/;
const LAYER_ID_RE = /^layer_[a-zA-Z0-9_-]+$/;

function nowIso() {
  return new Date().toISOString();
}

function safeUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseStrategies(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function asInt(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusTone(status) {
  if (status === "pass") return "pass";
  if (status === "fail" || status === "error") return "fail";
  if (status === "played") return "play";
  if (status === "ready") return "ready";
  return "muted";
}

function runStatusTone(status) {
  if (status === "done" || status === "completed") return "done";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  if (status === "blocked") return "blocked";
  return "pending";
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "n/a";
  return `${seconds}s`;
}

function fmtPct(value) {
  if (value === null || value === undefined || value === "") return "0%";
  const num = Number(value);
  if (!Number.isFinite(num)) return "0%";
  return `${Math.max(0, Math.min(100, Math.round(num)))}%`;
}

function unwrapData(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (Object.prototype.hasOwnProperty.call(payload, "data"))
    return payload.data;
  return payload;
}

function normalizeTaskStatus(raw) {
  const value = String(raw || "pending").toLowerCase();
  if (TASK_STATES.includes(value)) return value;
  if (value === "completed") return "done";
  if (value === "error") return "failed";
  if (value === "queued") return "pending";
  return "pending";
}

function normalizeDiagram(rawDiagram) {
  const diagram = unwrapData(rawDiagram) || {};
  const sourceNodes = Array.isArray(diagram.nodes)
    ? diagram.nodes
    : Array.isArray(diagram.tasks)
      ? diagram.tasks
      : [];
  const sourceEdges = Array.isArray(diagram.edges)
    ? diagram.edges
    : Array.isArray(diagram.dependencies)
      ? diagram.dependencies
      : [];

  const nodes = sourceNodes
    .map((node, index) => {
      const taskId = String(
        node.task_id || node.id || node.key || `task-${index + 1}`,
      );
      return {
        taskId,
        title: String(node.title || node.name || node.label || taskId),
        status: normalizeTaskStatus(node.status),
        priority: node.priority,
        objective: node.objective || node.description || "",
        acceptanceCriteria: Array.isArray(node.acceptance_criteria)
          ? node.acceptance_criteria
          : [],
        logs: node.logs || node.log || node.log_tail || "",
        artifacts: Array.isArray(node.artifacts) ? node.artifacts : [],
        raw: node,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  const edges = sourceEdges
    .map((edge, index) => {
      const from = String(edge.from_task_id || edge.from || edge.source || "");
      const to = String(edge.to_task_id || edge.to || edge.target || "");
      return {
        id: String(edge.id || `edge-${index + 1}`),
        from,
        to,
        raw: edge,
      };
    })
    .filter((edge) => edge.from && edge.to);

  return { nodes, edges };
}

function normalizeArtifacts(rawArtifacts) {
  const payload = unwrapData(rawArtifacts) || {};
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.artifacts)) return payload.artifacts;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function serializeEvent(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { message: String(rawText || "") };
  }
  const payload = unwrapData(parsed) || {};
  const event = payload.event || payload;
  const eventType = String(event.event_type || event.type || "event");
  const taskId =
    event.task_id ||
    event.taskId ||
    event.payload?.task_id ||
    event.payload?.taskId ||
    "";
  const nextStatus = event.status || event.payload?.status || "";
  const createdAt =
    event.created_at || event.timestamp || new Date().toISOString();
  const detail =
    event.message ||
    event.note ||
    event.payload?.message ||
    JSON.stringify(event.payload || payload || {});
  return {
    id: event.id || `${createdAt}-${taskId || "run"}-${eventType}`,
    type: eventType,
    taskId: taskId ? String(taskId) : "",
    status: nextStatus ? normalizeTaskStatus(nextStatus) : "",
    createdAt,
    detail,
    raw: payload,
  };
}

function statusCountsFromNodes(nodes) {
  const counts = {
    pending: 0,
    running: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    paused: 0,
    stopped: 0,
  };
  for (const node of nodes) {
    const key = normalizeTaskStatus(node.status);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function readJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const err =
      payload.error || payload.output || `Request failed (${response.status})`;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
  return payload;
}

function splitLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultPlan() {
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
        name: "Core Layer",
        kind: "module",
        pov: "engineering",
        order: 1,
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

function loadLocalDraft() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["Plan is missing or invalid."];
  if (plan.schema_version !== "1.0")
    errors.push("schema_version must be '1.0'.");
  if (!UUID_RE.test(plan.project_id || ""))
    errors.push("project_id must be a UUID.");
  if (!UUID_RE.test(plan.plan_id || "")) errors.push("plan_id must be a UUID.");
  if (!Number.isInteger(plan.version) || plan.version < 1)
    errors.push("version must be an integer >= 1.");
  if (!plan.metadata || typeof plan.metadata !== "object")
    errors.push("metadata is required.");

  const metadata = plan.metadata || {};
  if (!metadata.name || !String(metadata.name).trim())
    errors.push("metadata.name is required.");
  if (!metadata.vision || !String(metadata.vision).trim())
    errors.push("metadata.vision is required.");
  if (!Array.isArray(metadata.goals) || metadata.goals.length < 1)
    errors.push("metadata.goals must have at least 1 item.");

  if (!Array.isArray(plan.layers) || plan.layers.length < 1)
    errors.push("layers must contain at least one layer.");

  const layerIds = new Set();
  const nodeIds = new Set();

  (plan.layers || []).forEach((layer, idx) => {
    if (!layer || typeof layer !== "object") {
      errors.push(`layers[${idx}] is invalid.`);
      return;
    }
    if (!LAYER_ID_RE.test(layer.id || ""))
      errors.push(`layer id ${layer.id || "(missing)"} is invalid.`);
    if (!layer.name || !String(layer.name).trim())
      errors.push(`layer ${layer.id || idx} name is required.`);
    if (!LAYER_KINDS.includes(layer.kind))
      errors.push(`layer ${layer.id || idx} kind is invalid.`);
    if (!POVS.includes(layer.pov))
      errors.push(`layer ${layer.id || idx} pov is invalid.`);
    if (!Number.isInteger(layer.order) || layer.order < 1)
      errors.push(`layer ${layer.id || idx} order must be >= 1.`);
    if (!Array.isArray(layer.nodes))
      errors.push(`layer ${layer.id || idx} nodes array is required.`);
    if (!Array.isArray(layer.edges))
      errors.push(`layer ${layer.id || idx} edges array is required.`);
    if (layer.id) layerIds.add(layer.id);

    (layer.nodes || []).forEach((node) => {
      if (!NODE_ID_RE.test(node.id || ""))
        errors.push(`node id ${node.id || "(missing)"} is invalid.`);
      if (!layer.id || node.layer_id !== layer.id)
        errors.push(`node ${node.id || "(missing)"} layer_id mismatch.`);
      if (!NODE_TYPES.includes(node.type))
        errors.push(`node ${node.id || "(missing)"} type is invalid.`);
      if (!node.label || !String(node.label).trim())
        errors.push(`node ${node.id || "(missing)"} label is required.`);
      if (!node.summary || !String(node.summary).trim())
        errors.push(`node ${node.id || "(missing)"} summary is required.`);
      if (!NODE_STATUSES.includes(node.status))
        errors.push(`node ${node.id || "(missing)"} status is invalid.`);
      if (node.priority && !NODE_PRIORITIES.includes(node.priority))
        errors.push(`node ${node.id || "(missing)"} priority is invalid.`);
      if (
        !node.position ||
        typeof node.position.x !== "number" ||
        typeof node.position.y !== "number"
      ) {
        errors.push(`node ${node.id || "(missing)"} position is invalid.`);
      }
      if (
        !node.size ||
        typeof node.size.w !== "number" ||
        typeof node.size.h !== "number"
      ) {
        errors.push(`node ${node.id || "(missing)"} size is invalid.`);
      }
      if (node.size && (node.size.w <= 0 || node.size.h <= 0))
        errors.push(`node ${node.id || "(missing)"} size must be > 0.`);
      if (node.id) nodeIds.add(node.id);
    });

    (layer.edges || []).forEach((edge) => {
      if (!EDGE_ID_RE.test(edge.id || ""))
        errors.push(`edge id ${edge.id || "(missing)"} is invalid.`);
      if (!NODE_ID_RE.test(edge.source || ""))
        errors.push(`edge ${edge.id || "(missing)"} source is invalid.`);
      if (!NODE_ID_RE.test(edge.target || ""))
        errors.push(`edge ${edge.id || "(missing)"} target is invalid.`);
      if (!EDGE_RELATIONS.includes(edge.relation))
        errors.push(`edge ${edge.id || "(missing)"} relation is invalid.`);
    });
  });

  const crossEdges = plan.cross_layer_edges || [];
  if (!Array.isArray(crossEdges)) {
    errors.push("cross_layer_edges must be an array.");
  } else {
    crossEdges.forEach((edge) => {
      if (!EDGE_ID_RE.test(edge.id || ""))
        errors.push(`cross edge id ${edge.id || "(missing)"} is invalid.`);
      if (!NODE_ID_RE.test(edge.source || ""))
        errors.push(`cross edge ${edge.id || "(missing)"} source is invalid.`);
      if (!NODE_ID_RE.test(edge.target || ""))
        errors.push(`cross edge ${edge.id || "(missing)"} target is invalid.`);
      if (!EDGE_RELATIONS.includes(edge.relation))
        errors.push(
          `cross edge ${edge.id || "(missing)"} relation is invalid.`,
        );
    });
  }

  (plan.layers || []).forEach((layer) => {
    (layer.edges || []).forEach((edge) => {
      if (edge.source && !nodeIds.has(edge.source))
        errors.push(`edge ${edge.id || "(missing)"} source node not found.`);
      if (edge.target && !nodeIds.has(edge.target))
        errors.push(`edge ${edge.id || "(missing)"} target node not found.`);
    });
  });
  (crossEdges || []).forEach((edge) => {
    if (edge.source && !nodeIds.has(edge.source))
      errors.push(
        `cross edge ${edge.id || "(missing)"} source node not found.`,
      );
    if (edge.target && !nodeIds.has(edge.target))
      errors.push(
        `cross edge ${edge.id || "(missing)"} target node not found.`,
      );
  });

  return errors;
}

function buildExecutionPrompt(plan) {
  const canvas = plan && typeof plan === "object" ? plan : {};
  const metadata =
    canvas.metadata && typeof canvas.metadata === "object"
      ? canvas.metadata
      : {};
  const name = String(metadata.name || "Untitled Plan").trim();
  const version = Number.isInteger(canvas.version) ? canvas.version : 1;
  const lines = [];

  lines.push(`Plan: ${name} (v${version})`);
  if (metadata.vision) lines.push(`Vision: ${String(metadata.vision).trim()}`);

  const goals = Array.isArray(metadata.goals)
    ? metadata.goals.map((goal) => String(goal).trim()).filter(Boolean)
    : [];
  if (goals.length) {
    lines.push("Goals:");
    goals.forEach((goal) => lines.push(`- ${goal}`));
  }

  if (metadata.default_target_branch) {
    lines.push(
      `Target branch: ${String(metadata.default_target_branch).trim()}`,
    );
  }

  const constraints =
    metadata.constraints && typeof metadata.constraints === "object"
      ? metadata.constraints
      : null;
  if (constraints) {
    const techStack = Array.isArray(constraints.tech_stack)
      ? constraints.tech_stack
          .map((item) => String(item).trim())
          .filter(Boolean)
      : [];
    const nonFunctional = Array.isArray(constraints.non_functional_requirements)
      ? constraints.non_functional_requirements
          .map((item) => String(item).trim())
          .filter(Boolean)
      : [];
    if (techStack.length) lines.push(`Tech stack: ${techStack.join(", ")}`);
    if (nonFunctional.length) lines.push(`NFRs: ${nonFunctional.join(", ")}`);
  }

  const layers = Array.isArray(canvas.layers) ? canvas.layers : [];
  const nodeLabels = new Map();

  if (layers.length) {
    lines.push("");
    lines.push("Layers & nodes:");
    layers.forEach((layer) => {
      const layerName = String(layer?.name || "Unnamed layer").trim();
      const layerKind = String(layer?.kind || "unknown").trim();
      const layerPov = String(layer?.pov || "unknown").trim();
      lines.push(`Layer: ${layerName} (${layerKind}/${layerPov})`);
      const nodes = Array.isArray(layer?.nodes) ? layer.nodes : [];
      nodes.forEach((node) => {
        const nodeId = String(node?.id || "").trim();
        const label = String(node?.label || nodeId || "Untitled").trim();
        const nodeType = String(node?.type || "note").trim();
        nodeLabels.set(nodeId, label);
        lines.push(`- ${label} [${nodeType}]`);
        const summary = String(node?.summary || "").trim();
        if (summary) lines.push(`  Summary: ${summary}`);
        const acceptance = Array.isArray(node?.acceptance_criteria)
          ? node.acceptance_criteria
              .map((item) => String(item).trim())
              .filter(Boolean)
          : [];
        if (acceptance.length) {
          lines.push(`  Acceptance: ${acceptance.join("; ")}`);
        }
      });
    });
  }

  const edges = [];
  layers.forEach((layer) => {
    if (Array.isArray(layer?.edges)) edges.push(...layer.edges);
  });
  if (Array.isArray(canvas.cross_layer_edges)) {
    edges.push(...canvas.cross_layer_edges);
  }
  if (edges.length) {
    lines.push("");
    lines.push("Dependencies:");
    edges.forEach((edge) => {
      const sourceId = String(edge?.source || "").trim();
      const targetId = String(edge?.target || "").trim();
      const sourceLabel = nodeLabels.get(sourceId) || sourceId || "unknown";
      const targetLabel = nodeLabels.get(targetId) || targetId || "unknown";
      const relation = String(edge?.relation || "relates_to").trim();
      lines.push(`- ${sourceLabel} -> ${targetLabel} (${relation})`);
      const notes = String(edge?.notes || "").trim();
      if (notes) lines.push(`  Notes: ${notes}`);
    });
  }

  const prefs =
    canvas.orchestrator_preferences &&
    typeof canvas.orchestrator_preferences === "object"
      ? canvas.orchestrator_preferences
      : null;
  if (prefs) {
    const qualityGates = Array.isArray(prefs.quality_gates)
      ? prefs.quality_gates.map((item) => String(item).trim()).filter(Boolean)
      : [];
    lines.push("");
    lines.push("Execution preferences:");
    if (prefs.max_parallel_agents != null)
      lines.push(`- max_parallel_agents: ${prefs.max_parallel_agents}`);
    if (prefs.retry_limit != null)
      lines.push(`- retry_limit: ${prefs.retry_limit}`);
    if (qualityGates.length)
      lines.push(`- quality_gates: ${qualityGates.join(", ")}`);
  }

  lines.push("");
  lines.push(
    "Execute this plan and implement tasks in parallel where dependencies allow.",
  );
  return lines.join("\n");
}

function CanvasNode({ data, selected }) {
  const node = data.node;
  return (
    <div
      className={`canvas-node ${selected ? "selected" : ""} ${data.connectSource ? "connect-source" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="canvas-handle"
      />
      <div className="node-header">
        <span className="node-label">{node.type}</span>
        <span
          className={`badge ${node.status === "completed" ? "success" : "pending"}`}
        >
          {node.status}
        </span>
      </div>
      <div className="node-body">
        <div className="node-title">{node.label}</div>
        <div className="node-summary">{node.summary}</div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="canvas-handle"
      />
    </div>
  );
}

function CanvasPlannerView() {
  const navigate = useNavigate();
  const [plan, setPlan] = useState(() => loadLocalDraft() || defaultPlan());
  const [selectedLayerId, setSelectedLayerId] = useState("all");
  const [selectedPov, setSelectedPov] = useState("all");
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState(null);
  const [connectMode, setConnectMode] = useState({
    active: false,
    scope: "layer",
    relation: "depends_on",
    required: true,
  });
  const [connectFromId, setConnectFromId] = useState(null);
  const [message, setMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [addLayerForm, setAddLayerForm] = useState({
    name: "",
    kind: "module",
    pov: "engineering",
    order: "",
  });
  const [addNodeForm, setAddNodeForm] = useState({
    layerId: "",
    type: "module",
    label: "",
    summary: "",
    status: "draft",
    priority: "medium",
  });

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(plan));
    } catch (err) {
      // ignore persistence errors
    }
  }, [plan]);

  useEffect(() => {
    if (!selectedNodeId) return;
    const exists = plan.layers.some((layer) =>
      layer.nodes.some((node) => node.id === selectedNodeId),
    );
    if (!exists) setSelectedNodeId(null);
  }, [plan, selectedNodeId]);

  useEffect(() => {
    if (!selectedEdgeKey) return;
    const [scope, edgeId] = selectedEdgeKey.split(":");
    const found =
      scope === "cross"
        ? plan.cross_layer_edges.some((edge) => edge.id === edgeId)
        : plan.layers.some((layer) =>
            layer.edges.some((edge) => edge.id === edgeId),
          );
    if (!found) setSelectedEdgeKey(null);
  }, [plan, selectedEdgeKey]);

  const nodeMap = useMemo(() => {
    const map = new Map();
    plan.layers.forEach((layer) => {
      layer.nodes.forEach((node) => map.set(node.id, node));
    });
    return map;
  }, [plan.layers]);

  const filteredLayers = useMemo(() => {
    let layers = plan.layers;
    if (selectedPov !== "all") {
      layers = layers.filter((layer) => layer.pov === selectedPov);
    }
    if (selectedLayerId !== "all") {
      layers = layers.filter((layer) => layer.id === selectedLayerId);
    }
    return layers;
  }, [plan.layers, selectedLayerId, selectedPov]);

  const visibleNodes = useMemo(
    () => filteredLayers.flatMap((layer) => layer.nodes),
    [filteredLayers],
  );
  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((node) => node.id)),
    [visibleNodes],
  );

  const visibleEdges = useMemo(() => {
    const layerEdges = filteredLayers.flatMap((layer) =>
      layer.edges.map((edge) => ({ scope: "layer", layerId: layer.id, edge })),
    );
    const crossEdges = plan.cross_layer_edges.map((edge) => ({
      scope: "cross",
      layerId: null,
      edge,
    }));
    return [...layerEdges, ...crossEdges].filter(
      (entry) =>
        visibleNodeIds.has(entry.edge.source) &&
        visibleNodeIds.has(entry.edge.target),
    );
  }, [filteredLayers, plan.cross_layer_edges, visibleNodeIds]);

  const selectedLayer = useMemo(() => {
    if (selectedLayerId !== "all")
      return plan.layers.find((layer) => layer.id === selectedLayerId) || null;
    return plan.layers[0] || null;
  }, [plan.layers, selectedLayerId]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return nodeMap.get(selectedNodeId) || null;
  }, [nodeMap, selectedNodeId]);

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeKey) return null;
    const [scope, edgeId] = selectedEdgeKey.split(":");
    if (scope === "cross") {
      return {
        scope,
        edge: plan.cross_layer_edges.find((edge) => edge.id === edgeId) || null,
      };
    }
    for (const layer of plan.layers) {
      const match = layer.edges.find((edge) => edge.id === edgeId);
      if (match) return { scope: "layer", layerId: layer.id, edge: match };
    }
    return null;
  }, [selectedEdgeKey, plan.cross_layer_edges, plan.layers]);

  const validationErrors = useMemo(() => validatePlan(plan), [plan]);
  const exportJson = useMemo(() => JSON.stringify(plan, null, 2), [plan]);
  const totalNodes = useMemo(
    () =>
      plan.layers.reduce(
        (sum, layer) => sum + (layer.nodes ? layer.nodes.length : 0),
        0,
      ),
    [plan.layers],
  );
  const planReady = validationErrors.length === 0 && totalNodes > 0;

  function updatePlan(mutator) {
    setPlan((prev) => {
      const base = { ...prev, created_at: prev.created_at || nowIso() };
      const next = mutator(base);
      return { ...next, updated_at: nowIso() };
    });
  }

  function resetDraft() {
    setPlan(defaultPlan());
    setSelectedLayerId("all");
    setSelectedPov("all");
    setSelectedNodeId(null);
    setSelectedEdgeKey(null);
    setConnectFromId(null);
    setMessage("Draft reset to defaults.");
  }

  function clearDraft() {
    try {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    } catch (err) {
      // ignore
    }
    resetDraft();
  }

  function addLayer() {
    if (!addLayerForm.name.trim()) {
      setMessage("Layer name is required.");
      return;
    }
    const newLayer = {
      id: randomId("layer"),
      name: addLayerForm.name.trim(),
      kind: addLayerForm.kind,
      pov: addLayerForm.pov,
      order: addLayerForm.order
        ? Number(addLayerForm.order)
        : plan.layers.length + 1,
      nodes: [],
      edges: [],
    };
    updatePlan((prev) => ({ ...prev, layers: [...prev.layers, newLayer] }));
    setAddLayerForm({
      name: "",
      kind: "module",
      pov: "engineering",
      order: "",
    });
    setMessage("Layer added.");
  }

  function deleteLayer(layerId) {
    const layer = plan.layers.find((item) => item.id === layerId);
    if (!layer) return;
    if (layer.nodes.length > 0) {
      setMessage("Delete nodes in the layer before removing it.");
      return;
    }
    updatePlan((prev) => ({
      ...prev,
      layers: prev.layers.filter((item) => item.id !== layerId),
    }));
    if (selectedLayerId === layerId) setSelectedLayerId("all");
    setMessage("Layer removed.");
  }

  function addNode() {
    const targetLayerId = addNodeForm.layerId || selectedLayer?.id;
    if (!targetLayerId) {
      setMessage("Select a layer before adding a node.");
      return;
    }
    if (!addNodeForm.label.trim() || !addNodeForm.summary.trim()) {
      setMessage("Node label and summary are required.");
      return;
    }
    const newNode = {
      id: randomId("node"),
      layer_id: targetLayerId,
      type: addNodeForm.type,
      label: addNodeForm.label.trim(),
      summary: addNodeForm.summary.trim(),
      position: { x: 120, y: 120 },
      size: { w: 240, h: 120 },
      status: addNodeForm.status,
      priority: addNodeForm.priority,
      tags: [],
      acceptance_criteria: [],
    };
    updatePlan((prev) => ({
      ...prev,
      layers: prev.layers.map((layer) =>
        layer.id === targetLayerId
          ? { ...layer, nodes: [...layer.nodes, newNode] }
          : layer,
      ),
    }));
    setSelectedNodeId(newNode.id);
    setAddNodeForm((form) => ({ ...form, label: "", summary: "" }));
    setMessage("Node added.");
  }

  function deleteNode(nodeId) {
    updatePlan((prev) => {
      const nextLayers = prev.layers.map((layer) => ({
        ...layer,
        nodes: layer.nodes.filter((node) => node.id !== nodeId),
        edges: layer.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
      }));
      const nextCross = prev.cross_layer_edges.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId,
      );
      return { ...prev, layers: nextLayers, cross_layer_edges: nextCross };
    });
    setSelectedNodeId(null);
    setSelectedEdgeKey(null);
    setMessage("Node and connected edges removed.");
  }

  function handleNodeClick(node) {
    if (connectMode.active) {
      if (!connectFromId) {
        setConnectFromId(node.id);
        setMessage("Select a target node to create the edge.");
        return;
      }
      if (connectFromId === node.id) {
        setMessage("Source and target must be different nodes.");
        setConnectFromId(null);
        return;
      }
      const sourceNode = nodeMap.get(connectFromId);
      const targetNode = node;
      if (!sourceNode) {
        setMessage("Source node not found.");
        setConnectFromId(null);
        return;
      }
      if (
        connectMode.scope === "layer" &&
        sourceNode.layer_id !== targetNode.layer_id
      ) {
        setMessage("Layer edges require source and target in the same layer.");
        setConnectFromId(null);
        return;
      }
      const hasDuplicate = (edges) =>
        edges.some(
          (edge) =>
            edge.source === sourceNode.id &&
            edge.target === targetNode.id &&
            edge.relation === connectMode.relation,
        );
      if (
        connectMode.scope === "cross" &&
        hasDuplicate(plan.cross_layer_edges)
      ) {
        setMessage("Duplicate cross-layer edge already exists.");
        setConnectFromId(null);
        return;
      }
      if (connectMode.scope === "layer") {
        const layer = plan.layers.find(
          (item) => item.id === sourceNode.layer_id,
        );
        if (layer && hasDuplicate(layer.edges)) {
          setMessage("Duplicate layer edge already exists.");
          setConnectFromId(null);
          return;
        }
      }
      const newEdge = {
        id: randomId("edge"),
        source: sourceNode.id,
        target: targetNode.id,
        relation: connectMode.relation,
        required: connectMode.required,
      };
      updatePlan((prev) => {
        if (connectMode.scope === "cross") {
          return {
            ...prev,
            cross_layer_edges: [...prev.cross_layer_edges, newEdge],
          };
        }
        return {
          ...prev,
          layers: prev.layers.map((layer) => {
            if (layer.id !== sourceNode.layer_id) return layer;
            return { ...layer, edges: [...layer.edges, newEdge] };
          }),
        };
      });
      setConnectFromId(null);
      setMessage("Edge created.");
      return;
    }
    setSelectedNodeId(node.id);
    setSelectedEdgeKey(null);
  }

  function deleteEdge(scope, edgeId) {
    updatePlan((prev) => {
      if (scope === "cross") {
        return {
          ...prev,
          cross_layer_edges: prev.cross_layer_edges.filter(
            (edge) => edge.id !== edgeId,
          ),
        };
      }
      return {
        ...prev,
        layers: prev.layers.map((layer) => ({
          ...layer,
          edges: layer.edges.filter((edge) => edge.id !== edgeId),
        })),
      };
    });
    setSelectedEdgeKey(null);
    setMessage("Edge removed.");
  }

  function updateEdge(scope, edgeId, patch) {
    updatePlan((prev) => {
      if (scope === "cross") {
        return {
          ...prev,
          cross_layer_edges: prev.cross_layer_edges.map((edge) =>
            edge.id === edgeId ? { ...edge, ...patch } : edge,
          ),
        };
      }
      return {
        ...prev,
        layers: prev.layers.map((layer) => ({
          ...layer,
          edges: layer.edges.map((edge) =>
            edge.id === edgeId ? { ...edge, ...patch } : edge,
          ),
        })),
      };
    });
  }

  function updateNode(nodeId, patch) {
    updatePlan((prev) => ({
      ...prev,
      layers: prev.layers.map((layer) => ({
        ...layer,
        nodes: layer.nodes.map((node) =>
          node.id === nodeId ? { ...node, ...patch } : node,
        ),
      })),
    }));
  }

  function copyExport() {
    navigator.clipboard
      .writeText(exportJson)
      .then(() => setMessage("Export JSON copied to clipboard."))
      .catch(() => setMessage("Unable to copy JSON."));
  }

  async function generateFromCodex() {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const payload = await postJson(`${API_BASE}/api/v1/plans/generate`, {});
      if (!payload || !payload.plan) throw new Error("No plan returned");
      setPlan(payload.plan);
      setSelectedLayerId("all");
      setSelectedPov("all");
      setSelectedNodeId(null);
      setSelectedEdgeKey(null);
      setConnectFromId(null);
      setMessage("Generated plan via Codex CLI.");
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : String(err || "Unknown error");
      const logHint =
        err && err.payload && err.payload.log_path
          ? ` (log: ${err.payload.log_path})`
          : "";
      setMessage(`Codex generation failed: ${messageText}${logHint}`);
    } finally {
      setIsGenerating(false);
    }
  }

  async function executePlan() {
    if (isExecuting) return;
    if (validationErrors.length > 0) {
      setMessage("Resolve validation errors before executing the plan.");
      return;
    }
    if (totalNodes === 0) {
      setMessage("Add at least one node before executing the plan.");
      return;
    }
    setIsExecuting(true);
    try {
      const prompt = buildExecutionPrompt(plan);
      const payload = await postJson(`${API_BASE}/api/action/autopilot`, {
        prompt,
        run: true,
        play: false,
        skip_codex: false,
        skip_runner: false,
      });
      const jobId = payload && payload.job_id ? String(payload.job_id) : "";
      const jobLabel = jobId ? ` (job ${jobId})` : "";
      setMessage(`Execution started${jobLabel}. Check Dashboard for progress.`);
      if (jobId) {
        navigate(`/dashboard?job=${encodeURIComponent(jobId)}`);
      } else {
        navigate("/dashboard");
      }
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : String(err || "Unknown error");
      setMessage(`Plan execution failed: ${messageText}`);
    } finally {
      setIsExecuting(false);
    }
  }

  function downloadExport() {
    const name = (plan.metadata?.name || "plan")
      .toLowerCase()
      .replace(/\s+/g, "-");
    const filename = `${name}-v${plan.version}.json`;
    const blob = new Blob([exportJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setMessage(`Downloaded ${filename}.`);
  }

  return (
    <main className="canvas-root">
      {/* Floating Toolbar */}
      <nav className="glass-panel toolbar-dock animate-slide-up">
        <div className="toolbar-group">
          <span className="eyebrow" style={{ margin: 0 }}>
            Canvas
          </span>
        </div>

        <div className="toolbar-group">
          <button className="btn ghost small" onClick={resetDraft}>
            Reset
          </button>
          <button className="btn ghost small" onClick={clearDraft}>
            Clear
          </button>
        </div>

        <div className="toolbar-group">
          <button
            className="btn ghost small"
            onClick={generateFromCodex}
            disabled={isGenerating}
          >
            {isGenerating ? "Generating..." : "Generate (Codex CLI)"}
          </button>
        </div>

        <div className="toolbar-group">
          <label
            className="flex-center"
            style={{ gap: 6, fontSize: "0.85rem" }}
          >
            <span style={{ color: "var(--ink-muted)" }}>Layer:</span>
            <select
              value={selectedLayerId}
              onChange={(e) => setSelectedLayerId(e.target.value)}
              className="glass"
              style={{
                padding: "4px 8px",
                borderRadius: 6,
                border: "none",
                background: "rgba(255,255,255,0.1)",
              }}
            >
              <option value="all">All Layers</option>
              {plan.layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="toolbar-group">
          <label className="btn ghost small">
            <input
              type="checkbox"
              checked={connectMode.active}
              onChange={(e) => {
                setConnectMode((state) => ({
                  ...state,
                  active: e.target.checked,
                }));
                setConnectFromId(null);
              }}
              style={{ width: "auto", marginRight: 6 }}
            />
            Connect Mode
          </label>
        </div>

        <div className="toolbar-group">
          <button className="btn primary small" onClick={downloadExport}>
            Export JSON
          </button>
        </div>

        <div className="toolbar-group">
          <button
            className="btn accent small"
            onClick={executePlan}
            disabled={!planReady || isExecuting}
          >
            {isExecuting ? "Executing..." : "Execute Plan"}
          </button>
        </div>
      </nav>

      {/* Floating Layer Panel */}
      <aside className="glass-panel layer-dock animate-fade-in">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <span className="eyebrow">Layers</span>
          <button
            className="btn ghost small"
            onClick={addLayer}
            style={{ padding: "4px 8px" }}
          >
            + New
          </button>
        </div>

        <div className="flex-col" style={{ gap: 8 }}>
          {plan.layers.map((layer) => (
            <div
              key={layer.id}
              className={`layer-item ${selectedLayerId === layer.id ? "active" : ""}`}
              onClick={() => setSelectedLayerId(layer.id)}
            >
              <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>
                {layer.name}
              </span>
              <div className="flex-center" style={{ gap: 4 }}>
                <span className="badge pending">{layer.nodes.length}</span>
                <button
                  className="btn ghost small"
                  style={{
                    padding: 2,
                    height: 20,
                    width: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteLayer(layer.id);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>

        <div
          className="glass-panel"
          style={{ padding: 10, marginTop: 12, background: "rgba(0,0,0,0.2)" }}
        >
          <input
            value={addLayerForm.name}
            onChange={(e) =>
              setAddLayerForm((form) => ({ ...form, name: e.target.value }))
            }
            placeholder="New Layer Name..."
            style={{
              marginBottom: 8,
              background: "transparent",
              border: "1px solid var(--line)",
            }}
          />
          <div className="flex-between">
            <select
              value={addLayerForm.kind}
              onChange={(e) =>
                setAddLayerForm((form) => ({ ...form, kind: e.target.value }))
              }
              style={{ width: "48%", padding: 4, fontSize: "0.8rem" }}
            >
              {LAYER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select
              value={addLayerForm.pov}
              onChange={(e) =>
                setAddLayerForm((form) => ({ ...form, pov: e.target.value }))
              }
              style={{ width: "48%", padding: 4, fontSize: "0.8rem" }}
            >
              {POVS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
      </aside>

      {/* Floating Right Dock (Inspector) */}
      <aside
        className="glass-panel layer-dock animate-fade-in"
        style={{
          left: "auto",
          right: 24,
          top: "calc(var(--header-height) + 60px)",
        }}
      >
        {selectedNode ? (
          <div className="flex-col" style={{ gap: 12 }}>
            <div
              className="node-header"
              style={{ padding: 0, border: "none", background: "transparent" }}
            >
              <span className="eyebrow">Inspector</span>
              <button
                className="btn danger small"
                onClick={() => deleteNode(selectedNode.id)}
              >
                Delete Node
              </button>
            </div>

            <input
              value={selectedNode.label}
              onChange={(e) =>
                updateNode(selectedNode.id, { label: e.target.value })
              }
              style={{
                fontSize: "1.1rem",
                fontWeight: 600,
                background: "transparent",
                border: "none",
                padding: 0,
                color: "var(--teal-glow)",
              }}
            />

            <textarea
              value={selectedNode.summary}
              onChange={(e) =>
                updateNode(selectedNode.id, { summary: e.target.value })
              }
              style={{ minHeight: 80, fontSize: "0.9rem", lineHeight: 1.5 }}
            />

            <div className="grid two">
              <label>
                <span className="eyebrow" style={{ fontSize: "0.65rem" }}>
                  Type
                </span>
                <select
                  value={selectedNode.type}
                  onChange={(e) =>
                    updateNode(selectedNode.id, { type: e.target.value })
                  }
                >
                  {NODE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="eyebrow" style={{ fontSize: "0.65rem" }}>
                  Status
                </span>
                <select
                  value={selectedNode.status}
                  onChange={(e) =>
                    updateNode(selectedNode.id, { status: e.target.value })
                  }
                >
                  {NODE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label>
              <span className="eyebrow" style={{ fontSize: "0.65rem" }}>
                Priority
              </span>
              <select
                value={selectedNode.priority || "medium"}
                onChange={(e) =>
                  updateNode(selectedNode.id, { priority: e.target.value })
                }
              >
                {NODE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ marginTop: 8 }}>
              <p className="eyebrow">
                Edges (
                {
                  visibleEdges.filter(
                    (e) =>
                      e.edge.source === selectedNode.id ||
                      e.edge.target === selectedNode.id,
                  ).length
                }
                )
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-col" style={{ gap: 12 }}>
            <span className="eyebrow">Add Node</span>
            <input
              value={addNodeForm.label}
              onChange={(e) =>
                setAddNodeForm((f) => ({ ...f, label: e.target.value }))
              }
              placeholder="Node Label"
            />
            <textarea
              value={addNodeForm.summary}
              onChange={(e) =>
                setAddNodeForm((f) => ({ ...f, summary: e.target.value }))
              }
              placeholder="Objective Summary..."
            />
            <div className="grid two">
              <select
                value={addNodeForm.type}
                onChange={(e) =>
                  setAddNodeForm((f) => ({ ...f, type: e.target.value }))
                }
              >
                {NODE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                value={addNodeForm.priority}
                onChange={(e) =>
                  setAddNodeForm((f) => ({ ...f, priority: e.target.value }))
                }
              >
                {NODE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn primary" onClick={addNode}>
              Create Node
            </button>

            <div
              style={{
                marginTop: 20,
                padding: 10,
                background: "rgba(255,255,255,0.05)",
                borderRadius: 8,
              }}
            >
              <p className="eyebrow">Export Preview</p>
              <div className="flex-between">
                <span className="badge pending" style={{ fontSize: "0.7rem" }}>
                  {validationErrors.length} Errors
                </span>
                <button className="btn small ghost" onClick={copyExport}>
                  Copy
                </button>
              </div>
            </div>
          </div>
        )}
      </aside>

      {message && (
        <div
          className="glass-panel animate-fade-in"
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "12px 24px",
            zIndex: 200,
            color: "var(--amber-glow)",
            fontWeight: 500,
          }}
        >
          {message}
        </div>
      )}

      {/* Canvas Surface */}
      <section className="canvas-surface">
        <ReactFlow
          nodes={visibleNodes.map((node) => ({
            id: node.id,
            type: "canvas",
            position: node.position,
            data: {
              node,
              connectSource: connectFromId === node.id,
            },
            selected: selectedNodeId === node.id,
            style: { width: node.size.w, height: node.size.h },
          }))}
          edges={visibleEdges.map((entry) => {
            const edgeKey = `${entry.scope}:${entry.edge.id}`;
            return {
              id: edgeKey,
              source: entry.edge.source,
              target: entry.edge.target,
              type: "smoothstep",
              selected: selectedEdgeKey === edgeKey,
              className: "edge-path",
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color:
                  selectedEdgeKey === edgeKey
                    ? "var(--teal-glow)"
                    : "var(--ink-muted)",
              },
              style: {
                stroke:
                  selectedEdgeKey === edgeKey
                    ? "var(--teal-glow)"
                    : "var(--ink-muted)",
                strokeWidth: selectedEdgeKey === edgeKey ? 3 : 2,
              },
            };
          })}
          nodeTypes={{ canvas: CanvasNode }}
          nodesConnectable={false}
          onNodeClick={(_, node) => handleNodeClick(node.data.node)}
          onEdgeClick={(_, edge) => setSelectedEdgeKey(edge.id)}
          onNodeDragStop={(_, node) =>
            updateNode(node.id, {
              position: {
                x: Math.round(node.position.x),
                y: Math.round(node.position.y),
              },
            })
          }
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeKey(null);
          }}
          fitView={false}
          minZoom={0.1}
          maxZoom={4}
          className="canvas-flow"
        >
          <Background gap={24} color="rgba(255,255,255,0.08)" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </section>
    </main>
  );
}

function ParallelWorldsDashboardView() {
  const location = useLocation();
  const [dashboard, setDashboard] = useState(null);
  const [selectedBranchpoint, setSelectedBranchpoint] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionOutput, setActionOutput] = useState("");
  const [actionJobId, setActionJobId] = useState("");
  const [actionJob, setActionJob] = useState(null);
  const [actionJobError, setActionJobError] = useState("");
  const [artifactName, setArtifactName] = useState("report.md");
  const [artifactText, setArtifactText] = useState("");
  const [logState, setLogState] = useState({
    kind: "",
    world: "",
    text: "",
    path: "",
    loading: false,
  });

  const [autopilot, setAutopilot] = useState({
    prompt: "",
    count: "3",
    fromRef: "",
    strategies: "",
    run: true,
    play: false,
    skipCodex: false,
    skipRunner: false,
  });

  const [kickoff, setKickoff] = useState({
    intent: "",
    count: "3",
    fromRef: "",
    strategies: "",
  });

  const [runForm, setRunForm] = useState({
    worlds: "",
    skipCodex: false,
    skipRunner: false,
  });

  const [playForm, setPlayForm] = useState({
    worlds: "",
    renderCommand: "",
    timeout: "",
    previewLines: "",
  });

  const [runIdInput, setRunIdInput] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [runSummary, setRunSummary] = useState(null);
  const [runDiagram, setRunDiagram] = useState({ nodes: [], edges: [] });
  const [runEvents, setRunEvents] = useState([]);
  const [runProgressLoading, setRunProgressLoading] = useState(false);
  const [runProgressRefreshing, setRunProgressRefreshing] = useState(false);
  const [runProgressError, setRunProgressError] = useState("");
  const [eventStreamStatus, setEventStreamStatus] = useState("idle");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [drawerTab, setDrawerTab] = useState("logs");
  const [taskArtifactsById, setTaskArtifactsById] = useState({});
  const [taskArtifactsLoading, setTaskArtifactsLoading] = useState(false);
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const [steerForm, setSteerForm] = useState({ comment: "", promptPatch: "" });

  const eventSourceRef = useRef(null);
  const pendingActionRef = useRef(null);

  async function loadDashboard(
    branchpoint = selectedBranchpoint,
    initial = false,
  ) {
    const query = branchpoint
      ? `?branchpoint=${encodeURIComponent(branchpoint)}`
      : "";
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError("");
    try {
      const payload = await readJson(`${API_BASE}/api/dashboard${query}`);
      setDashboard(payload);
      if (!branchpoint && payload.selected_branchpoint) {
        setSelectedBranchpoint(payload.selected_branchpoint);
      }
      if (branchpoint && payload.selected_branchpoint !== selectedBranchpoint) {
        setSelectedBranchpoint(payload.selected_branchpoint || branchpoint);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  function closeRunEventStream() {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setEventStreamStatus("idle");
  }

  function clearRunProgress() {
    closeRunEventStream();
    setActiveRunId("");
    setRunSummary(null);
    setRunDiagram({ nodes: [], edges: [] });
    setRunEvents([]);
    setSelectedTaskId("");
    setTaskArtifactsById({});
    setRunProgressError("");
  }

  async function loadRunProgress(runId, opts = {}) {
    const options = { initial: false, ...opts };
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) {
      setRunProgressError("Run ID is required.");
      return;
    }

    if (options.initial) setRunProgressLoading(true);
    else setRunProgressRefreshing(true);
    setRunProgressError("");

    try {
      const [summaryPayload, diagramPayload] = await Promise.all([
        readJson(
          `${RUNS_API_PREFIX}/runs/${encodeURIComponent(normalizedRunId)}`,
        ),
        readJson(
          `${RUNS_API_PREFIX}/runs/${encodeURIComponent(normalizedRunId)}/diagram`,
        ),
      ]);

      const nextSummary = unwrapData(summaryPayload);
      const nextDiagram = normalizeDiagram(diagramPayload);
      setActiveRunId(normalizedRunId);
      setRunSummary(nextSummary);
      setRunDiagram(nextDiagram);

      if (nextDiagram.nodes.length > 0) {
        const stillExists = nextDiagram.nodes.some(
          (node) => node.taskId === selectedTaskId,
        );
        if (!stillExists) {
          setSelectedTaskId(nextDiagram.nodes[0].taskId);
        }
      } else {
        setSelectedTaskId("");
      }
    } catch (err) {
      setRunProgressError(err.message);
    } finally {
      setRunProgressLoading(false);
      setRunProgressRefreshing(false);
    }
  }

  function connectRunEventStream(runId) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) {
      setRunProgressError("Run ID is required before connecting events.");
      return;
    }

    closeRunEventStream();
    setEventStreamStatus("connecting");
    setRunProgressError("");

    const source = new EventSource(
      `${RUNS_API_PREFIX}/runs/${encodeURIComponent(normalizedRunId)}/events`,
    );
    eventSourceRef.current = source;

    source.onopen = () => {
      setEventStreamStatus("live");
    };

    source.onmessage = (evt) => {
      const row = serializeEvent(evt.data);
      setRunEvents((prev) => [row, ...prev].slice(0, 250));
      if (row.taskId && row.status) {
        setRunDiagram((prev) => {
          const nextNodes = prev.nodes.map((node) =>
            node.taskId === row.taskId ? { ...node, status: row.status } : node,
          );
          return { ...prev, nodes: nextNodes };
        });
      }
    };

    source.onerror = () => {
      setEventStreamStatus("error");
    };
  }

  async function loadTaskArtifacts(taskId, force = false) {
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedTaskId || !activeRunId) return;
    if (!force && taskArtifactsById[normalizedTaskId]) return;

    setTaskArtifactsLoading(true);
    try {
      const payload = await readJson(
        `${RUNS_API_PREFIX}/tasks/${encodeURIComponent(normalizedTaskId)}/artifacts`,
      );
      const artifacts = normalizeArtifacts(payload);
      setTaskArtifactsById((prev) => ({
        ...prev,
        [normalizedTaskId]: artifacts,
      }));
    } catch (err) {
      setTaskArtifactsById((prev) => ({
        ...prev,
        [normalizedTaskId]: [
          {
            id: `err-${Date.now()}`,
            kind: "error",
            path: "",
            message: err.message,
          },
        ],
      }));
    } finally {
      setTaskArtifactsLoading(false);
    }
  }

  async function taskControlAction(taskId, action, body = {}) {
    if (!activeRunId) {
      setRunProgressError("Load a run before issuing task actions.");
      return;
    }

    setTaskActionBusy(true);
    setRunProgressError("");
    try {
      await readJson(
        `${RUNS_API_PREFIX}/tasks/${encodeURIComponent(taskId)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      await loadRunProgress(activeRunId, { initial: false });
      if (action === "steer") {
        setSteerForm({ comment: "", promptPatch: "" });
      }
    } catch (err) {
      setRunProgressError(err.message);
    } finally {
      setTaskActionBusy(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    const job = params.get("job");
    if (job) {
      setActionJobId(job);
      setActionJob((prev) => {
        if (prev && prev.id === job) return prev;
        return { id: job, status: "running", log: "", action: "autopilot" };
      });
      setActionJobError("");
    }
  }, [location.search]);

  useEffect(() => {
    if (!actionJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const payload = await readJson(
          `${API_BASE}/api/action_status?job=${encodeURIComponent(actionJobId)}`,
        );
        if (cancelled) return;
        setActionJob(payload);
        setActionJobError("");
        if (payload.status === "completed" || payload.status === "failed") {
          const pending = pendingActionRef.current;
          pendingActionRef.current = null;
          if (pending) {
            if (pending.switchToLatest && payload.result?.latest_branchpoint) {
              setSelectedBranchpoint(payload.result.latest_branchpoint);
              await loadDashboard(payload.result.latest_branchpoint, false);
            } else if (pending.refresh) {
              await loadDashboard(selectedBranchpoint, false);
            }
          }
          setActionJobId("");
        }
      } catch (err) {
        if (!cancelled) {
          setActionJobError(err.message);
        }
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [actionJobId, selectedBranchpoint]);

  useEffect(() => {
    loadDashboard("", true);
    return () => {
      closeRunEventStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedTaskId) return;
    loadTaskArtifacts(selectedTaskId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskId, activeRunId]);

  const worldRows = dashboard?.world_rows || [];
  const branchpoints = dashboard?.branchpoints || [];
  const branchpoint = dashboard?.branchpoint || null;

  const branchpointLabel = useMemo(() => {
    if (!branchpoint) return "none";
    return `${branchpoint.id} (${branchpoint.status || "created"})`;
  }, [branchpoint]);

  const selectedTask = useMemo(
    () =>
      runDiagram.nodes.find((node) => node.taskId === selectedTaskId) || null,
    [runDiagram.nodes, selectedTaskId],
  );

  const runStatusCounts = useMemo(
    () => statusCountsFromNodes(runDiagram.nodes),
    [runDiagram.nodes],
  );

  const completionPct = useMemo(() => {
    if (
      runSummary?.completion_pct !== undefined &&
      runSummary?.completion_pct !== null
    ) {
      return fmtPct(runSummary.completion_pct);
    }
    const total = runDiagram.nodes.length;
    if (!total) return "0%";
    const terminal =
      runStatusCounts.done + runStatusCounts.failed + runStatusCounts.stopped;
    return fmtPct((terminal / total) * 100);
  }, [runSummary, runDiagram.nodes.length, runStatusCounts]);

  const activeAgents = useMemo(() => {
    if (
      runSummary?.active_agents !== undefined &&
      runSummary?.active_agents !== null
    ) {
      return String(runSummary.active_agents);
    }
    if (
      runSummary?.counts?.running !== undefined &&
      runSummary?.counts?.running !== null
    ) {
      return String(runSummary.counts.running);
    }
    return String(runStatusCounts.running || 0);
  }, [runSummary, runStatusCounts.running]);

  const taskEvents = useMemo(() => {
    if (!selectedTaskId) return [];
    return runEvents.filter((evt) => evt.taskId === selectedTaskId);
  }, [runEvents, selectedTaskId]);

  const logText = useMemo(() => {
    if (!selectedTask) return "Select a task to inspect logs.";
    if (selectedTask.logs) return String(selectedTask.logs);
    if (taskEvents.length === 0) return "No logs captured for this task yet.";
    return taskEvents
      .map((evt) => {
        const stamp = evt.createdAt
          ? new Date(evt.createdAt).toLocaleTimeString()
          : "--:--:--";
        return `[${stamp}] ${evt.type}: ${evt.detail}`;
      })
      .join("\n");
  }, [selectedTask, taskEvents]);

  const selectedArtifacts = selectedTaskId
    ? taskArtifactsById[selectedTaskId] || []
    : [];

  async function postAction(action, payload, opts = {}) {
    const { refresh = true, switchToLatest = false } = opts;
    setBusy(true);
    setError("");
    setActionOutput("");
    try {
      const result = await readJson(`${API_BASE}/api/action/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      if (result.job_id) {
        setActionJobId(result.job_id);
        setActionJob({
          id: result.job_id,
          status: result.status || "running",
          action: result.action || action,
          log: "",
          result: null,
        });
        setActionOutput("");
        pendingActionRef.current = { refresh, switchToLatest };
        return;
      }
      setActionJob(null);
      setActionJobId("");
      setActionJobError("");
      setActionOutput(result.output || "Action completed.");
      if (switchToLatest && result.latest_branchpoint) {
        setSelectedBranchpoint(result.latest_branchpoint);
        await loadDashboard(result.latest_branchpoint, false);
      } else if (refresh) {
        await loadDashboard(selectedBranchpoint, false);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openArtifact(name) {
    setArtifactName(name);
    setArtifactText("");
    setError("");
    try {
      const payload = await readJson(
        `${API_BASE}/api/artifact?name=${encodeURIComponent(name)}`,
      );
      setArtifactText(payload.text || "");
    } catch (err) {
      setError(err.message);
    }
  }

  async function openLog(kind, worldId) {
    const bp = selectedBranchpoint || dashboard?.selected_branchpoint || "";
    if (!bp) {
      setError("Select or create a branchpoint first.");
      return;
    }
    setLogState({ kind, world: worldId, text: "", path: "", loading: true });
    setError("");
    try {
      const payload = await readJson(
        `${API_BASE}/api/log?kind=${encodeURIComponent(kind)}&branchpoint=${encodeURIComponent(bp)}&world=${encodeURIComponent(worldId)}&tail=220`,
      );
      setLogState({
        kind,
        world: worldId,
        text: payload.text || "",
        path: payload.path || "",
        loading: false,
      });
    } catch (err) {
      setLogState((prev) => ({ ...prev, loading: false }));
      setError(err.message);
    }
  }

  function forkFromWorld(world) {
    const intent = window.prompt(`New intent forked from ${world.branch}:`);
    if (!intent || !intent.trim()) return;
    postAction(
      "refork",
      {
        branchpoint: selectedBranchpoint || "",
        world: world.id,
        intent: intent.trim(),
        count: asInt(autopilot.count),
      },
      { switchToLatest: true },
    );
  }

  if (loading) {
    return (
      <main className="shell">
        <section
          className="glass-panel"
          style={{
            margin: "auto",
            padding: "40px",
            textAlign: "center",
            maxWidth: "400px",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
            Parallel Worlds
          </h1>
          <p className="subtle">Loading repository state...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Git Pathway Control</p>
          <h1>Parallel Worlds</h1>
          <div
            className="flex-center"
            style={{ gap: 10, justifyContent: "flex-start" }}
          >
            <span className="subtle">Branchpoint:</span>
            <code className="run-pill pending">{branchpointLabel}</code>
          </div>
        </div>
        <div className="hero-actions">
          <button
            className="btn ghost"
            disabled={refreshing || busy}
            onClick={() => loadDashboard(selectedBranchpoint, false)}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            className="btn ghost"
            onClick={() => openArtifact("report.md")}
          >
            Open report.md
          </button>
          <button className="btn ghost" onClick={() => openArtifact("play.md")}>
            Open play.md
          </button>
        </div>
      </header>
      <div
        className="dashboard-scroller"
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {error && (
          <div
            className="layout"
            style={{ flex: "0 0 auto", paddingBottom: 0 }}
          >
            <section className="notice error" style={{ width: "100%" }}>
              <strong>Error:</strong> {error}
            </section>
          </div>
        )}

        {actionJob && (
          <div
            className="layout"
            style={{ flex: "0 0 auto", paddingBottom: 0 }}
          >
            <section className="notice" style={{ width: "100%" }}>
              <div
                className="flex-between"
                style={{ marginBottom: 8, gap: 12 }}
              >
                <strong>
                  Action Job{actionJob.action ? `: ${actionJob.action}` : ""}
                </strong>
                <span className="subtle mono">{actionJob.id}</span>
              </div>
              <p className="subtle" style={{ margin: "0 0 8px" }}>
                Status: {actionJob.status || "running"}
              </p>
              {actionJobError && (
                <p className="subtle" style={{ margin: "0 0 8px" }}>
                  Polling error: {actionJobError}
                </p>
              )}
              <pre style={{ margin: 0 }}>
                {actionJob.log || "Awaiting output..."}
              </pre>
            </section>
          </div>
        )}

        {!actionJob && actionOutput && (
          <div
            className="layout"
            style={{ flex: "0 0 auto", paddingBottom: 0 }}
          >
            <section className="notice" style={{ width: "100%" }}>
              <pre style={{ margin: 0 }}>{actionOutput}</pre>
            </section>
          </div>
        )}

        <section className="glass-panel progress-shell animate-fade-in">
          <div className="progress-head">
            <div>
              <p className="eyebrow">Symphony Operator View</p>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
                Run Progress
              </h2>
              <p className="subtle">
                Monitor DAG execution and steer active tasks.
              </p>
            </div>
            <div className="progress-actions">
              <input
                value={runIdInput}
                onChange={(e) => setRunIdInput(e.target.value)}
                placeholder="run-id"
                style={{ width: 240 }}
              />
              <button
                className="btn"
                disabled={runProgressLoading || !runIdInput.trim()}
                onClick={() =>
                  loadRunProgress(runIdInput.trim(), { initial: true })
                }
              >
                {runProgressLoading ? "Loading..." : "Load"}
              </button>
              <button
                className="btn ghost"
                disabled={!activeRunId || runProgressRefreshing}
                onClick={() => loadRunProgress(activeRunId, { initial: false })}
              >
                Refresh
              </button>
              {eventStreamStatus === "live" ||
              eventStreamStatus === "connecting" ? (
                <button className="btn ghost" onClick={closeRunEventStream}>
                  Disconnect
                </button>
              ) : (
                <button
                  className="btn ghost"
                  disabled={!activeRunId}
                  onClick={() => connectRunEventStream(activeRunId)}
                >
                  Connect
                </button>
              )}
              <button
                className="btn ghost"
                disabled={!activeRunId}
                onClick={clearRunProgress}
              >
                Clear
              </button>
            </div>
          </div>

          {runProgressError && (
            <div className="notice error">
              <strong>Run API error:</strong> {runProgressError}
            </div>
          )}

          <div className="progress-kpis">
            <article className="kpi-card">
              <p>Run ID</p>
              <strong style={{ fontSize: "0.9rem" }}>
                {activeRunId || "none"}
              </strong>
            </article>
            <article className="kpi-card">
              <p>Status</p>
              <span
                className={`run-pill ${runStatusTone(runSummary?.status)}`}
                style={{ fontWeight: 600 }}
              >
                {String(runSummary?.status || "pending")}
              </span>
            </article>
            <article className="kpi-card">
              <p>Active Agents</p>
              <strong>{activeAgents}</strong>
            </article>
            <article className="kpi-card">
              <p>Completion</p>
              <strong>{completionPct}</strong>
            </article>
            <article className="kpi-card">
              <p>Tasks</p>
              <strong>{runDiagram.nodes.length}</strong>
            </article>
          </div>

          <div className="status-counter-row">
            {TASK_STATES.map((state) => (
              <span key={state} className={`status-chip ${state}`}>
                {state}: {runStatusCounts[state] || 0}
              </span>
            ))}
          </div>

          <div className="progress-layout">
            <section className="diagram-panel">
              <header className="flex-between">
                <h3 className="eyebrow" style={{ color: "var(--ink)" }}>
                  DAG Tasks
                </h3>
                <span className="subtle" style={{ fontSize: "0.75rem" }}>
                  {runDiagram.edges.length} edges
                </span>
              </header>

              {!runDiagram.nodes.length ? (
                <div
                  className="flex-center"
                  style={{ height: "100%", opacity: 0.5 }}
                >
                  <p>Load a run to view execution graph.</p>
                </div>
              ) : (
                <div className="dag-grid">
                  {runDiagram.nodes.map((node) => (
                    <button
                      key={node.taskId}
                      className={`dag-node ${node.status} ${selectedTaskId === node.taskId ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedTaskId(node.taskId);
                        setDrawerTab("logs");
                      }}
                    >
                      <span className="dag-node-title">{node.title}</span>
                      <span className={`dag-node-status ${node.status}`}>
                        {node.status}
                      </span>
                      <span className="dag-node-id mono">{node.taskId}</span>
                    </button>
                  ))}
                </div>
              )}

              <header className="event-head">
                <h3 className="eyebrow" style={{ color: "var(--ink)" }}>
                  Live Events
                </h3>
                <span className="subtle" style={{ fontSize: "0.75rem" }}>
                  {eventStreamStatus}
                </span>
              </header>
              <div className="event-feed">
                {!runEvents.length ? (
                  <p className="subtle" style={{ padding: 10 }}>
                    No events captured.
                  </p>
                ) : (
                  runEvents.map((event) => (
                    <article key={event.id} className="event-row">
                      <div className="event-row-head">
                        <span
                          className="status-chip tiny"
                          style={{ background: "rgba(255,255,255,0.1)" }}
                        >
                          {event.type}
                        </span>
                        <span
                          className="subtle mono"
                          style={{ fontSize: "0.7rem" }}
                        >
                          {event.taskId}
                        </span>
                      </div>
                      <p className="subtle" style={{ margin: 0 }}>
                        {event.detail}
                      </p>
                    </article>
                  ))
                )}
              </div>
            </section>

            <aside className="task-drawer">
              <header>
                <h3 className="eyebrow" style={{ marginBottom: 4 }}>
                  Task Details
                </h3>
                <p className="subtle mono" style={{ fontSize: "0.75rem" }}>
                  {selectedTaskId || "Select a task"}
                </p>
              </header>

              {selectedTask ? (
                <>
                  <article className="task-meta-card">
                    <h4 style={{ margin: "0 0 8px" }}>{selectedTask.title}</h4>
                    <p
                      className="subtle"
                      style={{ fontSize: "0.8rem", marginBottom: 12 }}
                    >
                      {selectedTask.objective || "No objective defined."}
                    </p>
                    <div className="status-counter-row compact">
                      <span
                        className={`status-chip tiny ${selectedTask.status}`}
                      >
                        {selectedTask.status}
                      </span>
                      <span className="status-chip tiny">
                        P: {selectedTask.priority ?? "n/a"}
                      </span>
                    </div>
                  </article>

                  <div className="button-row">
                    <button
                      className="btn small"
                      disabled={taskActionBusy}
                      onClick={() =>
                        taskControlAction(selectedTask.taskId, "pause")
                      }
                    >
                      Pause
                    </button>
                    <button
                      className="btn small"
                      disabled={taskActionBusy}
                      onClick={() =>
                        taskControlAction(selectedTask.taskId, "resume")
                      }
                    >
                      Resume
                    </button>
                    <button
                      className="btn small danger"
                      disabled={taskActionBusy}
                      onClick={() =>
                        taskControlAction(selectedTask.taskId, "stop")
                      }
                    >
                      Stop
                    </button>
                  </div>

                  <div
                    className="glass-panel"
                    style={{ padding: 10, background: "rgba(0,0,0,0.2)" }}
                  >
                    <label
                      className="eyebrow"
                      style={{ display: "block", marginBottom: 4 }}
                    >
                      Steering
                    </label>
                    <textarea
                      value={steerForm.comment}
                      onChange={(e) =>
                        setSteerForm((p) => ({ ...p, comment: e.target.value }))
                      }
                      placeholder="Feedback or constraint..."
                      style={{ marginBottom: 8, fontSize: "0.85rem" }}
                    />
                    <input
                      value={steerForm.promptPatch}
                      onChange={(e) =>
                        setSteerForm((p) => ({
                          ...p,
                          promptPatch: e.target.value,
                        }))
                      }
                      placeholder="Prompt patch..."
                      style={{ marginBottom: 8, fontSize: "0.85rem" }}
                    />
                    <button
                      className="btn primary small w-full"
                      style={{ width: "100%", justifyContent: "center" }}
                      disabled={taskActionBusy || !steerForm.comment.trim()}
                      onClick={() =>
                        taskControlAction(selectedTask.taskId, "steer", {
                          comment: steerForm.comment.trim(),
                          prompt_patch: steerForm.promptPatch.trim(),
                        })
                      }
                    >
                      {taskActionBusy ? "Sending..." : "Send Steering"}
                    </button>
                  </div>

                  <div className="drawer-tabs">
                    <button
                      className={`tab-btn ${drawerTab === "logs" ? "active" : ""}`}
                      onClick={() => setDrawerTab("logs")}
                    >
                      Logs
                    </button>
                    <button
                      className={`tab-btn ${drawerTab === "artifacts" ? "active" : ""}`}
                      onClick={() => setDrawerTab("artifacts")}
                    >
                      Artifacts
                    </button>
                  </div>

                  <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                    {drawerTab === "logs" ? (
                      <pre className="drawer-pre">{logText}</pre>
                    ) : (
                      <div className="artifact-list">
                        <div className="flex-between" style={{ padding: 8 }}>
                          <button
                            className="btn small ghost"
                            onClick={() =>
                              loadTaskArtifacts(selectedTask.taskId, true)
                            }
                          >
                            Refresh
                          </button>
                        </div>
                        {!selectedArtifacts.length ? (
                          <p className="subtle" style={{ textAlign: "center" }}>
                            No artifacts.
                          </p>
                        ) : (
                          selectedArtifacts.map((item, idx) => (
                            <article
                              key={item.id || idx}
                              className="artifact-row"
                            >
                              <div className="artifact-top">
                                <strong>{item.kind}</strong>
                                <span className="mono subtle">
                                  {item.path || item.name}
                                </span>
                              </div>
                              {item.content && (
                                <pre
                                  className="drawer-pre"
                                  style={{ maxHeight: 150 }}
                                >
                                  {String(item.content)}
                                </pre>
                              )}
                            </article>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div
                  className="flex-center"
                  style={{ height: "200px", opacity: 0.5 }}
                >
                  <p>Select a task node.</p>
                </div>
              )}
            </aside>
          </div>
        </section>

        <section
          className="layout"
          style={{ flex: "none", overflow: "visible", minHeight: "auto" }}
        >
          <div className="flex-col" style={{ gap: 24 }}>
            {/* Prompt Agent Panel */}
            <article className="glass-panel panel">
              <div className="flex-between">
                <h2>Prompt Agent</h2>
                <span className="subtle">Automated Ops</span>
              </div>
              <p className="subtle">
                Kickoff worlds, run codex/tests, and verify result with one
                prompt.
              </p>

              <textarea
                value={autopilot.prompt}
                onChange={(e) =>
                  setAutopilot((s) => ({ ...s, prompt: e.target.value }))
                }
                placeholder="Example: Fix flaky checkout timeout along with regression tests."
                style={{ minHeight: 80 }}
              />

              <div className="grid two">
                <label>
                  <span className="eyebrow">Count</span>
                  <input
                    value={autopilot.count}
                    onChange={(e) =>
                      setAutopilot((s) => ({ ...s, count: e.target.value }))
                    }
                  />
                </label>
                <label>
                  <span className="eyebrow">Base Ref</span>
                  <input
                    value={autopilot.fromRef}
                    onChange={(e) =>
                      setAutopilot((s) => ({ ...s, fromRef: e.target.value }))
                    }
                    placeholder="main"
                  />
                </label>
              </div>

              <label>
                <span className="eyebrow">Strategies (name::notes)</span>
                <textarea
                  value={autopilot.strategies}
                  onChange={(e) =>
                    setAutopilot((s) => ({ ...s, strategies: e.target.value }))
                  }
                  placeholder="surgical-fix::minimal changes"
                  style={{ minHeight: 60 }}
                />
              </label>

              <div className="grid checks">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={autopilot.run}
                    onChange={(e) =>
                      setAutopilot((s) => ({ ...s, run: e.target.checked }))
                    }
                  />
                  Run
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={autopilot.play}
                    onChange={(e) =>
                      setAutopilot((s) => ({ ...s, play: e.target.checked }))
                    }
                  />
                  Play
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={autopilot.skipCodex}
                    onChange={(e) =>
                      setAutopilot((s) => ({
                        ...s,
                        skipCodex: e.target.checked,
                      }))
                    }
                  />
                  Skip Codex
                </label>
              </div>

              <button
                className="btn primary"
                disabled={busy || !autopilot.prompt.trim()}
                onClick={() =>
                  postAction(
                    "autopilot",
                    {
                      prompt: autopilot.prompt.trim(),
                      count: asInt(autopilot.count),
                      from_ref: autopilot.fromRef.trim() || null,
                      strategies: parseStrategies(autopilot.strategies),
                      run: autopilot.run,
                      play: autopilot.play,
                      skip_codex: autopilot.skipCodex,
                      skip_runner: autopilot.skipRunner,
                    },
                    { switchToLatest: true },
                  )
                }
              >
                {busy ? "Running..." : "Run Prompt"}
              </button>
            </article>

            {/* World Blocks */}
            <section className="glass-panel panel">
              <div className="worlds-header">
                <h2>World Blocks</h2>
                <p className="subtle">Active development branches.</p>
              </div>

              {!worldRows.length ? (
                <p className="subtle">
                  No worlds found. Start a new prompt or kickoff.
                </p>
              ) : (
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(300px, 1fr))",
                  }}
                >
                  {worldRows.map(({ world, run, codex, render }) => (
                    <article
                      key={world.id}
                      className="glass-panel"
                      style={{ padding: 16, border: "1px solid var(--line)" }}
                    >
                      <div className="flex-between" style={{ marginBottom: 8 }}>
                        <h3 style={{ fontSize: "1rem" }}>
                          {world.index}. {world.name}
                        </h3>
                        <span
                          className={`status-chip tiny ${statusTone(world.status)}`}
                        >
                          {world.status}
                        </span>
                      </div>
                      <code
                        className="mono subtle"
                        style={{
                          display: "block",
                          marginBottom: 8,
                          fontSize: "0.8rem",
                        }}
                      >
                        {world.branch}
                      </code>
                      <p
                        className="subtle"
                        style={{ fontSize: "0.85rem", marginBottom: 12 }}
                      >
                        {world.notes}
                      </p>

                      <div
                        className="metrics grid two"
                        style={{ gap: 4, marginBottom: 12, fontSize: "0.8rem" }}
                      >
                        <span>Codex: {codex?.exit_code ?? "-"}</span>
                        <span>Run: {run?.exit_code ?? "-"}</span>
                        <span>Render: {render?.exit_code ?? "-"}</span>
                        <span>Time: {fmtDuration(run?.duration_sec)}</span>
                      </div>

                      <div className="button-row">
                        <button
                          className="btn small"
                          onClick={() =>
                            postAction("run", {
                              branchpoint: selectedBranchpoint || "",
                              worlds: world.id,
                            })
                          }
                        >
                          Run
                        </button>
                        <button
                          className="btn small"
                          onClick={() =>
                            postAction("play", {
                              branchpoint: selectedBranchpoint || "",
                              worlds: world.id,
                            })
                          }
                        >
                          Play
                        </button>
                        <button
                          className="btn small accent"
                          onClick={() => forkFromWorld(world)}
                        >
                          Fork
                        </button>
                      </div>

                      <div
                        className="flex-center"
                        style={{ gap: 8, marginTop: 8 }}
                      >
                        <button
                          className="btn ghost small"
                          onClick={() => openLog("codex", world.id)}
                        >
                          Codex Log
                        </button>
                        <button
                          className="btn ghost small"
                          onClick={() => openLog("run", world.id)}
                        >
                          Run Log
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Sidebar Controls */}
          <aside className="flex-col" style={{ gap: 24 }}>
            <article className="glass-panel panel">
              <h2>Branchpoint</h2>
              <label>
                <span className="eyebrow">Select</span>
                <select
                  value={selectedBranchpoint}
                  onChange={(e) => loadDashboard(e.target.value, false)}
                >
                  <option value="">Latest</option>
                  {branchpoints.map((bp) => (
                    <option key={bp.id} value={bp.id}>
                      {bp.id} ({bp.status})
                    </option>
                  ))}
                </select>
              </label>

              <h3 style={{ marginTop: 16, fontSize: "1rem" }}>
                Manual Kickoff
              </h3>
              <label>
                <span className="eyebrow">Intent</span>
                <textarea
                  value={kickoff.intent}
                  onChange={(e) =>
                    setKickoff((s) => ({ ...s, intent: e.target.value }))
                  }
                  placeholder="Describe task..."
                />
              </label>
              <button
                className="btn"
                disabled={busy || !kickoff.intent.trim()}
                onClick={() =>
                  postAction(
                    "kickoff",
                    {
                      intent: kickoff.intent.trim(),
                      count: asInt(kickoff.count),
                      from_ref: kickoff.fromRef.trim() || null,
                      strategies: parseStrategies(kickoff.strategies),
                    },
                    { switchToLatest: true },
                  )
                }
              >
                Kickoff
              </button>
            </article>

            <article className="glass-panel panel">
              <h2>Batch Controls</h2>
              <label>
                <span className="eyebrow">Target Worlds</span>
                <input
                  value={runForm.worlds}
                  onChange={(e) =>
                    setRunForm((s) => ({ ...s, worlds: e.target.value }))
                  }
                  placeholder="e.g. 1, 3"
                />
              </label>
              <div className="button-row">
                <button
                  className="btn"
                  onClick={() =>
                    postAction("run", {
                      branchpoint: selectedBranchpoint || "",
                      worlds: runForm.worlds,
                      skip_codex: runForm.skipCodex,
                      skip_runner: runForm.skipRunner,
                    })
                  }
                >
                  Run Batch
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    postAction("play", {
                      branchpoint: selectedBranchpoint || "",
                      worlds: playForm.worlds || runForm.worlds,
                      render_command: playForm.renderCommand.trim() || null,
                      timeout: asInt(playForm.timeout),
                      preview_lines: asInt(playForm.previewLines),
                    })
                  }
                >
                  Play Batch
                </button>
              </div>
            </article>

            <article
              className="glass-panel panel"
              style={{
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <h2>Viewer</h2>
              <div className="drawer-tabs">
                <span className={`tab-btn active`}>{artifactName}</span>
              </div>
              <pre className="drawer-pre" style={{ flex: 1 }}>
                {artifactText || "No artifact loaded."}
              </pre>
            </article>
          </aside>
        </section>
      </div>
    </main>
  );
}

export default function App() {
  const location = useLocation();
  const isCanvas = location.pathname === "/" || location.pathname === "/canvas";

  useEffect(() => {
    document.body.classList.toggle("canvas-active", isCanvas);
    return () => document.body.classList.remove("canvas-active");
  }, [isCanvas]);

  return (
    <div className="app-root">
      <header className="app-nav glass-panel">
        <div className="nav-brand">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">Symphony</div>
            <div className="brand-sub">AI Planning Studio</div>
          </div>
        </div>
        <nav className="nav-links">
          <NavLink
            end
            to="/"
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          >
            Canvas
          </NavLink>
          <NavLink
            to="/dashboard"
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          >
            Dashboard
          </NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<CanvasPlannerView />} />
        <Route path="/canvas" element={<Navigate to="/" replace />} />
        <Route path="/dashboard" element={<ParallelWorldsDashboardView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
