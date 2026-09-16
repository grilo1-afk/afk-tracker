import { supabase } from "./supabase-client.js";

// -- STATE
// Schema: { displayName, months: [{ id (uuid), name, year, month (0-based), budget (null|number), expenses: [{id (uuid), desc, val, date, createdAt}] }] }
let state = { displayName: null, months: [] };
let activeMonthId = null;

// -- UNDO STATE (expense deletion)
let _lastDeleted = null; // { expense, index, monthId }
let _undoTimer = null; // handle for the 4-second undo window

const MONTH_NAMES = [
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

// -- SESSION HELPERS (legacy key cleanup only — Supabase manages its own session)
const SESSION_KEY = "afk_session";
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

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("afk_logged_in");
  clearLocalCache();
}

// -- DB ROW → UI STATE MAPPER
// months.month in DB is 1-based; UI expects 0-based.
// budget = 0 in DB means "not set" → map to null in UI.
function dbRowsToState(monthRows) {
  const months = monthRows.map((m) => ({
    id: m.id,
    name: m.name,
    year: m.year,
    month: m.month - 1, // DB 1-based → UI 0-based
    budget: m.budget > 0 ? parseFloat(m.budget) : null,
    expenses: (m.expenses || []).map((e) => ({
      id: e.id,
      desc: e.description,
      val: parseFloat(e.amount),
      date: e.expense_date, // "YYYY-MM-DD" string
      createdAt: e.created_at,
    })),
  }));
  return { months };
}

// -- SUPABASE PERSISTENCE

async function loadState() {
  // Fetch months+expenses and profile display_name in parallel
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;

  const [monthsResult, profileResult] = await Promise.all([
    supabase
      .from("months")
      .select("*, expenses(*)")
      .order("year", { ascending: false })
      .order("month", { ascending: false }),
    user
      ? supabase.from("profiles").select("display_name").eq("id", user.id).single()
      : Promise.resolve({ data: null }),
  ]);

  if (monthsResult.error) {
    if (monthsResult.error.message && monthsResult.error.message.toLowerCase().includes("jwt")) {
      handleSessionInvalid("SESSION_INVALID");
    }
    throw new Error(monthsResult.error.message || "DB_ERROR");
  }

  const newState = dbRowsToState(monthsResult.data || []);
  const displayName = (profileResult.data && profileResult.data.display_name) || null;
  if (displayName) cacheDisplayName(displayName);
  newState.displayName = displayName || getDisplayName();
  return newState;
}

// Insert a new month row. Returns the inserted row's id (uuid) on success or null on failure.
async function dbAddMonth(year, monthOneBased, name) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData && authData.user;
  if (!user) {
    handleSessionInvalid("SESSION_INVALID");
    return null;
  }
  const { data, error } = await supabase
    .from("months")
    .insert({
      user_id: user.id,
      year,
      month: monthOneBased,
      name,
      budget: 0,
    })
    .select("id")
    .single();

  if (error) {
    showBanner("login-error", "Could not create month. Please try again.");
    console.error("dbAddMonth:", error);
    return null;
  }
  return data.id;
}

// Update the budget for a month row.
async function dbUpdateBudget(monthUuid, budget) {
  const { error } = await supabase
    .from("months")
    .update({ budget })
    .eq("id", monthUuid);

  if (error) {
    showBanner("login-error", "Could not save budget. Please try again.");
    console.error("dbUpdateBudget:", error);
    return false;
  }
  return true;
}

// Delete a month row (cascades to expenses via FK).
async function dbDeleteMonth(monthUuid) {
  const { error } = await supabase.from("months").delete().eq("id", monthUuid);

  if (error) {
    showBanner("login-error", "Could not delete month. Please try again.");
    console.error("dbDeleteMonth:", error);
    return false;
  }
  return true;
}

// Insert an expense. Returns the inserted row's id (uuid) on success or null on failure.
async function dbAddExpense(monthUuid, desc, amount, expenseDate) {
  const { data, error } = await supabase
    .from("expenses")
    .insert({
      month_id: monthUuid,
      description: desc,
      amount,
      expense_date: expenseDate,
    })
    .select("id, created_at")
    .single();

  if (error) {
    showBanner("login-error", "Could not save expense. Please try again.");
    console.error("dbAddExpense:", error);
    return null;
  }
  return data;
}

