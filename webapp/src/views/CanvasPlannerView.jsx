import React, { useEffect, useMemo, useRef, useState } from "react";
import NodeDetails from "../components/NodeDetails";
import {
  EDGE_RELATIONS,
  LOCAL_STORAGE_KEY,
  MAX_SCALE,
  MIN_SCALE,
  NODE_TYPES,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "../lib/constants";
import { randomId } from "../lib/ids";
import { clamp, defaultPlan, nowIso, splitLines, validatePlan } from "../lib/plan";
import { usePlanDraft } from "../hooks/usePlanDraft";

export default function CanvasPlannerView() {
  const { plan, setPlan } = usePlanDraft();
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState(null);
  const [connectMode, setConnectMode] = useState({
    active: false,
    scope: "layer",
    relation: "depends_on",
    required: true,
  });
  const [connectFromId, setConnectFromId] = useState(null);
  const [editingNodeId, setEditingNodeId] = useState(null);
  const [editingLayerId, setEditingLayerId] = useState(null);
  const [layerNameDraft, setLayerNameDraft] = useState("");
  const [toolbarNodeType, setToolbarNodeType] = useState("module");
  const [showSettings, setShowSettings] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [nodeDetailsId, setNodeDetailsId] = useState(null);
  const [toast, setToast] = useState("");

  const [viewport, setViewport] = useState({ x: 120, y: 120, scale: 1 });
  const [panState, setPanState] = useState(null);
  const [dragState, setDragState] = useState(null);

  const viewportRef = useRef(null);
  const exportMenuRef = useRef(null);

  useEffect(() => {
    if (!selectedLayerId || !plan.layers.some((layer) => layer.id === selectedLayerId)) {
      setSelectedLayerId(plan.layers[0]?.id || "");
    }
  }, [plan.layers, selectedLayerId]);

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
    if (!showExportMenu) return;
    function onClick(event) {
      if (!exportMenuRef.current) return;
      if (exportMenuRef.current.contains(event.target)) return;
      setShowExportMenu(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [showExportMenu]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!dragState && !panState) return;
    function onPointerMove(event) {
      if (dragState) {
        const world = worldFromClient(event.clientX, event.clientY);
        setPlan((prev) => ({
          ...prev,
          updated_at: nowIso(),
          layers: prev.layers.map((layer) => ({
            ...layer,
            nodes: layer.nodes.map((node) =>
              node.id === dragState.nodeId
                ? {
                    ...node,
                    position: {
                      x: Math.round(world.x - dragState.offsetX),
                      y: Math.round(world.y - dragState.offsetY),
                    },
                  }
                : node,
            ),
          })),
        }));
      }
      if (panState) {
        const deltaX = event.clientX - panState.startX;
        const deltaY = event.clientY - panState.startY;
        setViewport((prev) => ({ ...prev, x: panState.startPanX + deltaX, y: panState.startPanY + deltaY }));
      }
    }
    function onPointerUp() {
      setDragState(null);
      setPanState(null);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragState, panState, viewport.scale, viewport.x, viewport.y, setPlan]);

  const layersSorted = useMemo(
    () => [...plan.layers].sort((a, b) => (a.order || 0) - (b.order || 0)),
    [plan.layers],
  );

  const activeLayer = useMemo(
    () => plan.layers.find((layer) => layer.id === selectedLayerId) || layersSorted[0] || null,
    [plan.layers, selectedLayerId, layersSorted],
  );

  const nodeMap = useMemo(() => {
    const map = new Map();
    plan.layers.forEach((layer) => {
      layer.nodes.forEach((node) => map.set(node.id, node));
    });
    return map;
  }, [plan.layers]);

  const visibleLayers = useMemo(() => (activeLayer ? [activeLayer] : []), [activeLayer]);
  const visibleNodes = useMemo(() => visibleLayers.flatMap((layer) => layer.nodes), [visibleLayers]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);

  const visibleEdges = useMemo(() => {
    const layerEdges = visibleLayers.flatMap((layer) =>
      layer.edges.map((edge) => ({ scope: "layer", layerId: layer.id, edge })),
    );
    const crossEdges = plan.cross_layer_edges.map((edge) => ({ scope: "cross", layerId: null, edge }));
    return [...layerEdges, ...crossEdges].filter(
      (entry) => visibleNodeIds.has(entry.edge.source) && visibleNodeIds.has(entry.edge.target),
    );
  }, [visibleLayers, plan.cross_layer_edges, visibleNodeIds]);

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

  function worldFromClient(clientX, clientY) {
    if (!viewportRef.current) return { x: 0, y: 0 };
    const rect = viewportRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left - viewport.x) / viewport.scale,
      y: (clientY - rect.top - viewport.y) / viewport.scale,
    };
  }

  function viewportCenterWorld() {
    if (!viewportRef.current) return { x: 0, y: 0 };
    const rect = viewportRef.current.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    return {
      x: (centerX - viewport.x) / viewport.scale,
      y: (centerY - viewport.y) / viewport.scale,
    };
  }

  function resetDraft() {
    setPlan(defaultPlan());
    setSelectedLayerId("");
    setSelectedNodeId(null);
    setSelectedEdgeKey(null);
    setConnectFromId(null);
    setEditingNodeId(null);
    setToast("Draft reset to defaults.");
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
    const newLayer = {
      id: randomId("layer"),
      name: "New Layer",
      kind: "module",
      pov: "engineering",
      order: plan.layers.length + 1,
      nodes: [],
      edges: [],
    };
    updatePlan((prev) => ({ ...prev, layers: [...prev.layers, newLayer] }));
    setSelectedLayerId(newLayer.id);
    setEditingLayerId(newLayer.id);
    setLayerNameDraft(newLayer.name);
  }

  function renameLayer(layerId) {
    if (!layerNameDraft.trim()) {
      setToast("Layer name is required.");
      return;
    }
    updatePlan((prev) => ({
      ...prev,
      layers: prev.layers.map((layer) => (layer.id === layerId ? { ...layer, name: layerNameDraft.trim() } : layer)),
    }));
    setEditingLayerId(null);
  }

  function deleteLayer(layerId) {
    const layer = plan.layers.find((item) => item.id === layerId);
    if (!layer) return;
    if (layer.nodes.length > 0) {
      setToast("Delete nodes in the layer before removing it.");
      return;
    }
    updatePlan((prev) => ({ ...prev, layers: prev.layers.filter((item) => item.id !== layerId) }));
    if (selectedLayerId === layerId) setSelectedLayerId("");
    setToast("Layer removed.");
  }

  function addNode() {
    const targetLayerId = selectedLayerId || plan.layers[0]?.id;
    if (!targetLayerId) {
      setToast("Create a layer before adding nodes.");
      return;
    }
    const center = viewportCenterWorld();
    const size = { w: 240, h: 120 };
    const newNode = {
      id: randomId("node"),
      layer_id: targetLayerId,
      type: toolbarNodeType,
      label: "New node",
      summary: "Describe this node.",
      position: { x: Math.round(center.x - size.w / 2), y: Math.round(center.y - size.h / 2) },
      size,
      status: "draft",
      priority: "medium",
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
    setEditingNodeId(newNode.id);
    setToast("Node added. Edit inline.");
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
    setEditingNodeId(null);
    setToast("Node removed.");
  }

  function startDrag(event, node) {
    if (connectMode.active) return;
    if (event.target.closest("input, textarea, button, select")) return;
    event.stopPropagation();
    const world = worldFromClient(event.clientX, event.clientY);
    setDragState({
      nodeId: node.id,
      offsetX: world.x - node.position.x,
      offsetY: world.y - node.position.y,
    });
  }

  function handleCanvasPointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest(".canvas-node")) return;
    setPanState({
      startX: event.clientX,
      startY: event.clientY,
      startPanX: viewport.x,
      startPanY: viewport.y,
    });
    setSelectedNodeId(null);
    setSelectedEdgeKey(null);
  }

  function handleWheel(event) {
    event.preventDefault();
    if (!viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const worldX = (cursorX - viewport.x) / viewport.scale;
    const worldY = (cursorY - viewport.y) / viewport.scale;
    const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1;
    const nextScale = clamp(viewport.scale * zoomFactor, MIN_SCALE, MAX_SCALE);
    const nextPanX = cursorX - worldX * nextScale;
    const nextPanY = cursorY - worldY * nextScale;
    setViewport({ x: nextPanX, y: nextPanY, scale: nextScale });
  }

  function handleNodeClick(node) {
    if (connectMode.active) {
      if (!connectFromId) {
        setConnectFromId(node.id);
        setToast("Select a target node to create the edge.");
        return;
      }
      if (connectFromId === node.id) {
        setToast("Source and target must be different nodes.");
        setConnectFromId(null);
        return;
      }
      const sourceNode = nodeMap.get(connectFromId);
      const targetNode = node;
      if (!sourceNode) {
        setToast("Source node not found.");
        setConnectFromId(null);
        return;
      }
      if (connectMode.scope === "layer" && sourceNode.layer_id !== targetNode.layer_id) {
        setToast("Layer edges require source and target in the same layer.");
        setConnectFromId(null);
        return;
      }
      const hasDuplicate = (edges) =>
        edges.some(
          (edge) => edge.source === sourceNode.id && edge.target === targetNode.id && edge.relation === connectMode.relation,
        );
      if (connectMode.scope === "cross" && hasDuplicate(plan.cross_layer_edges)) {
        setToast("Duplicate cross-layer edge already exists.");
        setConnectFromId(null);
        return;
      }
      if (connectMode.scope === "layer") {
        const layer = plan.layers.find((item) => item.id === sourceNode.layer_id);
        if (layer && hasDuplicate(layer.edges)) {
          setToast("Duplicate layer edge already exists.");
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
      setToast("Edge created.");
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
    setToast("Edge removed.");
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
      .then(() => setToast("Export JSON copied to clipboard."))
      .catch(() => setToast("Unable to copy JSON."));
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
    setToast(`Downloaded ${filename}.`);
  }

  const connectFromLabel = connectFromId ? nodeMap.get(connectFromId)?.label || connectFromId : null;
  const activeLayerLabel = activeLayer ? activeLayer.name : "No layer";

  return (
    <div className="canvas-root">
      <div className="canvas-toolbar">
        <div className="toolbar-section">
          <span className="toolbar-title">Symphony Planner</span>
          <button className="btn small" onClick={addNode}>Add Node</button>
          <select
            className="toolbar-select"
            value={toolbarNodeType}
            onChange={(e) => setToolbarNodeType(e.target.value)}
          >
            {NODE_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <div className="toolbar-divider" />
          <label className="check toolbar-check">
            <input
              type="checkbox"
              checked={connectMode.active}
              onChange={(e) => {
                setConnectMode((state) => ({ ...state, active: e.target.checked }));
                setConnectFromId(null);
              }}
            />
            Connect
          </label>
          <select
            className="toolbar-select"
            value={connectMode.scope}
            onChange={(e) => setConnectMode((state) => ({ ...state, scope: e.target.value }))}
          >
            <option value="layer">Layer edge</option>
            <option value="cross">Cross-layer edge</option>
          </select>
          <select
            className="toolbar-select"
            value={connectMode.relation}
            onChange={(e) => setConnectMode((state) => ({ ...state, relation: e.target.value }))}
          >
            {EDGE_RELATIONS.map((relation) => (
              <option key={relation} value={relation}>{relation}</option>
            ))}
          </select>
          <label className="check toolbar-check">
            <input
              type="checkbox"
              checked={connectMode.required}
              onChange={(e) => setConnectMode((state) => ({ ...state, required: e.target.checked }))}
            />
            Required
          </label>
          {connectFromLabel ? <span className="toolbar-hint">From: {connectFromLabel}</span> : null}
        </div>
        <div className="toolbar-section">
          <button className="btn ghost small" onClick={() => setShowSettings(true)}>Plan Settings</button>
          <button className="btn ghost small" onClick={resetDraft}>Reset</button>
          <button className="btn ghost small" onClick={clearDraft}>Clear Draft</button>
          <button
            className={`btn small ${validationErrors.length ? "danger" : "success"}`}
            onClick={() => setShowValidation(true)}
          >
            {validationErrors.length ? `${validationErrors.length} Issues` : "Valid"}
          </button>
          <div className="toolbar-menu" ref={exportMenuRef}>
            <button className="btn accent small" onClick={() => setShowExportMenu((prev) => !prev)}>Export</button>
            {showExportMenu ? (
              <div className="toolbar-dropdown">
                <button className="menu-item" disabled={validationErrors.length > 0} onClick={copyExport}>Copy JSON</button>
                <button className="menu-item" disabled={validationErrors.length > 0} onClick={downloadExport}>Download JSON</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <aside className="layer-panel">
        <div className="layer-panel-header">
          <span className="mono">Pages</span>
          <button className="btn small" onClick={addLayer}>+</button>
        </div>
        <div className="layer-list">
          {layersSorted.map((layer) => {
            const active = layer.id === activeLayer?.id;
            return (
              <div key={layer.id} className={`layer-item ${active ? "active" : ""}`}>
                {editingLayerId === layer.id ? (
                  <input
                    className="layer-input"
                    value={layerNameDraft}
                    onChange={(e) => setLayerNameDraft(e.target.value)}
                    onBlur={() => renameLayer(layer.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameLayer(layer.id);
                      if (e.key === "Escape") setEditingLayerId(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <button className="layer-button" onClick={() => setSelectedLayerId(layer.id)}>
                    {layer.name}
                  </button>
                )}
                <div className="layer-actions">
                  <button
                    className="layer-action"
                    onClick={() => {
                      setEditingLayerId(layer.id);
                      setLayerNameDraft(layer.name);
                    }}
                  >
                    Rename
                  </button>
                  <button className="layer-action danger" onClick={() => deleteLayer(layer.id)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="layer-panel-footer">Active: {activeLayerLabel}</div>
      </aside>

      <div
        className="canvas-viewport"
        ref={viewportRef}
        onPointerDown={handleCanvasPointerDown}
        onWheel={handleWheel}
      >
        <div
          className="canvas-world"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          <svg className="canvas-edges" width={WORLD_WIDTH} height={WORLD_HEIGHT} aria-hidden="true">
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
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedEdgeKey(`${entry.scope}:${entry.edge.id}`);
                  }}
                />
              );
            })}
          </svg>
          {visibleNodes.map((node) => {
            const isEditing = editingNodeId === node.id;
            return (
              <div
                key={node.id}
                className={`canvas-node ${selectedNodeId === node.id ? "selected" : ""} ${connectFromId === node.id ? "connect-source" : ""} ${isEditing ? "editing" : ""}`}
                style={{ left: node.position.x, top: node.position.y, width: node.size.w, height: node.size.h }}
                onPointerDown={(event) => startDrag(event, node)}
                onClick={(event) => {
                  event.stopPropagation();
                  handleNodeClick(node);
                }}
                onDoubleClick={() => setEditingNodeId(node.id)}
              >
                <div className="node-header">
                  <span className="node-type">{node.type}</span>
                  <span className="node-status">{node.status}</span>
                </div>
                {isEditing ? (
                  <div
                    className="node-inline-edit"
                    onBlur={(event) => {
                      if (event.currentTarget.contains(event.relatedTarget)) return;
                      setEditingNodeId(null);
                    }}
                  >
                    <input
                      className="node-edit-input"
                      value={node.label}
                      onChange={(e) => updateNode(node.id, { label: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setEditingNodeId(null);
                        }
                      }}
                      autoFocus
                    />
                    <textarea
                      className="node-edit-textarea"
                      value={node.summary}
                      onChange={(e) => updateNode(node.id, { summary: e.target.value })}
                      rows={3}
                    />
                    <div className="node-inline-actions">
                      <button className="btn small" onClick={() => setEditingNodeId(null)}>Done</button>
                      <button className="btn small ghost" onClick={() => deleteNode(node.id)}>Delete</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <strong>{node.label}</strong>
                    <p>{node.summary}</p>
                    <div className="node-actions">
                      <button className="node-chip" onClick={() => setEditingNodeId(node.id)}>Edit</button>
                      <button className="node-chip" onClick={() => setNodeDetailsId(node.id)}>Details</button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showSettings ? (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>Plan Settings</h3>
              <button className="btn small ghost" onClick={() => setShowSettings(false)}>Close</button>
            </div>
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
            <label>
              Tech stack (one per line)
              <textarea
                value={(plan.metadata.constraints?.tech_stack || []).join("\n")}
                onChange={(e) =>
                  updatePlan((prev) => ({
                    ...prev,
                    metadata: {
                      ...prev.metadata,
                      constraints: {
                        ...prev.metadata.constraints,
                        tech_stack: splitLines(e.target.value),
                      },
                    },
                  }))
                }
              />
            </label>
            <label>
              Non-functional requirements (one per line)
              <textarea
                value={(plan.metadata.constraints?.non_functional_requirements || []).join("\n")}
                onChange={(e) =>
                  updatePlan((prev) => ({
                    ...prev,
                    metadata: {
                      ...prev.metadata,
                      constraints: {
                        ...prev.metadata.constraints,
                        non_functional_requirements: splitLines(e.target.value),
                      },
                    },
                  }))
                }
              />
            </label>
            <label>
              Excluded paths (one per line)
              <textarea
                value={(plan.metadata.constraints?.excluded_paths || []).join("\n")}
                onChange={(e) =>
                  updatePlan((prev) => ({
                    ...prev,
                    metadata: {
                      ...prev.metadata,
                      constraints: {
                        ...prev.metadata.constraints,
                        excluded_paths: splitLines(e.target.value),
                      },
                    },
                  }))
                }
              />
            </label>
          </div>
        </div>
      ) : null}

      {showValidation ? (
        <div className="modal-backdrop" onClick={() => setShowValidation(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>Validation</h3>
              <button className="btn small ghost" onClick={() => setShowValidation(false)}>Close</button>
            </div>
            {validationErrors.length ? (
              <ul className="validation-list">
                {validationErrors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            ) : (
              <p className="subtle">Plan passes schema checks.</p>
            )}
          </div>
        </div>
      ) : null}

      {nodeDetailsId ? (
        <div className="modal-backdrop" onClick={() => setNodeDetailsId(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>Node Details</h3>
              <button className="btn small ghost" onClick={() => setNodeDetailsId(null)}>Close</button>
            </div>
            {nodeMap.get(nodeDetailsId) ? (
              <NodeDetails
                node={nodeMap.get(nodeDetailsId)}
                updateNode={updateNode}
                deleteNode={deleteNode}
              />
            ) : (
              <p className="subtle">Node not found.</p>
            )}
          </div>
        </div>
      ) : null}

      {selectedEdge?.edge ? (
        <div className="edge-drawer">
          <div className="edge-drawer-header">
            <strong>Edge</strong>
            <button className="btn small ghost" onClick={() => setSelectedEdgeKey(null)}>Close</button>
          </div>
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
          <button className="btn small" onClick={() => deleteEdge(selectedEdge.scope, selectedEdge.edge.id)}>Delete Edge</button>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
