import { supabase } from "./supabase-client.js";

// -- STATE
let _saveTimer   = null;   // debounce handle for cloud sync
let _retryCount  = 0;      // how many retries have fired for the current failed flush
let _retryTimer  = null;   // handle for the next scheduled retry

// -- UNDO STATE (expense deletion)
let _lastDeleted = null;   // { expense, index, monthId }
let _undoTimer   = null;   // handle for the 4-second undo window

// Schema: { version, schemaVersion, updatedAt, months: [{ id, name, year, month, budget, expenses: [{id, desc, val, date, createdAt}] }] }
let state = { version: 1, schemaVersion: 1, updatedAt: new Date().toISOString(), months: [] };
let activeMonthId = null;

const MONTH_NAMES = [
  "January", "February", "March",    "April",
  "May",     "June",     "July",     "August",
  "September","October", "November", "December",
];

// -- GAS API URL
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwCEDs1stwKwJRBwPhEVpBu2byM40Hc4Ygx2YV2iMbaWibTBjT09GjEZcKroWN2FFzL/exec";

// -- SESSION HELPERS
const SESSION_KEY     = "afk_session";
const STATE_CACHE_KEY = "afk_state";

function readLocalCache() {
  try {
    const raw = localStorage.getItem(STATE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.months)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function writeLocalCache(stateObj) {
  try {
    localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(stateObj));
  } catch (_) {
    // Storage quota exceeded or private mode — non-fatal
  }
}

function clearLocalCache() {
  localStorage.removeItem(STATE_CACHE_KEY);
}

function getStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.token !== "string" || !s.token) return null;
    return s; // { token, username, expiresAt }
  } catch (_) {
    return null;
  }
}

function storeSession(token, username, expiresAt) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token, username, expiresAt }));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("afk_logged_in");
}

// -- CENTRALIZED API REQUEST
// Always returns an object. Never throws.
// Error shapes: { ok: false, error: "NETWORK_ERROR" | "TIMEOUT" | "INVALID_RESPONSE" | <server code> }
// NOTE: AbortController.signal is intentionally NOT passed to fetch — GAS responds with a 302 redirect
// to script.googleusercontent.com and attaching a signal causes some browsers to abort mid-redirect.
// Timeout is implemented via Promise.race() instead.
async function apiRequest(payload) {
  const fetchPromise = fetch(GAS_URL, {
    method:  "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    redirect: "follow",
    body:    JSON.stringify(payload),
  }).then(async (res) => {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      return { ok: false, error: "INVALID_RESPONSE" };
    }
  }).catch(() => ({ ok: false, error: "NETWORK_ERROR" }));

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, error: "TIMEOUT" }), 15000)
  );

  return Promise.race([fetchPromise, timeoutPromise]);
}

// -- SESSION INVALIDATION HANDLER
function handleSessionInvalid(errorCode) {
  clearSession();
  state = { months: [] };
  activeMonthId = null;
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  showScreen("login");
  if (errorCode === "ACCOUNT_INACTIVE") {
    showBanner("login-error", "Your account has been deactivated. Contact support.");
  } else {
    showBanner("login-error", "Your session has expired. Please log in again.");
  }
}

// -- DOM REFS
const loginScreen    = document.getElementById("login-screen");
const historyScreen  = document.getElementById("history-screen");
const monthScreen    = document.getElementById("month-screen");
const monthList      = document.getElementById("month-list");
const monthViewTitle = document.getElementById("month-view-title");

const budgetSetupBox    = document.getElementById("budget-setup-box");
const statsSection      = document.getElementById("stats-section");
const addExpenseSection = document.getElementById("add-expense-section");
const budgetInput       = document.getElementById("budget-input");
const btnSetBudget      = document.getElementById("btn-set-budget");
const displayBudget     = document.getElementById("display-budget");
const displaySpent      = document.getElementById("display-spent");
const displayRemaining  = document.getElementById("display-remaining");

const descInput     = document.getElementById("desc");
const valInput      = document.getElementById("val");
const expDateInput  = document.getElementById("exp-date");
const btnAddExpense = document.getElementById("btn-add-expense");
const tableBody     = document.getElementById("expense-table-body");

// -- THEME
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("afk_theme", theme);
  const icon = theme === "dark" ? "light_mode" : "dark_mode";
  document.querySelectorAll(".theme-icon").forEach((el) => { el.textContent = icon; });
}

function getPreferredTheme() {
  const saved = localStorage.getItem("afk_theme");
  if (saved) return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
}

document.getElementById("btn-theme").addEventListener("click",   toggleTheme);
document.getElementById("btn-theme-2").addEventListener("click", toggleTheme);

// -- PASSWORD TOGGLE (login field)
document.getElementById("btn-toggle-password").addEventListener("click", () => {
  const pwd  = document.getElementById("password");
  const icon = document.getElementById("eye-icon");
  const isHidden = pwd.type === "password";
  pwd.type = isHidden ? "text" : "password";
  icon.textContent = isHidden ? "visibility_off" : "visibility";
});

// -- MONTH PICKER MODAL
const pickerOverlay = document.getElementById("month-picker-overlay");
const pickMonthSel  = document.getElementById("pick-month");
const pickYearSel   = document.getElementById("pick-year");

MONTH_NAMES.forEach((name, i) => {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = name;
  pickMonthSel.appendChild(opt);
});

(function populateYears() {
  const now = new Date();
  const currentYear = now.getFullYear();
  for (let y = currentYear - 2; y <= currentYear + 2; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    pickYearSel.appendChild(opt);
  }
})();

