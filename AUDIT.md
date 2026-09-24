
# 🔍 Code Audit Report — AFK Tracker

**Reviewed:** All source files in `afk-tracker/`
**Scope:** `app.js`, `ui.js`, `state.js`, `api.js`, `auth.js`, `supabase-client.js`, `presets.js`, `recurring.js`, `sw.js`, `index.html`

---

## ✅ Completed Work

| Step | Description | Branch | Status |
|---|---|---|---|
| Step 1 | Delete `presets.js`, `recurring.js`; remove dead exports from `ui.js`; remove `import { supabase }` from `ui.js`; remove stale migration code | `refactor/step-1` | ✅ Merged |
| Bug fix | Bottom nav not shown after interactive login | `fix/login-logout-ux` | ✅ Merged |
| Bug fix | URL hash not cleared on logout | `fix/login-logout-ux` | ✅ Merged |
| Feature | Logout confirmation modal | `fix/login-logout-ux` | ✅ Merged |
| Fix | Removed deleted files from `sw.js` SHELL_FILES; bumped cache v25→v26 | `fix/login-logout-ux` | ✅ Merged |
| Step 2 | `getResolvedDisplayName()` + `getMonthDateRange()` in `state.js`; `_shortFmt()` in `ui.js`; fixes hardcoded `$` in chart labels | `refactor/step-2` | ✅ Merged |
| Bug fix | Settings currency/theme now only apply on Save; theme previews then reverts on cancel | `fix/settings-deferred-apply` | ✅ Merged |
| Feature | Success toast (top-right on desktop, below header on mobile) after Settings save | `fix/settings-deferred-apply` | ✅ Merged |
| Fix | Frozen header on desktop via `position: fixed` container at `min-width: 481px` | `fix/settings-deferred-apply` | ✅ Merged |

---

## 1. 🧹 Dead Code & Cleanup

### 1.1 Orphaned / Legacy Modules

`presets.js` and `recurring.js` are migration-only remnants. Each exports a single read function (`readPresets()` / `readRecurring()`) that reads from `localStorage` keys **never written to** anywhere in the current codebase post-migration. They exist only to serve `_migrateLocalStorageData()` in `app.js`. Once every user has migrated, both files and the migration function can be deleted.

- Files to delete: `presets.js`, `recurring.js`
- Code to delete: `_migrateLocalStorageData()` in `app.js` (lines 1663–1682), and its `readPresets` / `readRecurring` imports at lines 2–3.

---

### 1.2 Unused Exports in `ui.js`

| Export | Line | Why it's dead |
|---|---|---|
| `openProfileModal()` | 940 | Settings is now a full screen. Never called anywhere. |
| `closeProfileModal()` | 964 | Profile modal no longer exists. |
| `profileOverlay` | 938 | Exported `var` never consumed outside `ui.js`. |
| `closeAchievementScreen()` | 1209 | Exported, never imported or called. |
| `closeStatsScreen()` | 1313 | Imported in `app.js` line 86 but **never invoked**. |

All five can be removed from `ui.js` and the unused import removed from `app.js`.

---

### 1.3 Dead Variable Assignment

`ui.js` line 325:
```js
var barWFull = slotW - 2; // keep for x-centering
```
Assigned but **never read**. Pure dead assignment left from a layout refactor.

---

### 1.4 Stale Comment / Empty Block

`app.js` line 1393:
```js
// Settings is now a screen — no close button or overlay click needed
```
Followed by two blank lines. Comment refers to a removed modal. The empty block is leftover scaffolding.

---

### 1.5 Duplicated DOM Queries Across Two Modules

`budgetSetupBox`, `statsSection`, and `addExpenseSection` are queried at module-load time in **both** `app.js` (lines 349–352) and `ui.js` (lines 567–569). Two modules hold independent live references to the same three DOM nodes. `app.js` manipulates them directly in the budget save handler; `ui.js` does the same inside `openMonth()`. The DOM should have a single owner per element group.

---

