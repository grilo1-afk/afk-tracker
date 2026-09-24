import { supabase } from "./supabase-client.js";
import {
  state,
  setState,
  activeMonthId,
  setActiveMonthId,
  MONTH_NAMES,
  getActiveMonth,
  readLocalCache,
  writeLocalCache,
  clearSession,
  getDisplayName,
  cacheDisplayName,
  setCurrentUserId,
  getCurrentUserId,
  setCurrency,
  getLocalISODate,
  fmt,
  isDateInMonth,
} from "./state.js";
import {
  loadState,
  dbAddMonth,
  dbUpdateBudget,
  dbDeleteMonth,
  dbAddExpense,
  dbUpdateExpense,
  dbDeleteExpense,
  dbUpdateDisplayName,
  dbUpdatePassword,
  dbAddCategory,
  dbDeleteCategory,
  dbUpdateExpenseCategory,
  dbUpdateCurrency,
  dbExportData,
  dbUpdateLifetimeOffset,
  dbAddPreset,
  dbDeletePreset,
  dbAddRecurring,
  dbDeleteRecurring,
} from "./api.js";
import {
  registerAuthCallbacks,
  handleSessionInvalid,
  doLogin,
  signInWithPassword,
  signOut,
  getSession,
} from "./auth.js";
import {
  showScreen,
  applyTheme,
  getPreferredTheme,
  watchSystemTheme,
  showFieldError,
  clearFieldError,
  showBanner,
  clearBanner,
  renderWelcomeName,
  sortMonths,
  renderHistory,
  renderLifetimeTotal,
  openMonth,
  renderStats,
  renderExpenses,
  showUndoToast,
  hideUndoToast,
  openEditExpenseModal,
  closeEditExpenseModal,
  getEditingExpenseId,
  openDeleteMonthModal,
  closeDeleteMonthModal,
  getPendingDeleteMonthId,
  openMonthPicker,
  closeMonthPicker,
  registerDeleteExpenseCb,
  registerOpenEditExpenseCb,
  registerPostOpenMonthCb,
  parseMoneyInput,
  setSyncStatus,
  openAchievementScreen,
  openStatsScreen,
  renderStatsScreen,
  renderCharts,
  getAchievementCounts,
  registerOpenAchievementScreenCb,
  setChartPeriod,
  openManageScreen,
  openSettingsScreen,
  renderAppHeader,
} from "./ui.js";

// -- REALTIME SYNC

function setupRealtimeSync() {
  const userId = getCurrentUserId();
  if (!userId) return;

  // Safe to call even if no channel exists; prevents duplicate subscriptions
  supabase.removeAllChannels();

  supabase
    .channel("realtime-sync")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "months", filter: `user_id=eq.${userId}` },
      _handleRealtimeChange
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "expenses" }, // no filter — RLS handles access
      _handleRealtimeChange
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "categories", filter: `user_id=eq.${userId}` },
      _handleRealtimeChange
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "presets", filter: `user_id=eq.${userId}` },
      _handleRealtimeChange
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "recurring_expenses", filter: `user_id=eq.${userId}` },
      _handleRealtimeChange
    )
    .subscribe();
}

let _realtimeFetchInFlight = false;
let _realtimePendingFetch = false;

async function _handleRealtimeChange() {
  // Debounce: if a fetch is in-flight, queue one more but not multiple
  if (_realtimeFetchInFlight) {
    _realtimePendingFetch = true;
    return;
  }
  _realtimeFetchInFlight = true;
  try {
    const fresh = await loadState();
    setState(fresh);
    setCurrency(state.currency);
    writeLocalCache(state);
    sortMonths();

    // Only re-render the screen that is currently visible to avoid disrupting
    // any in-progress form entry on other screens.
    const historyEl = document.getElementById("history-screen");
    const monthEl   = document.getElementById("month-screen");
    const statsEl   = document.getElementById("stats-screen");
    const historyVisible = historyEl && !historyEl.classList.contains("hidden");
    const monthVisible   = monthEl   && !monthEl.classList.contains("hidden");
    const statsVisible   = statsEl   && !statsEl.classList.contains("hidden");

    if (historyVisible) {
      renderHistory();
      updateAchievementsBadge();
    }
    if (statsVisible) {
      renderStatsScreen();
    }
    if (monthVisible) {
      const m = getActiveMonth();
      if (m) {
        renderStats(m);
        renderExpenses(m);
      }
    }
  } catch (e) {
    console.error("Realtime sync failed:", e);
    // Non-fatal — the user can still use the app with the cached state
  } finally {
    _realtimeFetchInFlight = false;
    if (_realtimePendingFetch) {
      _realtimePendingFetch = false;
      _handleRealtimeChange(); // process the queued change
    }
  }
}

// -- SERVICE WORKER
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js");
  });
}

// -- WIRE AUTH CALLBACKS (breaks circular dep)
registerAuthCallbacks({
  showScreen,
  showBanner,
  renderHistory,
  renderWelcomeName,
  sortMonths,
});

// Wire the achievements teaser click on the stats screen back to openAchievementScreen
registerOpenAchievementScreenCb(() => {
  pushHash('#achievements');
  _navigateToHash('#achievements', false);
});

// -- ACHIEVEMENT BADGE (badge element removed with old header; function kept for compatibility)
function updateAchievementsBadge() {
  // badge moved; no-op unless element exists
  const { earned, total } = getAchievementCounts();
  const badge = document.getElementById("achievements-badge");
  if (badge) badge.textContent = earned + "/" + total;
}

// -- UNDO STATE
let _lastDeleted = null;
let _undoTimer = null;

// -- CATEGORY STATE
let _selectedCategoryId = null;
let _editSelectedCategoryId = null;

async function deleteExpense(expId) {
  const m = getActiveMonth();
  if (!m) return;
  if (_undoTimer) {
    clearTimeout(_undoTimer);
    _undoTimer = null;
    _lastDeleted = null;
    hideUndoToast();
  }
  const idx = m.expenses.findIndex((e) => e.id === expId);
  if (idx === -1) return;
  const saved = { expense: m.expenses[idx], index: idx, monthId: m.id };
  _lastDeleted = saved;
  m.expenses.splice(idx, 1);
  renderStats(m);
  renderExpenses(m);
  showUndoToast("Expense deleted");

  // Fire the delete immediately — undo window is purely about re-creation
  const result = await dbDeleteExpense(saved.expense.id);
  if (!result.ok) {
    // Rollback: splice the expense back in at its original position
    const failMonth = state.months.find((x) => x.id === saved.monthId);
    if (failMonth) {
      failMonth.expenses.splice(saved.index, 0, saved.expense);
      if (failMonth.id === activeMonthId) {
        renderStats(failMonth);
        renderExpenses(failMonth);
      }
    }
    // Cancel the undo window — there's nothing to undo
    clearTimeout(_undoTimer);
    _undoTimer = null;
    _lastDeleted = null;
    hideUndoToast();
    showBanner("login-error", result.message);
    return;
  }

  _undoTimer = setTimeout(() => {
    _undoTimer = null;
    _lastDeleted = null;
    hideUndoToast();
  }, 4000);
}

