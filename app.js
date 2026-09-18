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
  toggleTheme,
  showFieldError,
  clearFieldError,
  showBanner,
  clearBanner,
  renderWelcomeName,
  sortMonths,
  renderHistory,
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
  parseMoneyInput,
  setSyncStatus,
} from "./ui.js";

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
  const result = await dbAddExpense(monthId, expense.desc, expense.val, expense.date);
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
document.getElementById("btn-theme").addEventListener("click", toggleTheme);
document.getElementById("btn-theme-2").addEventListener("click", toggleTheme);

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
  if (!val || val <= 0) {
    budgetInput.classList.add("is-invalid");
    budgetInput.setAttribute("placeholder", "Enter a valid amount");
    return;
  }
  budgetInput.classList.remove("is-invalid");

  // Optimistic: apply immediately, then persist
  const prevBudget = m.budget;
  m.budget = val;
  budgetSetupBox.classList.add("hidden");
  statsSection.classList.remove("hidden");
  addExpenseSection.classList.remove("hidden");
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
  budgetInput.value = m.budget !== null ? m.budget : "";
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
  const optimisticExpense = { id: tmpId, desc, val, date: dateVal, createdAt: null };
  m.expenses.push(optimisticExpense);
  renderStats(m);
  renderExpenses(m);
  descInput.value = "";
  valInput.value = "";
  expDateInput.value = new Date().toISOString().slice(0, 10);
  clearFieldError(expDateInput, "err-exp-date");
  descInput.focus();

  const result = await dbAddExpense(m.id, desc, val, dateVal);
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
    exp.desc = newDesc;
    exp.val = newVal;
    exp.date = newDate;
    renderStats(m);
    renderExpenses(m);
    closeEditExpenseModal();

    const result = await dbUpdateExpense(exp.id, newDesc, newVal, newDate);
    if (!result.ok) {
      // Rollback
      exp.desc = prevDesc;
      exp.val = prevVal;
      exp.date = prevDate;
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
      sortMonths();
      renderHistory();
      await renderWelcomeName();
      showScreen("history");
      overlay.remove(); // Reveal history screen, sync continues silently

      try {
        setSyncStatus("syncing");
        const fresh = await loadState();
        setState(fresh);
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
