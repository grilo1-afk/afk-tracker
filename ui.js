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
  getLocalISODate,
} from "./state.js";
import { supabase } from "./supabase-client.js";

// -- SCREEN ROUTING
const loginScreen = document.getElementById("login-screen");
const historyScreen = document.getElementById("history-screen");
const monthScreen = document.getElementById("month-screen");
const achievementScreen = document.getElementById("achievement-screen");
const statsScreen = document.getElementById("stats-screen");
const manageScreen = document.getElementById("manage-screen");
const settingsScreen = document.getElementById("settings-screen");

const SCREENS = {
  login: loginScreen,
  history: historyScreen,
  month: monthScreen,
  achievement: achievementScreen,
  stats: statsScreen,
  manage: manageScreen,
  settings: settingsScreen,
};

export function showScreen(name) {
  Object.values(SCREENS).forEach((s) => s && s.classList.add("hidden"));
  const target = SCREENS[name];
  if (target) {
    target.classList.remove("hidden");
    // Scroll the .scroll-content inside this screen back to the top on every navigation
    const scrollEl = target.querySelector('.scroll-content');
    if (scrollEl) scrollEl.scrollTop = 0;
  }
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

// -- SHARED APP HEADER COMPONENT
// Renders the standard header for tab screens.
// config: { title, icon (Material Symbol name), subtitle, showBack, backCb }
export function renderAppHeader(screenId, config) {
  var screen = document.getElementById(screenId);
  if (!screen) return;
  var header = screen.querySelector('.screen-header');
  if (!header) return;
  header.innerHTML = '';

  // Left: title block
  var left = document.createElement('div');

  var h2 = document.createElement('h2');
  if (config.icon) {
    var iconSpan = document.createElement('span');
    iconSpan.className = 'material-symbols-outlined header-icon';
    iconSpan.textContent = config.icon;
    h2.appendChild(iconSpan);
    h2.appendChild(document.createTextNode(' ' + config.title));
  } else {
    h2.textContent = config.title;
  }
  left.appendChild(h2);

  if (config.subtitle) {
    var sub = document.createElement('div');
    sub.className = 'welcome-name-generic';
    sub.textContent = config.subtitle;
    left.appendChild(sub);
  }
  header.appendChild(left);

  // Right: actions
  var actions = document.createElement('div');
  actions.className = 'header-actions';

  if (config.showBack && config.backCb) {
    var backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn-icon';
    backBtn.title = 'Back';
    backBtn.setAttribute('aria-label', 'Back');
    backBtn.innerHTML = '<span class="material-symbols-outlined">arrow_back</span>';
    backBtn.addEventListener('click', config.backCb);
    actions.appendChild(backBtn);
  }

  header.appendChild(actions);
}

// -- SORT / HISTORY
export function sortMonths() {
  state.months.sort((a, b) =>
    b.year !== a.year ? b.year - a.year : b.month - a.month,
  );
}

export function renderYearSummary() {
  const container = document.getElementById("year-summary");
  if (!container) return;
  container.innerHTML = "";

  if (state.months.length === 0) return;

  const byYear = new Map();
  state.months.forEach((m) => {
    if (!byYear.has(m.year)) byYear.set(m.year, []);
    byYear.get(m.year).push(m);
  });

  let isFirst = true;
  byYear.forEach((months, year) => {
    const budgeted = months.filter((m) => m.budget !== null);
    if (budgeted.length === 0) return;

    const totalSpent  = budgeted.reduce((s, m) => s + m.expenses.reduce((ss, e) => ss + e.val, 0), 0);
    const totalBudget = budgeted.reduce((s, m) => s + m.budget, 0);
    const avgPerMonth = Math.round(totalSpent / budgeted.length);
    const underBudget = budgeted.filter((m) => {
      const spent = m.expenses.reduce((s, e) => s + e.val, 0);
      return m.budget > 0 && spent <= m.budget;
    }).length;

    const block = document.createElement("details");
    block.className = "year-summary-block";
    if (isFirst) block.open = true;
    isFirst = false;

    const heading = document.createElement("summary");
    heading.className = "year-summary-heading";
    heading.textContent = year;
    block.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "year-summary-grid";

    const items = [
      { label: "Spent",        value: fmt(totalSpent) },
      { label: "Avg / Month",  value: fmt(avgPerMonth) },
      { label: "Budgeted",     value: fmt(totalBudget) },
      { label: "Under Budget", value: underBudget + " / " + budgeted.length },
    ];

    items.forEach(({ label, value }) => {
      const item = document.createElement("div");
      item.className = "year-summary-item";
      const lEl = document.createElement("span");
      lEl.className = "year-summary-label";
      lEl.textContent = label;
      const vEl = document.createElement("span");
      vEl.className = "year-summary-value";
      vEl.textContent = value;
      item.appendChild(lEl);
      item.appendChild(vEl);
      grid.appendChild(item);
    });

    block.appendChild(grid);
    container.appendChild(block);
  });
}

export function renderLifetimeTotal() {
  const wrap = document.getElementById("lifetime-total-wrap");
  const valueEl = document.getElementById("display-lifetime-total");
  const noteEl = document.getElementById("lifetime-estimate-note");
  if (!wrap || !valueEl) return;

  if (state.months.length === 0 && state.lifetimeOffset === 0) {
    wrap.classList.add("hidden");
    return;
  }

  const measuredTotal = state.months.reduce(
    (s, m) => s + m.expenses.reduce((ss, e) => ss + e.val, 0),
    0
  );
  const lifetimeTotal = measuredTotal + state.lifetimeOffset;

  valueEl.textContent = fmt(lifetimeTotal);
  if (noteEl) {
    noteEl.textContent = state.lifetimeOffset > 0
      ? "includes an estimated " + fmt(state.lifetimeOffset) + " from before this app"
      : "";
  }
  wrap.classList.remove("hidden");
}

// -- CHARTS (D5)

var _chartPeriod = 12; // 6 | 12 | 'all'

export function setChartPeriod(period) {
  _chartPeriod = period;
}

function svgEl(tag, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) { Object.keys(attrs).forEach(function(k) { el.setAttribute(k, attrs[k]); }); }
  return el;
}

