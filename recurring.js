import { getCurrentUserId } from "./state.js";

function recurringKey() {
  const id = getCurrentUserId();
  return id ? `afk_recurring:${id}` : null;
}

export function readRecurring() {
  const key = recurringKey();
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

export function writeRecurring(items) {
  const key = recurringKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch (_) { /* non-fatal */ }
}