### 1.6 Inline Styles in HTML

The following belong in `style.css`, not in `style=""` attributes or embedded `<style>` tags:

- **`index.html` lines 25–82**: the entire `#init-loading` block, including an embedded `<style>` tag with `@keyframes`, animation declarations, sizing and font. This is a full component stylesheet inlined in HTML.
- **Lines 91–96**: login screen `<p>` text-align / color / font-size.
- **Lines 519, 526–527, 533, 548–549**: multiple `style="margin-top/bottom:...px;"` scattered through the settings password fields and data section.

---

### 1.7 Exposed Credentials in Source Code

`supabase-client.js` lines 3–4 hardcode the Supabase URL and publishable key in source. While an `sb_publishable_*` key is designed to be public, the pattern should use environment variables or a build-time injection so keys can be rotated without a code change, and to establish a clean habit before any non-publishable secrets are added.

---

## 2. 🧱 Architectural & SOLID Violations

### 2.1 SRP Violation — `app.js` Is a 1,784-line God Module

`app.js` simultaneously owns six distinct responsibilities:

1. **DOM event binding** for every feature (budget, expense CRUD, categories, presets, recurring, settings, auth, navigation)
2. **Hash-based routing engine** (`_navigateToHash()`, `pushHash()`, `popstate` handler)
3. **Realtime sync manager** (`setupRealtimeSync()`, `_handleRealtimeChange()`)
4. **Settings dirty-state machine** (`_snapshotSettings()`, `_updateSettingsSaveBtn()`, `_openSettings()`)
5. **Application bootstrap** (the `init()` IIFE, including warm/cold load branching)
6. **Inline feature controllers** for category picker, preset strip, recurring modal

Each is a valid, separable module. The recommended decomposition is in Section 5 (Refactoring Plan).

---

### 2.2 SRP Violation — `ui.js` Contains Domain / Business Logic

`ui.js` is intended to be a rendering layer but contains:

**Achievement domain logic** (`ui.js` lines 998–1131): The `ACHIEVEMENTS` constant is an array of objects with `earned(state)` predicate functions. These evaluate business rules against application state — they have no place in a UI module. They should live in a dedicated `achievements.js`.

**Network I/O in a render function**: `openProfileModal()` (`ui.js:940`) executes two live Supabase calls (`supabase.auth.getUser()` and `supabase.from('profiles').select(...)`). A rendering function must not reach through the presentation layer into the data layer.

---

### 2.3 Dependency Inversion Violation — `ui.js` Imports the Data Layer

```js
// ui.js line 13
import { supabase } from "./supabase-client.js";
```

A UI rendering module should have zero knowledge of the persistence layer. This coupling exists exclusively for the already-dead `openProfileModal()`. Removing that function also cleanly severs the illegal dependency.

---

### 2.4 Fragile Callback Registration (Symptom of Missing Architecture)

Four separate "register callback" functions work around circular dependencies:

- `registerAuthCallbacks()` — `auth.js:21`
- `registerDeleteExpenseCb()` — `ui.js:674`
- `registerOpenEditExpenseCb()` — `ui.js:676`
- `registerPostOpenMonthCb()` — `ui.js:678`

If any callback is not registered before it is called (e.g., due to module load order), the failure is a silent `null` invocation with no error. A lightweight event-bus pattern or cleaner module ownership would eliminate this fragility.

---

### 2.5 Duplicated Display-Name Resolution Logic

`app.js` line 1511 defines a private helper:
```js
function _getDisplayName() {
  return state.displayName || (typeof getDisplayName === "function" ? getDisplayName() : "");
}
```

The identical expression `state.displayName || getDisplayName()` also appears in `ui.js` line 110 inside `renderWelcomeName()`. This resolution logic should be a single exported accessor in `state.js` (e.g., `getResolvedDisplayName()`).

---

### 2.6 `setState()` Allows Partial State Replacement with `Object.assign`

`state.js` line 6–8:
```js
export function setState(newState) {