function _renderSpendingChart(container) {
  container.innerHTML = '';
  var monthsWithData = state.months.slice().filter(function(m) { return m.expenses.length > 0; });
  var useYearly = _chartPeriod === 'all' && monthsWithData.length > 24;

  if (useYearly) {
    var byYear = new Map();
    monthsWithData.forEach(function(m) {
      var total = m.expenses.reduce(function(s, e) { return s + e.val; }, 0);
      byYear.set(m.year, (byYear.get(m.year) || 0) + total);
    });
    var years = Array.from(byYear.keys()).sort(function(a, b) { return a - b; });
    if (years.length === 0) return;
    var W = 280, H = 120, PAD = { top: 20, right: 4, bottom: 20, left: 4 };
    var chartW = W - PAD.left - PAD.right;
    var chartH = H - PAD.top - PAD.bottom;
    var values = years.map(function(y) { return byYear.get(y); });
    var maxVal = Math.max.apply(null, values.concat([1]));
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '100%' });
    var barW = Math.max(Math.floor((Math.floor(chartW / years.length) - 4) * 0.7), 2);
    years.forEach(function(y, i) {
      var val = values[i];
      var barH = Math.max(Math.round((val / maxVal) * chartH), 2);
      var x = PAD.left + i * (barW + 4);
      var yPos = PAD.top + chartH - barH;
      svg.appendChild(svgEl('rect', { x: x, y: yPos, width: barW, height: barH, fill: 'var(--gold)', rx: 2, opacity: 0.85 }));
      var yValLbl = svgEl('text', { x: x + barW / 2, y: Math.max(yPos - 2, PAD.top + 8), 'text-anchor': 'middle', 'font-size': 7, fill: 'var(--gold)', opacity: 0.85 });
      yValLbl.textContent = val >= 100000 ? '$' + (val / 100000).toFixed(0) + 'k' : '$' + (val / 100).toFixed(0);
      svg.appendChild(yValLbl);
      var label = svgEl('text', { x: x + barW / 2, y: PAD.top + chartH + 14, 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--text-light)', opacity: 0.6 });
      label.textContent = String(y);
      svg.appendChild(label);
    });
    container.appendChild(svg);
    return;
  }

  var months = monthsWithData.slice(0, _chartPeriod === 'all' ? undefined : _chartPeriod).reverse();
  if (months.length === 0) return;
  var W = 280, H = 120, PAD = { top: 20, right: 4, bottom: 32, left: 4 };
  var chartW = W - PAD.left - PAD.right;
  var chartH = H - PAD.top - PAD.bottom;
  var values = months.map(function(m) { return m.expenses.reduce(function(s, e) { return s + e.val; }, 0); });
  var maxVal = Math.max.apply(null, values.concat([1]));
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '100%' });
  var slotW = Math.floor(chartW / months.length);
  var barW = Math.max(Math.floor(slotW * 0.45), 2);
  var barWFull = slotW - 2; // keep for x-centering
  var spansMultipleYears = months.length > 0 && months[0].year !== months[months.length - 1].year;
  months.forEach(function(m, i) {
    var val = values[i];
    var barH = Math.max(Math.round((val / maxVal) * chartH), 2);
    var x = PAD.left + i * slotW + Math.floor((slotW - barW) / 2);
    var y = PAD.top + chartH - barH;
    svg.appendChild(svgEl('rect', { x: x, y: y, width: barW, height: barH, fill: 'var(--gold)', rx: 2, opacity: 0.85 }));
    var valLbl = svgEl('text', { x: x + barW / 2, y: Math.max(y - 2, PAD.top + 8), 'text-anchor': 'middle', 'font-size': 7, fill: 'var(--gold)', opacity: 0.85 });
    valLbl.textContent = val >= 100000 ? '$' + (val / 100000).toFixed(0) + 'k' : '$' + (val / 100).toFixed(0);
    svg.appendChild(valLbl);
    var label = svgEl('text', { x: PAD.left + i * slotW + slotW / 2, y: PAD.top + chartH + 12, 'text-anchor': 'middle', 'font-size': 8, fill: 'var(--text-light)', opacity: 0.6 });
    label.textContent = MONTH_NAMES[m.month].slice(0, 3);
    svg.appendChild(label);
    if (spansMultipleYears) {
      var yearLabel = svgEl('text', { x: x + barW / 2, y: PAD.top + chartH + 21, 'text-anchor': 'middle', 'font-size': 7, fill: 'var(--text-light)', opacity: 0.4 });
      yearLabel.textContent = "'" + String(m.year).slice(-2);
      svg.appendChild(yearLabel);
    }
  });
  container.appendChild(svg);
}