// Update an existing expense.
async function dbUpdateExpense(expenseUuid, desc, amount, expenseDate) {
  const { error } = await supabase
    .from("expenses")
    .update({
      description: desc,
      amount,
      expense_date: expenseDate,
    })
    .eq("id", expenseUuid);

  if (error) {
    showBanner("login-error", "Could not update expense. Please try again.");
    console.error("dbUpdateExpense:", error);
    return false;
  }
  return true;
}

// Delete an expense row.
async function dbDeleteExpense(expenseUuid) {
  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("id", expenseUuid);

  if (error) {
    showBanner("login-error", "Could not delete expense. Please try again.");
    console.error("dbDeleteExpense:", error);
    return false;
  }
  return true;
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
    showBanner(
      "login-error",
      "Your account has been deactivated. Contact support.",
    );
  } else {
    showBanner("login-error", "Your session has expired. Please log in again.");
  }
}

// -- DOM REFS
const loginScreen = document.getElementById("login-screen");
const historyScreen = document.getElementById("history-screen");
const monthScreen = document.getElementById("month-screen");
const monthList = document.getElementById("month-list");
const monthViewTitle = document.getElementById("month-view-title");

const budgetSetupBox = document.getElementById("budget-setup-box");
const statsSection = document.getElementById("stats-section");
const addExpenseSection = document.getElementById("add-expense-section");
const budgetInput = document.getElementById("budget-input");
const btnSetBudget = document.getElementById("btn-set-budget");
const displayBudget = document.getElementById("display-budget");
const displaySpent = document.getElementById("display-spent");
const displayRemaining = document.getElementById("display-remaining");

const descInput = document.getElementById("desc");
const valInput = document.getElementById("val");
const expDateInput = document.getElementById("exp-date");
const btnAddExpense = document.getElementById("btn-add-expense");
const tableBody = document.getElementById("expense-table-body");

// -- THEME
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("afk_theme", theme);
  const icon = theme === "dark" ? "light_mode" : "dark_mode";
  document.querySelectorAll(".theme-icon").forEach((el) => {
    el.textContent = icon;
  });
}

function getPreferredTheme() {
  const saved = localStorage.getItem("afk_theme");
  if (saved) return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
}

document.getElementById("btn-theme").addEventListener("click", toggleTheme);
document.getElementById("btn-theme-2").addEventListener("click", toggleTheme);

// -- PASSWORD TOGGLE
document.getElementById("btn-toggle-password").addEventListener("click", () => {
  const pwd = document.getElementById("password");
  const icon = document.getElementById("eye-icon");
  const isHidden = pwd.type === "password";
  pwd.type = isHidden ? "text" : "password";
  icon.textContent = isHidden ? "visibility_off" : "visibility";
});

// -- MONTH PICKER MODAL
const pickerOverlay = document.getElementById("month-picker-overlay");
const pickMonthSel = document.getElementById("pick-month");
const pickYearSel = document.getElementById("pick-year");

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
  pickYearSel.value = now.getFullYear();
  pickerOverlay.classList.remove("hidden");
}

function closeMonthPicker() {
  pickerOverlay.classList.add("hidden");
}

document
  .getElementById("btn-pick-cancel")
  .addEventListener("click", closeMonthPicker);
pickerOverlay.addEventListener("click", (e) => {
  if (e.target === pickerOverlay) closeMonthPicker();
});

document
  .getElementById("btn-pick-confirm")
  .addEventListener("click", async () => {
    const m = parseInt(pickMonthSel.value, 10); // 0-based from <select>
    const y = parseInt(pickYearSel.value, 10);
    const name = MONTH_NAMES[m] + " " + y;

    // Dedup check by year + 0-based month (id is now a DB uuid, not a calendar string)
    if (state.months.find((x) => x.year === y && x.month === m)) {
      const existing = document.getElementById("pick-error");
      if (existing) existing.textContent = name + " already exists.";
      return;
    }

    const newId = await dbAddMonth(y, m + 1, name); // DB month is 1-based
    if (!newId) return; // error banner shown by dbAddMonth

    const newMonth = {
      id: newId,
      name,
      year: y,
      month: m,
      budget: null,
      expenses: [],
    };
    state.months.push(newMonth);
    sortMonths();
    closeMonthPicker();
    renderHistory();
    openMonth(newId);
  });

