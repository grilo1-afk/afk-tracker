import {
  state,
  activeMonthId,
  setActiveMonthId,
  MONTH_NAMES,
  fmt,
  getActiveMonth,
  getCurrentMonthObj,
  getDisplayName,
  cacheDisplayName,
} from "./state.js";
import { supabase } from "./supabase-client.js";

// -- SCREEN ROUTING
const loginScreen = document.getElementById("login-screen");
const historyScreen = document.getElementById("history-screen");
const monthScreen = document.getElementById("month-screen");

const SCREENS = {
  login: loginScreen,
  history: historyScreen,
  month: monthScreen,
};

export function showScreen(name) {
  Object.values(SCREENS).forEach((s) => s.classList.add("hidden"));
  SCREENS[name]?.classList.remove("hidden");
}

// -- THEME
function resolveTheme(preference) {
  if (preference === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return preference;
}

export function applyTheme(preference) {
  localStorage.setItem("afk_theme", preference);
  document.documentElement.setAttribute("data-theme", resolveTheme(preference));
  const select = document.getElementById("theme-select");
  if (select) select.value = preference;
}

export function getPreferredTheme() {
  return localStorage.getItem("afk_theme") || "system";
}

export function watchSystemTheme() {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener(
    "change",
    () => {
      if (getPreferredTheme() === "system") applyTheme("system");
    },
  );
}

// -- VALIDATION HELPERS
export function showFieldError(inputEl, spanId, message) {
  inputEl.classList.add("is-invalid");
  const span = document.getElementById(spanId);
  if (span) span.textContent = message;
}

export function clearFieldError(inputEl, spanId) {
  inputEl.classList.remove("is-invalid");
  const span = document.getElementById(spanId);
  if (span) span.textContent = "";
}

export function parseMoneyInput(rawValue) {
  const normalized = String(rawValue).trim().replace(",", ".");
  const val = parseFloat(normalized);
  return Number.isFinite(val) ? val : NaN;
}

export function showBanner(bannerId, message) {
  const el = document.getElementById(bannerId);
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

export function clearBanner(bannerId) {
  const el = document.getElementById(bannerId);
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

// -- DISPLAY NAME
export async function renderWelcomeName() {
  const name = state.displayName || getDisplayName();
  const el = document.getElementById("welcome-name");
  if (el) el.textContent = name;
}

// -- SORT / HISTORY
export function sortMonths() {
  state.months.sort((a, b) =>
    b.year !== a.year ? b.year - a.year : b.month - a.month,
  );
}

export function renderHistory() {
  const monthList = document.getElementById("month-list");
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
    metaDiv.className = "month-card-meta" + (hasBudget ? "" : " needs-setup");
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
    btn.textContent = "Delete";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteMonthModal(m.id, btn);
    });
    rightDiv.appendChild(btn);

    card.appendChild(clickable);
    card.appendChild(rightDiv);
    monthList.appendChild(card);
  });
}

// -- MONTH VIEW
const monthViewTitle = document.getElementById("month-view-title");
const budgetSetupBox = document.getElementById("budget-setup-box");
const statsSection = document.getElementById("stats-section");
const addExpenseSection = document.getElementById("add-expense-section");
const expDateInput = document.getElementById("exp-date");
const displayBudget = document.getElementById("display-budget");
const displaySpent = document.getElementById("display-spent");
const displayRemaining = document.getElementById("display-remaining");
const tableBody = document.getElementById("expense-table-body");

export function openMonth(id) {
  setActiveMonthId(id);
  const m = getActiveMonth();
  if (!m) return;
  monthViewTitle.textContent = m.name;
  if (m.budget === null) {
    budgetSetupBox.classList.remove("hidden");
    statsSection.classList.add("hidden");
    addExpenseSection.classList.add("hidden");
    document.getElementById("budget-input").value = "";
  } else {
    budgetSetupBox.classList.add("hidden");
    statsSection.classList.remove("hidden");
    addExpenseSection.classList.remove("hidden");
    const today = new Date().toISOString().slice(0, 10);
    expDateInput.value = today;
    const lastDay = new Date(m.year, m.month + 1, 0).getDate();
    const mm = String(m.month + 1).padStart(2, "0");
    expDateInput.min = m.year + "-" + mm + "-01";
    expDateInput.max =
      m.year + "-" + mm + "-" + String(lastDay).padStart(2, "0");
    renderStats(m);
    renderExpenses(m);
  }
  showScreen("month");
}