async function undoDeleteExpense() {
  if (!_lastDeleted) return;
  clearTimeout(_undoTimer);
  _undoTimer = null;
  const { expense, index, monthId } = _lastDeleted;
  _lastDeleted = null;
  hideUndoToast();

  // Expense is already gone from DB — undo means re-creating it
  const result = await dbAddExpense(monthId, expense.desc, expense.val / 100, expense.date, expense.categoryId || null);
  if (!result.ok) {
    showBanner("login-error", "Could not restore expense. Try again.");
    return;
  }

  // Re-resolve after the await — state.months may have been replaced by a
  // realtime refresh while dbAddExpense was in flight.
  const m = state.months.find((x) => x.id === monthId);
  if (!m) return; // month no longer exists locally; nothing to reconcile

  // Build restored expense from the new row
  const restored = {
    id: result.data.id,
    desc: expense.desc,
    val: expense.val,
    date: expense.date,
    createdAt: result.data.created_at,
    categoryId: expense.categoryId || null,
  };
  const clampedIndex = Math.min(index, m.expenses.length);
  m.expenses.splice(clampedIndex, 0, restored);
  if (m.id === activeMonthId) {
    renderStats(m);
    renderExpenses(m);
  }
}

// Register delete callback so ui.js can call it without importing app.js
registerDeleteExpenseCb(deleteExpense);

// Update Today button disabled state whenever a month is opened
registerPostOpenMonthCb(updateTodayButtonsState);

// When the edit modal opens, sync _editSelectedCategoryId, render the edit picker,
// and update Today button disabled state (the edit modal can open from any month).
registerOpenEditExpenseCb((expId) => {
  updateTodayButtonsState();
  const m = getActiveMonth();
  const exp = m && m.expenses.find((e) => e.id === expId);
  _editSelectedCategoryId = (exp && exp.categoryId) || null;

  const editPicker = document.getElementById("edit-exp-category-picker");
  if (!editPicker) return;
  editPicker.innerHTML = "";
  state.categories.forEach((cat) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSelected = cat.id === _editSelectedCategoryId;
    btn.className = "category-pill" + (isSelected ? " selected" : "");
    btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
    btn.textContent = cat.name;
    btn.addEventListener("click", () => {
      _editSelectedCategoryId = (cat.id === _editSelectedCategoryId) ? null : cat.id;
      // Re-render to update selected state and aria-pressed
      editPicker.querySelectorAll(".category-pill").forEach((p) => {
        p.classList.remove("selected");
        p.setAttribute("aria-pressed", "false");
      });
      const nowSelected = cat.id === _editSelectedCategoryId;
      btn.classList.toggle("selected", nowSelected);
      btn.setAttribute("aria-pressed", nowSelected ? "true" : "false");
    });
    editPicker.appendChild(btn);
  });
});

// -- DOM REFS
const loginScreen = document.getElementById("login-screen");
const budgetSetupBox = document.getElementById("budget-setup-box");
const statsSection = document.getElementById("stats-section");
const addExpenseSection = document.getElementById("add-expense-section");
const budgetInput = document.getElementById("budget-input");
const btnSetBudget = document.getElementById("btn-set-budget");
const descInput = document.getElementById("desc");
const valInput = document.getElementById("val");
const expDateInput = document.getElementById("exp-date");
const btnAddExpense = document.getElementById("btn-add-expense");

// -- UNDO TOAST
document.getElementById("btn-undo-delete").addEventListener("click", undoDeleteExpense);

// -- THEME (applies immediately; persist happens on Settings Save)
document.getElementById("theme-select").addEventListener("change", (e) => {
  applyTheme(e.target.value);
  _updateSettingsSaveBtn();
});

// -- CURRENCY (applies immediately; persist happens on Settings Save)
document.getElementById("currency-select").addEventListener("change", (e) => {
  const code = e.target.value;
  setCurrency(code);
  const m = getActiveMonth();
  if (m && m.budget !== null) { renderStats(m); renderExpenses(m); }
  _updateSettingsSaveBtn();
});

// -- PASSWORD TOGGLE
document.getElementById("btn-toggle-password").addEventListener("click", () => {
  const pwd = document.getElementById("password");
  const icon = document.getElementById("eye-icon");
  const hidden = pwd.type === "password";
  pwd.type = hidden ? "text" : "password";
  icon.textContent = hidden ? "visibility_off" : "visibility";
});

// -- MONTH PICKER SELECT POPULATION
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
  const cur = new Date().getFullYear();
  const existingYears = state.months.map((m) => m.year);
  const minYear = Math.min(cur - 10, ...(existingYears.length ? existingYears : [cur]));
  const maxYear = Math.max(cur + 1, ...(existingYears.length ? existingYears : [cur]));
  for (let y = maxYear; y >= minYear; y--) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    pickYearSel.appendChild(opt);
  }
})();

document
  .getElementById("btn-pick-cancel")
  .addEventListener("click", closeMonthPicker);
pickerOverlay.addEventListener("click", (e) => {
  if (e.target === pickerOverlay) closeMonthPicker();
});

document
  .getElementById("btn-pick-confirm")
  .addEventListener("click", async () => {
    const m = parseInt(pickMonthSel.value, 10);
    const y = parseInt(pickYearSel.value, 10);
    const name = MONTH_NAMES[m] + " " + y;
    if (state.months.find((x) => x.year === y && x.month === m)) {
      const el = document.getElementById("pick-error");
      if (el) el.textContent = name + " already exists.";
      return;
    }
    const result = await dbAddMonth(y, m + 1, name, () =>
      handleSessionInvalid("SESSION_INVALID"),
    );
    if (!result) return; // null = no session (onAuthError already called)
    if (!result.ok) {
      const el = document.getElementById("pick-error");
      if (el) el.textContent = result.message;
      return;
    }
    state.months.push({
      id: result.data,
      name,
      year: y,
      month: m,
      budget: null,
      expenses: [],
    });
    sortMonths();
    closeMonthPicker();
    renderHistory();
    updateAchievementsBadge();
    openMonth(result.data);
    renderPresetStrip();
    renderCategoryPicker();
    if (state.recurring.length > 0) {
      _openRecurringModal(result.data, { year: y, month: m }, state.recurring);
    }
  });