function openMonthPicker() {
  const now = new Date();
  pickMonthSel.value = now.getMonth();
  pickYearSel.value  = now.getFullYear();
  pickerOverlay.classList.remove("hidden");
}

function closeMonthPicker() {
  pickerOverlay.classList.add("hidden");
}

document.getElementById("btn-pick-cancel").addEventListener("click", closeMonthPicker);
pickerOverlay.addEventListener("click", (e) => {
  if (e.target === pickerOverlay) closeMonthPicker();
});

document.getElementById("btn-pick-confirm").addEventListener("click", () => {
  const m    = parseInt(pickMonthSel.value, 10);
  const y    = parseInt(pickYearSel.value, 10);
  const name = MONTH_NAMES[m] + " " + y;
  const calId = y + "-" + String(m + 1).padStart(2, "0");
  if (state.months.find((x) => x.id === calId || x.name === name)) {
    const existing = document.getElementById("pick-error");
    if (existing) existing.textContent = name + " already exists.";
    return;
  }
  const newMonth = { id: calId, name, year: y, month: m, budget: null, expenses: [] };
  state.months.push(newMonth);
  sortMonths();
  saveState();
  closeMonthPicker();
  renderHistory();
  openMonth(calId);
});

// -- UTILS
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function fmt(n) {
  return "$ " + parseFloat(n).toFixed(2);
}

// -- INLINE VALIDATION
function showFieldError(inputEl, spanId, message) {
  inputEl.classList.add("is-invalid");
  const span = document.getElementById(spanId);
  if (span) span.textContent = message;
}

function clearFieldError(inputEl, spanId) {
  inputEl.classList.remove("is-invalid");
  const span = document.getElementById(spanId);
  if (span) span.textContent = "";
}

function showBanner(bannerId, message) {
  const el = document.getElementById(bannerId);
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

function clearBanner(bannerId) {
  const el = document.getElementById(bannerId);
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

// -- ESCAPE KEY
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!pickerOverlay.classList.contains("hidden")) { closeMonthPicker(); return; }
  const dmOverlay = document.getElementById("delete-month-overlay");
  if (dmOverlay && !dmOverlay.classList.contains("hidden")) { closeDeleteMonthModal(); return; }
  const eeOverlay = document.getElementById("edit-expense-overlay");
  if (eeOverlay && !eeOverlay.classList.contains("hidden")) { closeEditExpenseModal(); return; }
  if (!profileOverlay.classList.contains("hidden")) { closeProfileModal(); return; }
});

["username", "password"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", () => {
    clearFieldError(document.getElementById(id), "err-" + id);
    clearBanner("login-error");
  });
});

// -- DISPLAY NAME
function renderWelcomeName() {
  const el = document.getElementById("welcome-name");
  if (el) el.textContent = getDisplayName();
}

function getActiveMonth() {
  return state.months.find((m) => m.id === activeMonthId) || null;
}

function getCurrentMonthId() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
}

// -- PERSISTENCE (session-authenticated GAS Web App)

// -- SAVE STATUS
// Updates all .save-status elements on visible screens.
// status: "saving" | "saved" | "error" | "idle"
let _savedResetTimer = null;
function setSaveStatus(status) {
  const els = document.querySelectorAll(".save-status");
  if (!els.length) return;

  clearTimeout(_savedResetTimer);

  if (status === "idle") {
    els.forEach((el) => {
      el.textContent = "";
      el.className = "save-status";          // no .visible
    });
    return;
  }

  const map = {
    saving: "Saving\u2026",
    saved:  "\u2713 Saved",
    error:  "\u26A0 Not synced",
  };

  els.forEach((el) => {
    el.textContent = map[status] || "";
    el.className = "save-status visible " + status;
  });

  if (status === "saved") {
    _savedResetTimer = setTimeout(() => setSaveStatus("idle"), 2000);
  }
}

// Conflict resolution: "newer version wins" strategy.
// Returns the state that should be used, and whether it came from local.
function resolveConflict(localState, cloudState) {
  const lv = (localState && typeof localState.version === "number") ? localState.version : null;
  const cv = (cloudState && typeof cloudState.version === "number") ? cloudState.version : null;
  // Either missing version → cloud is authoritative
  if (lv === null || cv === null) return { resolved: cloudState, localWon: false };
  if (lv > cv) return { resolved: localState, localWon: true };
  // cloud newer or equal → use cloud
  return { resolved: cloudState, localWon: false };
}

// Public mutation handler — called from all existing call sites, unchanged signature.
// Stamps version + updatedAt, writes local cache synchronously, then schedules a debounced cloud flush.
function saveState() {
  state.version  = (typeof state.version === "number" && state.version > 0) ? state.version + 1 : 1;
  state.updatedAt = new Date().toISOString();
  writeLocalCache(state);           // instant, synchronous
  // Reset retry state — new user mutation supersedes any in-flight retry
  _retryCount = 0;
  clearTimeout(_retryTimer);
  _retryTimer = null;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushToCloud, 800);
}

// Retry schedule (ms): 5s → 15s → 30s, then give up
const RETRY_DELAYS = [5000, 15000, 30000];

function scheduleRetry() {
  if (_retryCount >= RETRY_DELAYS.length) return; // all retries exhausted — stay on error state
  clearTimeout(_retryTimer);
  _retryTimer = setTimeout(() => {
    _retryCount++;
    flushToCloud();
  }, RETRY_DELAYS[_retryCount]);
}

