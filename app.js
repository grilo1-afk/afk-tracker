// ── STATE ──────────────────────────────────────────────────────────────────
// Schema: { months: [{ id, name, year, month, budget, expenses: [{id, desc, val, date}] }] }
let state = { months: [] };
let activeMonthId = null;

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

// ── PASSWORD TOGGLE ───────────────────────────────────────────────────────────
document.getElementById("btn-toggle-password").addEventListener("click", () => {
  const pwd = document.getElementById("password");
  const icon = document.getElementById("eye-icon");
  if (pwd.type === "password") {
    pwd.type = "text";
    // Switch to eye-off icon (line through the eye)
    icon.innerHTML = `
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    `;
  } else {
    pwd.type = "password";
    icon.innerHTML = `
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    `;
  }
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
    alert(name + " already exists.");
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
const btnAddExpense = document.getElementById("btn-add-expense");
const tableBody = document.getElementById("expense-table-body");

// ── UTILS ────────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function fmt(n) {
  return "$ " + parseFloat(n).toFixed(2);
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
    await fetch(GAS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8", // Evita requisições de preflight complexas do CORS no Google Apps Script
      },
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
// NOTE: callers must await saveState() where needed; here we fire-and-forget
// because ensureCurrentMonth is called inline during login flow.
async function ensureCurrentMonth() {
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
    await saveState();
  }
}

// ── SCREEN ROUTING ────────────────────────────────────────────────────────────
function showScreen(name) {
  loginScreen.classList.add("hidden");
  historyScreen.classList.add("hidden");
  monthScreen.classList.add("hidden");
  if (name === "login") loginScreen.classList.remove("hidden");
  if (name === "history") historyScreen.classList.remove("hidden");
  if (name === "month") monthScreen.classList.remove("hidden");
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
  if (
    !confirm(
      'Delete "' + m.name + '" and all its expenses? This cannot be undone.',
    )
  )
    return;
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
  if (!confirm("Remove this expense?")) return;
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
  await ensureCurrentMonth();
  sortMonths();
  renderHistory();
  showScreen("history");

  btnLogin.textContent = "Login";
  btnLogin.disabled = false;
}

// Login
document.getElementById("btn-login").addEventListener("click", async () => {
  const u = document.getElementById("username").value.trim();
  const p = document.getElementById("password").value;
  if (!u || !p) {
    alert("Enter your username and password.");
    return;
  }

  const btnLogin = document.getElementById("btn-login");
  btnLogin.textContent = "Authenticating...";
  btnLogin.disabled = true;

  try {
    const hashed = await hashPassword(p);

    // Use GET — GAS doGet handles ?action=auth without the 302 redirect
    // that POST requests trigger from cross-origin clients.
    const authUrl = GAS_URL
      + "?action=auth"
      + "&user=" + encodeURIComponent(u)
      + "&pass=" + hashed;
    const res  = await fetch(authUrl, { redirect: "follow" });
    const text = await res.text();
    console.log("[auth] raw response:", text);
    const json = JSON.parse(text);

    if (!json.ok) {
      alert("Invalid credentials! Access denied.");
      btnLogin.textContent = "Login";
      btnLogin.disabled = false;
      return;
    }
  } catch (err) {
    console.error("Auth check failed:", err);
    alert("Could not reach the server. Check your connection.");
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

// Logout (history screen)
document.getElementById("btn-logout").addEventListener("click", doLogout);

// Logout (month screen)
document.getElementById("btn-logout-2").addEventListener("click", doLogout);

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
    alert("Enter a valid budget amount.");
    return;
  }
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
  if (!desc || !val || val <= 0) {
    alert("Enter a description and a valid amount.");
    return;
  }
  const today = new Date().toLocaleDateString("en-US");
  m.expenses.push({ id: uid(), desc, val, date: today });
  saveState();
  renderStats(m);
  renderExpenses(m);
  descInput.value = "";
  valInput.value = "";
  descInput.focus();
}

// ── AUTO-LOGIN ON PAGE LOAD ───────────────────────────────────────────────────
(async function init() {
  if (localStorage.getItem("afk_logged_in") === "true") {
    // Hide login immediately (synchronous) so it never flashes
    loginScreen.classList.add("hidden");

    // Show a minimal loading overlay while the GAS fetch runs
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
      "gap:12px",
      "z-index:999",
      "color:#d4af37",
      "font-family:'Segoe UI',sans-serif",
      "font-size:14px",
      "letter-spacing:2px",
      "text-transform:uppercase",
    ].join(";");
    overlay.innerHTML = `
      <div style="font-size:22px;font-weight:bold;">AFK Tavern</div>
      <div style="color:#c5c6c7;font-size:12px;">Loading...</div>
    `;
    document.body.appendChild(overlay);

    await doLogin();

    overlay.remove();
  }
})();