// -- UTILS
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
  if (!pickerOverlay.classList.contains("hidden")) {
    closeMonthPicker();
    return;
  }
  const dmOverlay = document.getElementById("delete-month-overlay");
  if (dmOverlay && !dmOverlay.classList.contains("hidden")) {
    closeDeleteMonthModal();
    return;
  }
  const eeOverlay = document.getElementById("edit-expense-overlay");
  if (eeOverlay && !eeOverlay.classList.contains("hidden")) {
    closeEditExpenseModal();
    return;
  }
  if (!profileOverlay.classList.contains("hidden")) {
    closeProfileModal();
    return;
  }
});

["username", "password"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", () => {
    clearFieldError(document.getElementById(id), "err-" + id);
    clearBanner("login-error");
  });
});

// -- DISPLAY NAME
// Fetches display_name from the profiles table, caches it in localStorage,
// then updates the welcome-name element. Falls back to cached/default on error.
async function renderWelcomeName() {
  try {
    const { data: authData } = await supabase.auth.getUser();
    const user = authData && authData.user;
    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .single();
      const name = (profile && profile.display_name) || null;
      if (name) cacheDisplayName(name);
    }
  } catch (_) { /* non-fatal — fall through to cached value */ }

  const el = document.getElementById("welcome-name");
  if (el) el.textContent = getDisplayName();
}

function getActiveMonth() {
  return state.months.find((m) => m.id === activeMonthId) || null;
}

function getCurrentMonthId() {
  const now = new Date();
  // Returns a year+month key matching DB uuid lookup via year/month fields
  return { year: now.getFullYear(), month: now.getMonth() }; // month 0-based
}

// Returns the month object whose year+month matches the current calendar month
function getCurrentMonthObj() {
  const { year, month } = getCurrentMonthId();
  return state.months.find((m) => m.year === year && m.month === month) || null;
}

// -- SCREEN ROUTING
const SCREENS = {
  login: loginScreen,
  history: historyScreen,
  month: monthScreen,
};

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
  const currentObj = getCurrentMonthObj();
  monthList.innerHTML = "";
  if (state.months.length === 0) {
    monthList.innerHTML =
      '<div class="empty-history">No months recorded yet. Create your first month below.</div>';
    return;
  }
  state.months.forEach((m) => {
    const isCurrent = currentObj && m.id === currentObj.id;
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
  const expCount = m.expenses.length;
  document.getElementById("delete-month-name").textContent =
    "Delete " + m.name + "?";
  document.getElementById("delete-month-stats").textContent =
    expCount +
    " expense" +
    (expCount !== 1 ? "s" : "") +
    " \u00B7 " +
    fmt(totalSpent) +
    " spent";
  document.getElementById("delete-month-overlay").classList.remove("hidden");
}

function closeDeleteMonthModal() {
  _pendingDeleteMonthId = null;
  document.getElementById("delete-month-overlay").classList.add("hidden");
}

document
  .getElementById("btn-delete-month-cancel")
  .addEventListener("click", closeDeleteMonthModal);
document
  .getElementById("btn-delete-month-confirm")
  .addEventListener("click", async () => {
    if (!_pendingDeleteMonthId) return;
    await deleteMonth(_pendingDeleteMonthId);
    closeDeleteMonthModal();
  });
document
  .getElementById("delete-month-overlay")
  .addEventListener("click", (e) => {
    if (e.target === document.getElementById("delete-month-overlay"))
      closeDeleteMonthModal();
  });

async function deleteMonth(id) {
  const ok = await dbDeleteMonth(id);
  if (!ok) return;
  state.months = state.months.filter((x) => x.id !== id);
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
    const today = new Date().toISOString().slice(0, 10);
    expDateInput.value = today;
    const lastDay = new Date(m.year, m.month + 1, 0).getDate();
    expDateInput.min =
      m.year + "-" + String(m.month + 1).padStart(2, "0") + "-01";
    expDateInput.max =
      m.year +
      "-" +
      String(m.month + 1).padStart(2, "0") +
      "-" +
      String(lastDay).padStart(2, "0");
    renderStats(m);
    renderExpenses(m);
  }
  showScreen("month");
}