// Private — sends current state to GAS. Reads module-level `state` at execution
// time, so it always sends the latest snapshot regardless of when saveState() was called.
// apiRequest() never throws — all network/timeout/parse failures come back as { ok: false, error }.
async function flushToCloud() {
  _saveTimer = null;
  const session = getStoredSession();
  if (!session) return;
  setSaveStatus("saving");
  const json = await apiRequest({
    action: "saveState",
    token:  session.token,
    data:   state,
  });
  if (!json.ok) {
    const err = json.error || "";
    if (err === "SESSION_INVALID" || err === "ACCOUNT_INACTIVE") {
      setSaveStatus("idle");
      handleSessionInvalid(err);
    } else {
      // Covers NETWORK_ERROR, TIMEOUT, INVALID_RESPONSE, and any other server error
      scheduleRetry();
      setSaveStatus("error");
    }
  } else {
    _retryCount = 0;
    clearTimeout(_retryTimer);
    _retryTimer = null;
    setSaveStatus("saved");
  }
}

// Flush any pending debounced save when the user closes or navigates away.
window.addEventListener("beforeunload", flushToCloud);

async function loadState() {
  const session = getStoredSession();
  if (!session) throw new Error("NO_SESSION");
  const json = await apiRequest({
    action: "getState",
    token: session.token,
  });
  if (!json.ok) {
    const err = json.error || "SERVER_ERROR";
    if (err === "SESSION_INVALID" || err === "ACCOUNT_INACTIVE") {
      handleSessionInvalid(err);
    }
    throw new Error(err);
  }
  if (json.data && Array.isArray(json.data.months)) {
    return json.data;
  }
  return { version: 1, schemaVersion: 1, updatedAt: new Date().toISOString(), months: [] };
}

// -- ENSURE CURRENT MONTH EXISTS
function ensureCurrentMonth() {
  const now = new Date();
  const id = getCurrentMonthId();
  if (!state.months.find((m) => m.id === id)) {
    state.months.unshift({
      id,
      name: MONTH_NAMES[now.getMonth()] + " " + now.getFullYear(),
      year: now.getFullYear(),
      month: now.getMonth(),
      budget: null,
      expenses: [],
    });
    saveState();
  }
}

// -- SCREEN ROUTING
const SCREENS = { login: loginScreen, history: historyScreen, month: monthScreen };

function showScreen(name) {
  Object.values(SCREENS).forEach((s) => s.classList.add("hidden"));
  SCREENS[name]?.classList.remove("hidden");
}

// -- HISTORY SCREEN
function sortMonths() {
  state.months.sort((a, b) =>
    b.year !== a.year ? b.year - a.year : b.month - a.month,
  );
}

function renderHistory() {
  const currentId = getCurrentMonthId();
  monthList.innerHTML = "";
  if (state.months.length === 0) {
    monthList.innerHTML = '<div class="empty-history">No months recorded yet. Create your first month below.</div>';
    return;
  }
  state.months.forEach((m) => {
    const isCurrent = m.id === currentId;
    const totalSpent = m.expenses.reduce((s, e) => s + e.val, 0);
    const hasBudget = m.budget !== null;
    const metaText = hasBudget
      ? "Budget: " + fmt(m.budget) + " \u2022 Spent: " + fmt(totalSpent)
      : "Budget not set yet";
    const metaClass = hasBudget ? "" : "needs-setup";

    const card = document.createElement("div");
    card.className = "month-card";

    const clickable = document.createElement("div");
    clickable.className = "month-card-clickable month-card-info";
    clickable.dataset.id = m.id;
    clickable.addEventListener("click", () => openMonth(m.id));

    const nameDiv = document.createElement("div");
    nameDiv.className = "month-card-name";
    nameDiv.textContent = m.name;

    const metaDiv = document.createElement("div");
    metaDiv.className = "month-card-meta" + (metaClass ? " " + metaClass : "");
    metaDiv.textContent = metaText;

    clickable.appendChild(nameDiv);
    clickable.appendChild(metaDiv);

    const rightDiv = document.createElement("div");
    rightDiv.className = "month-card-right";

    if (isCurrent) {
      const badge = document.createElement("span");
      badge.className = "badge-current";
      badge.textContent = "Current";
      rightDiv.appendChild(badge);
    }

    const btn = document.createElement("button");
    btn.className = "btn-danger btn-delete-month";
    btn.dataset.id = m.id;
    btn.textContent = "Delete";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteMonthModal(m.id);
    });
    rightDiv.appendChild(btn);

    card.appendChild(clickable);
    card.appendChild(rightDiv);
    monthList.appendChild(card);
  });
}

// -- DELETE MONTH CONFIRMATION MODAL
let _pendingDeleteMonthId = null;

function openDeleteMonthModal(id) {
  const m = state.months.find((x) => x.id === id);
  if (!m) return;
  _pendingDeleteMonthId = id;
  const totalSpent = m.expenses.reduce((s, e) => s + e.val, 0);
  const expCount   = m.expenses.length;
  document.getElementById("delete-month-name").textContent  = "Delete " + m.name + "?";
  document.getElementById("delete-month-stats").textContent =
    expCount + " expense" + (expCount !== 1 ? "s" : "") + " \u00B7 " + fmt(totalSpent) + " spent";
  document.getElementById("delete-month-overlay").classList.remove("hidden");
}

function closeDeleteMonthModal() {
  _pendingDeleteMonthId = null;
  document.getElementById("delete-month-overlay").classList.add("hidden");
}

