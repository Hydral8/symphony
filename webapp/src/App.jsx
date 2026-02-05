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
  if (status === "played") return "play";
  if (status === "ready") return "ready";
  return "muted";
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "n/a";
  return `${seconds}s`;
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

  useEffect(() => {
    loadDashboard("", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const worldRows = dashboard?.world_rows || [];
  const branchpoints = dashboard?.branchpoints || [];
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
        setActionOutput(`Running ${action}...`);
        while (true) {
          const status = await readJson(`${API_BASE}/api/action_status?job=${encodeURIComponent(jobId)}`);
          const liveText = status.log || status?.result?.output || "";
          if (liveText) {
            setActionOutput(liveText);
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
          <p className="subtle">The model chooses branch count from 1..max.</p>
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
          <p className="subtle">The model chooses branch count from 1..max.</p>
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