function renderStats(m) {
  const spent = m.expenses.reduce((s, e) => s + e.val, 0);
  const remaining = m.budget - spent;
  displayBudget.textContent = fmt(m.budget);
  displaySpent.textContent = fmt(spent);
  displayRemaining.textContent = fmt(remaining);
  displayRemaining.classList.toggle("over-budget", remaining < 0);

  const progressWrap = document.getElementById("budget-progress-wrap");
  const barFill = document.getElementById("budget-bar-fill");
  const pctText = document.getElementById("budget-pct-text");
  if (progressWrap && barFill && pctText && m.budget > 0) {
    const rawPct = (spent / m.budget) * 100;
    const clampPct = Math.min(rawPct, 100);
    const colorClass = rawPct >= 100 ? "over" : rawPct >= 80 ? "warn" : "";
    barFill.style.width = clampPct + "%";
    barFill.className =
      "budget-bar-fill" + (colorClass ? " " + colorClass : "");
    pctText.textContent = rawPct.toFixed(1) + "% of budget used";
    pctText.className =
      "budget-pct-text" + (colorClass ? " " + colorClass : "");
    progressWrap.classList.remove("hidden");
  } else if (progressWrap) {
    progressWrap.classList.add("hidden");
  }

  const dailyEl = document.getElementById("daily-allowance");
  const currentObj = getCurrentMonthObj();
  if (dailyEl) {
    if (currentObj && m.id === currentObj.id && remaining > 0) {
      const now = new Date();
      const daysLeft =
        new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() -
        now.getDate();
      if (daysLeft > 0) {
        const daily = remaining / daysLeft;
        dailyEl.textContent =
          fmt(daily) +
          " / day remaining  (" +
          daysLeft +
          " day" +
          (daysLeft !== 1 ? "s" : "") +
          " left in month)";
        dailyEl.classList.remove("hidden");
      } else {
        dailyEl.classList.add("hidden");
      }
    } else {
      dailyEl.classList.add("hidden");
    }
  }

  const projEl = document.getElementById("spending-projection");
  if (projEl) {
    const now = new Date();
    const daysPassed = now.getDate();
    const daysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
    ).getDate();
    if (
      currentObj &&
      m.id === currentObj.id &&
      daysPassed >= 3 &&
      m.expenses.length > 0
    ) {
      const dailyRate = spent / daysPassed;
      const projected = dailyRate * daysInMonth;
      const diff = projected - m.budget;
      if (diff > 0) {
        projEl.textContent =
          "At this pace: " +
          fmt(projected) +
          " projected  \u26A0 " +
          fmt(diff) +
          " over budget";
        projEl.className = "stat-hint over";
      } else {
        projEl.textContent =
          "At this pace: " +
          fmt(projected) +
          " projected  \u2713 On track to finish under budget";
        projEl.className = "stat-hint ok";
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
  return isoDate;
}

function renderExpenses(m) {
  if (window.innerWidth <= 480) {
    _renderExpenseCards(m);
  } else {
    _renderExpenseTable(m);
  }
}

function _renderExpenseTable(m) {
  const existingCards = document.getElementById("expense-card-list");
  if (existingCards) existingCards.remove();
  const table = tableBody.closest("table");
  if (table) table.style.display = "";

  tableBody.innerHTML = "";
  if (m.expenses.length === 0) {
    tableBody.innerHTML =
      '<tr class="expense-row"><td colspan="4" style="text-align:center;color:#555;">No expenses recorded yet.</td></tr>';
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
    btnEdit.innerHTML =
      '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">edit</span>';
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
  const table = tableBody.closest("table");
  if (table) table.style.display = "none";
  tableBody.innerHTML = "";

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
    btnEdit.innerHTML =
      '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">edit</span>';
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
    _undoTimer = null;
    const prev = _lastDeleted;
    _lastDeleted = null;
    hideUndoToast();
    if (prev) dbDeleteExpense(prev.expense.id); // flush previous to DB
  }

  const idx = m.expenses.findIndex((e) => e.id === expId);
  if (idx === -1) return;

  _lastDeleted = { expense: m.expenses[idx], index: idx, monthId: m.id };
  m.expenses.splice(idx, 1);

  renderStats(m);
  renderExpenses(m);
  showUndoToast("Expense deleted");

  // 4-second undo window — on expiry, flush delete to DB
  _undoTimer = setTimeout(async () => {
    _undoTimer = null;
    const toDelete = _lastDeleted;
    _lastDeleted = null;
    hideUndoToast();
    if (toDelete) await dbDeleteExpense(toDelete.expense.id);
  }, 4000);
}

function undoDeleteExpense() {
  if (!_lastDeleted) return;
  clearTimeout(_undoTimer);
  _undoTimer = null;

  const { expense, index, monthId } = _lastDeleted;
  _lastDeleted = null;

  const m = state.months.find((x) => x.id === monthId);
  if (!m) {
    hideUndoToast();
    return;
  }

  m.expenses.splice(index, 0, expense);

  if (m.id === activeMonthId) {
    renderStats(m);
    renderExpenses(m);
  }
  hideUndoToast();
  // No DB call needed — the delete was deferred and we cancelled it
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
  const valEl = document.getElementById("edit-exp-val");
  const dateEl = document.getElementById("edit-exp-date");

  descEl.value = exp.desc;
  valEl.value = exp.val;
  dateEl.value = exp.date || "";

  const lastDay = new Date(m.year, m.month + 1, 0).getDate();
  dateEl.min = m.year + "-" + String(m.month + 1).padStart(2, "0") + "-01";
  dateEl.max =
    m.year +
    "-" +
    String(m.month + 1).padStart(2, "0") +
    "-" +
    String(lastDay).padStart(2, "0");

  [descEl, valEl, dateEl].forEach((el) => el.classList.remove("is-invalid"));
  ["err-edit-exp-desc", "err-edit-exp-val", "err-edit-exp-date"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "";
    },
  );

  document.getElementById("edit-expense-overlay").classList.remove("hidden");
  descEl.focus();
}

function closeEditExpenseModal() {
  _editingExpenseId = null;
  document.getElementById("edit-expense-overlay").classList.add("hidden");
}

document
  .getElementById("btn-edit-expense-close-x")
  .addEventListener("click", closeEditExpenseModal);
document
  .getElementById("btn-edit-expense-cancel")
  .addEventListener("click", closeEditExpenseModal);
document
  .getElementById("edit-expense-overlay")
  .addEventListener("click", (e) => {
    if (e.target === document.getElementById("edit-expense-overlay"))
      closeEditExpenseModal();
  });

document
  .getElementById("btn-edit-expense-save")
  .addEventListener("click", async () => {
    if (!_editingExpenseId) return;
    const m = getActiveMonth();
    if (!m) return;
    const exp = m.expenses.find((e) => e.id === _editingExpenseId);
    if (!exp) return;

    const descEl = document.getElementById("edit-exp-desc");
    const valEl = document.getElementById("edit-exp-val");
    const dateEl = document.getElementById("edit-exp-date");

    const newDesc = descEl.value.trim();
    const newVal = parseFloat(valEl.value);
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

    const ok = await dbUpdateExpense(exp.id, newDesc, newVal, newDate);
    if (!ok) return;

    exp.desc = newDesc;
    exp.val = newVal;
    exp.date = newDate;

    renderStats(m);
    renderExpenses(m);
    closeEditExpenseModal();
  });

// -- EVENT LISTENERS

// -- TODAY BUTTON HANDLERS
document.getElementById("btn-today-expense").addEventListener("click", () => {
  expDateInput.value = new Date().toISOString().slice(0, 10);
  expDateInput.classList.remove("is-invalid");
  clearFieldError(expDateInput, "err-exp-date");
});

document.getElementById("btn-today-edit-exp").addEventListener("click", () => {
  const dateEl = document.getElementById("edit-exp-date");
  if (dateEl) {
    dateEl.value = new Date().toISOString().slice(0, 10);
    dateEl.classList.remove("is-invalid");
    clearFieldError(dateEl, "err-edit-exp-date");
  }
});

document.getElementById("btn-back").addEventListener("click", () => {
  activeMonthId = null;
  renderHistory();
  showScreen("history");
});

document
  .getElementById("btn-create-month")
  .addEventListener("click", openMonthPicker);

btnSetBudget.addEventListener("click", async () => {
  const m = getActiveMonth();
  if (!m) return;
  const val = parseFloat(budgetInput.value);
  if (!val || val <= 0) {
    budgetInput.classList.add("is-invalid");
    budgetInput.setAttribute("placeholder", "Enter a valid amount");
    return;
  }
  budgetInput.classList.remove("is-invalid");

  const ok = await dbUpdateBudget(m.id, val);
  if (!ok) return;

  m.budget = val;
  budgetSetupBox.classList.add("hidden");
  statsSection.classList.remove("hidden");
  addExpenseSection.classList.remove("hidden");
  const today = new Date().toISOString().slice(0, 10);
  expDateInput.value = today;
  const lastDay = new Date(m.year, m.month + 1, 0).getDate();
  expDateInput.min =
    m.year + "-" + String(m.month + 1).padStart(2, "0") + "-01";
  expDateInput.max =
    m.year +
    "-" +
    String(m.month + 1).padStart(2, "0") +
    "-" +
    String(lastDay).padStart(2, "0");
  renderStats(m);
  renderExpenses(m);
});

document.getElementById("btn-cancel-budget").addEventListener("click", () => {
  const m = getActiveMonth();
  if (!m) return;
  budgetInput.classList.remove("is-invalid");
  budgetInput.value = "";
  if (m.budget !== null) {
    budgetSetupBox.classList.add("hidden");
    statsSection.classList.remove("hidden");
    addExpenseSection.classList.remove("hidden");
  } else {
    activeMonthId = null;
    renderHistory();
    showScreen("history");
  }
});

document.getElementById("btn-edit-budget").addEventListener("click", () => {
  const m = getActiveMonth();
  if (!m) return;
  budgetInput.value = m.budget !== null ? m.budget : "";
  budgetSetupBox.classList.remove("hidden");
  statsSection.classList.add("hidden");
  addExpenseSection.classList.add("hidden");
  ["budget-progress-wrap", "daily-allowance", "spending-projection"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    },
  );
  budgetInput.focus();
});