document.getElementById("btn-delete-month-cancel").addEventListener("click", closeDeleteMonthModal);
document.getElementById("btn-delete-month-confirm").addEventListener("click", () => {
  if (!_pendingDeleteMonthId) return;
  deleteMonth(_pendingDeleteMonthId);
  closeDeleteMonthModal();
});
document.getElementById("delete-month-overlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("delete-month-overlay")) closeDeleteMonthModal();
});

function deleteMonth(id) {
  const m = state.months.find((x) => x.id === id);
  if (!m) return;
  state.months = state.months.filter((x) => x.id !== id);
  saveState();
  renderHistory();
}

// -- MONTH VIEW
function openMonth(id) {
  activeMonthId = id;
  const m = getActiveMonth();
  if (!m) return;
  monthViewTitle.textContent = m.name;
  if (m.budget === null) {
    budgetSetupBox.classList.remove("hidden");
    statsSection.classList.add("hidden");
    addExpenseSection.classList.add("hidden");
    budgetInput.value = "";
  } else {
    budgetSetupBox.classList.add("hidden");
    statsSection.classList.remove("hidden");
    addExpenseSection.classList.remove("hidden");
    // Pre-fill date input with today and constrain to the viewed month
    const today = new Date().toISOString().slice(0, 10);
    expDateInput.value = today;
    const lastDay = new Date(m.year, m.month + 1, 0).getDate();
    expDateInput.min = m.year + "-" + String(m.month + 1).padStart(2, "0") + "-01";
    expDateInput.max = m.year + "-" + String(m.month + 1).padStart(2, "0") + "-" + String(lastDay).padStart(2, "0");
    renderStats(m);
    renderExpenses(m);
  }
  showScreen("month");
}

function renderStats(m) {
  const spent     = m.expenses.reduce((s, e) => s + e.val, 0);
  const remaining = m.budget - spent;
  displayBudget.textContent    = fmt(m.budget);
  displaySpent.textContent     = fmt(spent);
  displayRemaining.textContent = fmt(remaining);
  displayRemaining.classList.toggle("over-budget", remaining < 0);

  // -- #18: Budget progress bar
  const progressWrap   = document.getElementById("budget-progress-wrap");
  const barFill        = document.getElementById("budget-bar-fill");
  const pctText        = document.getElementById("budget-pct-text");
  if (progressWrap && barFill && pctText && m.budget > 0) {
    const rawPct     = spent / m.budget * 100;
    const clampPct   = Math.min(rawPct, 100);
    const colorClass = rawPct >= 100 ? "over" : rawPct >= 80 ? "warn" : "";
    barFill.style.width = clampPct + "%";
    barFill.className   = "budget-bar-fill" + (colorClass ? " " + colorClass : "");
    pctText.textContent = rawPct.toFixed(1) + "% of budget used";
    pctText.className   = "budget-pct-text" + (colorClass ? " " + colorClass : "");
    progressWrap.classList.remove("hidden");
  } else if (progressWrap) {
    progressWrap.classList.add("hidden");
  }

  // -- #19: Daily allowance (current month only)
  const dailyEl        = document.getElementById("daily-allowance");
  const currentMonthId = getCurrentMonthId();
  if (dailyEl) {
    if (m.id === currentMonthId && remaining > 0) {
      const now      = new Date();
      const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
      if (daysLeft > 0) {
        const daily = remaining / daysLeft;
        dailyEl.textContent = fmt(daily) + " / day remaining  (" + daysLeft + " day" + (daysLeft !== 1 ? "s" : "") + " left in month)";
        dailyEl.classList.remove("hidden");
      } else {
        dailyEl.classList.add("hidden");
      }
    } else {
      dailyEl.classList.add("hidden");
    }
  }

  // -- #20: Spending projection (current month only, >=3 days passed, >=1 expense)
  const projEl = document.getElementById("spending-projection");
  if (projEl) {
    const now         = new Date();
    const daysPassed  = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (m.id === currentMonthId && daysPassed >= 3 && m.expenses.length > 0) {
      const dailyRate = spent / daysPassed;
      const projected = dailyRate * daysInMonth;
      const diff      = projected - m.budget;
      if (diff > 0) {
        projEl.textContent = "At this pace: " + fmt(projected) + " projected  \u26A0 " + fmt(diff) + " over budget";
        projEl.className   = "stat-hint over";
      } else {
        projEl.textContent = "At this pace: " + fmt(projected) + " projected  \u2713 On track to finish under budget";
        projEl.className   = "stat-hint ok";
      }
      projEl.classList.remove("hidden");
    } else {
      projEl.classList.add("hidden");
    }
  }
}

function formatExpenseDate(isoDate) {
  if (!isoDate) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    const [y, mo, d] = isoDate.split("-").map(Number);
    return new Date(y, mo - 1, d).toLocaleDateString("en-US");
  }
  return isoDate; // unmigrated fallback — display as-is
}

function renderExpenses(m) {
  // -- #21: Mobile cards at <=480px, table on desktop
  if (window.innerWidth <= 480) {
    _renderExpenseCards(m);
  } else {
    _renderExpenseTable(m);
  }
}