// -- CHART PERIOD TOGGLE
document.getElementById("chart-period-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".chart-period-btn");
  if (!btn) return;
  document.querySelectorAll(".chart-period-btn").forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  const period = btn.dataset.period === "all" ? "all" : parseInt(btn.dataset.period, 10);
  setChartPeriod(period);
  renderCharts();
});

// -- ESCAPE KEY
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const achScreen = document.getElementById("achievement-screen");
  if (achScreen && !achScreen.classList.contains("hidden")) {
    pushHash('#stats');
    openStatsScreen();
    setNavActive('stats');
    return;
  }
  const pickerEl = document.getElementById("month-picker-overlay");
  if (pickerEl && !pickerEl.classList.contains("hidden")) {
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
  const rcOverlay = document.getElementById("recurring-modal-overlay");
  if (rcOverlay && !rcOverlay.classList.contains("hidden")) {
    rcOverlay.classList.add("hidden");
    return;
  }
  // settings is a full screen now — Escape on settings goes home
  if (!document.getElementById("settings-screen").classList.contains("hidden")) {
    showScreen("history");
    setNavActive("home");
    return;
  }
});

["username", "password"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", () => {
    clearFieldError(document.getElementById(id), "err-" + id);
    clearBanner("login-error");
  });
});

// -- TODAY BUTTONS
function updateTodayButtonsState() {
  const m = getActiveMonth();
  const now = new Date();
  const isCurrentMonth = !!m && m.year === now.getFullYear() && m.month === now.getMonth();
  const btnToday = document.getElementById("btn-today-expense");
  const btnTodayEdit = document.getElementById("btn-today-edit-exp");
  if (btnToday) btnToday.disabled = !isCurrentMonth;
  if (btnTodayEdit) btnTodayEdit.disabled = !isCurrentMonth;
}

document.getElementById("btn-today-expense").addEventListener("click", () => {
  expDateInput.value = getLocalISODate();
  expDateInput.classList.remove("is-invalid");
  clearFieldError(expDateInput, "err-exp-date");
});
document.getElementById("btn-today-edit-exp").addEventListener("click", () => {
  const dateEl = document.getElementById("edit-exp-date");
  if (dateEl) {
    dateEl.value = getLocalISODate();
    dateEl.classList.remove("is-invalid");
    clearFieldError(dateEl, "err-edit-exp-date");
  }
});

// -- REFRESH
document.getElementById("btn-refresh").addEventListener("click", async () => {
  const btn = document.getElementById("btn-refresh");
  btn.disabled = true;
  setSyncStatus("syncing");
  try {
    const fresh = await loadState();
    setState(fresh);
    writeLocalCache(state);
    sortMonths();
    renderHistory();
    updateAchievementsBadge();
    setSyncStatus(null);
  } catch (e) {
    console.error("Manual refresh failed:", e);
    setSyncStatus("stale");
  } finally {
    btn.disabled = false;
  }
});

// -- CATEGORIES

function renderCategoryPicker() {
  const picker = document.getElementById("category-picker");
  if (!picker) return;
  picker.innerHTML = "";

  if (_selectedCategoryId && !state.categories.find((c) => c.id === _selectedCategoryId)) {
    _selectedCategoryId = null;
  }

  state.categories.forEach((cat) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSelected = cat.id === _selectedCategoryId;
    btn.className = "category-pill" + (isSelected ? " selected" : "");
    btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
    btn.textContent = cat.name;
    btn.addEventListener("click", () => {
      _selectedCategoryId = (cat.id === _selectedCategoryId) ? null : cat.id;
      renderCategoryPicker();
    });
    picker.appendChild(btn);
  });

  const newPill = document.createElement("button");
  newPill.type = "button";
  newPill.className = "category-pill new-pill";
  newPill.textContent = "+ New";
  newPill.addEventListener("click", () => {
    document.getElementById("category-inline-add")?.classList.remove("hidden");
    document.getElementById("category-picker")?.classList.add("hidden");
    document.getElementById("category-new-input")?.focus();
  });
  picker.appendChild(newPill);
}

function renderCategorySettingsList() {
  const list = document.getElementById("category-list");
  if (!list) return;
  list.innerHTML = "";

  if (state.categories.length === 0) {
    const empty = document.createElement("div");
    empty.className = "preset-empty";
    empty.textContent = "No categories yet.";
    list.appendChild(empty);
    return;
  }

  const usedIds = new Set(
    state.months.flatMap((m) => m.expenses.map((e) => e.categoryId).filter(Boolean))
  );

  state.categories.forEach((cat) => {
    const row = document.createElement("div");
    row.className = "preset-row";
    const label = document.createElement("span");
    label.className = "preset-row-label";
    label.textContent = cat.name;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-danger btn-sm";
    del.textContent = "Remove";
    if (usedIds.has(cat.id)) {
      del.disabled = true;
      del.title = "Category is in use — remove it from all expenses first.";
      del.style.opacity = "0.4";
      del.style.cursor = "not-allowed";
    } else {
      del.addEventListener("click", async () => {
        const result = await dbDeleteCategory(cat.id);
        if (!result.ok) {
          const errEl = document.getElementById("err-category-settings");
          if (errEl) errEl.textContent = result.message;
          return;
        }
        state.categories = state.categories.filter((c) => c.id !== cat.id);
        if (_selectedCategoryId === cat.id) _selectedCategoryId = null;
        renderCategorySettingsList();
        renderCategoryPicker();
      });
    }
    row.appendChild(label);
    row.appendChild(del);
    list.appendChild(row);
  });
}

document.getElementById("btn-category-new-confirm").addEventListener("click", async () => {
  const input = document.getElementById("category-new-input");
  const errEl = document.getElementById("err-category-inline");
  const name = input.value.trim();
  if (!name) {
    if (errEl) errEl.textContent = "Enter a category name.";
    return;
  }
  if (state.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    if (errEl) errEl.textContent = "A category with that name already exists.";
    return;
  }
  if (errEl) errEl.textContent = "";
  const result = await dbAddCategory(name);
  if (!result.ok) {
    if (errEl) errEl.textContent = result.message;
    return;
  }
  state.categories.push(result.data);
  _selectedCategoryId = result.data.id;
  input.value = "";
  document.getElementById("category-inline-add")?.classList.add("hidden");
  document.getElementById("category-picker")?.classList.remove("hidden");
  renderCategoryPicker();
  renderCategorySettingsList();
});

