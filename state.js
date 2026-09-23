// -- SHARED STATE
// Schema: { displayName, months: [{ id(uuid), name, year, month(0-based), budget(null|number), expenses:[{id(uuid),desc,val,date,createdAt,categoryId}] }], categories: [{id,name}], presets: [{id,desc,amount}], recurring: [{id,desc,amount}], currency: string, lifetimeOffset: number }
export let state = { displayName: null, months: [], categories: [], presets: [], recurring: [], currency: "USD", lifetimeOffset: 0 };

// Mutates state in-place so all module references stay live
export function setState(newState) {
  Object.assign(state, newState);
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

export function getCurrentUserId() {
  return currentUserId;
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

// Local calendar date as YYYY-MM-DD. Deliberately NOT toISOString().slice(0,10) —
// that returns the UTC date, which is a different calendar day from roughly
// 9pm to midnight local time for anyone west of UTC (including Brazil).
export function getLocalISODate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const CURRENCY_LOCALES = {
  BRL: "pt-BR",
  EUR: "de-DE",
  GBP: "en-GB",
  JPY: "ja-JP",
  CAD: "en-CA",
  AUD: "en-AU",
  MXN: "es-MX",
};

export function fmt(cents) {
  const currency = state.currency || "USD";
  const locale = CURRENCY_LOCALES[currency] || "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function setCurrency(code) {
  state.currency = (code || "USD").toUpperCase();
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
// budget = null in DB means "not set yet"; 0 is a valid deliberate budget.
export function dbRowsToState(monthRows) {
  const months = monthRows.map((m) => ({
    id: m.id,
    name: m.name,
    year: m.year,
    month: m.month - 1,
    budget: m.budget !== null ? Math.round(parseFloat(m.budget) * 100) : null,
    expenses: (m.expenses || []).map((e) => ({
      id: e.id,
      desc: e.description,
      val: Math.round(parseFloat(e.amount) * 100),
      date: e.expense_date,
      createdAt: e.created_at,
      categoryId: e.category_id || null,
    })),
  }));
  return { months };
}

// Whether an ISO date string (YYYY-MM-DD) falls within the given month object
// (which uses 0-based `month`, matching the rest of the app's state shape).
export function isDateInMonth(dateStr, month) {
  if (!dateStr || !month) return false;
  const lastDay = new Date(month.year, month.month + 1, 0).getDate();
  const mm = String(month.month + 1).padStart(2, "0");
  const min = `${month.year}-${mm}-01`;
  const max = `${month.year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  return dateStr >= min && dateStr <= max;
}