function _renderExpenseTable(m) {
  // Remove any mobile card list if switching back to desktop
  const existingCards = document.getElementById("expense-card-list");
  if (existingCards) existingCards.remove();
  const table = tableBody.closest("table");
  if (table) table.style.display = "";

  tableBody.innerHTML = "";
  if (m.expenses.length === 0) {
    tableBody.innerHTML = '<tr class="expense-row"><td colspan="4" style="text-align:center;color:#555;">No expenses recorded yet.</td></tr>';
    return;
  }
  m.expenses.forEach((exp) => {
    const tr = document.createElement("tr");
    tr.className = "expense-row";

    const tdDate = document.createElement("td");
    tdDate.textContent = formatExpenseDate(exp.date);

    const tdDesc = document.createElement("td");
    tdDesc.textContent = exp.desc;

    const tdVal = document.createElement("td");
    tdVal.className = "value-col";
    tdVal.textContent = fmt(exp.val);

    const tdAction = document.createElement("td");
    tdAction.className = "action-col action-col--wide";

    const btnEdit = document.createElement("button");
    btnEdit.className = "btn-edit-expense";
    btnEdit.dataset.id = exp.id;
    btnEdit.title = "Edit expense";
    btnEdit.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">edit</span>';
    btnEdit.addEventListener("click", () => openEditExpenseModal(exp.id));

    const btnDel = document.createElement("button");
    btnDel.className = "btn-danger btn-del-expense";
    btnDel.dataset.id = exp.id;
    btnDel.textContent = "Del";
    btnDel.addEventListener("click", () => deleteExpense(exp.id));

    tdAction.appendChild(btnEdit);
    tdAction.appendChild(btnDel);
    tr.appendChild(tdDate);
    tr.appendChild(tdDesc);
    tr.appendChild(tdVal);
    tr.appendChild(tdAction);
    tableBody.appendChild(tr);
  });
}

function _renderExpenseCards(m) {
  // Hide the table, insert card list adjacent to it
  const table = tableBody.closest("table");
  if (table) table.style.display = "none";
  tableBody.innerHTML = "";

  // Reuse or create the card list container
  let cardList = document.getElementById("expense-card-list");
  if (!cardList) {
    cardList = document.createElement("div");
    cardList.id = "expense-card-list";
    cardList.className = "expense-card-list";
    if (table && table.parentNode) {
      table.parentNode.insertBefore(cardList, table);
    }
  }
  cardList.innerHTML = "";

  if (m.expenses.length === 0) {
    const empty = document.createElement("div");
    empty.className = "expense-card-empty";
    empty.textContent = "No expenses recorded yet.";
    cardList.appendChild(empty);
    return;
  }

  m.expenses.forEach((exp) => {
    const card = document.createElement("div");
    card.className = "expense-card";

    const descEl = document.createElement("div");
    descEl.className = "expense-card-desc";
    descEl.textContent = exp.desc;

    const row = document.createElement("div");
    row.className = "expense-card-row";

    const dateEl = document.createElement("span");
    dateEl.className = "expense-card-date";
    dateEl.textContent = formatExpenseDate(exp.date);

    const valEl = document.createElement("span");
    valEl.className = "expense-card-val";
    valEl.textContent = fmt(exp.val);

    const actionsEl = document.createElement("div");
    actionsEl.className = "expense-card-actions";

    const btnEdit = document.createElement("button");
    btnEdit.className = "btn-edit-expense";
    btnEdit.dataset.id = exp.id;
    btnEdit.title = "Edit expense";
    btnEdit.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">edit</span>';
    btnEdit.addEventListener("click", () => openEditExpenseModal(exp.id));

    const btnDel = document.createElement("button");
    btnDel.className = "btn-danger btn-del-expense";
    btnDel.dataset.id = exp.id;
    btnDel.textContent = "Del";
    btnDel.addEventListener("click", () => deleteExpense(exp.id));

    actionsEl.appendChild(btnEdit);
    actionsEl.appendChild(btnDel);

    row.appendChild(dateEl);
    row.appendChild(valEl);
    row.appendChild(actionsEl);

    card.appendChild(descEl);
    card.appendChild(row);
    cardList.appendChild(card);
  });
}

// -- UNDO TOAST HELPERS
function showUndoToast(message) {
  const toast = document.getElementById("undo-toast");
  if (!toast) return;
  document.getElementById("undo-toast-msg").textContent = message;
  toast.classList.remove("hidden");
}

function hideUndoToast() {
  const toast = document.getElementById("undo-toast");
  if (toast) toast.classList.add("hidden");
}

function deleteExpense(expId) {
  const m = getActiveMonth();
  if (!m) return;

  // If there's an active undo window for a previous deletion, commit it now
  if (_undoTimer) {
    clearTimeout(_undoTimer);
    _undoTimer    = null;
    _lastDeleted  = null;
    hideUndoToast();
    flushToCloud();
  }

  const idx = m.expenses.findIndex((e) => e.id === expId);
  if (idx === -1) return;

  // Stash for potential undo
  _lastDeleted = { expense: m.expenses[idx], index: idx, monthId: m.id };

  // Remove from state + update local cache immediately (no cloud flush yet)
  m.expenses.splice(idx, 1);
  state.version   = (typeof state.version === "number" && state.version > 0) ? state.version + 1 : 1;
  state.updatedAt = new Date().toISOString();
  writeLocalCache(state);

  renderStats(m);
  renderExpenses(m);

  showUndoToast("Expense deleted");

  // 4-second undo window — on expiry, flush to cloud
  _undoTimer = setTimeout(() => {
    _undoTimer   = null;
    _lastDeleted = null;
    hideUndoToast();
    flushToCloud();
  }, 4000);
}