function _renderVsBudgetChart(container) {
  container.innerHTML = '';
  var months = state.months.slice().filter(function(m) { return m.budget !== null && m.budget > 0; }).slice(0, _chartPeriod === 'all' ? undefined : _chartPeriod).reverse();
  if (months.length === 0) return;
  var W = 280, H = 120, PAD = { top: 20, right: 4, bottom: 32, left: 4 };
  var chartW = W - PAD.left - PAD.right;
  var chartH = H - PAD.top - PAD.bottom;
  var spentVals  = months.map(function(m) { return m.expenses.reduce(function(s, e) { return s + e.val; }, 0); });
  var budgetVals = months.map(function(m) { return m.budget; });
  var maxVal = Math.max.apply(null, spentVals.concat(budgetVals).concat([1]));
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '100%' });
  var groupW = Math.floor(chartW / months.length);
  var barW   = Math.floor(groupW * 0.3);
  var spansMultipleYears = months.length > 0 && months[0].year !== months[months.length - 1].year;
  months.forEach(function(m, i) {
    var spent  = spentVals[i];
    var budget = budgetVals[i];
    var gx = PAD.left + i * groupW;
    var budgetH = Math.max(Math.round((budget / maxVal) * chartH), 2);
    svg.appendChild(svgEl('rect', { x: gx + 1, y: PAD.top + chartH - budgetH, width: barW, height: budgetH, fill: 'var(--gold)', opacity: 0.25, rx: 2 }));
    var bdgLbl = svgEl('text', { x: gx + 1 + barW / 2, y: Math.max(PAD.top + chartH - budgetH - 2, PAD.top + 8), 'text-anchor': 'middle', 'font-size': 7, fill: 'var(--gold)', opacity: 0.6 });
    bdgLbl.textContent = budget >= 100000 ? '$' + (budget / 100000).toFixed(0) + 'k' : '$' + (budget / 100).toFixed(0);
    svg.appendChild(bdgLbl);
    var spentH = Math.max(Math.round((spent / maxVal) * chartH), 2);
    svg.appendChild(svgEl('rect', { x: gx + 1 + barW + 2, y: PAD.top + chartH - spentH, width: barW, height: spentH, fill: spent > budget ? 'var(--danger)' : 'var(--success)', opacity: 0.85, rx: 2 }));
    var spLbl = svgEl('text', { x: gx + 1 + barW + 2 + barW / 2, y: Math.max(PAD.top + chartH - spentH - 2, PAD.top + 8), 'text-anchor': 'middle', 'font-size': 7, fill: spent > budget ? 'var(--danger)' : 'var(--success)', opacity: 0.85 });
    spLbl.textContent = spent >= 100000 ? '$' + (spent / 100000).toFixed(0) + 'k' : '$' + (spent / 100).toFixed(0);
    svg.appendChild(spLbl);
    var label = svgEl('text', { x: gx + groupW / 2, y: PAD.top + chartH + 12, 'text-anchor': 'middle', 'font-size': 8, fill: 'var(--text-light)', opacity: 0.6 });
    label.textContent = MONTH_NAMES[m.month].slice(0, 3);
    svg.appendChild(label);
    if (spansMultipleYears) {
      var yearLabel = svgEl('text', { x: gx + groupW / 2, y: PAD.top + chartH + 21, 'text-anchor': 'middle', 'font-size': 7, fill: 'var(--text-light)', opacity: 0.4 });
      yearLabel.textContent = "'" + String(m.year).slice(-2);
      svg.appendChild(yearLabel);
    }
  });
  container.appendChild(svg);
}

function _hasUncategorizedSpending() {
  return state.months.some(function(m) {
    return m.expenses.some(function(e) { return !e.categoryId; });
  });
}

function _renderCategoryChart(container) {
  container.innerHTML = '';
  if (state.categories.length === 0 && !_hasUncategorizedSpending()) return;
  var totals = new Map();
  state.categories.forEach(function(c) { totals.set(c.id, 0); });
  var uncategorized = 0;
  state.months.forEach(function(m) {
    m.expenses.forEach(function(e) {
      if (e.categoryId && totals.has(e.categoryId)) {
        totals.set(e.categoryId, totals.get(e.categoryId) + e.val);
      } else {
        uncategorized += e.val;
      }
    });
  });
  var rows = state.categories
    .map(function(c) { return { name: c.name, total: totals.get(c.id) || 0 }; })
    .filter(function(r) { return r.total > 0; })
    .sort(function(a, b) { return b.total - a.total; });
  var totalCategoryCount = rows.length + (uncategorized > 0 ? 1 : 0);
  if (uncategorized > 0) {
    rows = rows.slice(0, 7);
    rows.push({ name: 'Uncategorized', total: uncategorized, isUncategorized: true });
    rows.sort(function(a, b) { return b.total - a.total; });
  } else {
    rows = rows.slice(0, 8);
  }
  if (rows.length === 0) return;
  var ROW_H = 18;
  var LABEL_W = 70;
  var BAR_MAX_W = 140;
  var W = LABEL_W + BAR_MAX_W + 60;
  var H = rows.length * ROW_H + 4;
  var maxVal = rows[0].total;
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '100%' });
  rows.forEach(function(row, i) {
    var y = i * ROW_H + 2;
    var barW = Math.max(Math.round((row.total / maxVal) * BAR_MAX_W), 2);
    var labelEl = svgEl('text', { x: LABEL_W - 4, y: y + ROW_H * 0.65, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--text-light)', opacity: row.isUncategorized ? 0.5 : 0.75 });
    labelEl.textContent = row.name.length > 11 ? row.name.slice(0, 10) + '…' : row.name;
    svg.appendChild(labelEl);
    svg.appendChild(svgEl('rect', { x: LABEL_W, y: y + 3, width: barW, height: ROW_H - 6, fill: row.isUncategorized ? '#666' : 'var(--gold)', opacity: row.isUncategorized ? 0.5 : 0.75, rx: 2 }));
    var valEl = svgEl('text', { x: LABEL_W + barW + 4, y: y + ROW_H * 0.65, 'font-size': 9, fill: 'var(--text-light)', opacity: 0.6 });
    valEl.textContent = fmt(row.total);
    svg.appendChild(valEl);
  });
  container.appendChild(svg);
  return totalCategoryCount;
}

export function renderCharts() {
  var section = document.getElementById('charts-section');
  if (!section) return;
  var c1 = document.getElementById('chart-spending');
  var c2 = document.getElementById('chart-vs-budget');
  var c3 = document.getElementById('chart-by-category');
  if (c1) _renderSpendingChart(c1);
  if (c2) _renderVsBudgetChart(c2);
  var categoryCount = c3 ? _renderCategoryChart(c3) : 0;
  var categoryTitleEl = document.getElementById('chart-title-category');
  if (categoryTitleEl) {
    categoryTitleEl.textContent = categoryCount > 8 ? 'By Category (top 8)' : 'By Category';
  }
  var hasContent = (c1 && c1.children.length > 0) || (c2 && c2.children.length > 0) || (c3 && c3.children.length > 0);
  section.classList.toggle('hidden', !hasContent);
}