btnAddExpense.addEventListener("click", addExpense);
valInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addExpense();
});

async function addExpense() {
  const m = getActiveMonth();
  if (!m) return;
  const desc = descInput.value.trim();
  const val = parseFloat(valInput.value);
  const dateVal = expDateInput.value;

  let valid = true;
  if (!desc) {
    descInput.classList.add("is-invalid");
    valid = false;
  } else descInput.classList.remove("is-invalid");

  if (!val || val <= 0) {
    valInput.classList.add("is-invalid");
    valid = false;
  } else valInput.classList.remove("is-invalid");

  if (!dateVal) {
    showFieldError(expDateInput, "err-exp-date", "Date is required.");
    valid = false;
  } else {
    expDateInput.classList.remove("is-invalid");
    const minDate = expDateInput.min;
    const maxDate = expDateInput.max;
    if ((minDate && dateVal < minDate) || (maxDate && dateVal > maxDate)) {
      showFieldError(
        expDateInput,
        "err-exp-date",
        "Date is outside this month.",
      );
    } else {
      clearFieldError(expDateInput, "err-exp-date");
    }
  }

  if (!valid) return;

  const row = await dbAddExpense(m.id, desc, val, dateVal);
  if (!row) return;

  m.expenses.push({
    id: row.id,
    desc,
    val,
    date: dateVal,
    createdAt: row.created_at,
  });
  renderStats(m);
  renderExpenses(m);
  descInput.value = "";
  valInput.value = "";
  expDateInput.value = new Date().toISOString().slice(0, 10);
  clearFieldError(expDateInput, "err-exp-date");
  descInput.focus();
}

