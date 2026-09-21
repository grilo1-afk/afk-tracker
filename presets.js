import { getCurrentUserId } from "./state.js";

function presetsKey() {
  const id = getCurrentUserId();
  return id ? `afk_presets:${id}` : null;
}

export function readPresets() {
  const key = presetsKey();
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export function writePresets(presets) {
  const key = presetsKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(presets));
  } catch (_) { /* non-fatal */ }
}