export function renderHistory() {
  var monthList = document.getElementById('month-list');
  var currentObj = getCurrentMonthObj();
  monthList.innerHTML = '';
  if (state.months.length === 0) {
    monthList.innerHTML = '<div class="empty-history">No months recorded yet. Create your first month below.</div>';
    return;
  }

  var byYear = new Map();
  state.months.forEach(function(m) {
    if (!byYear.has(m.year)) byYear.set(m.year, []);
    byYear.get(m.year).push(m);
  });

  var isFirst = true;
  byYear.forEach(function(monthsInYear, year) {
    var group = document.createElement('details');
    group.className = 'history-year-group';
    if (isFirst) group.open = true;
    isFirst = false;

    var heading = document.createElement('summary');
    heading.className = 'history-year-heading';
    heading.textContent = year;
    group.appendChild(heading);

    var yearList = document.createElement('div');
    yearList.className = 'history-year-list';

    monthsInYear.forEach(function(m) {
      var isCurrent = currentObj && m.id === currentObj.id;
      var totalSpent = m.expenses.reduce(function(s, e) { return s + e.val; }, 0);
      var hasBudget = m.budget !== null;
      var metaText = hasBudget
        ? 'Budget: ' + fmt(m.budget) + ' • Spent: ' + fmt(totalSpent)
        : 'Budget not set yet';

      var card = document.createElement('div');
      card.className = 'month-card' + (isCurrent ? ' month-card--current' : '');

      var clickable = document.createElement('div');
      clickable.className = 'month-card-clickable month-card-info';
      clickable.dataset.id = m.id;
      clickable.addEventListener('click', function() { openMonth(m.id); });

      var nameDiv = document.createElement('div');
      nameDiv.className = 'month-card-name';
      nameDiv.textContent = m.name;

      var metaDiv = document.createElement('div');
      metaDiv.className = 'month-card-meta' + (hasBudget ? '' : ' needs-setup');
      metaDiv.textContent = metaText;

      clickable.appendChild(nameDiv);
      clickable.appendChild(metaDiv);

      if (hasBudget && m.budget > 0) {
        var pct = Math.min((totalSpent / m.budget) * 100, 100);
        var colorClass = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
        var barWrap = document.createElement('div');
        barWrap.className = 'history-bar-wrap';
        barWrap.setAttribute('role', 'img');
        barWrap.setAttribute('aria-label', Math.round(pct) + '% of budget used' + (pct >= 100 ? ', over budget' : ''));
        var bar = document.createElement('div');
        bar.className = 'history-bar-fill' + (colorClass ? ' ' + colorClass : '');
        bar.style.width = pct.toFixed(1) + '%';
        barWrap.appendChild(bar);
        clickable.appendChild(barWrap);
      }

      var rightDiv = document.createElement('div');
      rightDiv.className = 'month-card-right';

      if (isCurrent) {
        var badge = document.createElement('span');
        badge.className = 'badge-current';
        badge.textContent = 'Current';
        rightDiv.appendChild(badge);
      }

      var btn = document.createElement('button');
      btn.className = 'btn-danger btn-delete-month';
      btn.textContent = 'Delete';
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        openDeleteMonthModal(m.id, btn);
      });
      rightDiv.appendChild(btn);

      card.appendChild(clickable);
      card.appendChild(rightDiv);
      yearList.appendChild(card);
    });

    group.appendChild(yearList);
    monthList.appendChild(group);
  });
}

// -- MONTH VIEW
var monthViewTitle = document.getElementById('month-view-title');
var budgetSetupBox = document.getElementById('budget-setup-box');
var statsSection = document.getElementById('stats-section');
var addExpenseSection = document.getElementById('add-expense-section');
var expDateInput = document.getElementById('exp-date');
var displayBudget = document.getElementById('display-budget');
var displaySpent = document.getElementById('display-spent');
var displayRemaining = document.getElementById('display-remaining');
var tableBody = document.getElementById('expense-table-body');
var statsSecondary = document.getElementById('stats-secondary');
var displayPurchaseCount = document.getElementById('display-purchase-count');
var displayAvgPurchase = document.getElementById('display-avg-purchase');
var displayMaxPurchase = document.getElementById('display-max-purchase');

export function openMonth(id) {
  setActiveMonthId(id);
  var m = getActiveMonth();
  if (!m) return;
  monthViewTitle.textContent = m.name;

  // Always start from a clean form — clear anything left over from a
  // previous invalid submit, whether on this month or a different one.
  var descEl = document.getElementById('desc');
  var valEl = document.getElementById('val');
  if (descEl) { descEl.value = ''; clearFieldError(descEl, 'err-exp-desc'); }
  if (valEl) { valEl.value = ''; clearFieldError(valEl, 'err-exp-val'); }
  clearFieldError(expDateInput, 'err-exp-date');

  if (m.budget === null) {
    budgetSetupBox.classList.remove('hidden');
    statsSection.classList.add('hidden');
    addExpenseSection.classList.add('hidden');
    if (statsSecondary) statsSecondary.classList.add('hidden');
    document.getElementById('budget-input').value = '';
  } else {
    budgetSetupBox.classList.add('hidden');
    statsSection.classList.remove('hidden');
    addExpenseSection.classList.remove('hidden');
    var lastDay = new Date(m.year, m.month + 1, 0).getDate();
    var mm = String(m.month + 1).padStart(2, '0');
    var minDate = m.year + '-' + mm + '-01';
    var maxDate = m.year + '-' + mm + '-' + String(lastDay).padStart(2, '0');
    expDateInput.min = minDate;
    expDateInput.max = maxDate;
    var todayIso = getLocalISODate();
    // Default to today only if today actually falls within this month;
    // otherwise default to the 1st, so the field never opens pre-invalid.
    expDateInput.value = (todayIso >= minDate && todayIso <= maxDate) ? todayIso : minDate;
    renderStats(m);
    renderExpenses(m);
  }
  showScreen('month');
  if (_postOpenMonthCb) _postOpenMonthCb();
}

