// -- STATE
// Schema: { months: [{ id, name, year, month, budget, expenses: [{id, desc, val, date, createdAt}] }] }
let state = { months: [] };
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
const SESSION_KEY = "afk_session";

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
async function apiRequest(payload) {
  const res = await fetch(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    redirect: "follow",
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return JSON.parse(text);
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

async function saveState() {
  const session = getStoredSession();
  if (!session) return;
  try {
    const json = await apiRequest({
      action: "saveState",
      token: session.token,
      data: state,
    });
    if (!json.ok) {
      const err = json.error || "";
      if (err === "SESSION_INVALID" || err === "ACCOUNT_INACTIVE") {
        handleSessionInvalid(err);
      }
    }
  } catch (e) {
    console.error("Error saving state to cloud:", e);
  }
}

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
    state = json.data;
  }
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
      deleteMonth(m.id);
    });
    rightDiv.appendChild(btn);

    card.appendChild(clickable);
    card.appendChild(rightDiv);
    monthList.appendChild(card);
  });
}

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

function formatExpenseDate(isoDate) {
  if (!isoDate) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    const [y, mo, d] = isoDate.split("-").map(Number);
    return new Date(y, mo - 1, d).toLocaleDateString("en-US");
  }
  return isoDate; // unmigrated fallback — display as-is
}

function renderExpenses(m) {
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
    tdAction.className = "action-col";

    const btn = document.createElement("button");
    btn.className = "btn-danger btn-del-expense";
    btn.dataset.id = exp.id;
    btn.textContent = "Del";
    btn.addEventListener("click", () => deleteExpense(exp.id));

    tdAction.appendChild(btn);
    tr.appendChild(tdDate);
    tr.appendChild(tdDesc);
    tr.appendChild(tdVal);
    tr.appendChild(tdAction);
    tableBody.appendChild(tr);
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

// -- EVENT LISTENERS

// Shared post-auth entry: load state and show history screen.
// Does NOT touch the login button — callers own their own loading state.
async function doLogin() {
  await loadState();
  ensureCurrentMonth();
  sortMonths();
  renderHistory();
  renderWelcomeName();
  showScreen("history");
}

// Login -- sends plaintext password to GAS; server does PBKDF2 verification
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
    const json = await apiRequest({ action: "login", username: u, password: p });
    if (!json.ok) {
      const err = json.error || "SERVER_ERROR";
      if (err === "INVALID_CREDENTIALS") {
        showFieldError(pEl, "err-password", "Invalid username or password.");
        uEl.classList.add("is-invalid");
        return;
      } else if (err === "RATE_LIMITED") {
        showBanner("login-error", "Too many failed attempts. Try again in 15 minutes.");
      } else if (err === "ACCOUNT_INACTIVE") {
        showBanner("login-error", "Your account is inactive. Contact support.");
      } else {
        showBanner("login-error", "Could not reach the server. Check your connection.");
      }
      return;
    }
    storeSession(json.token, json.username, json.expiresAt);
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
    const session = getStoredSession();
    if (session) {
      try { await apiRequest({ action: "logout", token: session.token }); } catch (_) {}
    }
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
  const today = new Date().toISOString().slice(0, 10); // "2026-09-05"
  m.expenses.push({ id: uid(), desc, val, date: today, createdAt: new Date().toISOString() });
  saveState();
  renderStats(m);
  renderExpenses(m);
  descInput.value = "";
  valInput.value = "";
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
    } catch (err) {
      showFieldError(newPassInput, "err-new-pass", "Could not reach the server.");
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

  const session = getStoredSession();
  if (!session) return; // no stored session -- show login screen

  // Hide login immediately so it never flashes
  loginScreen.classList.add("hidden");

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

  // Go directly to getState -- it authenticates server-side and returns SESSION_INVALID
  // if the token is expired/revoked/account-inactive, which handleSessionInvalid() handles.
  // This eliminates the redundant validateSession round-trip.
  try {
    await doLogin();
  } catch (e) {
    // doLogin threw (e.g. SESSION_INVALID from getState) -- handleSessionInvalid already ran
    console.error("init doLogin failed:", e);
  }

  overlay.remove();
})();
