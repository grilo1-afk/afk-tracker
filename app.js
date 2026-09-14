// ── STATE ──────────────────────────────────────────────────────────────────
// Schema: { months: [{ id, name, year, month, budget, expenses: [{id, desc, val, date}] }] }
let state = { months: [] };
let activeMonthId = null;

const MONTH_NAMES = [
  "January", "February", "March",    "April",
  "May",     "June",     "July",     "August",
  "September","October", "November", "December",
];

// ── CRYPTO ───────────────────────────────────────────────────────────────────
async function hashPassword(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // lowercase hex
}

// ── DOM REFS ────────────────────────────────────────────────────────────────
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
const btnAddExpense = document.getElementById("btn-add-expense");
const tableBody     = document.getElementById("expense-table-body");

// ── THEME ────────────────────────────────────────────────────────────────────
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

// ── PASSWORD TOGGLE (login field) ─────────────────────────────────────────────
document.getElementById("btn-toggle-password").addEventListener("click", () => {
  const pwd  = document.getElementById("password");
  const icon = document.getElementById("eye-icon");
  const isHidden = pwd.type === "password";
  pwd.type = isHidden ? "text" : "password";
  icon.textContent = isHidden ? "visibility_off" : "visibility";
});

// ── MONTH PICKER MODAL ────────────────────────────────────────────────────────
const pickerOverlay = document.getElementById("month-picker-overlay");
const pickMonthSel = document.getElementById("pick-month");
const pickYearSel = document.getElementById("pick-year");

// Populate month dropdown
MONTH_NAMES.forEach((name, i) => {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = name;
  pickMonthSel.appendChild(opt);
});

// Populate year dropdown: 2 years back → 2 years ahead
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

document.getElementById("btn-pick-confirm").addEventListener("click", () => {
  const m = parseInt(pickMonthSel.value, 10);
  const y = parseInt(pickYearSel.value, 10);
  const name = MONTH_NAMES[m] + " " + y;

  // Prevent duplicate months (use year-month as natural id for calendar months)
  const calId = y + "-" + m;
  if (state.months.find((x) => x.id === calId || x.name === name)) {
    // Show error inside the modal picker
    const existing = document.getElementById("pick-error");
    if (existing) existing.textContent = name + " already exists.";
    return;
  }

  const newMonth = {
    id: calId,
    name,
    year: y,
    month: m,
    budget: null,
    expenses: [],
  };
  state.months.push(newMonth);
  sortMonths();
  saveState();
  closeMonthPicker();
  renderHistory();
  openMonth(calId);
});

// ── UTILS ────────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function fmt(n) {
  return "$ " + parseFloat(n).toFixed(2);
}

// ── INLINE VALIDATION ────────────────────────────────────────────────────────
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

// ── ESCAPE KEY — close any open modal overlay ────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!pickerOverlay.classList.contains("hidden")) { closeMonthPicker(); return; }
  if (!profileOverlay.classList.contains("hidden")) { closeProfileModal(); return; }
});

// Clear errors on user input — login fields
["username", "password"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", () => {
    clearFieldError(document.getElementById(id), "err-" + id);
    clearBanner("login-error");
  });
});

// ── DISPLAY NAME ─────────────────────────────────────────────────────────────
function renderWelcomeName() {
  const el = document.getElementById("welcome-name");
  if (el) el.textContent = getDisplayName();
}

function getActiveMonth() {
  return state.months.find((m) => m.id === activeMonthId) || null;
}

function getCurrentMonthId() {
  const now = new Date();
  return now.getFullYear() + "-" + now.getMonth();
}

// ── PERSISTENCE (Google Apps Script Web App) ─────────────────────────────────
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwCEDs1stwKwJRBwPhEVpBu2byM40Hc4Ygx2YV2iMbaWibTBjT09GjEZcKroWN2FFzL/exec";

async function saveState() {
  try {
    // text/plain avoids a CORS preflight — GAS handles it without an extra OPTIONS round-trip
    await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(state),
    });
  } catch (e) {
    console.error("Error saving state to cloud:", e);
  }
}

async function loadState() {
  try {
    // GAS returns MimeType.TEXT — must parse manually, not via .json()
    const response = await fetch(GAS_URL, { redirect: "follow" });
    const text = await response.text();
    const data = JSON.parse(text);
    if (data && Array.isArray(data.months)) {
      state = data;
    }
  } catch (e) {
    console.error("Error loading state from cloud:", e);
    state = { months: [] };
  }
}

// ── ENSURE CURRENT MONTH EXISTS ──────────────────────────────────────────────
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
    saveState(); // fire-and-forget — don't block login flow
  }
}

// ── SCREEN ROUTING ────────────────────────────────────────────────────────────
const SCREENS = { login: loginScreen, history: historyScreen, month: monthScreen };