document.getElementById("btn-category-new-cancel").addEventListener("click", () => {
  document.getElementById("category-new-input").value = "";
  const errEl = document.getElementById("err-category-inline");
  if (errEl) errEl.textContent = "";
  document.getElementById("category-inline-add")?.classList.add("hidden");
  document.getElementById("category-picker")?.classList.remove("hidden");
});

document.getElementById("btn-add-category-settings").addEventListener("click", async () => {
  const input = document.getElementById("category-settings-input");
  const errEl = document.getElementById("err-category-settings");
  const name = input.value.trim();
  if (!name) {
    if (errEl) errEl.textContent = "Enter a category name.";
    return;
  }
  if (state.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    if (errEl) errEl.textContent = "A category with that name already exists.";
    return;
  }
  if (errEl) errEl.textContent = "";
  const result = await dbAddCategory(name);
  if (!result.ok) {
    if (errEl) errEl.textContent = result.message;
    return;
  }
  state.categories.push(result.data);
  input.value = "";
  renderCategorySettingsList();
  renderCategoryPicker();
});

// -- RECURRING

function renderRecurringList() {
  const list = document.getElementById("recurring-list");
  if (!list) return;
  const items = state.recurring;
  list.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "preset-empty";
    empty.textContent = "No recurring expenses yet.";
    list.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "preset-row";
    const label = document.createElement("span");
    label.className = "preset-row-label";
    label.textContent = item.desc;
    const amount = document.createElement("span");
    amount.className = "preset-row-amount";
    amount.textContent = fmt(Math.round(parseFloat(item.amount) * 100));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-danger btn-sm";
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      const itemId = item.id;
      const idx = state.recurring.findIndex((x) => x.id === itemId);
      if (idx === -1) return;
      const saved = state.recurring[idx];
      state.recurring.splice(idx, 1);
      renderRecurringList();
      const result = await dbDeleteRecurring(itemId);
      if (!result.ok) {
        // Rollback — re-resolve by id since realtime may have refreshed state
        const liveIdx = state.recurring.findIndex((x) => x.id === itemId);
        if (liveIdx === -1) state.recurring.splice(idx, 0, saved);
        renderRecurringList();
        showBanner("login-error", result.message);
      }
    });
    row.appendChild(label);
    row.appendChild(amount);
    row.appendChild(del);
    list.appendChild(row);
  });
}

document.getElementById("btn-add-recurring").addEventListener("click", async () => {
  const descEl   = document.getElementById("recurring-desc-input");
  const amountEl = document.getElementById("recurring-amount-input");
  const errEl    = document.getElementById("err-recurring");
  const desc   = descEl.value.trim();
  const amount = parseMoneyInput(amountEl.value);
  if (!desc || !amount || amount <= 0) {
    if (errEl) errEl.textContent = "Enter a description and a valid amount.";
    return;
  }
  if (errEl) errEl.textContent = "";
  const tmpId = `tmp-${crypto.randomUUID()}`;
  state.recurring.push({ id: tmpId, desc, amount });
  descEl.value = "";
  amountEl.value = "";
  renderRecurringList();
  const result = await dbAddRecurring(desc, amount);
  if (!result.ok) {
    // Re-resolve by id — state may have been refreshed by realtime
    const liveIdx = state.recurring.findIndex((x) => x.id === tmpId);
    if (liveIdx !== -1) state.recurring.splice(liveIdx, 1);
    renderRecurringList();
    if (errEl) errEl.textContent = result.message;
    return;
  }
  // Replace tmp id with real db id
  const liveItem = state.recurring.find((x) => x.id === tmpId);
  if (liveItem) {
    liveItem.id = result.data.id;
    liveItem.desc = result.data.desc;
    liveItem.amount = result.data.amount;
  }
  renderRecurringList();
});

function _openRecurringModal(monthId, monthObj, items) {
  const overlay   = document.getElementById("recurring-modal-overlay");
  const nameEl    = document.getElementById("recurring-modal-month-name");
  const checklist = document.getElementById("recurring-checklist");
  const errEl     = document.getElementById("err-recurring-modal");
  if (!overlay || !checklist) return;

  const mm = String(monthObj.month + 1).padStart(2, "0");
  const expenseDate = `${monthObj.year}-${mm}-01`;

  nameEl.textContent = MONTH_NAMES[monthObj.month] + " " + monthObj.year;
  if (errEl) errEl.textContent = "";
  checklist.innerHTML = "";

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "recurring-check-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.id = `rc-${item.id}`;
    const labelEl = document.createElement("label");
    labelEl.htmlFor = `rc-${item.id}`;
    labelEl.className = "recurring-check-label";
    labelEl.textContent = item.desc;
    const amountEl = document.createElement("span");
    amountEl.className = "recurring-check-amount";
    amountEl.textContent = fmt(Math.round(parseFloat(item.amount) * 100));
    row.appendChild(checkbox);
    row.appendChild(labelEl);
    row.appendChild(amountEl);
    checklist.appendChild(row);
  });

  overlay._monthId     = monthId;
  overlay._expenseDate = expenseDate;
  overlay._items       = items;

  overlay.classList.remove("hidden");
}

document.getElementById("btn-recurring-close-x").addEventListener("click", () => {
  document.getElementById("recurring-modal-overlay").classList.add("hidden");
});
document.getElementById("btn-recurring-skip").addEventListener("click", () => {
  document.getElementById("recurring-modal-overlay").classList.add("hidden");
});
document.getElementById("recurring-modal-overlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("recurring-modal-overlay"))
    document.getElementById("recurring-modal-overlay").classList.add("hidden");
});

document.getElementById("btn-recurring-add-selected").addEventListener("click", async () => {
  const overlay   = document.getElementById("recurring-modal-overlay");
  const checklist = document.getElementById("recurring-checklist");
  const errEl     = document.getElementById("err-recurring-modal");
  const btn       = document.getElementById("btn-recurring-add-selected");
  if (!overlay || !checklist) return;

  const monthId     = overlay._monthId;
  const expenseDate = overlay._expenseDate;
  const items       = overlay._items;

  const checked = [];
  const rows = checklist.querySelectorAll(".recurring-check-row");
  rows.forEach((row, i) => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb && cb.checked && items[i]) checked.push(items[i]);
  });

  if (checked.length === 0) {
    overlay.classList.add("hidden");
    return;
  }

  btn.classList.add("btn--loading");
  btn.disabled = true;
  if (errEl) errEl.textContent = "";

  try {
    for (const item of checked) {
      const result = await dbAddExpense(
        monthId,
        item.desc,
        item.amount,
        expenseDate,
        item.categoryId || null
      );
      if (!result.ok) {
        if (errEl) errEl.textContent = `Failed to add "${item.desc}": ${result.message}`;
        const m = getActiveMonth();
        if (m) { renderStats(m); renderExpenses(m); }
        return;
      }
      const m = getActiveMonth();
      if (m) {
        m.expenses.push({
          id: result.data.id,
          desc: item.desc,
          val: Math.round(item.amount * 100),
          date: expenseDate,
          createdAt: result.data.created_at,
          categoryId: item.categoryId || null,
        });
      }
    }
    const m = getActiveMonth();
    if (m) { renderStats(m); renderExpenses(m); }
    overlay.classList.add("hidden");
  } finally {
    btn.classList.remove("btn--loading");
    btn.disabled = false;
  }
});

