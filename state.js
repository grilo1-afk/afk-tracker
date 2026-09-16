// -- SHARED STATE
// Schema: { displayName, months: [{ id(uuid), name, year, month(0-based), budget(null|number), expenses:[{id(uuid),desc,val,date,createdAt}] }] }
export let state = { displayName: null, months: [] };

// Mutates state in-place so all module references stay live
export function setState(newState) {
  Object.assign(state, newState);
  state.months = newState.months;
  state.displayName = newState.displayName ?? state.displayName;
}

export let activeMonthId = null;
export function setActiveMonthId(id) { activeMonthId = id; }

export const MONTH_NAMES = [
  "January", "February", "March",    "April",
  "May",     "June",     "July",     "August",
  "September","October", "November", "December",
];

// -- LOCAL CACHE
const SESSION_KEY     = "afk_session";
const STATE_CACHE_KEY = "afk_state";

export function readLocalCache() {
  try {
    const raw = localStorage.getItem(STATE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.months)) return null;
    return parsed;
  } catch (_) { return null; }
}

export function writeLocalCache(stateObj) {
  try {
    localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(stateObj));
  } catch (_) { /* non-fatal */ }
}

export function clearLocalCache() {
  localStorage.removeItem(STATE_CACHE_KEY);
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("afk_logged_in");
  clearLocalCache();
}

// -- DISPLAY NAME (localStorage fast-read cache)
export function getDisplayName() {
  return localStorage.getItem("afk_display_name") || "User";
}

export function cacheDisplayName(name) {
  localStorage.setItem("afk_display_name", (name || "").trim() || "User");
}

// -- HELPERS
export function fmt(n) {
  return "$ " + parseFloat(n).toFixed(2);
}

export function getActiveMonth() {
  return state.months.find((m) => m.id === activeMonthId) || null;
}

export function getCurrentMonthObj() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth(); // 0-based
  return state.months.find((m) => m.year === year && m.month === month) || null;
}

// -- DB ROW → UI STATE MAPPER
// months.month in DB is 1-based; UI expects 0-based.
// budget = 0 in DB means "not set" → map to null in UI.
export function dbRowsToState(monthRows) {
  const months = monthRows.map((m) => ({
    id:       m.id,
    name:     m.name,
    year:     m.year,
    month:    m.month - 1,
    budget:   m.budget > 0 ? parseFloat(m.budget) : null,
    expenses: (m.expenses || []).map((e) => ({
      id:        e.id,
      desc:      e.description,
      val:       parseFloat(e.amount),
      date:      e.expense_date,
      createdAt: e.created_at,
    })),
  }));
  return { months };
}