export function renderStats(m) {
  var spent = m.expenses.reduce(function(s, e) { return s + e.val; }, 0);
  var remaining = m.budget - spent;
  displayBudget.textContent = fmt(m.budget);
  displaySpent.textContent = fmt(spent);
  // Update hero remaining element
  var remainingEl = document.getElementById('display-remaining');
  if (remainingEl) {
    remainingEl.textContent = remaining < 0 ? '-' + fmt(Math.abs(remaining)) : fmt(remaining);
    remainingEl.classList.toggle('over-budget', remaining < 0);
  }
  var progressWrap = document.getElementById('budget-progress-wrap');
  var barFill = document.getElementById('budget-bar-fill');
  if (progressWrap && barFill && m.budget !== null) {
    if (m.budget === 0) {
      barFill.style.width = spent === 0 ? '0%' : '100%';
      barFill.className = 'budget-bar-fill' + (spent > 0 ? ' over' : '');
    } else {
      var rawPct = (spent / m.budget) * 100;
      var clampPct = Math.min(rawPct, 100);
      var colorClass = rawPct >= 100 ? 'over' : rawPct >= 80 ? 'warn' : '';
      barFill.style.width = clampPct + '%';
      barFill.className = 'budget-bar-fill' + (colorClass ? ' ' + colorClass : '');
    }
    progressWrap.classList.remove('hidden');
  } else if (progressWrap) {
    progressWrap.classList.add('hidden');
  }
  if (statsSecondary) {
    var count = m.expenses.length;
    if (count === 0) {
      statsSecondary.classList.add('hidden');
    } else {
      var avg = Math.round(m.expenses.reduce(function(s, e) { return s + e.val; }, 0) / count);
      var max = Math.max.apply(null, m.expenses.map(function(e) { return e.val; }));
      displayPurchaseCount.textContent = count;
      displayAvgPurchase.textContent = fmt(avg);
      displayMaxPurchase.textContent = fmt(max);
      statsSecondary.classList.remove('hidden');
    }
  }
}

function formatExpenseDate(isoDate) {
  if (!isoDate) return '';
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(isoDate)) {
    var parts = isoDate.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-US');
  }
  return isoDate;
}

var _deleteExpenseCb = null;
export function registerDeleteExpenseCb(fn) { _deleteExpenseCb = fn; }
var _openEditExpenseCb = null;
export function registerOpenEditExpenseCb(fn) { _openEditExpenseCb = fn; }
var _postOpenMonthCb = null;
export function registerPostOpenMonthCb(fn) { _postOpenMonthCb = fn; }

export function renderExpenses(m) {
  m.expenses.sort(function(a, b) {
    return a.date !== b.date ? (a.date < b.date ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1);
  });
  if (window.innerWidth <= 480) { _renderExpenseCards(m); } else { _renderExpenseTable(m); }
}

function _renderExpenseTable(m) {
  var existingCards = document.getElementById('expense-card-list');
  if (existingCards) existingCards.remove();
  var table = tableBody.closest('table');
  if (table) table.style.display = '';
  tableBody.innerHTML = '';
  if (m.expenses.length === 0) {
    tableBody.innerHTML = '<tr class="expense-row"><td colspan="5" style="text-align:center;color:#555;">No expenses recorded yet.</td></tr>';
    return;
  }
  m.expenses.forEach(function(exp) {
    var tr = document.createElement('tr');
    tr.className = 'expense-row';
    var tdDate = document.createElement('td');
    tdDate.textContent = formatExpenseDate(exp.date);
    var tdDesc = document.createElement('td');
    tdDesc.textContent = exp.desc;
    var catTd = document.createElement('td');
    catTd.className = 'category-col';
    var cat = state.categories.find(function(c) { return c.id === exp.categoryId; });
    catTd.textContent = cat ? cat.name : '\u2014';
    var tdVal = document.createElement('td');
    tdVal.className = 'value-col';
    tdVal.textContent = fmt(exp.val);
    var tdAction = document.createElement('td');
    tdAction.className = 'action-col action-col--wide';
    var btnEdit = document.createElement('button');
    btnEdit.className = 'btn-edit-expense';
    btnEdit.title = 'Edit expense';
    btnEdit.setAttribute('aria-label', 'Edit expense');
    btnEdit.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">edit</span>';
    btnEdit.addEventListener('click', function() { openEditExpenseModal(exp.id, btnEdit); });
    var btnDel = document.createElement('button');
    btnDel.className = 'btn-danger btn-del-expense';
    btnDel.textContent = 'Del';
    btnDel.setAttribute('aria-label', 'Delete expense');
    btnDel.addEventListener('click', function() { if (_deleteExpenseCb) _deleteExpenseCb(exp.id); });
    tdAction.appendChild(btnEdit);
    tdAction.appendChild(btnDel);
    tr.appendChild(tdDate); tr.appendChild(tdDesc); tr.appendChild(catTd);
    tr.appendChild(tdVal); tr.appendChild(tdAction);
    tableBody.appendChild(tr);
  });
}