function undoDeleteExpense() {
  if (!_lastDeleted) return;
  clearTimeout(_undoTimer);
  _undoTimer = null;

  const { expense, index, monthId } = _lastDeleted;
  _lastDeleted = null;

  const m = state.months.find((x) => x.id === monthId);
  if (!m) { hideUndoToast(); return; }

  // Re-insert at original position
  m.expenses.splice(index, 0, expense);
  state.version   = (typeof state.version === "number" && state.version > 0) ? state.version + 1 : 1;
  state.updatedAt = new Date().toISOString();
  writeLocalCache(state);

  if (m.id === activeMonthId) {
    renderStats(m);
    renderExpenses(m);
  }
  hideUndoToast();
}

// -- EXPENSE EDIT MODAL
let _editingExpenseId = null;

function openEditExpenseModal(expId) {
  const m = getActiveMonth();
  if (!m) return;
  const exp = m.expenses.find((e) => e.id === expId);
  if (!exp) return;

  _editingExpenseId = expId;

  const descEl = document.getElementById("edit-exp-desc");
  const valEl  = document.getElementById("edit-exp-val");
  const dateEl = document.getElementById("edit-exp-date");

  descEl.value = exp.desc;
  valEl.value  = exp.val;
  dateEl.value = exp.date || "";

  // Constrain date picker to the viewed month
  const lastDay = new Date(m.year, m.month + 1, 0).getDate();
  dateEl.min = m.year + "-" + String(m.month + 1).padStart(2, "0") + "-01";
  dateEl.max = m.year + "-" + String(m.month + 1).padStart(2, "0") + "-" + String(lastDay).padStart(2, "0");

  // Clear any previous validation state
  [descEl, valEl, dateEl].forEach((el) => el.classList.remove("is-invalid"));
  ["err-edit-exp-desc", "err-edit-exp-val", "err-edit-exp-date"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });

  document.getElementById("edit-expense-overlay").classList.remove("hidden");
  descEl.focus();
}

function closeEditExpenseModal() {
  _editingExpenseId = null;
  document.getElementById("edit-expense-overlay").classList.add("hidden");
}

document.getElementById("btn-edit-expense-close-x").addEventListener("click", closeEditExpenseModal);
document.getElementById("btn-edit-expense-cancel").addEventListener("click", closeEditExpenseModal);
document.getElementById("edit-expense-overlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("edit-expense-overlay")) closeEditExpenseModal();
});

document.getElementById("btn-edit-expense-save").addEventListener("click", () => {
  if (!_editingExpenseId) return;
  const m = getActiveMonth();
  if (!m) return;
  const exp = m.expenses.find((e) => e.id === _editingExpenseId);
  if (!exp) return;

  const descEl = document.getElementById("edit-exp-desc");
  const valEl  = document.getElementById("edit-exp-val");
  const dateEl = document.getElementById("edit-exp-date");

  const newDesc = descEl.value.trim();
  const newVal  = parseFloat(valEl.value);
  const newDate = dateEl.value;

  let valid = true;
  if (!newDesc) {
    showFieldError(descEl, "err-edit-exp-desc", "Description is required.");
    valid = false;
  } else {
    clearFieldError(descEl, "err-edit-exp-desc");
  }

  if (!newVal || newVal <= 0) {
    showFieldError(valEl, "err-edit-exp-val", "Enter a valid amount.");
    valid = false;
  } else {
    clearFieldError(valEl, "err-edit-exp-val");
  }

  if (!newDate) {
    showFieldError(dateEl, "err-edit-exp-date", "Date is required.");
    valid = false;
  } else {
    clearFieldError(dateEl, "err-edit-exp-date");
  }

  if (!valid) return;

  // Mutate in-place — id and createdAt are untouched
  exp.desc = newDesc;
  exp.val  = newVal;
  exp.date = newDate;

  saveState();
  renderStats(m);
  renderExpenses(m);
  closeEditExpenseModal();
});

// -- EVENT LISTENERS

// Shared post-auth entry: load state and show history screen.
// Does NOT touch the login button — callers own their own loading state.
async function doLogin() {
  // Verify the Supabase session is active before proceeding
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    handleSessionInvalid("SESSION_INVALID");
    throw new Error("SESSION_INVALID");
  }

  const cloudState = await loadState();
  state = cloudState;
  writeLocalCache(state);
  ensureCurrentMonth();
  sortMonths();
  renderHistory();
  renderWelcomeName();
  showScreen("history");
}

// Login -- uses Supabase Auth instead of GAS session tokens
document.getElementById("btn-login").addEventListener("click", async () => {
  const uEl = document.getElementById("username");
  const pEl = document.getElementById("password");
  const u   = uEl.value.trim();
  const p   = pEl.value;

  clearFieldError(uEl, "err-username");
  clearFieldError(pEl, "err-password");
  clearBanner("login-error");

  let valid = true;
  if (!u) { showFieldError(uEl, "err-username", "Username is required."); valid = false; }
  if (!p) { showFieldError(pEl, "err-password", "Password is required."); valid = false; }
  if (!valid) return;

  const btnLogin = document.getElementById("btn-login");
  btnLogin.classList.add("btn--loading");
  btnLogin.disabled = true;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: u, password: p });
    if (error) {
      const msg = error.message || "";
      if (msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("credentials") || error.status === 400) {
        showFieldError(pEl, "err-password", "Invalid username or password.");
        uEl.classList.add("is-invalid");
      } else if (error.status === 429) {
        showBanner("login-error", "Too many failed attempts. Try again later.");
      } else {
        showBanner("login-error", "Could not reach the server. Check your connection.");
      }
      return;
    }
    // Supabase manages its own session in localStorage — no manual storeSession needed
    await doLogin();
  } catch (err) {
    showBanner("login-error", "Could not reach the server. Check your connection.");
  } finally {
    btnLogin.classList.remove("btn--loading");
    btnLogin.disabled = false;
  }
});