// -- PROFILE MODAL
const profileOverlay = document.getElementById("profile-overlay");
const displayNameInput = document.getElementById("display-name-input");
const currentPassInput = document.getElementById("current-pass-input");
const newPassInput = document.getElementById("new-pass-input");
const confirmPassInput = document.getElementById("confirm-pass-input");

// Display name is sourced from profiles table; localStorage is used only as a fast-read cache.
function getDisplayName() {
  return localStorage.getItem("afk_display_name") || "User";
}

function cacheDisplayName(name) {
  localStorage.setItem("afk_display_name", (name || "").trim() || "User");
}

async function openProfileModal() {
  // Attempt to refresh display name from DB on every open
  try {
    const { data: authData } = await supabase.auth.getUser();
    const user = authData && authData.user;
    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .single();
      if (profile && profile.display_name) {
        cacheDisplayName(profile.display_name);
      }
    }
  } catch (_) { /* non-fatal */ }

  displayNameInput.value = getDisplayName();
  currentPassInput.value = "";
  newPassInput.value = "";
  confirmPassInput.value = "";
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

document
  .getElementById("btn-profile")
  .addEventListener("click", openProfileModal);
document
  .getElementById("btn-profile-2")
  .addEventListener("click", openProfileModal);
document
  .getElementById("btn-profile-close-x")
  .addEventListener("click", closeProfileModal);
