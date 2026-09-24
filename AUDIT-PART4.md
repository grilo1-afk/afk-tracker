# 🔍 Code Audit Report — AFK Tracker (Part 4 of 4)

_Continued from AUDIT-PART3.md — Refactoring Plan Steps 6–10_

---

### Step 6 — Extract `router.js`

Move `_navigateToHash()`, `pushHash()`, `setNavActive()`, the `popstate` event listener, and all four bottom-nav-tab `click` listeners out of `app.js` into a new `router.js`. The router will import `showScreen`, `renderHistory`, `openStatsScreen`, `openManageScreen`, `openSettingsScreen`, `openAchievementScreen` from `ui.js`, and call controller functions exposed by the other modules. `app.js` calls `router.init()` from the bootstrap IIFE.

**Outcome:** `app.js` loses ~120 lines. All navigation logic is co-located and independently readable.

---

### Step 7 — Extract `sync.js`

Move `setupRealtimeSync()` and `_handleRealtimeChange()` out of `app.js` into a new `sync.js`. The module exports `initRealtimeSync()` and `teardownRealtimeSync()`. It imports `loadState`, `setState`, `setCurrency`, `writeLocalCache`, `state` from the data layer, and calls render callbacks passed to it at init time (or via the event bus from Step 9).

**Outcome:** Realtime sync is independently understandable. `app.js` loses ~90 lines.

---

### Step 8 — Extract `settings-controller.js`

Move `_snapshotSettings()`, `_updateSettingsSaveBtn()`, `_openSettings()`, and the entire `btn-profile-save` click handler out of `app.js` into a new `settings-controller.js`. This module owns all dirty-detection state (`_settingsSnapshot`) and wires its own event listeners on `DOMContentLoaded` or via an `init()` call.

**Outcome:** The settings state machine lives in one place. `app.js` loses ~130 lines.

---

### Step 9 — Replace Callback Registration with an Event Bus (Optional but Recommended)

Replace the four `register*Cb()` functions with a minimal event bus (a `Map` of event name → array of handlers, exposed as `on(event, fn)` and `emit(event, ...args)`). Replace:
- `registerDeleteExpenseCb` → `bus.on('expense:delete', fn)`
- `registerOpenEditExpenseCb` → `bus.on('expense:edit-open', fn)`
- `registerPostOpenMonthCb` → `bus.on('month:opened', fn)`
- `registerAuthCallbacks` → individual `bus.on('auth:session-invalid', fn)`, etc.

This eliminates the silent `null`-call risk and the load-order dependency of the current pattern.

**Outcome:** Module coupling is reduced. Any module can react to events without importing the emitting module.

---

### Step 10 — Validate `setState()` Calls

Replace the two `setState({ months: ..., displayName: ... })` calls in `app.js` (lines 1291–1294 and 1302–1305) that silently drop `categories`, `presets`, `recurring`, `currency`, and `lifetimeOffset` with targeted, field-level mutations:

```js
// Instead of:
setState({ months: state.months.filter(x => x.id !== id), displayName: state.displayName });

// Do:
state.months = state.months.filter(x => x.id !== id);
```

Or add a `mergeState(partial)` that explicitly documents it is a partial merge, with a comment listing which keys are intentionally omitted. Optionally add a dev-only assertion that warns when a `setState` call omits known top-level keys.

**Outcome:** Eliminates the risk of accidentally wiping state keys during rollback operations.

---

## 6. 📊 Summary Table

| Category | Count | Priority |
|---|---|---|
| Files that can be deleted | 2 (`presets.js`, `recurring.js`) | High |
| Dead exports to remove | 5 | High |
| Dead variable assignments | 1 | Low |
| SRP violations (god modules) | 2 (`app.js`, `ui.js`) | High |
| DIP violations | 1 (`ui.js` → `supabase`) | High |
| Duplicated logic blocks | 7 | Medium |
| Inline styles / HTML debt | 8+ style attributes | Low |
| Credential management | 1 | Medium |
| Silent failure risk (null callbacks) | 4 registration points | Medium |
| Unsafe partial state replacement | 2 call sites | Medium |

---

## 7. ❓ Which Step Would You Like to Start With?

The recommended starting point is **Step 1** (Safe Deletions) — it has zero risk of breaking behaviour, produces immediate measurable cleanup, and unblocks Steps 2–10 by removing the noise from the codebase.

However, if you prefer to start with a higher-impact structural change, **Step 5** (extracting `achievements.js`) or **Step 6** (extracting `router.js`) are self-contained enough to tackle independently.

Please indicate which step you want to begin, and the refactoring will be applied with full code changes.