import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const RUNS_API_PREFIX = `${API_BASE}/api/v1`;
const TASK_STATES = ["pending", "running", "blocked", "done", "failed", "paused", "stopped"];

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

export default function App() {
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
          </div>
          <div className="button-row">
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