function showScreen(name) {
  Object.values(SCREENS).forEach((s) => s.classList.add("hidden"));
  SCREENS[name]?.classList.remove("hidden");
}

// ── HISTORY SCREEN ────────────────────────────────────────────────────────────
function sortMonths() {
  // Newest first: sort by year desc, then month desc
  state.months.sort((a, b) =>
    b.year !== a.year ? b.year - a.year : b.month - a.month,
  );
}

function renderHistory() {
  const currentId = getCurrentMonthId();
  monthList.innerHTML = "";

  if (state.months.length === 0) {
    monthList.innerHTML =
      '<div class="empty-history">No months recorded yet. Create your first month below.</div>';
    return;
  }

  state.months.forEach((m) => {
    const isCurrent = m.id === currentId;
    const totalSpent = m.expenses.reduce((s, e) => s + e.val, 0);
    const hasBudget = m.budget !== null;

    const metaText = hasBudget
      ? "Budget: " +
        fmt(m.budget) +
        " &nbsp;&bull;&nbsp; Spent: " +
        fmt(totalSpent)
      : "Budget not set yet";
    const metaClass = hasBudget ? "" : "needs-setup";

    const card = document.createElement("div");
    card.className = "month-card";
    card.innerHTML = `
      <div class="month-card-clickable month-card-info" data-id="${m.id}">
        <div class="month-card-name">${m.name}</div>
        <div class="month-card-meta ${metaClass}">${metaText}</div>
      </div>
      <div class="month-card-right">
        ${isCurrent ? '<span class="badge-current">Current</span>' : ""}
        <button class="btn-danger btn-delete-month" data-id="${m.id}">Delete</button>
      </div>
    `;
    monthList.appendChild(card);
  });

  monthList.querySelectorAll(".month-card-clickable").forEach((el) => {
    el.addEventListener("click", () => openMonth(el.dataset.id));
  });

  monthList.querySelectorAll(".btn-delete-month").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteMonth(btn.dataset.id);
    });
  });
}

function deleteMonth(id) {
  const m = state.months.find((x) => x.id === id);
  if (!m) return;
  // No confirm dialog — delete is immediate (the button is explicit enough)
  state.months = state.months.filter((x) => x.id !== id);
  saveState();
  renderHistory();
}

// ── MONTH VIEW ────────────────────────────────────────────────────────────────
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
}

function renderExpenses(m) {
  tableBody.innerHTML = "";
  if (m.expenses.length === 0) {
    tableBody.innerHTML =
      '<tr class="expense-row"><td colspan="4" style="text-align:center;color:#555;">No expenses recorded yet.</td></tr>';
    return;
  }
  m.expenses.forEach((exp) => {
    const tr = document.createElement("tr");
    tr.className = "expense-row";
    tr.innerHTML = `
      <td>${exp.date}</td>
      <td>${exp.desc}</td>
      <td class="value-col">${fmt(exp.val)}</td>
      <td class="action-col">
        <button class="btn-danger btn-del-expense" data-id="${exp.id}">Del</button>
      </td>
    `;
    tableBody.appendChild(tr);
  });

  tableBody.querySelectorAll(".btn-del-expense").forEach((btn) => {
    btn.addEventListener("click", () => deleteExpense(btn.dataset.id));
  });
}

function deleteExpense(expId) {
  const m = getActiveMonth();
  if (!m) return;
  m.expenses = m.expenses.filter((e) => e.id !== expId);
  saveState();
  renderStats(m);
  renderExpenses(m);
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────

// Shared login flow (used by manual login AND auto-login on page load)
async function doLogin() {
  const btnLogin = document.getElementById("btn-login");
  btnLogin.textContent = "Loading...";
  btnLogin.disabled = true;

  await loadState();
  ensureCurrentMonth();
  sortMonths();
  renderHistory();
  renderWelcomeName();
  showScreen("history");

  btnLogin.textContent = "Login";
  btnLogin.disabled = false;
}

// Login
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
  btnLogin.textContent = "Authenticating...";
  btnLogin.disabled = true;

  try {
    const hashed  = await hashPassword(p);
    const authUrl = GAS_URL
      + "?action=auth"
      + "&user=" + encodeURIComponent(u)
      + "&pass=" + hashed;
    const res  = await fetch(authUrl, { redirect: "follow" });
    const text = await res.text();
    const json = JSON.parse(text);

    if (!json.ok) {
      showFieldError(pEl, "err-password", "Invalid credentials.");
      uEl.classList.add("is-invalid");
      btnLogin.textContent = "Login";
      btnLogin.disabled = false;
      return;
    }
  } catch (err) {
    console.error("Auth check failed:", err);
    showBanner("login-error", "Could not reach the server. Check your connection.");
    btnLogin.textContent = "Login";
    btnLogin.disabled = false;
    return;
  }

  localStorage.setItem("afk_logged_in", "true");
  await doLogin();
});