// -- PRESETS

function renderPresetStrip() {
  const strip = document.getElementById("preset-strip");
  if (!strip) return;
  strip.innerHTML = "";
  if (state.presets.length === 0) {
    strip.classList.add("hidden");
    return;
  }
  strip.classList.remove("hidden");
  state.presets.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-pill";
    btn.textContent = `${p.desc}  ${fmt(Math.round(parseFloat(p.amount) * 100))}`;
    btn.addEventListener("click", () => {
      descInput.value = p.desc;
      valInput.value = parseFloat(p.amount).toFixed(2);
      expDateInput.value = getLocalISODate();
      clearFieldError(descInput, "err-exp-desc");
      clearFieldError(valInput, "err-exp-val");
      clearFieldError(expDateInput, "err-exp-date");
      descInput.focus();
    });
    strip.appendChild(btn);
  });
}

function renderPresetList() {
  const list = document.getElementById("preset-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.presets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "preset-empty";
    empty.textContent = "No presets yet.";
    list.appendChild(empty);
    return;
  }
  state.presets.forEach((p) => {
    const row = document.createElement("div");
    row.className = "preset-row";
    const label = document.createElement("span");
    label.className = "preset-row-label";
    label.textContent = p.desc;
    const amount = document.createElement("span");
    amount.className = "preset-row-amount";
    amount.textContent = fmt(Math.round(parseFloat(p.amount) * 100));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-danger btn-sm";
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      const presetId = p.id;
      const idx = state.presets.findIndex((x) => x.id === presetId);
      if (idx === -1) return;
      const saved = state.presets[idx];
      state.presets.splice(idx, 1);
      renderPresetList();
      renderPresetStrip();
      const result = await dbDeletePreset(presetId);
      if (!result.ok) {
        const liveIdx = state.presets.findIndex((x) => x.id === presetId);
        if (liveIdx === -1) state.presets.splice(idx, 0, saved);
        renderPresetList();
        renderPresetStrip();
        showBanner("login-error", result.message);
      }
    });
    row.appendChild(label);
    row.appendChild(amount);
    row.appendChild(del);
    list.appendChild(row);
  });
}

document.getElementById("btn-add-preset").addEventListener("click", async () => {
  const descEl = document.getElementById("preset-desc-input");
  const amountEl = document.getElementById("preset-amount-input");
  const errEl = document.getElementById("err-preset");
  const desc = descEl.value.trim();
  const amount = parseMoneyInput(amountEl.value);
  if (!desc || !amount || amount <= 0) {
    if (errEl) errEl.textContent = "Enter a description and a valid amount.";
    return;
  }
  if (errEl) errEl.textContent = "";
  const tmpId = `tmp-${crypto.randomUUID()}`;
  state.presets.push({ id: tmpId, desc, amount });
  descEl.value = "";
  amountEl.value = "";
  renderPresetList();
  renderPresetStrip();
  const result = await dbAddPreset(desc, amount);
  if (!result.ok) {
    const liveIdx = state.presets.findIndex((x) => x.id === tmpId);
    if (liveIdx !== -1) state.presets.splice(liveIdx, 1);
    renderPresetList();
    renderPresetStrip();
    if (errEl) errEl.textContent = result.message;
    return;
  }
  const liveItem = state.presets.find((x) => x.id === tmpId);
  if (liveItem) {
    liveItem.id = result.data.id;
    liveItem.desc = result.data.desc;
    liveItem.amount = result.data.amount;
  }
  renderPresetList();
  renderPresetStrip();
});

// -- NAVIGATION
document.getElementById("btn-back").addEventListener("click", () => {
  pushHash('#home');
  setActiveMonthId(null);
  renderHistory();
  updateAchievementsBadge();
  showScreen("history");
  setNavActive("home");
});
document
  .getElementById("btn-create-month")
  .addEventListener("click", openMonthPicker);

// -- BUDGET
btnSetBudget.addEventListener("click", async () => {
  const m = getActiveMonth();
  if (!m) return;
  const val = parseMoneyInput(budgetInput.value);
  if (Number.isNaN(val) || val < 0) {
    showFieldError(budgetInput, "err-budget", "Enter a valid amount.");
    return;
  }
  clearFieldError(budgetInput, "err-budget");

  // Optimistic: apply immediately, then persist
  const prevBudget = m.budget;
  m.budget = Math.round(val * 100);
  budgetSetupBox.classList.add("hidden");
  statsSection.classList.remove("hidden");
  addExpenseSection.classList.remove("hidden");
  renderPresetStrip();
  renderCategoryPicker();
  const lastDay = new Date(m.year, m.month + 1, 0).getDate();
  const mm = String(m.month + 1).padStart(2, "0");
  const minDate = m.year + "-" + mm + "-01";
  const maxDate = m.year + "-" + mm + "-" + String(lastDay).padStart(2, "0");
  expDateInput.min = minDate;
  expDateInput.max = maxDate;
  const todayIso = getLocalISODate();
  expDateInput.value = (todayIso >= minDate && todayIso <= maxDate) ? todayIso : minDate;
  renderStats(m);
  renderExpenses(m);

  const monthId = m.id;
  const result = await dbUpdateBudget(monthId, val);
  if (!result.ok) {
    // Re-resolve after the await — state.months may have been replaced by a
    // realtime refresh while dbUpdateBudget was in flight.
    const liveM = state.months.find((x) => x.id === monthId);
    if (liveM) liveM.budget = prevBudget;
    budgetSetupBox.classList.remove("hidden");
    statsSection.classList.add("hidden");
    addExpenseSection.classList.add("hidden");
    if (liveM) {
      renderStats(liveM);
      renderExpenses(liveM);
    }
    showBanner("login-error", result.message);
  }
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
    setActiveMonthId(null);
    renderHistory();
    showScreen("history");
  }
});