function _renderExpenseCards(m) {
  var table = tableBody.closest('table');
  if (table) table.style.display = 'none';
  tableBody.innerHTML = '';
  var cardList = document.getElementById('expense-card-list');
  if (!cardList) {
    cardList = document.createElement('div');
    cardList.id = 'expense-card-list';
    cardList.className = 'expense-card-list';
    if (table && table.parentNode) table.parentNode.insertBefore(cardList, table);
  }
  cardList.innerHTML = '';
  if (m.expenses.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'expense-card-empty';
    empty.textContent = 'No expenses recorded yet.';
    cardList.appendChild(empty);
    return;
  }
  m.expenses.forEach(function(exp) {
    var card = document.createElement('div');
    card.className = 'expense-card';
    var descEl = document.createElement('div');
    descEl.className = 'expense-card-desc';
    descEl.textContent = exp.desc;
    var cat = state.categories.find(function(c) { return c.id === exp.categoryId; });
    if (cat) {
      var catLabel = document.createElement('span');
      catLabel.className = 'expense-card-category';
      catLabel.textContent = cat.name;
      card.appendChild(descEl);
      card.appendChild(catLabel);
    } else {
      card.appendChild(descEl);
    }
    var row = document.createElement('div');
    row.className = 'expense-card-row';
    var dateEl = document.createElement('span');
    dateEl.className = 'expense-card-date';
    dateEl.textContent = formatExpenseDate(exp.date);
    var valEl = document.createElement('span');
    valEl.className = 'expense-card-val';
    valEl.textContent = fmt(exp.val);
    var actionsEl = document.createElement('div');
    actionsEl.className = 'expense-card-actions';
    var btnEdit = document.createElement('button');
    btnEdit.className = 'btn-edit-expense';
    btnEdit.title = 'Edit expense';
    btnEdit.setAttribute('aria-label', 'Edit expense');
    btnEdit.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">edit</span>';
    btnEdit.addEventListener('click', function() { openEditExpenseModal(exp.id, btnEdit); });
    var btnDel = document.createElement('button');
    btnDel.className = 'btn-danger btn-del-expense';
    btnDel.textContent = 'Del';
    btnDel.setAttribute('aria-label', 'Delete expense');
    btnDel.addEventListener('click', function() { if (_deleteExpenseCb) _deleteExpenseCb(exp.id); });
    actionsEl.appendChild(btnEdit);
    actionsEl.appendChild(btnDel);
    row.appendChild(dateEl); row.appendChild(valEl); row.appendChild(actionsEl);
    card.appendChild(row);
    cardList.appendChild(card);
  });
}

// -- UNDO TOAST
export function showUndoToast(message) {
  var toast = document.getElementById('undo-toast');
  if (!toast) return;
  document.getElementById('undo-toast-msg').textContent = message;
  toast.classList.remove('hidden');
}

export function hideUndoToast() {
  var toast = document.getElementById('undo-toast');
  if (toast) toast.classList.add('hidden');
}

// -- FOCUS TRAP HELPERS
var _lastFocusedTrigger = null;

function trapFocus(overlayEl) {
  var focusable = overlayEl.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  function handleKeydown(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }
  overlayEl.addEventListener('keydown', handleKeydown);
  overlayEl._focusTrapHandler = handleKeydown;
}

