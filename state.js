// -- SHARED STATE
// Schema: { displayName, months: [{ id(uuid), name, year, month(0-based), budget(null|number), expenses:[{id(uuid),desc,val,date,createdAt}] }] }
export let state = { displayName: null, months: [] };

// Mutates state in-place so all module references stay live
export function setState(newState) {
  Object.assign(state, newState);
  state.months = newState.months;
  state.displayName = newState.displayName ?? state.displayName;
}

// -- USER ID (for namespaced cache keys)
let currentUserId = null;
let _legacyKeysCleaned = false;

export function setCurrentUserId(id) {
  currentUserId = id;
  // One-time cleanup: remove unnamespaced legacy keys left by pre-A1 builds
  if (id && !_legacyKeysCleaned) {
    _legacyKeysCleaned = true;
    localStorage.removeItem("afk_state");
    localStorage.removeItem("afk_display_name");
  }
}

export let activeMonthId = null;
export function setActiveMonthId(id) {
  activeMonthId = id;
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// -- LOCAL CACHE
const SESSION_KEY = "afk_session";

function stateCacheKey() {
  return currentUserId ? `afk_state:${currentUserId}` : null;
}

function displayNameCacheKey() {
  return currentUserId ? `afk_display_name:${currentUserId}` : null;
}

export function readLocalCache() {
  const key = stateCacheKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.months)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function writeLocalCache(stateObj) {
  const key = stateCacheKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(stateObj));
  } catch (_) {
    /* non-fatal */
  }
}

export function clearLocalCache() {
  const key = stateCacheKey();
  if (!key) return;
  localStorage.removeItem(key);
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("afk_logged_in");
  clearLocalCache();
  const dnKey = displayNameCacheKey();
  if (dnKey) localStorage.removeItem(dnKey);
  currentUserId = null;
}

// -- DISPLAY NAME (localStorage fast-read cache)
export function getDisplayName() {
  const key = displayNameCacheKey();
  if (!key) return "User";
  return localStorage.getItem(key) || "User";
}

export function cacheDisplayName(name) {
  const key = displayNameCacheKey();
  if (!key) return;
  localStorage.setItem(key, (name || "").trim() || "User");
}

// -- HELPERS
export function fmt(n) {
  return "$ " + parseFloat(n).toFixed(2);
}

export function getActiveMonth() {
  return state.months.find((m) => m.id === activeMonthId) || null;
}

export function getCurrentMonthObj() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  return state.months.find((m) => m.year === year && m.month === month) || null;
}

// -- DB ROW → UI STATE MAPPER
// months.month in DB is 1-based; UI expects 0-based.
// budget = 0 in DB means "not set" → map to null in UI.
export function dbRowsToState(monthRows) {
  const months = monthRows.map((m) => ({
    id: m.id,
    name: m.name,
    year: m.year,
    month: m.month - 1,
    budget: m.budget > 0 ? parseFloat(m.budget) : null,
    expenses: (m.expenses || []).map((e) => ({
      id: e.id,
      desc: e.description,
      val: parseFloat(e.amount),
      date: e.expense_date,
      createdAt: e.created_at,
    })),
  }));
  return { months };
}