document.getElementById("btn-edit-budget").addEventListener("click", () => {
  const m = getActiveMonth();
  if (!m) return;
  budgetInput.value = m.budget !== null ? (m.budget / 100).toFixed(2) : "";
  budgetSetupBox.classList.remove("hidden");
  statsSection.classList.add("hidden");
  addExpenseSection.classList.add("hidden");
  document.getElementById("budget-progress-wrap")?.classList.add("hidden");
  budgetInput.focus();
});

// -- ADD EXPENSE
btnAddExpense.addEventListener("click", addExpense);
valInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addExpense();
});

async function addExpense() {
  const m = getActiveMonth();
  if (!m) return;
  const desc = descInput.value.trim();
  const val = parseMoneyInput(valInput.value);
  const dateVal = expDateInput.value;
  let valid = true;
  if (!desc) {
    showFieldError(descInput, "err-exp-desc", "Description is required.");
    valid = false;
  } else clearFieldError(descInput, "err-exp-desc");
  if (!val || val <= 0) {
    showFieldError(valInput, "err-exp-val", "Enter a valid amount.");
    valid = false;
  } else clearFieldError(valInput, "err-exp-val");
  if (!dateVal) {
    showFieldError(expDateInput, "err-exp-date", "Date is required.");
    valid = false;
  } else {
    expDateInput.classList.remove("is-invalid");
    if (
      (expDateInput.min && dateVal < expDateInput.min) ||
      (expDateInput.max && dateVal > expDateInput.max)
    ) {
      showFieldError(
        expDateInput,
        "err-exp-date",
        "Date is outside this month.",
      );
      valid = false;
    } else {
      clearFieldError(expDateInput, "err-exp-date");
    }
  }
  if (!valid) return;

  // Optimistic: push with tmp id, render and clear form immediately
  const tmpId = `tmp-${crypto.randomUUID()}`;
  const optimisticExpense = { id: tmpId, desc, val: Math.round(val * 100), date: dateVal, createdAt: null, categoryId: _selectedCategoryId };
  m.expenses.push(optimisticExpense);
  renderStats(m);
  renderExpenses(m);
  descInput.value = "";
  valInput.value = "";
  descInput.focus();

  const monthId = m.id;
  const result = await dbAddExpense(monthId, desc, val, dateVal, _selectedCategoryId);
  // Re-resolve after the await — state.months may have been replaced by a
  // realtime refresh while dbAddExpense was in flight.
  const liveM = state.months.find((x) => x.id === monthId);

  if (!result.ok) {
    // Rollback: remove the optimistic expense
    if (liveM) {
      const tmpIdx = liveM.expenses.findIndex((e) => e.id === tmpId);
      if (tmpIdx !== -1) liveM.expenses.splice(tmpIdx, 1);
      renderStats(liveM);
      renderExpenses(liveM);
    }
    showBanner("login-error", result.message);
    return;
  }
  // Success: replace tmp id with real row data
  if (liveM) {
    const saved = liveM.expenses.find((e) => e.id === tmpId);
    if (saved) {
      saved.id = result.data.id;
      saved.createdAt = result.data.created_at;
    }
  }
  _selectedCategoryId = null;
  renderCategoryPicker();
}

// -- EXPENSE EDIT MODAL
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
    const expId = getEditingExpenseId();
    if (!expId) return;
    const m = getActiveMonth();
    if (!m) return;
    const exp = m.expenses.find((e) => e.id === expId);
    if (!exp) return;
    const descEl = document.getElementById("edit-exp-desc");
    const valEl = document.getElementById("edit-exp-val");
    const dateEl = document.getElementById("edit-exp-date");
    const newDesc = descEl.value.trim();
    const newVal = parseMoneyInput(valEl.value);
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
    } else if (!isDateInMonth(newDate, m)) {
      showFieldError(dateEl, "err-edit-exp-date", "Date is outside this month.");
      valid = false;
    } else {
      clearFieldError(dateEl, "err-edit-exp-date");
    }
    if (!valid) return;

    // Optimistic: apply new values, close modal, then persist
    const prevDesc = exp.desc;
    const prevVal = exp.val;
    const prevDate = exp.date;
    const prevCatId = exp.categoryId;
    exp.desc = newDesc;
    exp.val = Math.round(newVal * 100);
    exp.date = newDate;
    exp.categoryId = _editSelectedCategoryId;
    renderStats(m);
    renderExpenses(m);
    closeEditExpenseModal();

    const monthId = m.id;
    const [descResult, catResult] = await Promise.all([
      dbUpdateExpense(exp.id, newDesc, newVal, newDate),
      dbUpdateExpenseCategory(exp.id, _editSelectedCategoryId),
    ]);
    const result = descResult.ok ? catResult : descResult;
    if (!result.ok) {
      // Rollback — re-resolve both month and expense after the await
      const liveM = state.months.find((x) => x.id === monthId);
      const liveExp = liveM && liveM.expenses.find((e) => e.id === expId);
      if (liveExp) {
        liveExp.desc = prevDesc;
        liveExp.val = prevVal;
        liveExp.date = prevDate;
        liveExp.categoryId = prevCatId;
      }
      if (liveM) {
        renderStats(liveM);
        renderExpenses(liveM);
      }
      showBanner("login-error", result.message);
    }
  });

// -- DELETE MONTH
document
  .getElementById("btn-delete-month-cancel")
  .addEventListener("click", closeDeleteMonthModal);
document
  .getElementById("btn-delete-month-confirm")
  .addEventListener("click", async () => {
    const id = getPendingDeleteMonthId();
    if (!id) return;

    // Optimistic: remove immediately, then persist
    const idx = state.months.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const savedMonth = state.months[idx];
    setState({
      months: state.months.filter((x) => x.id !== id),
      displayName: state.displayName,
    });
    closeDeleteMonthModal();
    renderHistory();
    updateAchievementsBadge();

    const result = await dbDeleteMonth(id);
    if (!result.ok) {
      // Rollback: re-insert at original index
      const restored = [...state.months];
      restored.splice(idx, 0, savedMonth);
      setState({ months: restored, displayName: state.displayName });
      renderHistory();
      updateAchievementsBadge();
      showBanner("login-error", result.message);
    }
  });
document
  .getElementById("delete-month-overlay")
  .addEventListener("click", (e) => {
    if (e.target === document.getElementById("delete-month-overlay"))
      closeDeleteMonthModal();
  });

// -- PROFILE (password eye toggles)
document.querySelectorAll(".btn-eye-profile").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    const icon = btn.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = hidden ? "visibility_off" : "visibility";
  });
});

