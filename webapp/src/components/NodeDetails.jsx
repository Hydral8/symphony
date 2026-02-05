import React from "react";
import { NODE_PRIORITIES, NODE_STATUSES, NODE_TYPES } from "../lib/constants";
import { splitLines } from "../lib/plan";

export default function NodeDetails({ node, updateNode, deleteNode }) {
  if (!node) return null;
  return (
    <div className="stack">
      <div className="row between">
        <strong>{node.label}</strong>
        <button className="btn small" onClick={() => deleteNode(node.id)}>Delete</button>
      </div>
      <label>
        Type
        <select value={node.type} onChange={(e) => updateNode(node.id, { type: e.target.value })}>
          {NODE_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </label>
      <label>
        Status
        <select value={node.status} onChange={(e) => updateNode(node.id, { status: e.target.value })}>
          {NODE_STATUSES.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
      </label>
      <label>
        Priority
        <select value={node.priority || "medium"} onChange={(e) => updateNode(node.id, { priority: e.target.value })}>
          {NODE_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>{priority}</option>
          ))}
        </select>
      </label>
      <div className="grid two">
        <label>
          X
          <input
            value={node.position.x}
            onChange={(e) => updateNode(node.id, { position: { ...node.position, x: Number(e.target.value) || 0 } })}
          />
        </label>
        <label>
          Y
          <input
            value={node.position.y}
            onChange={(e) => updateNode(node.id, { position: { ...node.position, y: Number(e.target.value) || 0 } })}
          />
        </label>
      </div>
      <div className="grid two">
        <label>
          Width
          <input
            value={node.size.w}
            onChange={(e) => updateNode(node.id, { size: { ...node.size, w: Number(e.target.value) || 1 } })}
          />
        </label>
        <label>
          Height
          <input
            value={node.size.h}
            onChange={(e) => updateNode(node.id, { size: { ...node.size, h: Number(e.target.value) || 1 } })}
          />
        </label>
      </div>
      <label>
        Acceptance criteria (one per line)
        <textarea
          value={(node.acceptance_criteria || []).join("\n")}
          onChange={(e) => updateNode(node.id, { acceptance_criteria: splitLines(e.target.value) })}
        />
      </label>
      <label>
        Details markdown
        <textarea
          value={node.details_markdown || ""}
          onChange={(e) => updateNode(node.id, { details_markdown: e.target.value })}
        />
      </label>
      <label>
        Tags (comma separated)
        <input
          value={(node.tags || []).join(", ")}
          onChange={(e) => updateNode(node.id, { tags: splitLines(e.target.value.replace(/,/g, "\n")) })}
        />
      </label>
    </div>
  );
}