export function renderStats(m) {
  const spent = m.expenses.reduce((s, e) => s + e.val, 0);
  const remaining = m.budget - spent;
  displayBudget.textContent = fmt(m.budget);
  displaySpent.textContent = fmt(spent);
  displayRemaining.textContent = fmt(remaining);
  displayRemaining.classList.toggle("over-budget", remaining < 0);

  const progressWrap = document.getElementById("budget-progress-wrap");
  const barFill = document.getElementById("budget-bar-fill");
  const pctText = document.getElementById("budget-pct-text");
  if (progressWrap && barFill && pctText && m.budget !== null) {
    if (m.budget === 0) {
      if (spent === 0) {
        // Zero budget, nothing spent — show bar at 0%, no special styling
        barFill.style.width = "0%";
        barFill.className = "budget-bar-fill";
        pctText.textContent = "0.0% of budget used";
        pctText.className = "budget-pct-text";
      } else {
        // Zero budget, any spending — over budget by definition
        barFill.style.width = "100%";
        barFill.className = "budget-bar-fill over";
        pctText.textContent = "100%+ of budget used";
        pctText.className = "budget-pct-text over";
      }
    } else {
      // Normal case: budget > 0
      const rawPct = (spent / m.budget) * 100;
      const clampPct = Math.min(rawPct, 100);
      const colorClass = rawPct >= 100 ? "over" : rawPct >= 80 ? "warn" : "";
      barFill.style.width = clampPct + "%";
      barFill.className =
        "budget-bar-fill" + (colorClass ? " " + colorClass : "");
      pctText.textContent = rawPct.toFixed(1) + "% of budget used";
      pctText.className =
        "budget-pct-text" + (colorClass ? " " + colorClass : "");
    }
    progressWrap.classList.remove("hidden");
  } else if (progressWrap) {
    progressWrap.classList.add("hidden");
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

// deleteExpense callback registered by app.js to avoid circular imports
let _deleteExpenseCb = null;
export function registerDeleteExpenseCb(fn) {
  _deleteExpenseCb = fn;
}

export function renderExpenses(m) {
  m.expenses.sort((a, b) =>
    a.date !== b.date
      ? a.date < b.date ? 1 : -1
      : a.createdAt < b.createdAt ? 1 : -1
  );
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
    btnEdit.title = "Edit expense";
    btnEdit.innerHTML =
      '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">edit</span>';
    btnEdit.addEventListener("click", () => openEditExpenseModal(exp.id, btnEdit));
    const btnDel = document.createElement("button");
    btnDel.className = "btn-danger btn-del-expense";
    btnDel.textContent = "Del";
    btnDel.addEventListener(
      "click",
      () => _deleteExpenseCb && _deleteExpenseCb(exp.id),
    );
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
    if (table && table.parentNode)
      table.parentNode.insertBefore(cardList, table);
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
    btnEdit.title = "Edit expense";
    btnEdit.innerHTML =
      '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">edit</span>';
    btnEdit.addEventListener("click", () => openEditExpenseModal(exp.id, btnEdit));
    const btnDel = document.createElement("button");
    btnDel.className = "btn-danger btn-del-expense";
    btnDel.textContent = "Del";
    btnDel.addEventListener(
      "click",
      () => _deleteExpenseCb && _deleteExpenseCb(exp.id),
    );
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

// -- UNDO TOAST
export function showUndoToast(message) {
  const toast = document.getElementById("undo-toast");
  if (!toast) return;
  document.getElementById("undo-toast-msg").textContent = message;
  toast.classList.remove("hidden");
}

export function hideUndoToast() {
  const toast = document.getElementById("undo-toast");
  if (toast) toast.classList.add("hidden");
}

// -- FOCUS TRAP HELPERS (modal-internal, not exported)
let _lastFocusedTrigger = null;

function trapFocus(overlayEl) {
  const focusable = overlayEl.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  function handleKeydown(e) {
    if (e.key !== "Tab") return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  overlayEl.addEventListener("keydown", handleKeydown);
  overlayEl._focusTrapHandler = handleKeydown;
}

function releaseFocusTrap(overlayEl) {
  if (overlayEl._focusTrapHandler) {
    overlayEl.removeEventListener("keydown", overlayEl._focusTrapHandler);
    overlayEl._focusTrapHandler = null;
  }
}

function returnFocusToTrigger() {
  if (_lastFocusedTrigger && document.body.contains(_lastFocusedTrigger)) {
    _lastFocusedTrigger.focus();
  }
  _lastFocusedTrigger = null;
}

// -- EXPENSE EDIT MODAL
let _editingExpenseId = null;

export function openEditExpenseModal(expId, triggerEl) {
  const m = getActiveMonth();
  if (!m) return;
  const exp = m.expenses.find((e) => e.id === expId);
  if (!exp) return;
  _editingExpenseId = expId;
  _lastFocusedTrigger = triggerEl || null;
  const descEl = document.getElementById("edit-exp-desc");
  const valEl = document.getElementById("edit-exp-val");
  const dateEl = document.getElementById("edit-exp-date");
  descEl.value = exp.desc;
  valEl.value = (exp.val / 100).toFixed(2);
  dateEl.value = exp.date || "";
  const lastDay = new Date(m.year, m.month + 1, 0).getDate();
  const mm = String(m.month + 1).padStart(2, "0");
  dateEl.min = m.year + "-" + mm + "-01";
  dateEl.max = m.year + "-" + mm + "-" + String(lastDay).padStart(2, "0");
  [descEl, valEl, dateEl].forEach((el) => el.classList.remove("is-invalid"));
  ["err-edit-exp-desc", "err-edit-exp-val", "err-edit-exp-date"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "";
    },
  );
  const eeOverlay = document.getElementById("edit-expense-overlay");
  eeOverlay.classList.remove("hidden");
  trapFocus(eeOverlay);
  descEl.focus();
}

export function closeEditExpenseModal() {
  _editingExpenseId = null;
  const eeOverlay = document.getElementById("edit-expense-overlay");
  releaseFocusTrap(eeOverlay);
  eeOverlay.classList.add("hidden");
  returnFocusToTrigger();
}

export function getEditingExpenseId() {
  return _editingExpenseId;
}

// -- DELETE MONTH MODAL
let _pendingDeleteMonthId = null;

export function openDeleteMonthModal(id, triggerEl) {
  const m = state.months.find((x) => x.id === id);
  if (!m) return;
  _pendingDeleteMonthId = id;
  _lastFocusedTrigger = triggerEl || null;
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
  const dmOverlay = document.getElementById("delete-month-overlay");
  dmOverlay.classList.remove("hidden");
  trapFocus(dmOverlay);
  const cancelBtn = document.getElementById("btn-delete-month-cancel");
  if (cancelBtn) cancelBtn.focus();
}

export function closeDeleteMonthModal() {
  _pendingDeleteMonthId = null;
  const dmOverlay = document.getElementById("delete-month-overlay");
  releaseFocusTrap(dmOverlay);
  dmOverlay.classList.add("hidden");
  returnFocusToTrigger();
}

export function getPendingDeleteMonthId() {
  return _pendingDeleteMonthId;
}

// -- MONTH PICKER MODAL
export function openMonthPicker(event) {
  const now = new Date();
  document.getElementById("pick-month").value = now.getMonth();
  document.getElementById("pick-year").value = now.getFullYear();
  _lastFocusedTrigger = (event && event.currentTarget) || null;
  const mpOverlay = document.getElementById("month-picker-overlay");
  mpOverlay.classList.remove("hidden");
  trapFocus(mpOverlay);
  const pickMonth = document.getElementById("pick-month");
  if (pickMonth) pickMonth.focus();
}

export function closeMonthPicker() {
  const mpOverlay = document.getElementById("month-picker-overlay");
  releaseFocusTrap(mpOverlay);
  mpOverlay.classList.add("hidden");
  returnFocusToTrigger();
}

// -- PROFILE MODAL
export const profileOverlay = document.getElementById("profile-overlay");

export async function openProfileModal(event) {
  try {
    const { data: authData } = await supabase.auth.getUser();
    const user = authData && authData.user;
    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .single();
      if (profile && profile.display_name)
        cacheDisplayName(profile.display_name);
    }
  } catch (_) {}
  document.getElementById("display-name-input").value = getDisplayName();
  document.getElementById("current-pass-input").value = "";
  document.getElementById("new-pass-input").value = "";
  document.getElementById("confirm-pass-input").value = "";
  document.getElementById("theme-select").value = getPreferredTheme();
  _lastFocusedTrigger = (event && event.currentTarget) || null;
  profileOverlay.classList.remove("hidden");
  trapFocus(profileOverlay);
  const nameInput = document.getElementById("display-name-input");
  if (nameInput) nameInput.focus();
}

export function closeProfileModal() {
  releaseFocusTrap(profileOverlay);
  profileOverlay.classList.add("hidden");
  returnFocusToTrigger();
}

// -- SYNC STATUS INDICATOR
// status: "syncing" | "stale" | null (null clears the indicator)
// Uses existing .save-status class modifiers already in style.css:
//   .saving  → muted/neutral tone
//   .error   → warning/danger tone
//   .visible → controls opacity transition
export function setSyncStatus(status) {
  document.querySelectorAll(".save-status").forEach((el) => {
    el.classList.remove("visible", "saving", "error");
    if (status === "syncing") {
      el.textContent = "Syncing\u2026";
      el.classList.add("visible", "saving");
    } else if (status === "stale") {
      el.textContent = "Showing saved data \u2014 could not refresh";
      el.classList.add("visible", "error");
    } else {
      el.textContent = "";
    }
  });
}