// Snapshot of settings values when modal opens — used for dirty detection
let _settingsSnapshot = null;

function _snapshotSettings() {
  return {
    name: (document.getElementById("display-name-input")?.value || "").trim(),
    theme: document.getElementById("theme-select")?.value || "",
    currency: document.getElementById("currency-select")?.value || "",
    offset: (document.getElementById("lifetime-offset-input")?.value || "").trim(),
    cp: "", np: "", cf: "",
  };
}

function _updateSettingsSaveBtn() {
  const btn = document.getElementById("btn-profile-save");
  if (!btn || !_settingsSnapshot) return;
  const cp = document.getElementById("current-pass-input")?.value || "";
  const np = document.getElementById("new-pass-input")?.value || "";
  const cf = document.getElementById("confirm-pass-input")?.value || "";
  const name = (document.getElementById("display-name-input")?.value || "").trim();
  const theme = document.getElementById("theme-select")?.value || "";
  const currency = document.getElementById("currency-select")?.value || "";
  const offset = (document.getElementById("lifetime-offset-input")?.value || "").trim();
  const dirty = name !== _settingsSnapshot.name
    || theme !== _settingsSnapshot.theme
    || currency !== _settingsSnapshot.currency
    || offset !== _settingsSnapshot.offset
    || cp !== "" || np !== "" || cf !== "";
  btn.disabled = !dirty;
}

function _openSettings() {
  // Pre-populate all fields
  const nameInput = document.getElementById("display-name-input");
  if (nameInput) nameInput.value = getDisplayName();
  const themeSelect = document.getElementById("theme-select");
  if (themeSelect) themeSelect.value = getPreferredTheme();
  const currencySelect = document.getElementById("currency-select");
  if (currencySelect) currencySelect.value = state.currency || "USD";
  const offsetInput = document.getElementById("lifetime-offset-input");
  if (offsetInput) offsetInput.value = state.lifetimeOffset > 0
    ? (state.lifetimeOffset / 100).toFixed(2)
    : "";
  // Clear password fields
  ["current-pass-input", "new-pass-input", "confirm-pass-input"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  openSettingsScreen();
  _settingsSnapshot = _snapshotSettings();
  _updateSettingsSaveBtn();
  // Wire dirty detection to all settings fields (once)
  ["display-name-input", "theme-select", "currency-select",
   "lifetime-offset-input", "current-pass-input", "new-pass-input", "confirm-pass-input"
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el._dirtyListenerAdded) {
      el.addEventListener("input", _updateSettingsSaveBtn);
      el.addEventListener("change", _updateSettingsSaveBtn);
      el._dirtyListenerAdded = true;
    }
  });
}

// -- UNIFIED SETTINGS SAVE
document
  .getElementById("btn-profile-save")
  .addEventListener("click", async () => {
    const btn = document.getElementById("btn-profile-save");
    const newName = (document.getElementById("display-name-input")?.value || "").trim();
    const cp = document.getElementById("current-pass-input")?.value || "";
    const np = document.getElementById("new-pass-input")?.value || "";
    const cf = document.getElementById("confirm-pass-input")?.value || "";
    const offsetRaw = (document.getElementById("lifetime-offset-input")?.value || "").trim();
    btn.classList.add("btn--loading");
    btn.disabled = true;
    try {
      const origName = _settingsSnapshot ? _settingsSnapshot.name : "";
      if (newName && newName !== origName) {
        const r = await dbUpdateDisplayName(newName);
        if (!r.ok) {
          const el = document.getElementById("err-current-pass");
          if (el) { el.textContent = r.message; el.style.color = ""; }
          return;
        }
        cacheDisplayName(newName);
        state.displayName = newName;
        await renderWelcomeName();
      }
      const newCurrency = document.getElementById("currency-select")?.value;
      const origCurrency = _settingsSnapshot ? _settingsSnapshot.currency : (state.currency || "USD");
      if (newCurrency && newCurrency !== origCurrency) {
        setCurrency(newCurrency);
        const m = getActiveMonth();
        if (m && m.budget !== null) { renderStats(m); renderExpenses(m); }
        await dbUpdateCurrency(newCurrency);
      }
      if (offsetRaw !== (_settingsSnapshot ? _settingsSnapshot.offset : "")) {
        const offsetVal = parseMoneyInput(offsetRaw);
        if (!isNaN(offsetVal) && offsetVal >= 0) {
          const r = await dbUpdateLifetimeOffset(offsetVal);
          if (!r.ok) {
            const el = document.getElementById("err-lifetime-offset");
            if (el) el.textContent = r.message;
            return;
          }
          state.lifetimeOffset = Math.round(offsetVal * 100);
          renderLifetimeTotal();
        }
      }
      if (cp || np || cf) {
        const cpEl = document.getElementById("current-pass-input");
        const npEl = document.getElementById("new-pass-input");
        const cfEl = document.getElementById("confirm-pass-input");
        if (!cp) { showFieldError(cpEl, "err-current-pass", "Current password is required."); return; }
        if (np !== cf) { showFieldError(cfEl, "err-confirm-pass", "Passwords do not match."); return; }
        if (np.length < 8) { showFieldError(npEl, "err-new-pass", "Minimum 8 characters."); return; }
        const r = await dbUpdatePassword(np);
        if (!r.ok) { showFieldError(cpEl, "err-current-pass", r.message); return; }
        [cpEl, npEl, cfEl].forEach((el) => { el.value = ""; el.classList.remove("is-invalid"); });
        ["err-current-pass", "err-new-pass", "err-confirm-pass"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) { el.textContent = ""; el.style.color = ""; }
        });
        const sEl = document.getElementById("err-confirm-pass");
        if (sEl) {
          sEl.style.color = "var(--success)";
          sEl.textContent = "Password updated.";
          setTimeout(() => { sEl.textContent = ""; sEl.style.color = ""; }, 3000);
        }
        _settingsSnapshot = _snapshotSettings();
        _updateSettingsSaveBtn();
        return;
      }
      _settingsSnapshot = _snapshotSettings();
      _updateSettingsSaveBtn();
      showScreen("history");
      setNavActive("home");
    } finally {
      btn.classList.remove("btn--loading");
      btn.disabled = false;
    }
  });

// -- BOTTOM NAV
function setNavActive(tab) {
  document.querySelectorAll(".bottom-nav-tab").forEach((b) => b.classList.remove("active"));
  const tabEl = document.getElementById("nav-tab-" + tab);
  if (tabEl) tabEl.classList.add("active");
}

