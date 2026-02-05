import { API_BASE } from "./constants";

export async function readJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const err = payload.error || payload.output || `Request failed (${response.status})`;
    throw new Error(err);
  }
  return payload;
}

export { API_BASE };
