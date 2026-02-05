import React, { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "";

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

function parentPath(rawPath) {
  const normalized = String(rawPath || "").trim().replace(/[\\/]+$/, "");
  if (!normalized) return "";
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (slash <= 0) return normalized;
  return normalized.slice(0, slash);
}

function statusTone(status) {
  if (status === "pass") return "pass";
  if (status === "fail" || status === "error") return "fail";
  if (status === "running" || status === "ran") return "run";
  if (status === "played") return "play";
  if (status === "ready") return "ready";
  return "muted";
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "n/a";
  return `${seconds}s`;
}

function compareCreatedAsc(a, b) {
  const leftTs = Date.parse(String(a?.createdAt || ""));
  const rightTs = Date.parse(String(b?.createdAt || ""));
  const leftOk = Number.isFinite(leftTs);
  const rightOk = Number.isFinite(rightTs);
  if (leftOk && rightOk && leftTs !== rightTs) {
    return leftTs - rightTs;
  }
  if (leftOk && !rightOk) return -1;
  if (!leftOk && rightOk) return 1;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

async function readJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const err = payload.error || payload.output || `Request failed (${response.status})`;
    throw new Error(err);
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function apiUrl(path) {
  const base = String(API_BASE || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [selectedBranchpoint, setSelectedBranchpoint] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickingPath, setPickingPath] = useState(false);
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

  const [projectForm, setProjectForm] = useState({
    path: "",
    name: "",
    basePath: "",
    baseBranch: "main",
    configName: "parallel_worlds.json",
  });

  const [switchForm, setSwitchForm] = useState({
    path: "",
    name: "",
    baseBranch: "main",
    configName: "parallel_worlds.json",
  });

  const [autopilot, setAutopilot] = useState({
    prompt: "",
    count: "4",
    maxCount: "4",
    fromRef: "",
    strategies: "",
    run: true,
    play: false,
    skipCodex: false,
    skipRunner: false,
  });

  const [kickoff, setKickoff] = useState({
    intent: "",
    count: "4",
    maxCount: "4",
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
  const [compareWorldIds, setCompareWorldIds] = useState([]);
  const [renderViewOpen, setRenderViewOpen] = useState(false);
  const [renderViewLogs, setRenderViewLogs] = useState({});

  async function loadDashboard(branchpoint = selectedBranchpoint, initial = false, opts = {}) {
    const { silent = false } = opts;
    const query = branchpoint ? `?branchpoint=${encodeURIComponent(branchpoint)}` : "";
    if (initial) setLoading(true);
    else if (!silent) setRefreshing(true);
    if (!silent) setError("");
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
      if (!silent) setError(err.message);
    } finally {
      if (initial) setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bp = params.get("branchpoint") || "";
    const rawWorlds = params.get("worlds") || "";
    const initialWorlds = rawWorlds
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 2);
    if (initialWorlds.length > 0) {
      setCompareWorldIds(initialWorlds);
    }
    if ((params.get("view") || "").toLowerCase() === "render") {
      setRenderViewOpen(true);
    }
    loadDashboard(bp, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const worldRows = dashboard?.world_rows || [];
  const branchpoints = dashboard?.branchpoints || [];
  const branchpointWorldMap = dashboard?.branchpoint_worlds || {};
  const branchpoint = dashboard?.branchpoint || null;
  const summary = dashboard?.summary || {};
  const activeRepo = dashboard?.repo || "";
  const activeConfig = dashboard?.config || "";

  useEffect(() => {
    let fallback = parentPath(activeRepo);
    if (!fallback) return;

    if (fallback === "/Users/sbae703") {
      fallback = "/Users/sbae703/codex_projects";
    }

    setProjectForm((s) => (s.basePath.trim() ? s : { ...s, basePath: fallback }));
  }, [activeRepo]);

  const branchpointLabel = useMemo(() => {
    if (!branchpoint) return "none";
    return `${branchpoint.id} (${branchpoint.status || "created"})`;
  }, [branchpoint]);

  const openBranches = Number.isInteger(summary.open_branches_current)
    ? summary.open_branches_current
    : worldRows.length;

  const awaitingMerge = Number.isInteger(summary.awaiting_merge_current)
    ? summary.awaiting_merge_current
    : worldRows.filter((row) => row.world.status === "pass" || row.world.id === branchpoint?.selected_world_id).length;

  const effectiveProjectBasePath = projectForm.basePath.trim() || parentPath(activeRepo);
  const canCreateProject = Boolean(projectForm.path.trim() || projectForm.name.trim());
  const dagRows = worldRows
    .map((row) => {
      const world = row.world || {};
      const live = row.live || {};
      return {
        id: world.id || "",
        name: world.name || "world",
        branch: world.branch || "",
        status: world.status || "ready",
        head: live.head || "n/a",
        commits: Number.isInteger(live.ahead_commits) ? live.ahead_commits : 0,
        dirty: Number.isInteger(live.dirty_files) ? live.dirty_files : 0,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const branchpointLineage = useMemo(() => {
    const nodes = (Array.isArray(branchpoints) ? branchpoints : [])
      .map((bp) => ({
        id: String(bp?.id || "").trim(),
        sourceRef: String(bp?.source_ref || "").trim(),
        baseBranch: String(bp?.base_branch || "").trim() || "main",
        status: String(bp?.status || "created").trim() || "created",
        createdAt: String(bp?.created_at || "").trim(),
      }))
      .filter((bp) => bp.id);

    if (nodes.length === 0) {
      return { rows: [], total: 0 };
    }

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const worldsByBranchpoint = new Map();
    const worldBranchOwner = new Map();

    for (const node of nodes) {
      const rawWorlds = Array.isArray(branchpointWorldMap[node.id]) ? branchpointWorldMap[node.id] : [];
      const worlds = rawWorlds
        .map((world) => ({
          id: String(world?.id || "").trim(),
          name: String(world?.name || "world").trim() || "world",
          branch: String(world?.branch || "").trim(),
          status: String(world?.status || "ready").trim() || "ready",
          index: Number.isInteger(world?.index) ? world.index : null,
        }))
        .filter((world) => world.id);

      worlds.sort((left, right) => {
        const leftIndex = Number.isInteger(left.index) ? left.index : 10_000;
        const rightIndex = Number.isInteger(right.index) ? right.index : 10_000;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        return String(left.name).localeCompare(String(right.name));
      });

      worldsByBranchpoint.set(node.id, worlds);
      for (const world of worlds) {
        if (world.branch && !worldBranchOwner.has(world.branch)) {
          worldBranchOwner.set(world.branch, node.id);
        }
      }
    }

    const parentById = new Map();
    const childrenById = new Map();

    for (const node of nodes) {
      const parentId = worldBranchOwner.get(node.sourceRef);
      if (parentId && parentId !== node.id) {
        parentById.set(node.id, parentId);
        if (!childrenById.has(parentId)) {
          childrenById.set(parentId, []);
        }
        childrenById.get(parentId).push(node.id);
      }
    }

    for (const children of childrenById.values()) {
      children.sort((leftId, rightId) => compareCreatedAsc(byId.get(leftId), byId.get(rightId)));
    }

    const sourceGroups = new Map();
    for (const node of nodes) {
      if (parentById.has(node.id)) continue;
      const sourceRef = node.sourceRef || node.baseBranch || "main";
      if (!sourceGroups.has(sourceRef)) {
        sourceGroups.set(sourceRef, []);
      }
      sourceGroups.get(sourceRef).push(node.id);
    }

    for (const roots of sourceGroups.values()) {
      roots.sort((leftId, rightId) => compareCreatedAsc(byId.get(leftId), byId.get(rightId)));
    }

    const rows = [];
    const visited = new Set();

    const walk = (nodeId, depth) => {
      if (!nodeId || visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = byId.get(nodeId);
      if (!node) return;
      rows.push({
        type: "branchpoint",
        key: `bp:${node.id}`,
        depth,
        branchpoint: node,
        worlds: worldsByBranchpoint.get(node.id) || [],
      });
      const children = childrenById.get(nodeId) || [];
      for (const childId of children) {
        walk(childId, depth + 1);
      }
    };

    const sortedSources = Array.from(sourceGroups.keys()).sort((left, right) => String(left).localeCompare(String(right)));
    for (const sourceRef of sortedSources) {
      rows.push({ type: "source", key: `source:${sourceRef}`, depth: 0, sourceRef });
      const roots = sourceGroups.get(sourceRef) || [];
      for (const rootId of roots) {
        walk(rootId, 1);
      }
    }

    const orphans = nodes.filter((node) => !visited.has(node.id)).sort(compareCreatedAsc);
    if (orphans.length > 0) {
      rows.push({ type: "source", key: "source:unlinked", depth: 0, sourceRef: "unlinked" });
      for (const orphan of orphans) {
        walk(orphan.id, 1);
      }
    }

    return { rows, total: nodes.length };
  }, [branchpointWorldMap, branchpoints]);

  const allBranches = useMemo(() => {
    const rows = [];
    const allBranchpointWorlds =
      branchpointWorldMap && typeof branchpointWorldMap === "object" ? branchpointWorldMap : {};
    for (const [bpId, worlds] of Object.entries(allBranchpointWorlds)) {
      if (!Array.isArray(worlds)) continue;
      for (const world of worlds) {
        const branch = String(world?.branch || "").trim();
        if (!branch) continue;
        rows.push({
          key: `${bpId}:${world?.id || branch}`,
          branchpointId: bpId,
          worldName: String(world?.name || "world").trim() || "world",
          branch,
          status: String(world?.status || "ready").trim() || "ready",
        });
      }
    }
    rows.sort((left, right) => String(left.branch).localeCompare(String(right.branch)));
    return rows;
  }, [branchpointWorldMap]);

  async function postAction(action, payload, opts = {}) {
    const { refresh = true, switchToLatest = false, resetBranchpoint = false } = opts;
    setBusy(true);
    setError("");
    setActionOutput("");
    try {
      let result = await readJson(`${API_BASE}/api/action/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });

      if (result.job_id) {
        const jobId = String(result.job_id);
        let lastDashboardRefreshAt = 0;
        setActionOutput(`Running ${action}...`);
        while (true) {
          const status = await readJson(`${API_BASE}/api/action_status?job=${encodeURIComponent(jobId)}`);
          const liveText = status.log || status?.result?.output || "";
          if (liveText) {
            setActionOutput(liveText);
          }
          const now = Date.now();
          if (now - lastDashboardRefreshAt >= 1700) {
            await loadDashboard("", false, { silent: true });
            lastDashboardRefreshAt = now;
          }
          if (status.status === "completed" || status.status === "failed") {
            result = status.result || {};
            break;
          }
          await sleep(700);
        }
      }

      setActionOutput(result.output || "Action completed.");
      if (result.ok === false) {
        throw new Error(result.error || result.output || "Action failed");
      }

      if (resetBranchpoint) {
        setSelectedBranchpoint("");
        await loadDashboard("", false);
      } else if (switchToLatest && result.latest_branchpoint) {
        setSelectedBranchpoint(result.latest_branchpoint);
        await loadDashboard(result.latest_branchpoint, false);
      } else if (refresh) {
        await loadDashboard(selectedBranchpoint, false);
      }
      return result;
    } catch (err) {
      setError(err.message);
      return null;
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

  async function chooseFolder(target) {
    const isNewProjectPath = target === "new";
    const isNewBasePath = target === "new-base";
    const defaultPath = isNewProjectPath
      ? projectForm.path
      : isNewBasePath
        ? projectForm.basePath
        : switchForm.path;
    const prompt = isNewProjectPath
      ? "Choose where to create the new project"
      : isNewBasePath
        ? "Choose base path for new projects"
        : "Choose an existing project repository";

    setPickingPath(true);
    setError("");
    try {
      const payload = await readJson(`${API_BASE}/api/action/pick_path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          default_path: defaultPath.trim() || null,
        }),
      });
      if (payload.canceled || !payload.path) return;
      if (isNewProjectPath) {
        setProjectForm((s) => ({ ...s, path: payload.path }));
      } else if (isNewBasePath) {
        setProjectForm((s) => ({ ...s, basePath: payload.path }));
      } else {
        setSwitchForm((s) => ({ ...s, path: payload.path }));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setPickingPath(false);
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

  async function launchWorld(worldId, popupWindow = null) {
    const result = await postAction(
      "launch",
      {
        branchpoint: selectedBranchpoint || "",
        world: worldId,
      },
      { refresh: false },
    );
    const url = String(result?.url || "").trim();
    if (!url) {
      if (popupWindow && !popupWindow.closed) {
        try {
          popupWindow.document.title = "Launch failed";
          popupWindow.document.body.innerHTML =
            "<p style='font-family:sans-serif;padding:16px'>Unable to launch app for this world.</p>";
        } catch (err) {
          popupWindow.close();
        }
      }
      return null;
    }
    if (popupWindow && !popupWindow.closed) {
      try {
        popupWindow.location.replace(url);
        return url;
      } catch (err) {
        // Fall through to regular tab open fallback.
      }
    }
    window.open(url, "_blank");
    return url;
  }

  async function playInBrowser(worldId) {
    let popupWindow = null;
    try {
      popupWindow = window.open("about:blank", "_blank");
      if (popupWindow && popupWindow.document) {
        popupWindow.document.title = "Launching App";
        popupWindow.document.body.innerHTML = "<p style='font-family:sans-serif;padding:16px'>Preparing app...</p>";
      }
    } catch (err) {
      popupWindow = null;
    }
    const launchedUrl = await launchWorld(worldId, popupWindow);
    if (!launchedUrl && popupWindow && !popupWindow.closed) {
      try {
        popupWindow.focus();
      } catch (err) {
        // no-op
      }
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
        max_count: asInt(autopilot.maxCount),
      },
      { switchToLatest: true },
    );
  }

  function toggleCompareWorld(worldId) {
    setCompareWorldIds((prev) => {
      if (prev.includes(worldId)) {
        return prev.filter((id) => id !== worldId);
      }
      if (prev.length >= 2) {
        return [prev[1], worldId];
      }
      return [...prev, worldId];
    });
  }

  function buildRenderViewUrl(worldIds) {
    const params = new URLSearchParams();
    params.set("view", "render");
    const bp = selectedBranchpoint || dashboard?.selected_branchpoint || "";
    if (bp) params.set("branchpoint", bp);
    const ids = (worldIds || []).map((id) => String(id || "").trim()).filter(Boolean).slice(0, 2);
    if (ids.length) params.set("worlds", ids.join(","));
    return `${window.location.pathname}?${params.toString()}`;
  }

  function openRenderView(worldIds = compareWorldIds, inNewTab = false) {
    const ids = (worldIds || []).map((id) => String(id || "").trim()).filter(Boolean).slice(0, 2);
    if (ids.length === 0) {
      setError("Select at least one world to open full render view.");
      return;
    }
    const url = buildRenderViewUrl(ids);
    if (inNewTab) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    setCompareWorldIds(ids);
    setRenderViewOpen(true);
    window.history.pushState({}, "", url);
  }

  function closeRenderView() {
    setRenderViewOpen(false);
    const bp = selectedBranchpoint || dashboard?.selected_branchpoint || "";
    const url = bp ? `${window.location.pathname}?branchpoint=${encodeURIComponent(bp)}` : window.location.pathname;
    window.history.pushState({}, "", url);
  }

  async function mergeWorld(world) {
    const defaultTarget = String(branchpoint?.base_branch || "main").trim() || "main";
    const chosen = window.prompt(`Merge target branch for ${world.branch}:`, defaultTarget);
    if (chosen === null) return;
    const target = String(chosen || "").trim() || defaultTarget;
    await postAction("select", {
      branchpoint: selectedBranchpoint || "",
      world: world.id,
      merge: true,
      target_branch: target,
    });
  }

  useEffect(() => {
    if (!renderViewOpen) return;
    const bp = selectedBranchpoint || dashboard?.selected_branchpoint || "";
    if (!bp || compareWorldIds.length === 0) return;

    let cancelled = false;
    const loadLogs = async () => {
      const next = {};
      for (const wid of compareWorldIds) {
        try {
          const payload = await readJson(
            `${API_BASE}/api/log?kind=render&branchpoint=${encodeURIComponent(bp)}&world=${encodeURIComponent(wid)}&tail=500`,
          );
          if (!cancelled) {
            next[wid] = {
              text: payload.text || "",
              path: payload.path || "",
            };
          }
        } catch (err) {
          if (!cancelled) {
            next[wid] = { text: `Unable to load render log: ${err.message}`, path: "" };
          }
        }
      }
      if (!cancelled) {
        setRenderViewLogs(next);
      }
    };

    loadLogs();
    return () => {
      cancelled = true;
    };
  }, [renderViewOpen, compareWorldIds, selectedBranchpoint, dashboard]);

  const compareRows = compareWorldIds
    .map((wid) => worldRows.find((row) => row.world?.id === wid))
    .filter(Boolean);

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

  if (renderViewOpen) {
    return (
      <main className="shell render-view-shell">
        <section className="glass render-view-header">
          <div>
            <p className="eyebrow">Render Review</p>
            <h1>Full Render View</h1>
            <p className="subtle">
              Branchpoint: <code>{branchpointLabel}</code>
            </p>
          </div>
          <div className="hero-actions">
            <button className="btn ghost" onClick={() => closeRenderView()}>
              Back to Dashboard
            </button>
            <button className="btn ghost" onClick={() => openRenderView(compareWorldIds, true)}>
              Open in New Tab
            </button>
            <button className="btn ghost" disabled={refreshing || busy} onClick={() => loadDashboard(selectedBranchpoint, false)}>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </section>

        {error ? (
          <section className="glass notice error">
            <strong>Error:</strong> {error}
          </section>
        ) : null}

        {compareRows.length === 0 ? (
          <section className="glass panel">
            <p className="subtle">No worlds selected for render view. Go back and choose one or two worlds.</p>
          </section>
        ) : (
          <section className={`render-compare-grid ${compareRows.length === 1 ? "single" : ""}`}>
            {compareRows.map((row) => {
              const world = row.world;
              const render = row.render;
              const assets = Array.isArray(render?.visual_assets) ? render.visual_assets : [];
              const log = renderViewLogs[world.id] || { text: "", path: "" };
              return (
                <article key={`render-view-${world.id}`} className="glass render-compare-card">
                  <header className="render-compare-head">
                    <h2>
                      {String(world.index).padStart(2, "0")} {world.name}
                    </h2>
                    <span className={`status ${statusTone(world.status)}`}>{world.status || "ready"}</span>
                  </header>
                  <p className="mono">{world.branch}</p>
                  <p className="subtle">Render exit: {render ? render.exit_code ?? "n/a" : "n/a"} · Duration: {fmtDuration(render?.duration_sec)}</p>

                  {assets.length === 0 ? (
                    <div className="render-empty">No visual artifacts found. Use Play to generate visuals.</div>
                  ) : (
                    <div className="render-asset-stack">
                      {assets.map((asset) => (
                        <a
                          key={`${world.id}-asset-full-${asset.index}`}
                          className="render-asset-link"
                          href={apiUrl(asset.url)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {asset.kind === "video" ? (
                            <video className="render-asset-media" src={apiUrl(asset.url)} controls preload="metadata" />
                          ) : (
                            <img className="render-asset-media" src={apiUrl(asset.url)} alt={`Render artifact ${asset.index + 1}`} loading="lazy" />
                          )}
                          <span>Open artifact {asset.index + 1}</span>
                        </a>
                      ))}
                    </div>
                  )}

                  <div className="render-log-panel">
                    <p className="subtle mono">{log.path || render?.log_path || ""}</p>
                    <pre>{log.text || "No render log loaded."}</pre>
                  </div>
                </article>
              );
            })}
          </section>
        )}
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
            Repo: <code>{activeRepo || "n/a"}</code>
          </p>
          <p className="subtle">
            Config: <code>{activeConfig || "n/a"}</code>
          </p>
          <p className="subtle">
            Branchpoint: <code>{branchpointLabel}</code>
          </p>
          <div className="hero-stats">
            <p className="hero-stat">
              <span>Open branches</span>
              <strong>{openBranches}</strong>
            </p>
            <p className="hero-stat">
              <span>Awaiting merge (feature complete)</span>
              <strong>{awaitingMerge}</strong>
            </p>
          </div>
        </div>
        <div className="hero-actions">
          <button className="btn ghost" disabled={refreshing || busy} onClick={() => loadDashboard(selectedBranchpoint, false)}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button className="btn ghost" onClick={() => openArtifact("report.md")}>Open report.md</button>
          <button className="btn ghost" onClick={() => openArtifact("play.md")}>Open play.md</button>
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

      <section className="glass panel">
        <h2>Project Setup</h2>
        <p className="subtle">Create a brand-new git repository project or switch this dashboard to an existing one.</p>
        <div className="layout">
          <article>
            <h3>New Project</h3>
            <label>
              Project path (optional)
              <div className="field-with-action">
                <input
                  value={projectForm.path}
                  onChange={(e) => setProjectForm((s) => ({ ...s, path: e.target.value }))}
                  placeholder="/Users/you/dev/new-app (leave empty to use base path + name)"
                />
                <button className="btn ghost small" type="button" disabled={busy || pickingPath} onClick={() => chooseFolder("new")}>
                  {pickingPath ? "Opening..." : "Choose in Finder"}
                </button>
              </div>
            </label>
            <label>
              Base path (used when project path is empty)
              <div className="field-with-action">
                <input
                  value={projectForm.basePath}
                  onChange={(e) => setProjectForm((s) => ({ ...s, basePath: e.target.value }))}
                  placeholder={parentPath(activeRepo) || "/Users/you/dev"}
                />
                <button className="btn ghost small" type="button" disabled={busy || pickingPath} onClick={() => chooseFolder("new-base")}>
                  {pickingPath ? "Opening..." : "Choose in Finder"}
                </button>
              </div>
            </label>
            <div className="grid two">
              <label>
                Project name
                <input
                  value={projectForm.name}
                  onChange={(e) => setProjectForm((s) => ({ ...s, name: e.target.value }))}
                  placeholder="New App"
                />
              </label>
              <label>
                Base branch
                <input
                  value={projectForm.baseBranch}
                  onChange={(e) => setProjectForm((s) => ({ ...s, baseBranch: e.target.value }))}
                  placeholder="main"
                />
              </label>
            </div>
            <label>
              Config filename
              <input
                value={projectForm.configName}
                onChange={(e) => setProjectForm((s) => ({ ...s, configName: e.target.value }))}
                placeholder="parallel_worlds.json"
              />
            </label>
            <button
              className="btn"
              disabled={busy || pickingPath || !canCreateProject}
              onClick={() =>
                postAction(
                  "new_project",
                  {
                    path: projectForm.path.trim() || null,
                    name: projectForm.name.trim() || null,
                    base_path: effectiveProjectBasePath || null,
                    base_branch: projectForm.baseBranch.trim() || "main",
                    config_name: projectForm.configName.trim() || "parallel_worlds.json",
                  },
                  { resetBranchpoint: true },
                )
              }
            >
              Create Project
            </button>
          </article>
          <article>
            <h3>Switch Project</h3>
            <label>
              Existing repo path
              <div className="field-with-action">
                <input
                  value={switchForm.path}
                  onChange={(e) => setSwitchForm((s) => ({ ...s, path: e.target.value }))}
                  placeholder="/Users/you/dev/existing-repo"
                />
                <button className="btn ghost small" type="button" disabled={busy || pickingPath} onClick={() => chooseFolder("switch")}>
                  {pickingPath ? "Opening..." : "Choose in Finder"}
                </button>
              </div>
            </label>
            <label>
              Config filename
              <input
                value={switchForm.configName}
                onChange={(e) => setSwitchForm((s) => ({ ...s, configName: e.target.value }))}
                placeholder="parallel_worlds.json"
              />
            </label>
            <div className="grid two">
              <label>
                If creating: project name
                <input
                  value={switchForm.name}
                  onChange={(e) => setSwitchForm((s) => ({ ...s, name: e.target.value }))}
                  placeholder="New App"
                />
              </label>
              <label>
                If creating: base branch
                <input
                  value={switchForm.baseBranch}
                  onChange={(e) => setSwitchForm((s) => ({ ...s, baseBranch: e.target.value }))}
                  placeholder="main"
                />
              </label>
            </div>
            <div className="button-row">
              <button
                className="btn"
                disabled={busy || pickingPath || !switchForm.path.trim()}
                onClick={() =>
                  postAction(
                    "switch_project",
                    {
                      path: switchForm.path.trim(),
                      config_name: switchForm.configName.trim() || "parallel_worlds.json",
                    },
                    { resetBranchpoint: true },
                  )
                }
              >
                Switch Existing
              </button>
              <button
                className="btn primary"
                disabled={busy || pickingPath || !switchForm.path.trim()}
                onClick={() =>
                  postAction(
                    "open_or_create_project",
                    {
                      path: switchForm.path.trim(),
                      name: switchForm.name.trim() || null,
                      base_branch: switchForm.baseBranch.trim() || "main",
                      config_name: switchForm.configName.trim() || "parallel_worlds.json",
                    },
                    { resetBranchpoint: true },
                  )
                }
              >
                Open or Create
              </button>
            </div>
          </article>
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
              Exact world count (optional)
              <input
                value={autopilot.count}
                onChange={(e) => setAutopilot((s) => ({ ...s, count: e.target.value }))}
                placeholder="4"
              />
            </label>
            <label>
              Max world count (model auto-select)
              <input
                value={autopilot.maxCount}
                onChange={(e) => setAutopilot((s) => ({ ...s, maxCount: e.target.value }))}
                placeholder="4"
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
          <p className="subtle">Exact count is authoritative for new branchpoints. It does not change existing branchpoints.</p>
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
                  max_count: asInt(autopilot.maxCount),
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
              Exact world count (optional)
              <input value={kickoff.count} onChange={(e) => setKickoff((s) => ({ ...s, count: e.target.value }))} placeholder="4" />
            </label>
            <label>
              Max world count (model auto-select)
              <input value={kickoff.maxCount} onChange={(e) => setKickoff((s) => ({ ...s, maxCount: e.target.value }))} placeholder="4" />
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
          <p className="subtle">Exact count is authoritative for new branchpoints. It does not change existing branchpoints.</p>
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
                  max_count: asInt(kickoff.maxCount),
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

      <section className="glass dag-panel">
        <div className="dag-header">
          <h2>Branchpoint DAG</h2>
          <p className="subtle">Global lineage from main/source refs plus live branch heads for the selected branchpoint.</p>
        </div>
        <div className="dag-subsection">
          <h3>All Branchpoints</h3>
          <p className="subtle">Shows every branchpoint path starting from its source ref (for example, main).</p>
          {branchpointLineage.rows.length === 0 ? (
            <p className="subtle">No branchpoints found yet.</p>
          ) : (
            <div className="dag-tree">
              {branchpointLineage.rows.map((row) =>
                row.type === "source" ? (
                  <div key={row.key} className="dag-tree-source" style={{ "--depth": row.depth }}>
                    <span className="dag-dot root" />
                    <div>
                      <p className="dag-node-title">source</p>
                      <p className="dag-node-meta mono">{row.sourceRef}</p>
                    </div>
                  </div>
                ) : (
                  <article key={row.key} className={`dag-tree-branchpoint tone-${statusTone(row.branchpoint.status)}`} style={{ "--depth": row.depth }}>
                    <span className="dag-link" />
                    <div className="dag-branch-head">
                      <span className={`status ${statusTone(row.branchpoint.status)}`}>{row.branchpoint.status}</span>
                      <strong>{row.branchpoint.id}</strong>
                    </div>
                    <p className="dag-node-meta mono">
                      from {row.branchpoint.sourceRef || row.branchpoint.baseBranch || "main"} | worlds {row.worlds.length}
                    </p>
                    {row.worlds.length > 0 ? (
                      <div className="dag-tree-worlds">
                        {row.worlds.map((world) => (
                          <span
                            key={`dag-world-${row.branchpoint.id}-${world.id}`}
                            className={`dag-world-pill tone-${statusTone(world.status)}`}
                            title={world.branch || world.id}
                          >
                            {world.branch || world.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ),
              )}
            </div>
          )}
          <p className="subtle">Total branchpoints: {branchpointLineage.total}</p>
        </div>

        <div className="dag-subsection">
          <h3>Selected Branchpoint Branch Heads</h3>
          <div className="dag-root-node">
            <span className="dag-dot root" />
            <div>
              <p className="dag-node-title">source</p>
              <p className="dag-node-meta mono">
                {branchpoint?.source_ref || "main"} ({branchpoint?.base_branch || "base"})
              </p>
            </div>
          </div>
          {dagRows.length === 0 ? (
            <p className="subtle">No world branches yet for this branchpoint.</p>
          ) : (
            <div className="dag-branches">
              {dagRows.map((item) => (
                <article key={`dag-${item.id || item.branch}`} className={`dag-branch tone-${statusTone(item.status)}`}>
                  <span className="dag-link" />
                  <div className="dag-branch-head">
                    <span className={`status ${statusTone(item.status)}`}>{item.status}</span>
                    <strong>{item.name}</strong>
                  </div>
                  <p className="mono">{item.branch}</p>
                  <p className="dag-node-meta">HEAD {item.head} | commits {item.commits} | dirty {item.dirty}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="glass worlds-panel">
        <div className="worlds-header">
          <div>
            <h2>World Blocks</h2>
            <p className="subtle">
              Use each world block to run code, play/render output, or open the world app in a new browser tab.
            </p>
            <p className="subtle">
              Selected branchpoint: <code>{branchpoint?.id || "none"}</code>
            </p>
          </div>
          <div className="button-row">
            <button className="btn ghost small" disabled={compareWorldIds.length === 0} onClick={() => openRenderView(compareWorldIds, false)}>
              Full Render View
            </button>
            <button className="btn ghost small" disabled={compareWorldIds.length === 0} onClick={() => openRenderView(compareWorldIds, true)}>
              Full View in New Tab
            </button>
            <button className="btn ghost small" disabled={compareWorldIds.length === 0} onClick={() => setCompareWorldIds([])}>
              Clear Compare
            </button>
          </div>
        </div>
        <div className="all-branches-wrap">
          <p className="subtle">
            All branches in repo: <strong>{allBranches.length}</strong>
          </p>
          <div className="all-branches-list">
            {allBranches.map((item) => (
              <span key={item.key} className={`all-branch-pill tone-${statusTone(item.status)}`} title={`${item.worldName} (${item.branchpointId})`}>
                <code>{item.branch}</code>
              </span>
            ))}
          </div>
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
              const live = row.live || {};
              const liveCommits = Number.isInteger(live.ahead_commits) ? live.ahead_commits : "n/a";
              const liveHead = live.head || "n/a";
              const liveDirty = Number.isInteger(live.dirty_files) ? live.dirty_files : "n/a";
              const sourceHead = live.source_head || "source";
              const commitNodes = Array.isArray(live.commit_nodes) ? live.commit_nodes : [];
              const nodesTruncated = Boolean(live.commit_nodes_truncated);
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
                    <span>Commits: {liveCommits}</span>
                    <span>HEAD: {liveHead}</span>
                    <span>Dirty: {liveDirty}</span>
                  </div>
                  <div className="timeline-wrap">
                    <p className="timeline-title">Branch timeline</p>
                    <ol className="commit-tree">
                      <li className="commit-node root">
                        <span className="commit-dot" />
                        <code className="commit-sha">{sourceHead}</code>
                        <span className="commit-subject">source ({branchpoint?.source_ref || "base"})</span>
                      </li>
                      {commitNodes.length === 0 ? (
                        <li className="commit-node empty">
                          <span className="commit-dot" />
                          <span className="commit-subject">no new commits yet</span>
                        </li>
                      ) : (
                        commitNodes.map((node, idx) => (
                          <li key={`${world.id}-node-${idx}-${node.sha || "sha"}`} className="commit-node">
                            <span className="commit-dot" />
                            <code className="commit-sha">{node.sha || "n/a"}</code>
                            <span className="commit-subject">{node.subject || "commit"}</span>
                          </li>
                        ))
                      )}
                      {nodesTruncated ? (
                        <li className="commit-node empty">
                          <span className="commit-dot" />
                          <span className="commit-subject">... more commits not shown</span>
                        </li>
                      ) : null}
                    </ol>
                  </div>
                  <div className="button-row">
                    <button
                      className="btn small"
                      disabled={busy}
                      onClick={() =>
                        postAction("run", {
                          branchpoint: selectedBranchpoint || "",
                          worlds: world.id,
                          skip_codex: true,
                          skip_runner: false,
                        })
                      }
                    >
                      Run
                    </button>
                    <button className="btn small" disabled={busy} onClick={() => postAction("play", { branchpoint: selectedBranchpoint || "", worlds: world.id })}>
                      Play
                    </button>
                    <button className="btn small ghost" disabled={busy} onClick={() => playInBrowser(world.id)}>
                      Play in Browser
                    </button>
                    <button className="btn small" disabled={busy} onClick={() => postAction("select", { branchpoint: selectedBranchpoint || "", world: world.id, merge: false })}>
                      Select
                    </button>
                    <button className="btn small primary" disabled={busy} onClick={() => mergeWorld(world)}>
                      Select + Merge
                    </button>
                    <button className="btn small accent" disabled={busy} onClick={() => forkFromWorld(world)}>
                      Fork
                    </button>
                  </div>
                  <div className="button-row">
                    <button
                      className="btn ghost small"
                      disabled={busy}
                      onClick={() => toggleCompareWorld(world.id)}
                    >
                      {compareWorldIds.includes(world.id) ? "Remove From Compare" : "Add To Compare"}
                    </button>
                    <button
                      className="btn ghost small"
                      disabled={busy}
                      onClick={() => openRenderView([world.id], false)}
                    >
                      Full Render
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
