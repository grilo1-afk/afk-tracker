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

function deleteExpense(expId) {
  const m = getActiveMonth();
  if (!m) return;
  if (_undoTimer) {
    clearTimeout(_undoTimer);
    _undoTimer = null;
    const prev = _lastDeleted;
    _lastDeleted = null;
    hideUndoToast();
    if (prev) dbDeleteExpense(prev.expense.id);
  }
  const idx = m.expenses.findIndex((e) => e.id === expId);
  if (idx === -1) return;
  _lastDeleted = { expense: m.expenses[idx], index: idx, monthId: m.id };
  m.expenses.splice(idx, 1);
  renderStats(m);
  renderExpenses(m);
  showUndoToast("Expense deleted");
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
}

// Register delete callback so ui.js can call it without importing app.js
registerDeleteExpenseCb(deleteExpense);

// Make undoDeleteExpense available for the inline onclick in HTML
window.undoDeleteExpense = undoDeleteExpense;

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
    const newId = await dbAddMonth(y, m + 1, name, () =>
      handleSessionInvalid("SESSION_INVALID"),
    );
    if (!newId) return;
    state.months.push({
      id: newId,
      name,
      year: y,
      month: m,
      budget: null,
      expenses: [],
    });
    sortMonths();
    closeMonthPicker();
    renderHistory();
    openMonth(newId);
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
  const val = parseFloat(budgetInput.value);
  if (!val || val <= 0) {
    budgetInput.classList.add("is-invalid");
    budgetInput.setAttribute("placeholder", "Enter a valid amount");
    return;
  }
  budgetInput.classList.remove("is-invalid");
  const ok = await dbUpdateBudget(m.id, val);
  if (!ok) {
    showBanner("login-error", "Could not save budget. Try again.");
    return;
  }
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
  ["budget-progress-wrap", "daily-allowance", "spending-projection"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    },
  );
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
  const row = await dbAddExpense(m.id, desc, val, dateVal);
  if (!row) {
    showBanner("login-error", "Could not save expense. Try again.");
    return;
  }
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
    if (!ok) {
      showBanner("login-error", "Could not update expense. Try again.");
      return;
    }
    exp.desc = newDesc;
    exp.val = newVal;
    exp.date = newDate;
    renderStats(m);
    renderExpenses(m);
    closeEditExpenseModal();
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
    const ok = await dbDeleteMonth(id);
    if (!ok) {
      showBanner("login-error", "Could not delete month. Try again.");
      closeDeleteMonthModal();
      return;
    }
    setState({
      months: state.months.filter((x) => x.id !== id),
      displayName: state.displayName,
    });
    closeDeleteMonthModal();
    renderHistory();
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
      await dbUpdateDisplayName(newName);
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
          showFieldError(
            cpEl,
            "err-current-pass",
            "Could not update password. Try again.",
          );
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
        const fresh = await loadState();
        setState(fresh);
        writeLocalCache(state);
        sortMonths();
        renderHistory();
      } catch (e) {
        console.error("Background sync failed:", e);
      }
    } else {
      // Cold load: no cache — block on full loadState
      try {
        await doLogin();
      } catch (e) {
        console.error("init doLogin failed:", e);
      }
      overlay.remove();
    }
  } catch (e) {
    console.error("init failed:", e);
    overlay.remove();
  }
})();