profileOverlay.addEventListener("click", (e) => {
  if (e.target === profileOverlay) closeProfileModal();
});

document
  .getElementById("btn-profile-save")
  .addEventListener("click", async () => {
    const newName = displayNameInput.value.trim();
    const newPass = newPassInput.value;
    const confirmPass = confirmPassInput.value;
    const btn = document.getElementById("btn-profile-save");

    if (newName) {
      // Persist to Supabase profiles table; keep localStorage in sync as cache
      try {
        const { data: authData } = await supabase.auth.getUser();
        const user = authData && authData.user;
        if (user) {
          await supabase
            .from("profiles")
            .update({ display_name: newName })
            .eq("id", user.id);
        }
      } catch (_) { /* non-fatal */ }
      cacheDisplayName(newName);
      await renderWelcomeName();
    }

    const currentPass = currentPassInput.value;
    if (currentPass || newPass || confirmPass) {
      if (!currentPass) {
        showFieldError(
          currentPassInput,
          "err-current-pass",
          "Current password is required.",
        );
        return;
      }
      if (newPass !== confirmPass) {
        showFieldError(
          confirmPassInput,
          "err-confirm-pass",
          "Passwords do not match.",
        );
        return;
      }
      if (newPass.length < 8) {
        showFieldError(newPassInput, "err-new-pass", "Minimum 8 characters.");
        return;
      }

      btn.classList.add("btn--loading");
      btn.disabled = true;

      try {
        const { error } = await supabase.auth.updateUser({ password: newPass });
        if (error) {
          showFieldError(
            currentPassInput,
            "err-current-pass",
            "Could not update password. Try again.",
          );
          return;
        }
        [currentPassInput, newPassInput, confirmPassInput].forEach((el) => {
          el.value = "";
          el.classList.remove("is-invalid");
        });
        ["err-current-pass", "err-new-pass", "err-confirm-pass"].forEach(
          (id) => {
            const el = document.getElementById(id);
            if (el) {
              el.textContent = "";
              el.style.color = "";
            }
          },
        );
        const successEl = document.getElementById("err-confirm-pass");
        if (successEl) {
          successEl.style.color = "var(--success)";
          successEl.textContent = "Password updated.";
          setTimeout(() => {
            successEl.textContent = "";
            successEl.style.color = "";
          }, 3000);
        }
      } finally {
        btn.classList.remove("btn--loading");
        btn.disabled = false;
      }
      return;
    }
    closeProfileModal();
  });

// -- AUTH HANDLERS

document.getElementById("btn-logout").addEventListener("click", async () => {
  const btn = document.getElementById("btn-logout");
  if (btn) {
    btn.classList.add("btn--loading");
    btn.disabled = true;
  }
  try {
    await supabase.auth.signOut();
    closeProfileModal();
    clearSession();
    state = { months: [] };
    activeMonthId = null;
    document.getElementById("username").value = "";
    document.getElementById("password").value = "";
    showScreen("login");
  } finally {
    if (btn) {
      btn.classList.remove("btn--loading");
      btn.disabled = false;
    }
  }
});