// Allow Enter key on login
document.getElementById("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});

async function doLogout() {
  const btn = document.getElementById("btn-logout");
  if (btn) { btn.classList.add("btn--loading"); btn.disabled = true; }

  try {
    // Best-effort sign out from Supabase — non-blocking on error
    await supabase.auth.signOut();
    closeProfileModal();
    clearSession();
    state = { months: [] };
    activeMonthId = null;
    document.getElementById("username").value = "";
    document.getElementById("password").value = "";
    showScreen("login");
  } finally {
    if (btn) { btn.classList.remove("btn--loading"); btn.disabled = false; }
  }
}

// Back to history
document.getElementById("btn-back").addEventListener("click", () => {
  activeMonthId = null;
  renderHistory();
  showScreen("history");
});

// Create new month
document.getElementById("btn-create-month").addEventListener("click", openMonthPicker);

// Set / update budget
btnSetBudget.addEventListener("click", () => {
  const m = getActiveMonth();
  if (!m) return;
  const val = parseFloat(budgetInput.value);
  if (!val || val <= 0) {
    budgetInput.classList.add("is-invalid");
    budgetInput.setAttribute("placeholder", "Enter a valid amount");
    return;
  }
  budgetInput.classList.remove("is-invalid");
  m.budget = val;
  saveState();
  budgetSetupBox.classList.add("hidden");
  statsSection.classList.remove("hidden");
  addExpenseSection.classList.remove("hidden");
  renderStats(m);
  renderExpenses(m);
});

// Cancel budget setup
document.getElementById("btn-cancel-budget").addEventListener("click", () => {
  const m = getActiveMonth();
  if (!m) return;
  budgetInput.classList.remove("is-invalid");
  budgetInput.value = "";
  if (m.budget !== null) {
    // Edit mode — restore stats view
    budgetSetupBox.classList.add("hidden");
    statsSection.classList.remove("hidden");
    addExpenseSection.classList.remove("hidden");
  } else {
    // First-time setup — go back to history
    activeMonthId = null;
    renderHistory();
    showScreen("history");
  }
});

// Edit budget
document.getElementById("btn-edit-budget").addEventListener("click", () => {
  const m = getActiveMonth();
  if (!m) return;
  budgetInput.value = m.budget !== null ? m.budget : "";
  budgetSetupBox.classList.remove("hidden");
  statsSection.classList.add("hidden");
  addExpenseSection.classList.add("hidden");
  // Hide analytics elements while budget setup box is shown
  ["budget-progress-wrap", "daily-allowance", "spending-projection"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
  budgetInput.focus();
});

// Add expense
btnAddExpense.addEventListener("click", addExpense);
valInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addExpense();
});

function addExpense() {
  const m = getActiveMonth();
  if (!m) return;
  const desc    = descInput.value.trim();
  const val     = parseFloat(valInput.value);
  const dateVal = expDateInput.value; // "YYYY-MM-DD"

  let valid = true;
  if (!desc) { descInput.classList.add("is-invalid"); valid = false; }
  else descInput.classList.remove("is-invalid");

  if (!val || val <= 0) { valInput.classList.add("is-invalid"); valid = false; }
  else valInput.classList.remove("is-invalid");

  if (!dateVal) {
    showFieldError(expDateInput, "err-exp-date", "Date is required.");
    expDateInput.classList.add("is-invalid");
    valid = false;
  } else {
    expDateInput.classList.remove("is-invalid");
    // Warn if outside the viewed month (non-blocking)
    const minDate = expDateInput.min;
    const maxDate = expDateInput.max;
    if ((minDate && dateVal < minDate) || (maxDate && dateVal > maxDate)) {
      showFieldError(expDateInput, "err-exp-date", "Date is outside this month.");
    } else {
      clearFieldError(expDateInput, "err-exp-date");
    }
  }

  if (!valid) return;

  m.expenses.push({ id: uid(), desc, val, date: dateVal, createdAt: new Date().toISOString() });
  saveState();
  renderStats(m);
  renderExpenses(m);
  descInput.value = "";
  valInput.value = "";
  expDateInput.value = new Date().toISOString().slice(0, 10);
  clearFieldError(expDateInput, "err-exp-date");
  descInput.focus();
}

// -- PROFILE MODAL
const profileOverlay    = document.getElementById("profile-overlay");
const displayNameInput  = document.getElementById("display-name-input");
const currentPassInput  = document.getElementById("current-pass-input");
const newPassInput      = document.getElementById("new-pass-input");
const confirmPassInput  = document.getElementById("confirm-pass-input");

function getDisplayName() {
  return localStorage.getItem("afk_display_name") || "User";
}

function setDisplayName(name) {
  localStorage.setItem("afk_display_name", name.trim() || "User");
}

function openProfileModal() {
  displayNameInput.value  = getDisplayName();
  currentPassInput.value  = "";
  newPassInput.value      = "";
  confirmPassInput.value  = "";
  profileOverlay.classList.remove("hidden");
}

function closeProfileModal() {
  profileOverlay.classList.add("hidden");
}

