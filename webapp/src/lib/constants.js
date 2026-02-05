export const API_BASE = import.meta.env.VITE_API_BASE || "";
export const LOCAL_STORAGE_KEY = "symphony.canvasPlan.v1.draft";

export const LAYER_KINDS = ["vision", "module", "uxui", "backend", "data", "infra", "task"];
export const POVS = ["product", "design", "engineering", "ops"];
export const NODE_TYPES = [
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
export const NODE_STATUSES = ["draft", "validated", "approved", "deprecated"];
export const NODE_PRIORITIES = ["low", "medium", "high", "critical"];
export const EDGE_RELATIONS = [
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

export const WORLD_WIDTH = 5200;
export const WORLD_HEIGHT = 3400;
export const MIN_SCALE = 0.35;
export const MAX_SCALE = 2.2;
