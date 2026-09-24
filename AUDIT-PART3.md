
# 🔍 Code Audit Report — AFK Tracker (Part 3 of 3)

_Continued from AUDIT-PART2.md_

---

## 4. 🚀 Quick Wins vs. High-Impact Refactoring

### Quick Wins (Low Effort, Immediate Cleanup)

| # | Action | Files Affected |
|---|---|---|
| QW-1 | Delete `presets.js`, `recurring.js`, and `_migrateLocalStorageData()` + its imports | `app.js`, `presets.js`, `recurring.js` |
| QW-2 | Remove 5 unused exports: `openProfileModal`, `closeProfileModal`, `profileOverlay`, `closeAchievementScreen`, `closeStatsScreen` | `ui.js`, `app.js` |
| QW-3 | Remove dead `barWFull` variable assignment | `ui.js:325` |
| QW-4 | Remove `import { supabase }` from `ui.js` (enabled by QW-2) | `ui.js:13` |
| QW-5 | Extract `_shortFmt(cents)` helper in `ui.js` — eliminates 6+ duplicated inline chart label strings and fixes the hardcoded `'$'` currency bug | `ui.js` |
| QW-6 | Extract `getMonthDateRange(m)` helper in `state.js` — eliminates 3 duplicate `lastDay/mm/minDate/maxDate` blocks | `state.js`, `app.js`, `ui.js` |
| QW-7 | Extract `closeRecurringModal()` helper in `app.js` — consolidates 3 identical `classList.add("hidden")` calls | `app.js` |
| QW-8 | Extract `addCategory(name, errorElId)` helper — eliminates duplicated add-category logic | `app.js` |
| QW-9 | Move inline `style=""` attributes and the `#init-loading` embedded `<style>` block into `style.css` | `index.html`, `style.css` |
| QW-10 | Add `getResolvedDisplayName()` to `state.js` and remove the duplicated `state.displayName \|\| getDisplayName()` expressions in `app.js` and `ui.js` | `state.js`, `app.js`, `ui.js` |

---

### High-Impact Refactoring (Moderate–High Effort)

| # | Action | Impact | Effort |
|---|---|---|---|
| HI-1 | Extract `achievements.js` — move `ACHIEVEMENTS` array + `_isPastMonth()` + `getAchievementCounts()` out of `ui.js` | Fixes SRP; `ui.js` becomes a pure render layer | Low-Medium |
| HI-2 | Extract `router.js` — move `_navigateToHash()`, `pushHash()`, `setNavActive()`, `popstate` handler, and nav-tab click bindings out of `app.js` | Isolates routing concern; `app.js` shrinks ~100 lines | Medium |
| HI-3 | Extract `sync.js` — move `setupRealtimeSync()` and `_handleRealtimeChange()` out of `app.js` | Isolates realtime concern; enables independent testing | Medium |
| HI-4 | Extract `settings-controller.js` — move `_snapshotSettings()`, `_updateSettingsSaveBtn()`, `_openSettings()`, and the `btn-profile-save` handler out of `app.js` | Isolates the settings dirty-tracking state machine | Medium |
| HI-5 | Extract `category-controller.js` — move both add-category handlers, `renderCategoryPicker()`, and `renderCategorySettingsList()` into a single focused module | Eliminates the duplicate add-category pattern (Issue 3.1) | Low-Medium |
| HI-6 | Extract `list-manager.js` or unify `renderPresetList` + `renderRecurringList` + their add/delete handlers into a `renderItemList()` factory | Eliminates Issues 3.2, 3.3, 3.4 in one pass | Medium |
| HI-7 | Replace the partial-object `setState()` pattern with explicit field-level setters or a validated merge | Prevents accidental state key loss (Issue 2.6) | Low |
| HI-8 | Replace the 4 callback-registration functions with a lightweight event bus (or simply consolidate module ownership) | Eliminates silent `null`-call risk (Issue 2.4) | Medium |

---

## 5. 📋 Proposed Step-by-Step Refactoring Plan

The steps are ordered so that each one is safe to apply in isolation — no step depends on a later one being complete first.

---

### Step 1 — Safe Deletions (Zero Risk)
Delete `presets.js` and `recurring.js`. Remove `_migrateLocalStorageData()` from `app.js` and its two imports at the top. Remove the 5 dead exports from `ui.js` (`openProfileModal`, `closeProfileModal`, `profileOverlay`, `closeAchievementScreen`, `closeStatsScreen`) and their unused import in `app.js`. Remove dead `barWFull` variable. Remove the `import { supabase }` line from `ui.js`. Remove stale comment block at `app.js:1393`.

**Outcome:** ~80 lines deleted across 3 files. `ui.js` loses its illegal data-layer import.

---

### Step 2 — DRY Helpers in `state.js` and `ui.js`
Add `getResolvedDisplayName()` to `state.js`. Add `getMonthDateRange(m)` to `state.js`. Add `_shortFmt(cents)` private helper to `ui.js` and use it across all 3 chart functions (also fixes the hardcoded `'$'` currency bug). Replace the duplicated `state.displayName || getDisplayName()` call in `app.js` and `ui.js` with the new accessor.

**Outcome:** ~30 lines of duplication eliminated. Currency display in charts becomes correct for all locales.

---

### Step 3 — Unify Category Add Logic
Extract a shared `addCategory(name, inputEl, errorEl)` async function in `app.js` that both the inline-add and settings-add handlers call. Consolidate `renderCategoryPicker()` and `renderCategorySettingsList()` calls inside that function.

**Outcome:** ~30 duplicate lines collapsed to a single function.

---

### Step 4 — Unify Preset and Recurring List Rendering
Create a `renderItemList({ listId, items, getLabel, getAmount, onDelete, onAfterDelete })` factory function. Refactor `renderPresetList()` and `renderRecurringList()` to use it. Extract a shared `addOptimisticItem(collection, dbFn, ...args)` helper used by both add-preset and add-recurring handlers.

**Outcome:** ~120 lines of duplicate list-render and optimistic-update code replaced by a single parameterised utility.

---

### Step 5 — Extract `achievements.js`
Move the `ACHIEVEMENTS` constant, `_isPastMonth()`, `getAchievementCounts()`, and `renderAchievements()` out of `ui.js` into a new `achievements.js`. `ui.js` keeps only `openAchievementScreen()` and `_renderAchievementsSection()`, which import from the new module.

**Outcome:** `ui.js` sheds ~230 lines of domain logic. Achievement rules become independently testable.

---

### Step 6 — Extract `router.js`
Move `_navigateTo