import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const RUNS_API_PREFIX = `${API_BASE}/api/v1`;
const TASK_STATES = ["pending", "running", "blocked", "done", "failed", "paused", "stopped"];
const LOCAL_STORAGE_KEY = "symphony.canvasPlan.v1.draft";

const LAYER_KINDS = ["vision", "module", "uxui", "backend", "data", "infra", "task"];
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

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const NODE_ID_RE = /^node_[a-zA-Z0-9_-]+$/;
const EDGE_ID_RE = /^edge_[a-zA-Z0-9_-]+$/;
const LAYER_ID_RE = /^layer_[a-zA-Z0-9_-]+$/;

function nowIso() {
  return new Date().toISOString();
}

function safeUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
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
  if (Object.prototype.hasOwnProperty.call(payload, "data")) return payload.data;
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
      const taskId = String(node.task_id || node.id || node.key || `task-${index + 1}`);
      return {
        taskId,
        title: String(node.title || node.name || node.label || taskId),
        status: normalizeTaskStatus(node.status),
        priority: node.priority,
        objective: node.objective || node.description || "",
        acceptanceCriteria: Array.isArray(node.acceptance_criteria) ? node.acceptance_criteria : [],
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
  const taskId = event.task_id || event.taskId || event.payload?.task_id || event.payload?.taskId || "";
  const nextStatus = event.status || event.payload?.status || "";
  const createdAt = event.created_at || event.timestamp || new Date().toISOString();
  const detail = event.message || event.note || event.payload?.message || JSON.stringify(event.payload || payload || {});
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
    const err = payload.error || payload.output || `Request failed (${response.status})`;
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

function CanvasPlannerView() {
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
  const [addLayerForm, setAddLayerForm] = useState({ name: "", kind: "module", pov: "engineering", order: "" });
  const [addNodeForm, setAddNodeForm] = useState({
    layerId: "",
    type: "module",
    label: "",
    summary: "",
    status: "draft",
    priority: "medium",
  });

  const surfaceRef = useRef(null);
  const [dragState, setDragState] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(plan));
    } catch (err) {
      // ignore persistence errors
    }
  }, [plan]);

  useEffect(() => {
    if (!selectedNodeId) return;
    const exists = plan.layers.some((layer) => layer.nodes.some((node) => node.id === selectedNodeId));
    if (!exists) setSelectedNodeId(null);
  }, [plan, selectedNodeId]);

  useEffect(() => {
    if (!selectedEdgeKey) return;
    const [scope, edgeId] = selectedEdgeKey.split(":");
    const found =
      scope === "cross"
        ? plan.cross_layer_edges.some((edge) => edge.id === edgeId)
        : plan.layers.some((layer) => layer.edges.some((edge) => edge.id === edgeId));
    if (!found) setSelectedEdgeKey(null);
  }, [plan, selectedEdgeKey]);

  useEffect(() => {
    if (!dragState) return;
    function onPointerMove(event) {
      if (!surfaceRef.current) return;
      const rect = surfaceRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left - dragState.offsetX;
      const y = event.clientY - rect.top - dragState.offsetY;
      setPlan((prev) => {
        const updated = {
          ...prev,
          created_at: prev.created_at || nowIso(),
          updated_at: nowIso(),
          layers: prev.layers.map((layer) => ({
            ...layer,
            nodes: layer.nodes.map((node) =>
              node.id === dragState.nodeId
                ? {
                    ...node,
                    position: { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) },
                  }
                : node,
            ),
          })),
        };
        return updated;
      });
    }
    function onPointerUp() {
      setDragState(null);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragState]);

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

  const visibleNodes = useMemo(() => filteredLayers.flatMap((layer) => layer.nodes), [filteredLayers]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);

  const visibleEdges = useMemo(() => {
    const layerEdges = filteredLayers.flatMap((layer) =>
      layer.edges.map((edge) => ({ scope: "layer", layerId: layer.id, edge })),
    );
    const crossEdges = plan.cross_layer_edges.map((edge) => ({ scope: "cross", layerId: null, edge }));
    return [...layerEdges, ...crossEdges].filter(
      (entry) => visibleNodeIds.has(entry.edge.source) && visibleNodeIds.has(entry.edge.target),
    );
  }, [filteredLayers, plan.cross_layer_edges, visibleNodeIds]);

  const selectedLayer = useMemo(() => {
    if (selectedLayerId !== "all") return plan.layers.find((layer) => layer.id === selectedLayerId) || null;
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
      return { scope, edge: plan.cross_layer_edges.find((edge) => edge.id === edgeId) || null };
    }
    for (const layer of plan.layers) {
      const match = layer.edges.find((edge) => edge.id === edgeId);
      if (match) return { scope: "layer", layerId: layer.id, edge: match };
    }
    return null;
  }, [selectedEdgeKey, plan.cross_layer_edges, plan.layers]);

  const validationErrors = useMemo(() => validatePlan(plan), [plan]);
  const exportJson = useMemo(() => JSON.stringify(plan, null, 2), [plan]);

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
      order: addLayerForm.order ? Number(addLayerForm.order) : plan.layers.length + 1,
      nodes: [],
      edges: [],
    };
    updatePlan((prev) => ({ ...prev, layers: [...prev.layers, newLayer] }));
    setAddLayerForm({ name: "", kind: "module", pov: "engineering", order: "" });
    setMessage("Layer added.");
  }

  function deleteLayer(layerId) {
    const layer = plan.layers.find((item) => item.id === layerId);
    if (!layer) return;
    if (layer.nodes.length > 0) {
      setMessage("Delete nodes in the layer before removing it.");
      return;
    }
    updatePlan((prev) => ({ ...prev, layers: prev.layers.filter((item) => item.id !== layerId) }));
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
        layer.id === targetLayerId ? { ...layer, nodes: [...layer.nodes, newNode] } : layer,
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
        edges: layer.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      }));
      const nextCross = prev.cross_layer_edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
      return { ...prev, layers: nextLayers, cross_layer_edges: nextCross };
    });
    setSelectedNodeId(null);
    setSelectedEdgeKey(null);
    setMessage("Node and connected edges removed.");
  }

  function startDrag(event, node) {
    if (connectMode.active) return;
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setDragState({
      nodeId: node.id,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    });
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
      if (connectMode.scope === "layer" && sourceNode.layer_id !== targetNode.layer_id) {
        setMessage("Layer edges require source and target in the same layer.");
        setConnectFromId(null);
        return;
      }
      const hasDuplicate = (edges) =>
        edges.some(
          (edge) => edge.source === sourceNode.id && edge.target === targetNode.id && edge.relation === connectMode.relation,
        );
      if (connectMode.scope === "cross" && hasDuplicate(plan.cross_layer_edges)) {
        setMessage("Duplicate cross-layer edge already exists.");
        setConnectFromId(null);
        return;
      }
      if (connectMode.scope === "layer") {
        const layer = plan.layers.find((item) => item.id === sourceNode.layer_id);
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
          return { ...prev, cross_layer_edges: [...prev.cross_layer_edges, newEdge] };
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
        return { ...prev, cross_layer_edges: prev.cross_layer_edges.filter((edge) => edge.id !== edgeId) };
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
          cross_layer_edges: prev.cross_layer_edges.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge)),
        };
      }
      return {
        ...prev,
        layers: prev.layers.map((layer) => ({
          ...layer,
          edges: layer.edges.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge)),
        })),
      };
    });
  }

  function updateNode(nodeId, patch) {
    updatePlan((prev) => ({
      ...prev,
      layers: prev.layers.map((layer) => ({
        ...layer,
        nodes: layer.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
      })),
    }));
  }

  function copyExport() {
    navigator.clipboard
      .writeText(exportJson)
      .then(() => setMessage("Export JSON copied to clipboard."))
      .catch(() => setMessage("Unable to copy JSON."));
  }

  function downloadExport() {
    const name = (plan.metadata?.name || "plan").toLowerCase().replace(/\s+/g, "-");
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
    <main className="shell canvas-shell">
      <header className="hero canvas-hero">
        <div>
          <p className="eyebrow">Planning Canvas</p>
          <h1>Symphony Planner</h1>
          <p className="subtle">Draft ID: <code>{plan.plan_id}</code></p>
        </div>
        <div className="hero-actions">
          <button className="btn ghost" onClick={resetDraft}>Reset Draft</button>
          <button className="btn ghost" onClick={clearDraft}>Clear Local Draft</button>
        </div>
      </header>

      {message ? (
        <section className="glass notice">
          <pre>{message}</pre>
        </section>
      ) : null}

      <section className="canvas-grid">
        <aside className="glass canvas-panel">
          <h2>Plan Metadata</h2>
          <label>
            Name
            <input
              value={plan.metadata.name}
              onChange={(e) => updatePlan((prev) => ({ ...prev, metadata: { ...prev.metadata, name: e.target.value } }))}
            />
          </label>
          <label>
            Vision
            <textarea
              value={plan.metadata.vision}
              onChange={(e) => updatePlan((prev) => ({ ...prev, metadata: { ...prev.metadata, vision: e.target.value } }))}
            />
          </label>
          <label>
            Goals (one per line)
            <textarea
              value={(plan.metadata.goals || []).join("\n")}
              onChange={(e) =>
                updatePlan((prev) => ({
                  ...prev,
                  metadata: { ...prev.metadata, goals: splitLines(e.target.value) },
                }))
              }
            />
          </label>

          <h3>Filters</h3>
          <div className="grid two">
            <label>
              Layer
              <select value={selectedLayerId} onChange={(e) => setSelectedLayerId(e.target.value)}>
                <option value="all">All layers</option>
                {plan.layers.map((layer) => (
                  <option key={layer.id} value={layer.id}>{layer.name}</option>
                ))}
              </select>
            </label>
            <label>
              POV
              <select value={selectedPov} onChange={(e) => setSelectedPov(e.target.value)}>
                <option value="all">All POVs</option>
                {POVS.map((pov) => (
                  <option key={pov} value={pov}>{pov}</option>
                ))}
              </select>
            </label>
          </div>

          <h3>Layers</h3>
          <div className="stack">
            {plan.layers.map((layer) => (
              <div key={layer.id} className={`layer-card ${selectedLayerId === layer.id ? "active" : ""}`}>
                <div className="row between">
                  <strong>{layer.name}</strong>
                  <button className="btn small ghost" onClick={() => setSelectedLayerId(layer.id)}>Select</button>
                </div>
                <div className="grid two">
                  <label>
                    Kind
                    <select
                      value={layer.kind}
                      onChange={(e) =>
                        updatePlan((prev) => ({
                          ...prev,
                          layers: prev.layers.map((item) =>
                            item.id === layer.id ? { ...item, kind: e.target.value } : item,
                          ),
                        }))
                      }
                    >
                      {LAYER_KINDS.map((kind) => (
                        <option key={kind} value={kind}>{kind}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    POV
                    <select
                      value={layer.pov}
                      onChange={(e) =>
                        updatePlan((prev) => ({
                          ...prev,
                          layers: prev.layers.map((item) =>
                            item.id === layer.id ? { ...item, pov: e.target.value } : item,
                          ),
                        }))
                      }
                    >
                      {POVS.map((pov) => (
                        <option key={pov} value={pov}>{pov}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Order
                  <input
                    value={layer.order}
                    onChange={(e) =>
                      updatePlan((prev) => ({
                        ...prev,
                        layers: prev.layers.map((item) =>
                          item.id === layer.id ? { ...item, order: Number(e.target.value) || 1 } : item,
                        ),
                      }))
                    }
                  />
                </label>
                <button className="btn small" onClick={() => deleteLayer(layer.id)}>Delete Layer</button>
              </div>
            ))}
          </div>
          <label>
            New Layer Name
            <input
              value={addLayerForm.name}
              onChange={(e) => setAddLayerForm((form) => ({ ...form, name: e.target.value }))}
              placeholder="Backend Systems"
            />
          </label>
          <div className="grid two">
            <label>
              Kind
              <select value={addLayerForm.kind} onChange={(e) => setAddLayerForm((form) => ({ ...form, kind: e.target.value }))}>
                {LAYER_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{kind}</option>
                ))}
              </select>
            </label>
            <label>
              POV
              <select value={addLayerForm.pov} onChange={(e) => setAddLayerForm((form) => ({ ...form, pov: e.target.value }))}>
                {POVS.map((pov) => (
                  <option key={pov} value={pov}>{pov}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Order (optional)
            <input
              value={addLayerForm.order}
              onChange={(e) => setAddLayerForm((form) => ({ ...form, order: e.target.value }))}
              placeholder={`${plan.layers.length + 1}`}
            />
          </label>
          <button className="btn" onClick={addLayer}>Add Layer</button>

          <h3>Add Node</h3>
          <label>
            Layer
            <select
              value={addNodeForm.layerId}
              onChange={(e) => setAddNodeForm((form) => ({ ...form, layerId: e.target.value }))}
            >
              <option value="">Use selected layer</option>
              {plan.layers.map((layer) => (
                <option key={layer.id} value={layer.id}>{layer.name}</option>
              ))}
            </select>
          </label>
          <div className="grid two">
            <label>
              Type
              <select value={addNodeForm.type} onChange={(e) => setAddNodeForm((form) => ({ ...form, type: e.target.value }))}>
                {NODE_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select value={addNodeForm.status} onChange={(e) => setAddNodeForm((form) => ({ ...form, status: e.target.value }))}>
                {NODE_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Label
            <input value={addNodeForm.label} onChange={(e) => setAddNodeForm((form) => ({ ...form, label: e.target.value }))} />
          </label>
          <label>
            Summary
            <textarea value={addNodeForm.summary} onChange={(e) => setAddNodeForm((form) => ({ ...form, summary: e.target.value }))} />
          </label>
          <label>
            Priority
            <select
              value={addNodeForm.priority}
              onChange={(e) => setAddNodeForm((form) => ({ ...form, priority: e.target.value }))}
            >
              {NODE_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>{priority}</option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={addNode}>Add Node</button>

          <h3>Connect Mode</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={connectMode.active}
              onChange={(e) => {
                setConnectMode((state) => ({ ...state, active: e.target.checked }));
                setConnectFromId(null);
              }}
            />
            Enable connect mode
          </label>
          <label>
            Edge Scope
            <select
              value={connectMode.scope}
              onChange={(e) => setConnectMode((state) => ({ ...state, scope: e.target.value }))}
            >
              <option value="layer">Layer edge</option>
              <option value="cross">Cross-layer edge</option>
            </select>
          </label>
          <label>
            Relation
            <select
              value={connectMode.relation}
              onChange={(e) => setConnectMode((state) => ({ ...state, relation: e.target.value }))}
            >
              {EDGE_RELATIONS.map((relation) => (
                <option key={relation} value={relation}>{relation}</option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={connectMode.required}
              onChange={(e) => setConnectMode((state) => ({ ...state, required: e.target.checked }))}
            />
            Required edge
          </label>
          {connectFromId ? (
            <button className="btn ghost" onClick={() => setConnectFromId(null)}>Cancel connect</button>
          ) : null}
        </aside>

        <section className="glass canvas-board" onClick={() => setSelectedNodeId(null)}>
          <div className="canvas-surface" ref={surfaceRef}>
            <svg className="canvas-edges" aria-hidden="true">
              {visibleEdges.map((entry) => {
                const source = nodeMap.get(entry.edge.source);
                const target = nodeMap.get(entry.edge.target);
                if (!source || !target) return null;
                const x1 = source.position.x + source.size.w / 2;
                const y1 = source.position.y + source.size.h / 2;
                const x2 = target.position.x + target.size.w / 2;
                const y2 = target.position.y + target.size.h / 2;
                return (
                  <line
                    key={`${entry.scope}:${entry.edge.id}`}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    className={`edge-line ${entry.scope === "cross" ? "cross" : ""}`}
                  />
                );
              })}
            </svg>
            {visibleNodes.map((node) => (
              <div
                key={node.id}
                className={`canvas-node ${selectedNodeId === node.id ? "selected" : ""} ${connectFromId === node.id ? "connect-source" : ""}`}
                style={{ left: node.position.x, top: node.position.y, width: node.size.w, height: node.size.h }}
                onPointerDown={(event) => startDrag(event, node)}
                onClick={(event) => {
                  event.stopPropagation();
                  handleNodeClick(node);
                }}
              >
                <div className="node-header">
                  <span className="node-type">{node.type}</span>
                  <span className="node-status">{node.status}</span>
                </div>
                <strong>{node.label}</strong>
                <p>{node.summary}</p>
              </div>
            ))}
          </div>
        </section>

        <aside className="glass canvas-panel">
          <h2>Inspector</h2>
          {selectedNode ? (
            <div className="stack">
              <div className="row between">
                <strong>{selectedNode.label}</strong>
                <button className="btn small" onClick={() => deleteNode(selectedNode.id)}>Delete</button>
              </div>
              <label>
                Label
                <input value={selectedNode.label} onChange={(e) => updateNode(selectedNode.id, { label: e.target.value })} />
              </label>
              <label>
                Summary
                <textarea
                  value={selectedNode.summary}
                  onChange={(e) => updateNode(selectedNode.id, { summary: e.target.value })}
                />
              </label>
              <div className="grid two">
                <label>
                  Type
                  <select value={selectedNode.type} onChange={(e) => updateNode(selectedNode.id, { type: e.target.value })}>
                    {NODE_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Status
                  <select value={selectedNode.status} onChange={(e) => updateNode(selectedNode.id, { status: e.target.value })}>
                    {NODE_STATUSES.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Priority
                <select value={selectedNode.priority || "medium"} onChange={(e) => updateNode(selectedNode.id, { priority: e.target.value })}>
                  {NODE_PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>{priority}</option>
                  ))}
                </select>
              </label>
              <div className="grid two">
                <label>
                  X
                  <input
                    value={selectedNode.position.x}
                    onChange={(e) => updateNode(selectedNode.id, { position: { ...selectedNode.position, x: Number(e.target.value) || 0 } })}
                  />
                </label>
                <label>
                  Y
                  <input
                    value={selectedNode.position.y}
                    onChange={(e) => updateNode(selectedNode.id, { position: { ...selectedNode.position, y: Number(e.target.value) || 0 } })}
                  />
                </label>
              </div>
              <div className="grid two">
                <label>
                  Width
                  <input
                    value={selectedNode.size.w}
                    onChange={(e) => updateNode(selectedNode.id, { size: { ...selectedNode.size, w: Number(e.target.value) || 1 } })}
                  />
                </label>
                <label>
                  Height
                  <input
                    value={selectedNode.size.h}
                    onChange={(e) => updateNode(selectedNode.id, { size: { ...selectedNode.size, h: Number(e.target.value) || 1 } })}
                  />
                </label>
              </div>
              <label>
                Acceptance criteria (one per line)
                <textarea
                  value={(selectedNode.acceptance_criteria || []).join("\n")}
                  onChange={(e) => updateNode(selectedNode.id, { acceptance_criteria: splitLines(e.target.value) })}
                />
              </label>
              <label>
                Details markdown
                <textarea
                  value={selectedNode.details_markdown || ""}
                  onChange={(e) => updateNode(selectedNode.id, { details_markdown: e.target.value })}
                />
              </label>
              <label>
                Tags (comma separated)
                <input
                  value={(selectedNode.tags || []).join(", ")}
                  onChange={(e) => updateNode(selectedNode.id, { tags: splitLines(e.target.value.replace(/,/g, "\n")) })}
                />
              </label>
            </div>
          ) : (
            <p className="subtle">Select a node to edit details.</p>
          )}

          <h3>Edges</h3>
          <div className="stack">
            {visibleEdges.length === 0 ? (
              <p className="subtle">No edges in current filters.</p>
            ) : (
              visibleEdges.map((entry) => {
                const source = nodeMap.get(entry.edge.source);
                const target = nodeMap.get(entry.edge.target);
                const edgeKey = `${entry.scope}:${entry.edge.id}`;
                return (
                  <div key={edgeKey} className={`edge-card ${selectedEdgeKey === edgeKey ? "active" : ""}`}>
                    <button className="edge-link" onClick={() => setSelectedEdgeKey(edgeKey)}>
                      {source?.label || entry.edge.source} → {target?.label || entry.edge.target}
                    </button>
                    <span className="mono">{entry.edge.relation}</span>
                    <button className="btn small" onClick={() => deleteEdge(entry.scope, entry.edge.id)}>Delete</button>
                  </div>
                );
              })
            )}
          </div>

          {selectedEdge?.edge ? (
            <div className="stack">
              <h4>Edge Details</h4>
              <label>
                Relation
                <select
                  value={selectedEdge.edge.relation}
                  onChange={(e) => updateEdge(selectedEdge.scope, selectedEdge.edge.id, { relation: e.target.value })}
                >
                  {EDGE_RELATIONS.map((relation) => (
                    <option key={relation} value={relation}>{relation}</option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selectedEdge.edge.required ?? true}
                  onChange={(e) => updateEdge(selectedEdge.scope, selectedEdge.edge.id, { required: e.target.checked })}
                />
                Required edge
              </label>
              <label>
                Notes
                <textarea
                  value={selectedEdge.edge.notes || ""}
                  onChange={(e) => updateEdge(selectedEdge.scope, selectedEdge.edge.id, { notes: e.target.value })}
                />
              </label>
              <label>
                Gates (one per line)
                <textarea
                  value={(selectedEdge.edge.gates || []).join("\n")}
                  onChange={(e) => updateEdge(selectedEdge.scope, selectedEdge.edge.id, { gates: splitLines(e.target.value) })}
                />
              </label>
            </div>
          ) : null}

          <h3>Export</h3>
          {validationErrors.length > 0 ? (
            <div className="notice error">
              <strong>Validation issues</strong>
              <ul>
                {validationErrors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="subtle">Plan passes schema checks and is ready to export.</p>
          )}
          <div className="button-row">
            <button className="btn" disabled={validationErrors.length > 0} onClick={copyExport}>Copy JSON</button>
            <button className="btn accent" disabled={validationErrors.length > 0} onClick={downloadExport}>Download</button>
          </div>
          <pre className="export-preview">{exportJson}</pre>
        </aside>
      </section>
    </main>
  );
}

function ParallelWorldsDashboardView() {
  const [dashboard, setDashboard] = useState(null);
  const [selectedBranchpoint, setSelectedBranchpoint] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionOutput, setActionOutput] = useState("");
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

  async function loadDashboard(branchpoint = selectedBranchpoint, initial = false) {
    const query = branchpoint ? `?branchpoint=${encodeURIComponent(branchpoint)}` : "";
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
        readJson(`${RUNS_API_PREFIX}/runs/${encodeURIComponent(normalizedRunId)}`),
        readJson(`${RUNS_API_PREFIX}/runs/${encodeURIComponent(normalizedRunId)}/diagram`),
      ]);

      const nextSummary = unwrapData(summaryPayload);
      const nextDiagram = normalizeDiagram(diagramPayload);
      setActiveRunId(normalizedRunId);
      setRunSummary(nextSummary);
      setRunDiagram(nextDiagram);

      if (nextDiagram.nodes.length > 0) {
        const stillExists = nextDiagram.nodes.some((node) => node.taskId === selectedTaskId);
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

    const source = new EventSource(`${RUNS_API_PREFIX}/runs/${encodeURIComponent(normalizedRunId)}/events`);
    eventSourceRef.current = source;

    source.onopen = () => {
      setEventStreamStatus("live");
    };

    source.onmessage = (evt) => {
      const row = serializeEvent(evt.data);
      setRunEvents((prev) => [row, ...prev].slice(0, 250));
      if (row.taskId && row.status) {
        setRunDiagram((prev) => {
          const nextNodes = prev.nodes.map((node) => (node.taskId === row.taskId ? { ...node, status: row.status } : node));
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
      const payload = await readJson(`${RUNS_API_PREFIX}/tasks/${encodeURIComponent(normalizedTaskId)}/artifacts`);
      const artifacts = normalizeArtifacts(payload);
      setTaskArtifactsById((prev) => ({ ...prev, [normalizedTaskId]: artifacts }));
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
      await readJson(`${RUNS_API_PREFIX}/tasks/${encodeURIComponent(taskId)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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

  const selectedTask = useMemo(() => runDiagram.nodes.find((node) => node.taskId === selectedTaskId) || null, [runDiagram.nodes, selectedTaskId]);

  const runStatusCounts = useMemo(() => statusCountsFromNodes(runDiagram.nodes), [runDiagram.nodes]);

  const completionPct = useMemo(() => {
    if (runSummary?.completion_pct !== undefined && runSummary?.completion_pct !== null) {
      return fmtPct(runSummary.completion_pct);
    }
    const total = runDiagram.nodes.length;
    if (!total) return "0%";
    const terminal = runStatusCounts.done + runStatusCounts.failed + runStatusCounts.stopped;
    return fmtPct((terminal / total) * 100);
  }, [runSummary, runDiagram.nodes.length, runStatusCounts]);

  const activeAgents = useMemo(() => {
    if (runSummary?.active_agents !== undefined && runSummary?.active_agents !== null) {
      return String(runSummary.active_agents);
    }
    if (runSummary?.counts?.running !== undefined && runSummary?.counts?.running !== null) {
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
        const stamp = evt.createdAt ? new Date(evt.createdAt).toLocaleTimeString() : "--:--:--";
        return `[${stamp}] ${evt.type}: ${evt.detail}`;
      })
      .join("\n");
  }, [selectedTask, taskEvents]);

  const selectedArtifacts = selectedTaskId ? taskArtifactsById[selectedTaskId] || [] : [];

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
      const payload = await readJson(`${API_BASE}/api/artifact?name=${encodeURIComponent(name)}`);
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
        <section className="glass loading-card">
          <h1>Parallel Worlds Dashboard</h1>
          <p>Loading repository state...</p>
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
          <p className="subtle">
            Branchpoint: <code>{branchpointLabel}</code>
          </p>
        </div>
        <div className="hero-actions">
          <button className="btn ghost" disabled={refreshing || busy} onClick={() => loadDashboard(selectedBranchpoint, false)}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button className="btn ghost" onClick={() => openArtifact("report.md")}>
            Open report.md
          </button>
          <button className="btn ghost" onClick={() => openArtifact("play.md")}>
            Open play.md
          </button>
        </div>
      </header>

      {error ? (
        <section className="glass notice error">
          <strong>Error:</strong> {error}
        </section>
      ) : null}

      {actionOutput ? (
        <section className="glass notice">
          <pre>{actionOutput}</pre>
        </section>
      ) : null}

      <section className="glass progress-shell">
        <div className="progress-head">
          <div>
            <p className="eyebrow">Symphony Operator View</p>
            <h2>Run Progress</h2>
            <p className="subtle">Monitor DAG execution and steer active tasks from one panel.</p>
          </div>
          <div className="progress-actions">
            <input
              value={runIdInput}
              onChange={(e) => setRunIdInput(e.target.value)}
              placeholder="run-id"
              aria-label="Run ID"
            />
            <button className="btn" disabled={runProgressLoading || !runIdInput.trim()} onClick={() => loadRunProgress(runIdInput.trim(), { initial: true })}>
              {runProgressLoading ? "Loading..." : "Load Run"}
            </button>
            <button className="btn ghost" disabled={!activeRunId || runProgressRefreshing} onClick={() => loadRunProgress(activeRunId, { initial: false })}>
              {runProgressRefreshing ? "Refreshing..." : "Refresh Run"}
            </button>
            {eventStreamStatus === "live" || eventStreamStatus === "connecting" ? (
              <button className="btn ghost" onClick={closeRunEventStream}>
                Disconnect Events
              </button>
            ) : (
              <button className="btn ghost" disabled={!activeRunId} onClick={() => connectRunEventStream(activeRunId)}>
                Connect Events
              </button>
            )}
            <button className="btn ghost" disabled={!activeRunId} onClick={clearRunProgress}>
              Clear
            </button>
          </div>
        </div>

        {runProgressError ? (
          <div className="notice error progress-error">
            <strong>Run API error:</strong> {runProgressError}
          </div>
        ) : null}

        <div className="progress-kpis">
          <article className="kpi-card">
            <p>Run ID</p>
            <strong>{activeRunId || "none"}</strong>
          </article>
          <article className="kpi-card">
            <p>Status</p>
            <strong className={`run-pill ${runStatusTone(runSummary?.status)}`}>{String(runSummary?.status || "pending")}</strong>
          </article>
          <article className="kpi-card">
            <p>Active agents</p>
            <strong>{activeAgents}</strong>
          </article>
          <article className="kpi-card">
            <p>Completion</p>
            <strong>{completionPct}</strong>
          </article>
          <article className="kpi-card">
            <p>Total tasks</p>
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
            <header>
              <h3>DAG Tasks</h3>
              <p className="subtle">{runDiagram.edges.length} dependency edges</p>
            </header>
            {runDiagram.nodes.length === 0 ? (
              <p className="subtle">Load a run to render task nodes.</p>
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
                    <span className={`dag-node-status ${node.status}`}>{node.status}</span>
                    <span className="dag-node-id mono">{node.taskId}</span>
                  </button>
                ))}
              </div>
            )}

            <header className="event-head">
              <h3>Live Events</h3>
              <p className="subtle">
                Stream: <code>{eventStreamStatus}</code>
              </p>
            </header>
            <div className="event-feed">
              {runEvents.length === 0 ? (
                <p className="subtle">No events yet. Connect stream or refresh run.</p>
              ) : (
                runEvents.map((event) => (
                  <article key={event.id} className="event-row">
                    <div className="event-row-head">
                      <strong>{event.type}</strong>
                      <span className="subtle">{event.taskId || "run"}</span>
                      <span className={`status-chip tiny ${event.status || "pending"}`}>{event.status || "info"}</span>
                    </div>
                    <p className="subtle">{event.detail}</p>
                  </article>
                ))
              )}
            </div>
          </section>

          <aside className="task-drawer">
            <header>
              <h3>Task Details</h3>
              <p className="subtle mono">{selectedTaskId || "none"}</p>
            </header>

            {selectedTask ? (
              <>
                <article className="task-meta-card">
                  <h4>{selectedTask.title}</h4>
                  <p className="subtle">{selectedTask.objective || "No objective provided."}</p>
                  <div className="status-counter-row compact">
                    <span className={`status-chip ${selectedTask.status}`}>{selectedTask.status}</span>
                    <span className="status-chip pending">priority: {selectedTask.priority ?? "n/a"}</span>
                  </div>
                </article>

                <div className="button-row">
                  <button className="btn small" disabled={taskActionBusy} onClick={() => taskControlAction(selectedTask.taskId, "pause")}>
                    Pause
                  </button>
                  <button className="btn small" disabled={taskActionBusy} onClick={() => taskControlAction(selectedTask.taskId, "resume")}>
                    Resume
                  </button>
                  <button className="btn small accent" disabled={taskActionBusy} onClick={() => taskControlAction(selectedTask.taskId, "stop")}>
                    Stop
                  </button>
                </div>

                <label>
                  Steering comment
                  <textarea
                    value={steerForm.comment}
                    onChange={(e) => setSteerForm((prev) => ({ ...prev, comment: e.target.value }))}
                    placeholder="Focus on deterministic retry behavior and include regression test coverage."
                  />
                </label>
                <label>
                  Prompt patch (optional)
                  <textarea
                    value={steerForm.promptPatch}
                    onChange={(e) => setSteerForm((prev) => ({ ...prev, promptPatch: e.target.value }))}
                    placeholder="Append: prioritize minimal diff and preserve public API compatibility."
                  />
                </label>
                <button
                  className="btn primary"
                  disabled={taskActionBusy || !steerForm.comment.trim()}
                  onClick={() =>
                    taskControlAction(selectedTask.taskId, "steer", {
                      comment: steerForm.comment.trim(),
                      prompt_patch: steerForm.promptPatch.trim(),
                    })
                  }
                >
                  {taskActionBusy ? "Submitting..." : "Send Steering"}
                </button>

                <div className="drawer-tabs">
                  <button className={`tab-btn ${drawerTab === "logs" ? "active" : ""}`} onClick={() => setDrawerTab("logs")}>Logs</button>
                  <button className={`tab-btn ${drawerTab === "artifacts" ? "active" : ""}`} onClick={() => setDrawerTab("artifacts")}>Artifacts</button>
                </div>

                {drawerTab === "logs" ? (
                  <pre className="drawer-pre">{logText}</pre>
                ) : (
                  <div className="artifact-list">
                    <div className="artifact-actions">
                      <button className="btn small" disabled={taskArtifactsLoading} onClick={() => loadTaskArtifacts(selectedTask.taskId, true)}>
                        {taskArtifactsLoading ? "Refreshing..." : "Refresh Artifacts"}
                      </button>
                    </div>
                    {selectedArtifacts.length === 0 ? (
                      <p className="subtle">No artifacts yet.</p>
                    ) : (
                      selectedArtifacts.map((item, idx) => (
                        <article key={item.id || `artifact-${idx}`} className="artifact-row">
                          <div className="artifact-top">
                            <strong>{item.kind || "artifact"}</strong>
                            <span className="subtle mono">{item.path || item.name || "inline"}</span>
                          </div>
                          {item.message ? <p className="subtle">{item.message}</p> : null}
                          {item.content ? <pre className="drawer-pre">{String(item.content)}</pre> : null}
                        </article>
                      ))
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="subtle">Select a DAG node to inspect logs, artifacts, and controls.</p>
            )}
          </aside>
        </div>
      </section>

      <section className="layout">
        <article className="glass panel">
          <h2>Prompt Agent</h2>
          <p className="subtle">One prompt can kickoff worlds, run codex/test execution, and optionally play render workflows.</p>
          <label>
            Prompt
            <textarea
              value={autopilot.prompt}
              onChange={(e) => setAutopilot((s) => ({ ...s, prompt: e.target.value }))}
              placeholder="Fix flaky checkout timeout and improve reliability."
            />
          </label>
          <div className="grid two">
            <label>
              World count
              <input
                value={autopilot.count}
                onChange={(e) => setAutopilot((s) => ({ ...s, count: e.target.value }))}
                placeholder="3"
              />
            </label>
            <label>
              From ref (optional)
              <input
                value={autopilot.fromRef}
                onChange={(e) => setAutopilot((s) => ({ ...s, fromRef: e.target.value }))}
                placeholder="main"
              />
            </label>
          </div>
          <label>
            Strategies (optional, one per line: <code>name::notes</code>)
            <textarea
              value={autopilot.strategies}
              onChange={(e) => setAutopilot((s) => ({ ...s, strategies: e.target.value }))}
              placeholder={"surgical-fix::minimal patch\nfix-plus-tests::add regression tests"}
            />
          </label>
          <div className="grid checks">
            <label className="check">
              <input
                type="checkbox"
                checked={autopilot.run}
                onChange={(e) => setAutopilot((s) => ({ ...s, run: e.target.checked }))}
              />
              Run after kickoff
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={autopilot.play}
                onChange={(e) => setAutopilot((s) => ({ ...s, play: e.target.checked }))}
              />
              Play after run
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={autopilot.skipCodex}
                onChange={(e) => setAutopilot((s) => ({ ...s, skipCodex: e.target.checked }))}
              />
              Skip codex
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={autopilot.skipRunner}
                onChange={(e) => setAutopilot((s) => ({ ...s, skipRunner: e.target.checked }))}
              />
              Skip runner
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

        <article className="glass panel">
          <h2>Branchpoint Controls</h2>
          <label>
            Branchpoint
            <select value={selectedBranchpoint} onChange={(e) => loadDashboard(e.target.value, false)}>
              <option value="">Latest</option>
              {branchpoints.map((bp) => (
                <option key={bp.id} value={bp.id}>
                  {bp.id} ({bp.status || "created"})
                </option>
              ))}
            </select>
          </label>

          <h3>Kickoff</h3>
          <label>
            Intent
            <textarea
              value={kickoff.intent}
              onChange={(e) => setKickoff((s) => ({ ...s, intent: e.target.value }))}
              placeholder="Refactor auth module to reduce branch complexity."
            />
          </label>
          <div className="grid two">
            <label>
              Count
              <input value={kickoff.count} onChange={(e) => setKickoff((s) => ({ ...s, count: e.target.value }))} />
            </label>
            <label>
              From ref
              <input
                value={kickoff.fromRef}
                onChange={(e) => setKickoff((s) => ({ ...s, fromRef: e.target.value }))}
                placeholder="main"
              />
            </label>
          </div>
          <label>
            Strategies (optional)
            <textarea
              value={kickoff.strategies}
              onChange={(e) => setKickoff((s) => ({ ...s, strategies: e.target.value }))}
              placeholder="thin-refactor::extract boundaries"
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
            Create Worlds
          </button>

          <h3>Run / Play</h3>
          <label>
            World filter(s), comma or space separated
            <input value={runForm.worlds} onChange={(e) => setRunForm((s) => ({ ...s, worlds: e.target.value }))} />
          </label>
          <div className="grid checks">
            <label className="check">
              <input
                type="checkbox"
                checked={runForm.skipCodex}
                onChange={(e) => setRunForm((s) => ({ ...s, skipCodex: e.target.checked }))}
              />
              Skip codex
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={runForm.skipRunner}
                onChange={(e) => setRunForm((s) => ({ ...s, skipRunner: e.target.checked }))}
              />
              Skip runner
            </label>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                postAction("run", {
                  branchpoint: selectedBranchpoint || "",
                  worlds: runForm.worlds,
                  skip_codex: runForm.skipCodex,
                  skip_runner: runForm.skipRunner,
                })
              }
            >
              Run Branchpoint
            </button>
            <button
              className="btn"
              disabled={busy}
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
              Play Branchpoint
            </button>
          </div>
          <div className="grid two">
            <label>
              Play worlds
              <input value={playForm.worlds} onChange={(e) => setPlayForm((s) => ({ ...s, worlds: e.target.value }))} />
            </label>
            <label>
              Render timeout
              <input
                value={playForm.timeout}
                onChange={(e) => setPlayForm((s) => ({ ...s, timeout: e.target.value }))}
                placeholder="180"
              />
            </label>
          </div>
          <label>
            Render command override
            <input
              value={playForm.renderCommand}
              onChange={(e) => setPlayForm((s) => ({ ...s, renderCommand: e.target.value }))}
              placeholder="npm run dev:smoke"
            />
          </label>
          <label>
            Preview lines
            <input
              value={playForm.previewLines}
              onChange={(e) => setPlayForm((s) => ({ ...s, previewLines: e.target.value }))}
              placeholder="25"
            />
          </label>
        </article>
      </section>

      <section className="glass worlds-panel">
        <div className="worlds-header">
          <h2>World Blocks</h2>
          <p className="subtle">
            Click <strong>Fork</strong> on any block to split a new branchpoint from that world branch.
          </p>
        </div>
        {worldRows.length === 0 ? (
          <p className="subtle">No worlds yet. Create one with Kickoff or Prompt Agent.</p>
        ) : (
          <div className="world-grid">
            {worldRows.map((row) => {
              const world = row.world;
              const run = row.run;
              const codex = row.codex;
              const render = row.render;
              return (
                <article key={world.id} className={`world-card tone-${statusTone(world.status)}`}>
                  <div className="world-head">
                    <h3>
                      {String(world.index).padStart(2, "0")} {world.name}
                    </h3>
                    <span className={`status ${statusTone(world.status)}`}>{world.status || "ready"}</span>
                  </div>
                  <p className="mono">{world.branch}</p>
                  <p className="subtle">{world.notes || "No strategy notes."}</p>
                  <div className="metrics">
                    <span>Codex: {codex ? codex.exit_code ?? "n/a" : "n/a"}</span>
                    <span>Run: {run ? run.exit_code ?? "n/a" : "n/a"}</span>
                    <span>Render: {render ? render.exit_code ?? "n/a" : "n/a"}</span>
                    <span>Run time: {fmtDuration(run?.duration_sec)}</span>
                  </div>
                  <div className="button-row">
                    <button className="btn small" disabled={busy} onClick={() => postAction("run", { branchpoint: selectedBranchpoint || "", worlds: world.id })}>
                      Run
                    </button>
                    <button className="btn small" disabled={busy} onClick={() => postAction("play", { branchpoint: selectedBranchpoint || "", worlds: world.id })}>
                      Play
                    </button>
                    <button className="btn small" disabled={busy} onClick={() => postAction("select", { branchpoint: selectedBranchpoint || "", world: world.id, merge: false })}>
                      Select
                    </button>
                    <button className="btn small accent" disabled={busy} onClick={() => forkFromWorld(world)}>
                      Fork
                    </button>
                  </div>
                  <div className="button-row">
                    <button className="link-btn" onClick={() => openLog("codex", world.id)}>
                      Codex log
                    </button>
                    <button className="link-btn" onClick={() => openLog("run", world.id)}>
                      Run log
                    </button>
                    <button className="link-btn" onClick={() => openLog("render", world.id)}>
                      Render log
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="layout logs">
        <article className="glass panel">
          <h2>
            Artifact: <code>{artifactName}</code>
          </h2>
          <pre>{artifactText || "No artifact loaded yet."}</pre>
        </article>
        <article className="glass panel">
          <h2>
            Log:{" "}
            {logState.kind ? (
              <code>
                {logState.kind} / {logState.world}
              </code>
            ) : (
              "none"
            )}
          </h2>
          <p className="subtle mono">{logState.path || ""}</p>
          <pre>{logState.loading ? "Loading log..." : logState.text || "Select a log from a world block."}</pre>
        </article>
      </section>
    </main>
  );
}

export default function App() {
  const [view, setView] = useState("canvas");

  return (
    <div className="app-root">
      <div className="view-switch">
        <button className={`btn small ${view === "canvas" ? "active" : "ghost"}`} onClick={() => setView("canvas")}>
          Canvas
        </button>
        <button className={`btn small ${view === "dashboard" ? "active" : "ghost"}`} onClick={() => setView("dashboard")}>
          Dashboard
        </button>
      </div>
      {view === "canvas" ? <CanvasPlannerView /> : <ParallelWorldsDashboardView />}
    </div>
  );
}