function releaseFocusTrap(overlayEl) {
  if (overlayEl._focusTrapHandler) {
    overlayEl.removeEventListener('keydown', overlayEl._focusTrapHandler);
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
var _editingExpenseId = null;

export function openEditExpenseModal(expId, triggerEl) {
  var m = getActiveMonth();
  if (!m) return;
  var exp = m.expenses.find(function(e) { return e.id === expId; });
  if (!exp) return;
  _editingExpenseId = expId;
  _lastFocusedTrigger = triggerEl || null;
  var descEl = document.getElementById('edit-exp-desc');
  var valEl = document.getElementById('edit-exp-val');
  var dateEl = document.getElementById('edit-exp-date');
  descEl.value = exp.desc;
  valEl.value = (exp.val / 100).toFixed(2);
  dateEl.value = exp.date || '';
  var lastDay = new Date(m.year, m.month + 1, 0).getDate();
  var mm = String(m.month + 1).padStart(2, '0');
  dateEl.min = m.year + '-' + mm + '-01';
  dateEl.max = m.year + '-' + mm + '-' + String(lastDay).padStart(2, '0');
  [descEl, valEl, dateEl].forEach(function(el) { el.classList.remove('is-invalid'); });
  ['err-edit-exp-desc', 'err-edit-exp-val', 'err-edit-exp-date'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  if (_openEditExpenseCb) _openEditExpenseCb(expId);
  var eeOverlay = document.getElementById('edit-expense-overlay');
  eeOverlay.classList.remove('hidden');
  trapFocus(eeOverlay);
  descEl.focus();
}

export function closeEditExpenseModal() {
  _editingExpenseId = null;
  var eeOverlay = document.getElementById('edit-expense-overlay');
  releaseFocusTrap(eeOverlay);
  eeOverlay.classList.add('hidden');
  returnFocusToTrigger();
}

export function getEditingExpenseId() { return _editingExpenseId; }

// -- DELETE MONTH MODAL
var _pendingDeleteMonthId = null;

export function openDeleteMonthModal(id, triggerEl) {
  var m = state.months.find(function(x) { return x.id === id; });
  if (!m) return;
  _pendingDeleteMonthId = id;
  _lastFocusedTrigger = triggerEl || null;
  var totalSpent = m.expenses.reduce(function(s, e) { return s + e.val; }, 0);
  var expCount = m.expenses.length;
  document.getElementById('delete-month-name').textContent = 'Delete ' + m.name + '?';
  document.getElementById('delete-month-stats').textContent =
    expCount + ' expense' + (expCount !== 1 ? 's' : '') + ' \u00B7 ' + fmt(totalSpent) + ' spent';
  var dmOverlay = document.getElementById('delete-month-overlay');
  dmOverlay.classList.remove('hidden');
  trapFocus(dmOverlay);
  var cancelBtn = document.getElementById('btn-delete-month-cancel');
  if (cancelBtn) cancelBtn.focus();
}

export function closeDeleteMonthModal() {
  _pendingDeleteMonthId = null;
  var dmOverlay = document.getElementById('delete-month-overlay');
  releaseFocusTrap(dmOverlay);
  dmOverlay.classList.add('hidden');
  returnFocusToTrigger();
}

export function getPendingDeleteMonthId() { return _pendingDeleteMonthId; }

// -- MONTH PICKER MODAL
export function openMonthPicker(event) {
  var now = new Date();
  document.getElementById('pick-month').value = now.getMonth();
  document.getElementById('pick-year').value = now.getFullYear();
  _lastFocusedTrigger = (event && event.currentTarget) || null;
  var mpOverlay = document.getElementById('month-picker-overlay');
  mpOverlay.classList.remove('hidden');
  trapFocus(mpOverlay);
  var pickMonth = document.getElementById('pick-month');
  if (pickMonth) pickMonth.focus();
}

export function closeMonthPicker() {
  var mpOverlay = document.getElementById('month-picker-overlay');
  releaseFocusTrap(mpOverlay);
  mpOverlay.classList.add('hidden');
  returnFocusToTrigger();
}

// -- PROFILE MODAL
export var profileOverlay = document.getElementById('profile-overlay');

export async function openProfileModal(event) {
  try {
    var authData = (await supabase.auth.getUser()).data;
    var user = authData && authData.user;
    if (user) {
      var profileResult = await supabase.from('profiles').select('display_name').eq('id', user.id).single();
      if (profileResult.data && profileResult.data.display_name)
        cacheDisplayName(profileResult.data.display_name);
    }
  } catch (_) {}
  document.getElementById('display-name-input').value = getDisplayName();
  document.getElementById('current-pass-input').value = '';
  document.getElementById('new-pass-input').value = '';
  document.getElementById('confirm-pass-input').value = '';
  document.getElementById('theme-select').value = getPreferredTheme();
  var currencySelectEl = document.getElementById('currency-select');
  if (currencySelectEl) currencySelectEl.value = state.currency || 'USD';
  _lastFocusedTrigger = (event && event.currentTarget) || null;
  profileOverlay.classList.remove('hidden');
  trapFocus(profileOverlay);
  var nameInput = document.getElementById('display-name-input');
  if (nameInput) nameInput.focus();
}

export function closeProfileModal() {
  releaseFocusTrap(profileOverlay);
  profileOverlay.classList.add('hidden');
  returnFocusToTrigger();
}

// -- SYNC STATUS INDICATOR
export function setSyncStatus(status) {
  document.querySelectorAll('.save-status').forEach(function(el) {
    el.classList.remove('visible', 'saving', 'error');
    if (status === 'syncing') {
      el.textContent = 'Syncing\u2026';
      el.classList.add('visible', 'saving');
    } else if (status === 'stale') {
      el.textContent = 'Showing saved data \u2014 could not refresh';
      el.classList.add('visible', 'error');
    } else {
      el.textContent = '';
    }
  });
}

// -- ACHIEVEMENTS (E4)

// Returns true only for months that have already ended (strictly before the
// current calendar month). Current and future months are excluded so that
// budget-related achievements cannot be triggered prematurely.
function _isPastMonth(m) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth(); // 0-based
  return m.year < curYear || (m.year === curYear && m.month < curMonth);
}

const ACHIEVEMENTS = [
  {
    id: "first_blood",
    title: "First Purchase",
    desc: "Record your first expense.",
    tier: "Bronze",
    sticker: "5.png",
    earned: (s) => s.months.some((m) => m.expenses.length > 0),
  },
  {
    id: "ten_purchases",
    title: "Habitual Spender",
    desc: "Record 10 expenses total.",
    tier: "Silver",
    sticker: "10.png",
    earned: (s) => s.months.reduce((t, m) => t + m.expenses.length, 0) >= 10,
  },
  {
    id: "fifty_purchases",
    title: "Dedicated Fan",
    desc: "Record 50 expenses total.",
    tier: "Gold",
    sticker: "15.png",
    earned: (s) => s.months.reduce((t, m) => t + m.expenses.length, 0) >= 50,
  },
  {
    id: "hundred_purchases",
    title: "True Believer",
    desc: "Record 100 expenses total.",
    tier: "Legendary",
    sticker: "1.gif",
    earned: (s) => s.months.reduce((t, m) => t + m.expenses.length, 0) >= 100,
  },
  {
    id: "under_budget",
    title: "Disciplined",
    desc: "Finish a month under budget.",
    tier: "Bronze",
    sticker: "25.png",
    earned: (s) => s.months.some((m) => {
      if (!_isPastMonth(m)) return false;
      if (m.budget === null || m.budget <= 0) return false;
      const spent = m.expenses.reduce((t, e) => t + e.val, 0);
      return spent <= m.budget;
    }),
  },
  {
    id: "three_under_budget",
    title: "Budget Master",
    desc: "Finish 3 months under budget.",
    tier: "Silver",
    sticker: "30.png",
    earned: (s) => s.months.filter((m) => {
      if (!_isPastMonth(m)) return false;
      if (m.budget === null || m.budget <= 0) return false;
      const spent = m.expenses.reduce((t, e) => t + e.val, 0);
      return spent <= m.budget;
    }).length >= 3,
  },
  {
    id: "six_under_budget",
    title: "Iron Will",
    desc: "Finish 6 months under budget.",
    tier: "Gold",
    sticker: "35.png",
    earned: (s) => s.months.filter((m) => {
      if (!_isPastMonth(m)) return false;
      if (m.budget === null || m.budget <= 0) return false;
      const spent = m.expenses.reduce((t, e) => t + e.val, 0);
      return spent <= m.budget;
    }).length >= 6,
  },
  {
    id: "twelve_under_budget",
    title: "Unbreakable",
    desc: "Finish 12 months under budget.",
    tier: "Legendary",
    sticker: "2.gif",
    earned: (s) => s.months.filter((m) => {
      if (!_isPastMonth(m)) return false;
      if (m.budget === null || m.budget <= 0) return false;
      const spent = m.expenses.reduce((t, e) => t + e.val, 0);
      return spent <= m.budget;
    }).length >= 12,
  },
  {
    id: "zero_spend_month",
    title: "Zero Spend",
    desc: "A month with a budget set but no expenses.",
    tier: "Gold",
    sticker: "40.png",
    earned: (s) => s.months.some((m) => _isPastMonth(m) && m.budget !== null && m.budget > 0 && m.expenses.length === 0),
  },
  {
    id: "six_zero_spend",
    title: "Ghost Mode",
    desc: "Have 6 months with a budget set but no expenses.",
    tier: "Legendary",
    sticker: "3.gif",
    earned: (s) => s.months.filter((m) => _isPastMonth(m) && m.budget !== null && m.budget > 0 && m.expenses.length === 0).length >= 6,
  },
  {
    id: "small_spender",
    title: "Small Spender",
    desc: () => "A single expense of " + fmt(1000) + " or more.",
    tier: "Bronze",
    sticker: "50.png",
    earned: (s) => s.months.some((m) => m.expenses.some((e) => e.val >= 1000)),
  },
  {
    id: "mid_spender",
    title: "Mid Spender",
    desc: () => "A single expense of " + fmt(2500) + " or more.",
    tier: "Silver",
    sticker: "55.png",
    earned: (s) => s.months.some((m) => m.expenses.some((e) => e.val >= 2500)),
  },
  {
    id: "big_spender",
    title: "Big Spender",
    desc: () => "A single expense of " + fmt(5000) + " or more.",
    tier: "Gold",
    sticker: "60.png",
    earned: (s) => s.months.some((m) => m.expenses.some((e) => e.val >= 5000)),
  },
  {
    id: "whale",
    title: "Whale",
    desc: () => "A single expense of " + fmt(10000) + " or more.",
    tier: "Legendary",
    sticker: "4.gif",
    earned: (s) => s.months.some((m) => m.expenses.some((e) => e.val >= 10000)),
  },
];

function _buildAchievementCard(a, isEarned) {
  const card = document.createElement("div");
  card.className = "achievement-card" + (isEarned ? " earned" : " locked");

  const img = document.createElement("img");
  img.src = "images/achievement-icons/" + a.sticker;
  img.alt = a.title;
  img.className = "achievement-sticker";
  img.loading = "lazy";
  card.appendChild(img);

  const info = document.createElement("div");
  info.className = "achievement-info";

  const titleEl = document.createElement("div");
  titleEl.className = "achievement-title";
  titleEl.textContent = a.title;

  const tierEl = document.createElement("span");
  tierEl.className = "achievement-tier achievement-tier--" + a.tier.toLowerCase();
  tierEl.textContent = a.tier;

  const descEl = document.createElement("div");
  descEl.className = "achievement-desc";
  descEl.textContent = typeof a.desc === "function" ? a.desc() : a.desc;

  info.appendChild(titleEl);
  info.appendChild(tierEl);
  info.appendChild(descEl);
  card.appendChild(info);

  return card;
}

export function renderAchievements() {
  const list = document.getElementById("achievement-list");
  if (!list) return;
  list.innerHTML = "";

  const earned = ACHIEVEMENTS.filter((a) => a.earned(state));
  const unearned = ACHIEVEMENTS.filter((a) => !a.earned(state));

  if (earned.length > 0) {
    const label = document.createElement("div");
    label.className = "achievement-section-label";
    label.textContent = "Earned";
    list.appendChild(label);
    earned.forEach((a) => list.appendChild(_buildAchievementCard(a, true)));
  }

  if (unearned.length > 0) {
    const label = document.createElement("div");
    label.className = "achievement-section-label";
    label.textContent = "Locked";
    list.appendChild(label);
    unearned.forEach((a) => list.appendChild(_buildAchievementCard(a, false)));
  }
}

export function openAchievementScreen() {
  renderAchievements();
  showScreen("achievement");
}

export function closeAchievementScreen() {
  showScreen("stats");
}

export function openManageScreen() {
  showScreen("manage");
}

export function getAchievementCounts() {
  return {
    earned: ACHIEVEMENTS.filter((a) => a.earned(state)).length,
    total: ACHIEVEMENTS.length,
  };
}

// -- STATISTICS SCREEN

var _openAchievementScreenCb = null;
export function registerOpenAchievementScreenCb(fn) { _openAchievementScreenCb = fn; }

function _renderAchievementsSection() {
  var wrap = document.getElementById("achievements-section");
  if (!wrap) return;
  wrap.innerHTML = "";

  var counts = getAchievementCounts();
  var earned = ACHIEVEMENTS.filter(function(a) { return a.earned(state); });

  var section = document.createElement("div");
  section.className = "ach-section";

  // Header row
  var header = document.createElement("div");
  header.className = "ach-section-header";

  var titleEl = document.createElement("div");
  titleEl.className = "ach-section-title";
  titleEl.textContent = "🏆 Achievements";

  var countEl = document.createElement("div");
  countEl.className = "ach-section-count";
  countEl.textContent = counts.earned + " / " + counts.total;

  header.appendChild(titleEl);
  header.appendChild(countEl);
  section.appendChild(header);

  // Progress bar
  var progressWrap = document.createElement("div");
  progressWrap.className = "ach-progress-wrap";
  var progressBar = document.createElement("div");
  progressBar.className = "ach-progress-bar";
  var pct = counts.total > 0 ? (counts.earned / counts.total) * 100 : 0;
  progressBar.style.width = pct.toFixed(1) + "%";
  progressWrap.appendChild(progressBar);
  section.appendChild(progressWrap);

  // Recent earned badges (up to 6)
  if (earned.length > 0) {
    var recentLabel = document.createElement("div");
    recentLabel.className = "ach-recent-label";
    recentLabel.textContent = "Recently Earned";
    section.appendChild(recentLabel);

    var badges = document.createElement("div");
    badges.className = "ach-badges-row";
    var recent = earned.slice(-6).reverse();
    recent.forEach(function(a) {
      var img = document.createElement("img");
      img.src = "images/achievement-icons/" + a.sticker;
      img.alt = a.title;
      img.title = a.title;
      img.className = "ach-badge-thumb";
      img.loading = "lazy";
      badges.appendChild(img);
    });
    section.appendChild(badges);
  }

  // View All button
  var viewBtn = document.createElement("button");
  viewBtn.type = "button";
  viewBtn.className = "btn-secondary ach-view-all-btn";
  viewBtn.textContent = earned.length === 0 ? "View Achievements" : "View All Achievements";
  viewBtn.addEventListener("click", function() {
    if (_openAchievementScreenCb) _openAchievementScreenCb();
  });
  section.appendChild(viewBtn);

  wrap.appendChild(section);
}

export function renderStatsScreen() {
  renderYearSummary();
  renderLifetimeTotal();
  renderCharts();
  _renderAchievementsSection();
}

export function openStatsScreen() {
  renderStatsScreen();
  showScreen("stats");
}

export function closeStatsScreen() {
  showScreen("history");
}

export function openSettingsScreen() {
  showScreen("settings");
}
