import { supabase } from "./supabase-client.js";
import { readPresets, writePresets } from "./presets.js";
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
  setCurrency,
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
  profileOverlay,
  openProfileModal,
  closeProfileModal,
  registerDeleteExpenseCb,
  registerOpenEditExpenseCb,
  parseMoneyInput,
  setSyncStatus,
} from "./ui.js";

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
  const m = state.months.find((x) => x.id === monthId);
  if (!m) return;

  // Expense is already gone from DB — undo means re-creating it
  const result = await dbAddExpense(monthId, expense.desc, expense.val / 100, expense.date, expense.categoryId || null);
  if (!result.ok) {
    showBanner("login-error", "Could not restore expense. Try again.");
    return;
  }
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

// When the edit modal opens, sync _editSelectedCategoryId and render the edit picker
registerOpenEditExpenseCb((expId) => {
  const m = getActiveMonth();
  const exp = m && m.expenses.find((e) => e.id === expId);
  _editSelectedCategoryId = (exp && exp.categoryId) || null;

  const editPicker = document.getElementById("edit-exp-category-picker");
  if (!editPicker) return;
  editPicker.innerHTML = "";
  state.categories.forEach((cat) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "category-pill" + (cat.id === _editSelectedCategoryId ? " selected" : "");
    btn.textContent = cat.name;
    btn.addEventListener("click", () => {
      _editSelectedCategoryId = (cat.id === _editSelectedCategoryId) ? null : cat.id;
      // Re-render to update selected state
      editPicker.querySelectorAll(".category-pill").forEach((p) => p.classList.remove("selected"));
      btn.classList.toggle("selected", cat.id === _editSelectedCategoryId);
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

// -- THEME
document.getElementById("theme-select").addEventListener("change", (e) => applyTheme(e.target.value));

// -- CURRENCY
document.getElementById("currency-select").addEventListener("change", async (e) => {
  const code = e.target.value;
  setCurrency(code);
  // Re-render current month stats if a month is open
  const m = getActiveMonth();
  if (m && m.budget !== null) {
    renderStats(m);
    renderExpenses(m);
  }
  // Persist — fire and forget; the value is already applied locally
  await dbUpdateCurrency(code);
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
  for (let y = cur - 2; y <= cur + 2; y++) {
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
    openMonth(result.data);
    renderPresetStrip();
    renderCategoryPicker();
  });

// -- ESCAPE KEY
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
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

// -- TODAY BUTTONS
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
    btn.className = "category-pill" + (cat.id === _selectedCategoryId ? " selected" : "");
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

// -- PRESETS

function renderPresetStrip() {
  const strip = document.getElementById("preset-strip");
  if (!strip) return;
  const presets = readPresets();
  strip.innerHTML = "";
  if (presets.length === 0) {
    strip.classList.add("hidden");
    return;
  }
  strip.classList.remove("hidden");
  presets.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-pill";
    btn.textContent = `${p.desc}  $${parseFloat(p.amount).toFixed(2)}`;
    btn.addEventListener("click", () => {
      descInput.value = p.desc;
      valInput.value = parseFloat(p.amount).toFixed(2);
      expDateInput.value = new Date().toISOString().slice(0, 10);
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
  const presets = readPresets();
  list.innerHTML = "";
  if (presets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "preset-empty";
    empty.textContent = "No presets yet.";
    list.appendChild(empty);
    return;
  }
  presets.forEach((p) => {
    const row = document.createElement("div");
    row.className = "preset-row";
    const label = document.createElement("span");
    label.className = "preset-row-label";
    label.textContent = p.desc;
    const amount = document.createElement("span");
    amount.className = "preset-row-amount";
    amount.textContent = `$${parseFloat(p.amount).toFixed(2)}`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-danger btn-sm";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      const updated = readPresets().filter((x) => x.id !== p.id);
      writePresets(updated);
      renderPresetList();
      renderPresetStrip();
    });
    row.appendChild(label);
    row.appendChild(amount);
    row.appendChild(del);
    list.appendChild(row);
  });
}

document.getElementById("btn-add-preset").addEventListener("click", () => {
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
  const presets = readPresets();
  presets.push({ id: crypto.randomUUID(), desc, amount });
  writePresets(presets);
  descEl.value = "";
  amountEl.value = "";
  renderPresetList();
  renderPresetStrip();
});

// -- NAVIGATION
document.getElementById("btn-back").addEventListener("click", () => {
  setActiveMonthId(null);
  renderHistory();
  showScreen("history");
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
  const today = new Date().toISOString().slice(0, 10);
  expDateInput.value = today;
  const lastDay = new Date(m.year, m.month + 1, 0).getDate();
  const mm = String(m.month + 1).padStart(2, "0");
  expDateInput.min = m.year + "-" + mm + "-01";
  expDateInput.max = m.year + "-" + mm + "-" + String(lastDay).padStart(2, "0");
  renderStats(m);
  renderExpenses(m);

  const result = await dbUpdateBudget(m.id, val);
  if (!result.ok) {
    m.budget = prevBudget;
    budgetSetupBox.classList.remove("hidden");
    statsSection.classList.add("hidden");
    addExpenseSection.classList.add("hidden");
    renderStats(m);
    renderExpenses(m);
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
  expDateInput.value = new Date().toISOString().slice(0, 10);
  clearFieldError(expDateInput, "err-exp-date");
  descInput.focus();

  const result = await dbAddExpense(m.id, desc, val, dateVal, _selectedCategoryId);
  if (!result.ok) {
    // Rollback: remove the optimistic expense
    const tmpIdx = m.expenses.findIndex((e) => e.id === tmpId);
    if (tmpIdx !== -1) m.expenses.splice(tmpIdx, 1);
    renderStats(m);
    renderExpenses(m);
    showBanner("login-error", result.message);
    return;
  }
  // Success: replace tmp id with real row data
  const saved = m.expenses.find((e) => e.id === tmpId);
  if (saved) {
    saved.id = result.data.id;
    saved.createdAt = result.data.created_at;
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

    const [descResult, catResult] = await Promise.all([
      dbUpdateExpense(exp.id, newDesc, newVal, newDate),
      dbUpdateExpenseCategory(exp.id, _editSelectedCategoryId),
    ]);
    const result = descResult.ok ? catResult : descResult;
    if (!result.ok) {
      // Rollback
      exp.desc = prevDesc;
      exp.val = prevVal;
      exp.date = prevDate;
      exp.categoryId = prevCatId;
      renderStats(m);
      renderExpenses(m);
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

    const result = await dbDeleteMonth(id);
    if (!result.ok) {
      // Rollback: re-insert at original index
      const restored = [...state.months];
      restored.splice(idx, 0, savedMonth);
      setState({ months: restored, displayName: state.displayName });
      renderHistory();
      showBanner("login-error", result.message);
    }
  });
document
  .getElementById("delete-month-overlay")
  .addEventListener("click", (e) => {
    if (e.target === document.getElementById("delete-month-overlay"))
      closeDeleteMonthModal();
  });

// -- PROFILE
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
document
  .getElementById("btn-profile")
  .addEventListener("click", () => {
    openProfileModal();
    renderPresetList();
    renderCategorySettingsList();
    const currencySelect = document.getElementById("currency-select");
    if (currencySelect) currencySelect.value = state.currency || "USD";
    const offsetInput = document.getElementById("lifetime-offset-input");
    if (offsetInput) offsetInput.value = state.lifetimeOffset > 0
      ? (state.lifetimeOffset / 100).toFixed(2)
      : "";
  });
document
  .getElementById("btn-profile-2")
  .addEventListener("click", () => {
    openProfileModal();
    renderPresetList();
    renderCategorySettingsList();
    const currencySelect = document.getElementById("currency-select");
    if (currencySelect) currencySelect.value = state.currency || "USD";
    const offsetInput = document.getElementById("lifetime-offset-input");
    if (offsetInput) offsetInput.value = state.lifetimeOffset > 0
      ? (state.lifetimeOffset / 100).toFixed(2)
      : "";
  });
document
  .getElementById("btn-profile-close-x")
  .addEventListener("click", closeProfileModal);
profileOverlay.addEventListener("click", (e) => {
  if (e.target === profileOverlay) closeProfileModal();
});

document
  .getElementById("btn-profile-save")
  .addEventListener("click", async () => {
    const newName = document.getElementById("display-name-input").value.trim();
    const currentPass = document.getElementById("current-pass-input").value;
    const newPass = document.getElementById("new-pass-input").value;
    const confirmPass = document.getElementById("confirm-pass-input").value;
    const btn = document.getElementById("btn-profile-save");
    if (newName) {
      const nameResult = await dbUpdateDisplayName(newName);
      if (!nameResult.ok) {
        const nameErrEl = document.getElementById("err-current-pass");
        if (nameErrEl) {
          nameErrEl.textContent = nameResult.message;
          nameErrEl.style.color = "";
        }
        return;
      }
      cacheDisplayName(newName);
      state.displayName = newName;
      await renderWelcomeName();
    }
    if (currentPass || newPass || confirmPass) {
      const cpEl = document.getElementById("current-pass-input");
      const npEl = document.getElementById("new-pass-input");
      const cfEl = document.getElementById("confirm-pass-input");
      if (!currentPass) {
        showFieldError(
          cpEl,
          "err-current-pass",
          "Current password is required.",
        );
        return;
      }
      if (newPass !== confirmPass) {
        showFieldError(cfEl, "err-confirm-pass", "Passwords do not match.");
        return;
      }
      if (newPass.length < 8) {
        showFieldError(npEl, "err-new-pass", "Minimum 8 characters.");
        return;
      }
      btn.classList.add("btn--loading");
      btn.disabled = true;
      try {
        const result = await dbUpdatePassword(newPass);
        if (!result.ok) {
          showFieldError(cpEl, "err-current-pass", result.message);
          return;
        }
        [cpEl, npEl, cfEl].forEach((el) => {
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
        const sEl = document.getElementById("err-confirm-pass");
        if (sEl) {
          sEl.style.color = "var(--success)";
          sEl.textContent = "Password updated.";
          setTimeout(() => {
            sEl.textContent = "";
            sEl.style.color = "";
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

// -- LIFETIME OFFSET SAVE
document.getElementById("btn-save-lifetime-offset").addEventListener("click", async () => {
  const input = document.getElementById("lifetime-offset-input");
  const errEl = document.getElementById("err-lifetime-offset");
  const btn = document.getElementById("btn-save-lifetime-offset");
  if (errEl) errEl.textContent = "";

  const val = parseMoneyInput(input.value);
  if (isNaN(val) || val < 0) {
    if (errEl) errEl.textContent = "Enter a valid amount (0 or greater).";
    return;
  }

  btn.classList.add("btn--loading");
  btn.disabled = true;
  try {
    const result = await dbUpdateLifetimeOffset(val);
    if (!result.ok) {
      if (errEl) errEl.textContent = result.message;
      return;
    }
    state.lifetimeOffset = Math.round(val * 100);
    renderLifetimeTotal();
  } finally {
    btn.classList.remove("btn--loading");
    btn.disabled = false;
  }
});

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
    closeProfileModal();
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
      showScreen("history");
      overlay.remove(); // Reveal history screen, sync continues silently

      try {
        setSyncStatus("syncing");
        const fresh = await loadState();
        setState(fresh);
        setCurrency(state.currency);
        writeLocalCache(state);
        sortMonths();
        renderHistory();
        setSyncStatus(null);
      } catch (e) {
        console.error("Background sync failed:", e);
        setSyncStatus("stale");
      }
    } else {
      // Cold load: no cache — block on full loadState
      try {
        await doLogin();
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
      overlay.remove();
    }
  } catch (e) {
    console.error("init failed:", e);
    overlay.remove();
  }
})();
