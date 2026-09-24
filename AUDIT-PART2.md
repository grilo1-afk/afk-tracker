
# 🔍 Code Audit Report — AFK Tracker (Part 2 of 2)

_Continued from AUDIT.md_

---

### 2.6 `setState()` Allows Partial State Replacement Without Validation

`state.js` lines 6–8:
```js
export function setState(newState) {
  Object.assign(state, newState);
}
```

`setState` is called in multiple places with partial objects — e.g., `setState({ months: filtered, displayName: state.displayName })` in `app.js` line 1293. Because `Object.assign` merges without schema validation, a caller can accidentally drop `categories`, `presets`, `recurring`, or `lifetimeOffset` from the state by passing an incomplete object. In `app.js` line 1294, the delete-month rollback is already at risk: `setState({ months: restored, displayName: state.displayName })` silently discards all other top-level state keys if the caller forgets them. This pattern should be replaced with explicit field-level setters or a validated merge function.

---

## 3. 🔁 Duplication & DRY Issues

### 3.1 Category Add Logic Duplicated (×2)

Two separate event handlers in `app.js` implement the exact same add-category flow:

- **Inline add** (from month view) — `btn-category-new-confirm` handler, lines 647–672
- **Settings add** — `btn-add-category-settings` handler, lines 682–704

Both handlers:
1. Trim the name from the input
2. Check `state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())`
3. Call `dbAddCategory(name)`
4. On success: push `result.data` onto `state.categories`
5. Clear the input value
6. Call `renderCategoryPicker()` + `renderCategorySettingsList()`

The only differences are the element IDs for the input and error span. This should be extracted into a single `addCategory(name, errorElId)` helper.

---

### 3.2 Optimistic-Add + Rollback Pattern Copy-Pasted (×2)

The identical "assign `tmpId`, optimistic push, clear inputs, render, await DB call, on failure splice out `tmpId` and show error, on success replace `tmpId` with real row id, re-render" pattern is duplicated verbatim for:

- **Presets** — `btn-add-preset` handler, `app.js` lines 983–1017
- **Recurring** — `btn-add-recurring` handler, `app.js` lines 756–789

Both use `crypto.randomUUID()` for the temp ID, both have an identical rollback path, and both have identical success reconciliation. This should be a shared `addOptimisticItem(collection, dbFn, ...args)` utility.

---

### 3.3 Optimistic-Delete + Rollback Pattern Copy-Pasted (×2)

The same pattern is repeated for the "Remove" button on preset rows and recurring rows:

- **Preset delete** — inside `renderPresetList()`, `app.js` lines 959–974
- **Recurring delete** — inside `renderRecurringList()`, `app.js` lines 733–748

Both: find the index, save the item, splice it out, render, await the DB delete, and on failure re-splice at the saved index and show a banner. This is also a candidate for a shared `deleteOptimisticItem(collection, id, dbFn, renderFn)` utility.

---

### 3.4 `renderPresetList()` and `renderRecurringList()` Are Near-Identical

`app.js` lines 935–981 (`renderPresetList()`) and lines 708–754 (`renderRecurringList()`) share:
- Same container query pattern (`document.getElementById("preset-list")` / `document.getElementById("recurring-list")`)
- Same empty-state `<div class="preset-empty">` block
- Same row structure: `preset-row` → `preset-row-label` (text) + `preset-row-amount` (fmt) + `btn-danger btn-sm` Remove button with optimistic-delete logic

The only differences are the collection, element IDs, and the extra `renderPresetStrip()` call for presets. A `renderItemList({ listId, items, onDelete, renderExtra })` factory function would serve both.

---

### 3.5 Amount Formatting Duplicated in Charts

Inside `_renderSpendingChart()`, `_renderVsBudgetChart()`, and `_renderCategoryChart()`, the inline label formatting is repeated identically:
```js
val >= 100000 ? '$' + (val / 100000).toFixed(0) + 'k' : '$' + (val / 100).toFixed(0)
```
This string appears 6+ times across the three chart functions in `ui.js`. It should be extracted as a private `_shortFmt(cents)` helper used by all three.

Note: this formatter also hardcodes `'$'` regardless of the user's selected currency, making it incorrect for non-USD users. The fix should use `fmt()` from `state.js` with abbreviated output.

---

### 3.6 "Month Date Range" Calculation Duplicated (×3)

The `minDate` / `maxDate` / `lastDay` calculation pattern:
```js
const lastDay = new Date(m.year, m.month + 1, 0).getDate();
const mm = String(m.month + 1).padStart(2, "0");
const minDate = m.year + "-" + mm + "-01";
const maxDate = m.year + "-" + mm + "-" + String(lastDay).padStart(2, "0");
```
appears three times:
- `app.js` lines 1051–1054 (budget set handler)
- `ui.js` lines 604–607 (inside `openMonth()`)
- `ui.js` lines 862–864 (inside `openEditExpenseModal()`)

This should be a single `getMonthDateRange(m)` helper exported from `state.js`, since `isDateInMonth()` already lives there and uses the same logic.

---

### 3.7 Recurring Modal `classList.add("hidden")` Repeated (×3)

Three separate event listeners on the recurring modal close it identically:
```js
document.getElementById("recurring-modal-overlay").classList.add("hidden");
```
Lines 833, 836, and 839–841 of `app.js`. A `closeRecurringModal()` helper would be cleaner and allow a focus-trap release to be added later.

---

## 4. 🚀 Quick Wins vs. High-Impact Refactoring

### Quick Wins (Low Effort, Immediate Cleanup)

| # | Action | Files Affected |
|---|---|---|
| QW-1 | Delete `presets.js`, `recurring.js`, and the `_migrateLocalStorageData()` call | `app.js`, `presets.js`, `recurring.js` |
| QW-2 | Remove 5 unused exports: `openProfileModal`, `closeProfileModal`, `profileOverlay`, `closeAchievementScreen`, `closeStatsScreen` | `ui.js`, `app.js` |
| QW-3 | Remove dead `barWFull` variable | `ui.js:325` |
| QW-4 | Remove the `import { supabase }` from `ui.js` (after QW-2 removes `openProfileModal`) | `ui.js:13` |
| QW-5 | Extract `_shortFmt(