document.getElementById("btn-login").addEventListener("click", async () => {
  const uEl = document.getElementById("username");
  const pEl = document.getElementById("password");
  const u = uEl.value.trim();
  const p = pEl.value;

  clearFieldError(uEl, "err-username");
  clearFieldError(pEl, "err-password");
  clearBanner("login-error");

  let valid = true;
  if (!u) {
    showFieldError(uEl, "err-username", "Username is required.");
    valid = false;
  }
  if (!p) {
    showFieldError(pEl, "err-password", "Password is required.");
    valid = false;
  }
  if (!valid) return;

  const btnLogin = document.getElementById("btn-login");
  btnLogin.classList.add("btn--loading");
  btnLogin.disabled = true;

  try {
    // Normalize: if the user typed a plain username (no @), append the internal domain
    const email = u.includes("@") ? u : u + "@afk-tracker.com";
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: p,
    });
    if (error) {
      const msg = error.message || "";
      if (msg.toLowerCase().includes("invalid") || error.status === 400) {
        showFieldError(pEl, "err-password", "Invalid username or password.");
        uEl.classList.add("is-invalid");
      } else if (error.status === 429) {
        showBanner("login-error", "Too many failed attempts. Try again later.");
      } else {
        showBanner(
          "login-error",
          "Could not reach the server. Check your connection.",
        );
      }
      return;
    }
    await doLogin();
  } catch (err) {
    showBanner(
      "login-error",
      "Could not reach the server. Check your connection.",
    );
  } finally {
    btnLogin.classList.remove("btn--loading");
    btnLogin.disabled = false;
  }
});

document.getElementById("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});

// -- POST-AUTH ENTRY POINT
async function doLogin() {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    handleSessionInvalid("SESSION_INVALID");
    throw new Error("SESSION_INVALID");
  }
  const loaded = await loadState();
  state = loaded;
  writeLocalCache(state);
  ensureCurrentMonth();
  sortMonths();
  renderHistory();
  await renderWelcomeName();
  showScreen("history");
}

// -- ENSURE CURRENT MONTH EXISTS
function ensureCurrentMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  if (!state.months.find((m) => m.year === year && m.month === month)) {
    // Don't block — fire-and-forget insert; on success the month will appear next refresh
    // For immediate UI responsiveness, add a local placeholder and insert async
    const name = MONTH_NAMES[month] + " " + year;
    dbAddMonth(year, month + 1, name).then((newId) => {
      if (!newId) return;
      state.months.unshift({
        id: newId,
        name,
        year,
        month,
        budget: null,
        expenses: [],
      });
      sortMonths();
      renderHistory();
    });
  }
}

// -- AUTO-LOGIN ON PAGE LOAD
(async function init() {
  applyTheme(getPreferredTheme());

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return;

  loginScreen.classList.add("hidden");

  const cached = readLocalCache();

  if (cached) {
    state = cached;
    ensureCurrentMonth();
    sortMonths();
    renderHistory();
    await renderWelcomeName();
    showScreen("history");

    try {
      const fresh = await loadState();
      state = fresh;
      writeLocalCache(state);
      ensureCurrentMonth();
      sortMonths();
      renderHistory();
    } catch (e) {
      console.error("Background sync failed:", e);
    }
  } else {
    const overlay = document.createElement("div");
    overlay.id = "init-loading";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:#0b0c10",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "flex-direction:column",
      "gap:18px",
      "z-index:999",
      "font-family:'Segoe UI',sans-serif",
    ].join(";");
    overlay.innerHTML = `
      <style>
        @keyframes _dots { 0%,20%{content:"."}40%{content:".."}60%,100%{content:"..."} }
        @keyframes _pulse { 0%,100%{opacity:0.7}50%{opacity:1} }
        #_load-logo { animation:_pulse 1.8s ease-in-out infinite;max-width:220px;width:80vw; }
        #_load-text::after { content:"...";display:inline-block;animation:_dots 1.4s steps(1,end) infinite; }
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
      console.error("init doLogin failed:", e);
    }
    overlay.remove();
  }
})();