document.querySelectorAll(".btn-eye-profile").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    const icon = btn.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = isHidden ? "visibility_off" : "visibility";
  });
});

document.getElementById("btn-profile").addEventListener("click",   openProfileModal);
document.getElementById("btn-profile-2").addEventListener("click", openProfileModal);
document.getElementById("btn-profile-close-x").addEventListener("click", closeProfileModal);
profileOverlay.addEventListener("click", (e) => { if (e.target === profileOverlay) closeProfileModal(); });

document.getElementById("btn-logout").addEventListener("click", doLogout);

document.getElementById("btn-profile-save").addEventListener("click", async () => {
  const newName     = displayNameInput.value.trim();
  const newPass     = newPassInput.value;
  const confirmPass = confirmPassInput.value;
  const btn         = document.getElementById("btn-profile-save");

  if (newName) {
    setDisplayName(newName);
    renderWelcomeName();
  }

  const currentPass = currentPassInput.value;
  if (currentPass || newPass || confirmPass) {
    if (!currentPass) {
      showFieldError(currentPassInput, "err-current-pass", "Current password is required.");
      return;
    }
    if (newPass !== confirmPass) {
      showFieldError(confirmPassInput, "err-confirm-pass", "Passwords do not match.");
      return;
    }
    if (newPass.length < 8) {
      showFieldError(newPassInput, "err-new-pass", "Minimum 8 characters.");
      return;
    }

    btn.classList.add("btn--loading");
    btn.disabled = true;

    try {
      const session = getStoredSession();
      if (!session) { handleSessionInvalid("SESSION_INVALID"); return; }
      const json = await apiRequest({
        action:          "changePassword",
        token:           session.token,
        currentPassword: currentPass,
        newPassword:     newPass,
      });
      if (!json.ok) {
        const err = json.error || "";
        if (err === "SESSION_INVALID" || err === "ACCOUNT_INACTIVE") {
          handleSessionInvalid(err);
          return;
        }
        if (err === "NETWORK_ERROR" || err === "TIMEOUT" || err === "INVALID_RESPONSE") {
          showFieldError(newPassInput, "err-new-pass", "Could not reach the server. Try again.");
          return;
        }
        showFieldError(currentPassInput, "err-current-pass", "Current password is incorrect.");
        return;
      }
      [currentPassInput, newPassInput, confirmPassInput].forEach((el) => {
        el.value = "";
        el.classList.remove("is-invalid");
      });
      ["err-current-pass", "err-new-pass", "err-confirm-pass"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) { el.textContent = ""; el.style.color = ""; }
      });
      const successEl = document.getElementById("err-confirm-pass");
      if (successEl) {
        successEl.style.color = "var(--success)";
        successEl.textContent = "Password updated.";
        setTimeout(() => { successEl.textContent = ""; successEl.style.color = ""; }, 3000);
      }
    } finally {
      btn.classList.remove("btn--loading");
      btn.disabled = false;
    }
    return;
  }
  closeProfileModal();
});

// -- AUTO-LOGIN ON PAGE LOAD
(async function init() {
  applyTheme(getPreferredTheme());

  // Check Supabase session instead of the legacy GAS token
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return; // no active session -- show login screen

  loginScreen.classList.add("hidden");

  const cached = readLocalCache();

  if (cached) {
    // Warm load: render from cache immediately, sync cloud in background
    state = cached;
    ensureCurrentMonth();
    sortMonths();
    renderHistory();
    renderWelcomeName();
    showScreen("history");

    try {
      const localSnapshot = state;
      const cloudState = await loadState();
      const { resolved, localWon } = resolveConflict(localSnapshot, cloudState);
      state = resolved;
      writeLocalCache(state);
      ensureCurrentMonth();
      sortMonths();
      renderHistory();
      if (localWon) {
        // Local was ahead of cloud — push it up
        await flushToCloud();
      }
    } catch (e) {
      // Cloud unavailable — local cache is still displayed, no disruption
      console.error("Background sync failed:", e);
    }
  } else {
    // Cold load: no cache — show loading overlay, block on GAS
    const overlay = document.createElement("div");
    overlay.id = "init-loading";
    overlay.style.cssText = [
      "position:fixed", "inset:0",
      "background:#0b0c10",
      "display:flex", "align-items:center", "justify-content:center",
      "flex-direction:column", "gap:18px",
      "z-index:999",
      "font-family:'Segoe UI',sans-serif",
    ].join(";");
    overlay.innerHTML = `
      <style>
        @keyframes _dots {
          0%,20%  { content: ".";   }
          40%     { content: "..";  }
          60%,100%{ content: "..."; }
        }
        @keyframes _pulse {
          0%,100% { opacity: 0.7; }
          50%     { opacity: 1;   }
        }
        #_load-logo { animation: _pulse 1.8s ease-in-out infinite; max-width:220px; width:80vw; }
        #_load-text::after {
          content: "...";
          display: inline-block;
          animation: _dots 1.4s steps(1,end) infinite;
        }
      </style>
      <img id="_load-logo" src="images/logo.png" alt="AFK Arena Tracker"/>
      <div style="color:#d4cfc8;font-size:12px;letter-spacing:2px;text-transform:uppercase;">
        <span id="_load-text">Loading</span>
      </div>
    `;
    document.body.appendChild(overlay);

    try {
      await doLogin();
    } catch (e) {
      // doLogin threw (e.g. SESSION_INVALID from getState) -- handleSessionInvalid already ran
      console.error("init doLogin failed:", e);
    }

    overlay.remove();
  }
})();