// Allow Enter key on login
document.getElementById("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});

function doLogout() {
  localStorage.removeItem("afk_logged_in");
  activeMonthId = null;
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  showScreen("login");
}

// Logout lives inside the profile modal (wired further below)

// Back to history
document.getElementById("btn-back").addEventListener("click", () => {
  activeMonthId = null;
  renderHistory();
  showScreen("history");
});

// Create new month (prompts for a custom month or uses today if already exists)
document
  .getElementById("btn-create-month")
  .addEventListener("click", openMonthPicker);

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

// Edit budget — re-shows the setup box pre-filled with current value
document.getElementById("btn-edit-budget").addEventListener("click", () => {
  const m = getActiveMonth();
  if (!m) return;
  budgetInput.value = m.budget !== null ? m.budget : "";
  budgetSetupBox.classList.remove("hidden");
  statsSection.classList.add("hidden");
  addExpenseSection.classList.add("hidden");
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
  const desc = descInput.value.trim();
  const val = parseFloat(valInput.value);
  if (!desc) { descInput.classList.add("is-invalid"); return; }
  if (!val || val <= 0) { valInput.classList.add("is-invalid"); return; }
  descInput.classList.remove("is-invalid");
  valInput.classList.remove("is-invalid");
  const today = new Date().toLocaleDateString("en-US");
  m.expenses.push({ id: uid(), desc, val, date: today });
  saveState();
  renderStats(m);
  renderExpenses(m);
  descInput.value = "";
  valInput.value = "";
  descInput.focus();
}

// ── PROFILE MODAL ────────────────────────────────────────────────────────────
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

// Eye-toggle buttons inside the profile modal (Material Symbols — just swap text)
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
document.getElementById("btn-profile-close").addEventListener("click", closeProfileModal);
profileOverlay.addEventListener("click", (e) => { if (e.target === profileOverlay) closeProfileModal(); });

// Logout now lives inside the profile modal
document.getElementById("btn-logout").addEventListener("click", doLogout);

document.getElementById("btn-profile-save").addEventListener("click", async () => {
  const newName    = displayNameInput.value.trim();
  const newPass    = newPassInput.value;
  const confirmPass = confirmPassInput.value;
  const btn        = document.getElementById("btn-profile-save");

  // Save display name and update the UI immediately
  if (newName) {
    setDisplayName(newName);
    renderWelcomeName();
  }

  // Password change is optional — only attempt if the user filled in the fields
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
    if (newPass.length < 6) {
      showFieldError(newPassInput, "err-new-pass", "Minimum 6 characters.");
      return;
    }

    btn.textContent = "Saving...";
    btn.disabled    = true;

    try {
      const username     = document.getElementById("username").value.trim() || "arian";
      const oldHashed    = await hashPassword(currentPass);
      const newHashed    = await hashPassword(newPass);
      const url = GAS_URL
        + "?action=updatePass"
        + "&user="    + encodeURIComponent(username)
        + "&oldPass=" + oldHashed
        + "&newPass=" + newHashed;
      const res  = await fetch(url, { redirect: "follow" });
      const text = await res.text();
      const json = JSON.parse(text);
      if (!json.ok) {
        showFieldError(currentPassInput, "err-current-pass", "Current password is incorrect.");
        btn.textContent = "Save Changes";
        btn.disabled    = false;
        return;
      }
      // Success: clear all password fields and errors, show green confirmation
      [currentPassInput, newPassInput, confirmPassInput].forEach((el) => {
        el.value = "";
        el.classList.remove("is-invalid");
      });
      ["err-current-pass","err-new-pass","err-confirm-pass"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) { el.textContent = ""; el.style.color = ""; }
      });
      const successEl = document.getElementById("err-confirm-pass");
      if (successEl) {
        successEl.style.color = "var(--success)";
        successEl.textContent = "Password updated.";
        setTimeout(() => { successEl.textContent = ""; successEl.style.color = ""; }, 3000);
      }
    } catch (err) {
      console.error("Password update failed:", err);
      showFieldError(newPassInput, "err-new-pass", "Could not reach the server.");
      btn.textContent = "Save Changes";
      btn.disabled    = false;
      return;
    }

    btn.textContent = "Save Changes";
    btn.disabled    = false;
    // Don't close modal on success — leave the green confirmation visible for 3s
    return;
  }

  // No password change requested — just close after saving display name
  closeProfileModal();
});

// ── AUTO-LOGIN ON PAGE LOAD ───────────────────────────────────────────────────
(async function init() {
  // Apply saved theme (or system preference) before any content renders
  applyTheme(getPreferredTheme());

  if (localStorage.getItem("afk_logged_in") === "true") {
    // Hide login immediately (synchronous) so it never flashes
    loginScreen.classList.add("hidden");

    // Show a minimal loading overlay while the GAS fetch runs
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

    await doLogin();

    overlay.remove();
  }
})();