document.getElementById("nav-tab-home").addEventListener("click", () => {
  pushHash('#home');
  if (!document.getElementById("settings-screen").classList.contains("hidden")) { showScreen("history"); setNavActive("home"); }
  setActiveMonthId(null);
  renderHistory();
  updateAchievementsBadge();
  showScreen("history");
  setNavActive("home");
});
document.getElementById("nav-tab-stats").addEventListener("click", () => {
  pushHash('#stats');
  _navigateToHash('#stats', false);
});
document.getElementById("nav-tab-manage").addEventListener("click", () => {
  pushHash('#manage');
  _navigateToHash('#manage', false);
});
document.getElementById("nav-tab-settings").addEventListener("click", () => {
  pushHash('#settings');
  _navigateToHash('#settings', false);
});


// -- HASH ROUTING
function pushHash(hash) {
  if (window.location.hash !== hash) window.history.pushState(null, "", hash || "#home");
}

function _getDisplayName() {
  return state.displayName || (typeof getDisplayName === "function" ? getDisplayName() : "");
}

function _navigateToHash(hash, isPopState) {
  const h = (hash || "#home").replace("#", "");
  const parts = h.split("/");
  const page = parts[0];
  const param = parts[1];
  const name = _getDisplayName();
  switch (page) {
    case "home": case "":
      setActiveMonthId(null); renderHistory(); updateAchievementsBadge();
      showScreen("history"); setNavActive("home"); break;
    case "stats":
      renderAppHeader("stats-screen", { title: "Statistics", icon: "bar_chart", subtitle: name });
      openStatsScreen(); setNavActive("stats"); break;
    case "manage":
      renderAppHeader("manage-screen", { title: "Manage", icon: "tune", subtitle: name });
      renderPresetList(); renderCategorySettingsList(); renderRecurringList();
      openManageScreen(); setNavActive("manage"); break;
    case "settings":
      renderAppHeader("settings-screen", { title: "Settings", icon: "settings", subtitle: name });
      _openSettings(); setNavActive("settings"); break;
    case "achievements":
      renderAppHeader("achievement-screen", { title: "Achievements", icon: "emoji_events", subtitle: name, showBack: true, backCb: () => { pushHash("#stats"); _navigateToHash("#stats", false); } });
      openAchievementScreen(); setNavActive("stats"); break;
    case "month":
      if (param) {
        const m = state.months.find((x) => x.id === param);
        if (m) { openMonth(param); setNavActive("home"); }
        else { if (!isPopState) pushHash("#home"); setActiveMonthId(null); renderHistory(); showScreen("history"); setNavActive("home"); }
      } break;
    default:
      setActiveMonthId(null); renderHistory(); showScreen("history"); setNavActive("home"); break;
  }
}

window.addEventListener("popstate", () => { _navigateToHash(window.location.hash, true); });

// -- DATA EXPORT
document.getElementById("btn-export-data").addEventListener("click", async () => {
  const btn = document.getElementById("btn-export-data");
  const errEl = document.getElementById("err-export");
  if (errEl) errEl.textContent = "";
  btn.classList.add("btn--loading");
  btn.disabled = true;

  try {
    const result = await dbExportData();
    if (!result.ok) {
      if (errEl) errEl.textContent = result.message;
      return;
    }
    const json = JSON.stringify(result.data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `afk-tracker-backup-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } finally {
    btn.classList.remove("btn--loading");
    btn.disabled = false;
  }
});

// -- AUTH
document.getElementById("btn-logout").addEventListener("click", async () => {
  const btn = document.getElementById("btn-logout");
  if (btn) {
    btn.classList.add("btn--loading");
    btn.disabled = true;
  }
  try {
    await signOut();
    supabase.removeAllChannels();
    _hideBottomNav();
    clearSession();
    setState({ displayName: null, months: [] });
    setActiveMonthId(null);
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
    const email = u.includes("@") ? u : u + "@afk-tracker.com";
    const error = await signInWithPassword(email, p);
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

// -- INIT
function _showBottomNav() {
  const nav = document.getElementById("bottom-nav");
  if (nav) nav.classList.remove("hidden");
}
function _hideBottomNav() {
  const nav = document.getElementById("bottom-nav");
  if (nav) nav.classList.add("hidden");
}

(async function init() {
  applyTheme(getPreferredTheme());
  watchSystemTheme();

  // The #init-loading overlay is baked into the HTML and visible from first paint.
  // We just grab the reference here; no need to create it.
  const overlay = document.getElementById("init-loading");

  try {
    const session = await getSession();
    if (!session) {
      // No session — show login screen, done.
      overlay.remove();
      return;
    }

    setCurrentUserId(session.user.id);

    loginScreen.classList.add("hidden");
    const cached = readLocalCache();

    if (cached) {
      // Warm load: render from cache immediately, sync in background
      setState(cached);
      setCurrency(state.currency);
      sortMonths();
      renderHistory();
      await renderWelcomeName();
      const initHash = window.location.hash;
      if (initHash && initHash !== "#home" && initHash !== "#") {
        _showBottomNav();
        _navigateToHash(initHash, false);
      } else {
        showScreen("history");
        _showBottomNav();
        setNavActive("home");
      }
      overlay.remove(); // Reveal history screen, sync continues silently
      setupRealtimeSync();

      try {
        setSyncStatus("syncing");
        const fresh = await loadState();
        setState(fresh);
        setCurrency(state.currency);
        writeLocalCache(state);
        sortMonths();
        renderHistory();
        updateAchievementsBadge();
        setSyncStatus(null);
      } catch (e) {
        console.error("Background sync failed:", e);
        setSyncStatus("stale");
      }
    } else {
      // Cold load: no cache — block on full loadState
      try {
        await doLogin();
        const initHashCold = window.location.hash;
        if (initHashCold && initHashCold !== "#home" && initHashCold !== "#") {
          _showBottomNav();
          _navigateToHash(initHashCold, false);
        } else {
          _showBottomNav();
          setNavActive("home");
        }
        updateAchievementsBadge();
      } catch (e) {
        console.error("init doLogin failed:", e);
        // doLogin() throws "SESSION_INVALID" after calling handleSessionInvalid()
        // internally, which already re-shows the login screen with its own banner.
        // For every other failure (network drop, etc.) we must show something —
        // without this the person is left on a blank page with no way to retry.
        if (e.message !== "SESSION_INVALID") {
          showScreen("login");
          showBanner(
            "login-error",
            "Could not load your data. Check your connection and try again.",
          );
        }
      }
      setupRealtimeSync();
      overlay.remove();
    }
  } catch (e) {
    console.error("init failed:", e);
    overlay.remove();
  }
})();
