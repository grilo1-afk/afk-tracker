# AFK Arena Tavern Tracker — Master Roadmap

**Revision 3.1 — approved scope**

Supersedes the original 44-item Apps Script audit and the two amendments that followed it. Every item below has been reviewed and either accepted, changed, or rejected. Nothing here is awaiting a decision.

Items carry a phase letter and a number. Where an entry descends from the original audit, its old number is noted. Each has a **Done when** line, which becomes the verification step in its implementation prompt.

**Stack:** Supabase (Auth, Postgres, RLS) · Vanilla JS, ES modules, no build · iPhone-first PWA, desktop supported · 2 users, provisioned by hand · 38 items across seven phases

---

## Locked decisions

Settled and not reopening. Anything in this roadmap — or in any prompt handed to Roo — that contradicts one of these is a mistake.

1. Supabase is the only backend. Apps Script and Sheets are gone and are not coming back.
2. Vanilla JavaScript, ES modules, no framework, no build step, static hosting.
3. Two users, created by hand in the Supabase dashboard.
4. No signup screen and no password recovery, by design. Both happen in the Supabase dashboard if they ever need to happen at all.
5. Login is by username. The app appends the email domain before calling Supabase; the user never types or sees an email address.
6. Row Level Security is the security boundary, and it is verified working.
7. No daily allowance and no spending projection. Built, tried, removed.
8. Money is USD. Currency is a stored preference, not something derived from the browser's locale.
9. No comparison between the two accounts. Two logins is all "two users" means.
10. No automatic budget rollover. Leftover budget is a signal to think, not a number to carry forward.
11. One game. The schema does not need a games table, and the roadmap does not plan for one.
12. The budget tracker is the first module of a larger AFK Arena companion, not the whole app. Boss timers and damage tracking come later. Nothing built now should assume the budget tracker owns the navigation.
13. Expense categories are user-defined, not a fixed taxonomy. The store's SKUs change every patch; the app should not hardcode them.
14. No automated backups exist on the current Supabase plan. A manual export is the mitigation — see F2.

---

## Not doing

Voided by the migration, or explicitly rejected. Listed once so the reasoning isn't lost.

- **#1–#5** — backend instrumentation, Sheets call reduction, login optimization, PBKDF2 tuning, backend errors. *The slow login was a property of the Apps Script execution model. There is no backend left to profile.*
- **#12–#17** — endpoint protection, password auth, session persistence, expiry, rate limiting, concurrency locks. *Supabase Auth owns all of it.*
- **#9, #10, #18** — save queue, debounce, race protection, retry schedule. *Existed because a whole-state blob was pushed to a slow endpoint. Granular CRUD removed the reason.*
- **#19, #23, #24** — state versioning, data migration, conflict detection. *No blob left to version; migration started from an empty database.*
- **#20, #21, #22** — stable month IDs, ISO dates, expense timestamps. *Delivered by the schema.*
- **#35, #36** — daily allowance, spending projection. *Rejected. See locked decision 7.*
- **Default monthly budget setting.** *Rejected — budgets change month to month based on what's releasing, so a stored default would be wrong more often than right. A null budget that demands a value on first use is two clicks and always correct.*
- **CSV export per month.** *Rejected. Cost outweighs the use.*
- **Fixed category taxonomy.** *Rejected in favor of user-defined categories — see locked decision 13.*
- **Cross-account comparison, budget rollover, historical import, second-game support.** *All rejected. See locked decisions 9–11.*

---

## Phase A — Hardening (8 items)

Defects in code that currently ships. None visible on a good day with one user on one device — which is why this phase goes first, since these failure modes appear exactly when the second person starts using the app on a phone.

### A1 — Namespace the local cache per user
`afk_state` and `afk_display_name` are global localStorage keys with no user in them. Two accounts in one browser means the second person sees the first person's months and name on warm load until the sync replaces them.

Key the cache on the Supabase user id, and drop any cache belonging to a different id at login. **The cache is staying** — see "Why the cache stays" below.

**Done when:** logging in as the second user in a browser that cached the first shows nothing belonging to the first at any point in the load.

### A2 — Stop creating the current month automatically
`ensureCurrentMonth()` inserts a row every time the app loads, and `init()` calls it twice on the cached path. The second insert is rejected only by the unique constraint, silently, into `console.error`. Every user also accumulates months they never created, sitting at budget zero.

Create a month when the person asks for one. The button already exists, and with the default-budget idea rejected, creation is where the budget gets set.

**Done when:** opening the app on the first day of a new month writes nothing to the database.

### A3 — Make a failed sync visible *(was #11)*
A failed background sync reaches `console.error` and nowhere else, so the person keeps reading cached data with no indication it's stale. On a phone that loses signal, this is the difference between an app that's honest and one that quietly lies.

Three states: current, syncing, showing stale data. The `aria-live` spans are already in `index.html`, unwired.

**Done when:** loading with the network disabled shows the cached months and says plainly that they may be out of date.

### A4 — Go optimistic on every write, keep the undo window
Today most writes wait for the network before touching state or rendering, while expense deletion mutates immediately and offers undo. The blocking model was a reasonable answer to Apps Script latency and is now just inconsistency.

Every write becomes: mutate state, render, send to Postgres, and on failure roll back visibly with an explanation. The four-second undo on expense deletion stays exactly as it is — it's a deliberate interface affordance, not a consequence of the old write model.

**Done when:** adding an expense on a throttled connection renders instantly, a forced failure visibly removes it again with a reason, and undo still behaves as it does now.

### A5 — Give api.js a real error contract *(was #25)*
Every `db*` function logs to console and returns `null` or `false`. A dropped connection, an RLS rejection, an expired session, and a constraint violation all produce the same banner telling the user to try again. Two of those four will never succeed on retry.

Return a typed result — network, auth, permission, validation, unknown — and let the interface say something true. This is also what A4 needs in order to roll back for the right reason.

**Done when:** each failure class produces a distinct and accurate message.

### A6 — Detect session expiry properly *(was #26)*
`auth.js` decides a session expired by checking whether the error message contains the string "jwt". That holds until Supabase rewords an error.

Use the error code, or subscribe to `onAuthStateChange` and let the client tell you. The subscription is also what G5 needs.

**Done when:** an expired session routes to login without any code reading message text.

### A7 — Sweep the dead code
Leftovers from the migration and from the removed projection feature:

- `app.js` hides `daily-allowance` and `spending-projection`. Neither element exists in `index.html`.
- `setState()` reassigns `state.months` immediately after `Object.assign` already set it, and the `??` fallback on `displayName` can resurrect a name that was just cleared.
- `window.undoDeleteExpense` with an inline `onclick` is the last global in the codebase, and the only thing that would break under a content security policy.
- The `save-status` spans are unused — A3 wires them, so leave them until then.

Treat this as a sweep rather than a checklist: anything else unreferenced goes too.

**Done when:** no identifier in the JavaScript refers to an element that doesn't exist, and no global remains.

### A8 — Make undo survive a reload
The four-second timer holds the actual database delete. Reload inside that window and the expense is gone locally but still in Postgres, so it reappears on the next sync and looks like the delete failed. On iPhone this is more likely than it sounds, because iOS relaunches backgrounded web apps aggressively.

Delete immediately and re-insert on undo, which keeps the interface identical and makes the database always the truth.

**Done when:** deleting an expense and reloading within four seconds leaves database and interface in agreement.

---

## Phase B — Data & integrity (5 items)

Schema and correctness work. Cheaper now than after there's data worth protecting.

### B1 — Order everything newest first
`select("*, expenses(*)")` orders the months but says nothing about the nested relation, so expense order is whatever Postgres returns. It looks stable until it isn't.

Months newest first, expenses newest first within their month, with creation time breaking ties on the same date.

**Done when:** two expenses added on the same date appear with the most recent on top, consistently across reloads.

### B2 — Replace the budget-zero sentinel
The column is `not null default 0` and the mapper reads `budget > 0 ? value : null`, so zero means "not set" and a real zero budget can't be expressed — which matters, because a zero-spend month is one of the achievements in E4.

Make it nullable and let null mean not set. With A2 and the rejected default, null on creation is exactly what prompts the user for a number.

**Done when:** a month can hold a budget of exactly zero and display it as a budget.

### B3 — Store and sum money in integer cents
Totals are summed with `reduce((s, e) => s + e.val, 0)` over floats parsed from a numeric column. The error is invisible per row and accumulates into the percentage, the remaining figure, and eventually the lifetime total in D4 — which is the number you least want to be slightly wrong.

Cents everywhere internally, formatted to dollars only at the display boundary. Currency is USD, so two decimal places is a fixed assumption and integers are safe well past any plausible total.

**Done when:** ten purchases of $0.99 total exactly $9.90, and the same holds after a reload.

### B4 — Enforce the expense date range in the database *(was #28)*
The interface checks that an expense date falls inside its month, in two places, by comparing against the input's min and max. Nothing enforces it server-side, so the rule is only as true as the last piece of UI code that touched it.

**Done when:** an insert with an out-of-month date is rejected by Postgres.

### B5 — Soft-delete months
Deleting a month cascades every expense in it, permanently, behind one confirmation. A `deleted_at` column and an RLS filter make that recoverable for the cost of one column. This matters more now that F2 has no server-side backup: it's the cheapest undo the data has.

**Done when:** a deleted month and its expenses can be restored.

---

## Phase C — Interface & accessibility (4 items)

### C1 — Modal focus management *(was #38)*
Four modals: month picker, edit expense, delete month, settings. All four already close on Escape and on backdrop click, which is the hard part. None trap Tab inside the modal or return focus to the trigger, and only the edit-expense modal focuses its first field.

**Done when:** each modal can be opened, completed and dismissed without a pointer, and focus lands back on the trigger.

### C2 — Theme as a three-way choice, not a toggle *(was #36, old numbering)*
Today `getPreferredTheme()` reads the OS preference once as a fallback, and the button flips between two states. If the system switches to light at sunset the app stays where it was.

Replace with Light, Dark and System. System follows the OS live and is the sensible default — it's the option that makes the app feel native inside a home-screen window on iPhone, where the rest of the system dims on schedule and a stuck app looks broken.

Lives in Settings under Appearance, per C4.

**Done when:** System follows an OS theme change live, and Light and Dark ignore it and persist.

### C3 — Finish the accessibility pass *(was #37)*
Error spans exist and are populated, but nothing links them to their inputs — `aria-describedby` would. Expense row actions are real buttons, which is good, and need visible focus. Icon-only buttons need accessible names.

**Done when:** a screen reader announces each validation error together with the field it belongs to.

### C4 — Turn Profile into Settings *(was #35, old numbering)*
The modal currently holds display name, password and logout. Several later items need somewhere to live.

Sections: Profile, Appearance, Tracker, Security. Appearance takes the theme control from C2 and the currency from F1. Tracker takes the quick-add presets from E2, the categories from E1, and the starting total from D4.

Worth doing before those items rather than during them, so they don't each invent their own placement. It's also the screen that has to survive locked decision 12, when boss timers and damage tracking arrive and need settings of their own.

**Done when:** the existing three controls are grouped and the empty sections are ready to receive items.

---

## Phase D — Analytics (5 items)

The phase that changes what the app is for. Everything until now records what you spent; this is where it starts telling you something.

### D1 — Month statistics *(was #37)*
Purchases, average purchase, and largest purchase, alongside the spent, budget, remaining and percentage already on screen. All derivable from state with no schema change.

Build it, then look at it and decide which of the three earn their place.

**Done when:** the month screen shows them without an extra query.

### D2 — Spending history *(was #38)*
The history screen already lists every month with budget and spent as text. Adding the proportional bar that already exists on the month screen turns a list into a comparison for very little work.

**Done when:** the history screen shows relative spending at a glance.

### D3 — Year summary *(was #39)*
Total spent, average per month, budget allocated, budget used, and months finished under budget.

**Done when:** a year with months in it produces the summary, and a year without produces an empty state that says so.

### D4 — Lifetime total, with a starting figure
For a tracker pointed at a single game, the total that game has ever cost is the most useful number the dataset can produce. Every per-month view softens it; the lifetime figure doesn't.

Because tracking starts now and the spending didn't, the lifetime total is a stored starting figure plus every month in the database. Set it once in Settings — a single approximate number for everything before the app existed — and it's added to every lifetime calculation thereafter.

Two things this needs to get right: the starting figure must be labelled as an estimate wherever it materially affects a displayed number, and it must never leak into per-month or per-year figures, which are measured rather than estimated.

**Done when:** setting a starting figure raises the lifetime total by exactly that amount and changes nothing else in the app.

### D5 — Charts *(was #40)*
Monthly spending, and spending against budget. Two series over twelve points doesn't justify a charting library — inline SVG is smaller than the library's stylesheet and themes correctly with the rest of the app.

Worth landing after E1, so category breakdown can be the third chart rather than a later retrofit.

**Done when:** the chart renders in both themes, works at iPhone width, and degrades sensibly below twelve months of data.

---

## Phase E — AFK Arena features (4 items)

The personality phase. It should stay flavour rather than becoming a game in its own right.

### E1 — User-defined expense categories *(was #41)*
Not a fixed taxonomy — the store's SKUs change every patch, and only the person buying knows what they bought. Needs a small categories table (per-user, name plus optionally a color or icon), CRUD for it, and a picker that offers what already exists plus an "add new" path.

Rules regardless of what gets added: every existing expense gets a sensible default category on migration, and the picker fits an iPhone screen without a scroll for a typical category count.

**Done when:** existing expenses survive the change with a default category, a new category can be created inline while adding an expense, and the picker fits an iPhone screen.

### E2 — Quick-add presets *(was #42)*
The standard purchases made repeatedly. Clicking one fills the form rather than submitting it, so date and description stay editable. Configured under Tracker in Settings, which is why C4 comes first.

Highest ratio of daily convenience to implementation cost in this document, and the item that most benefits from the app being one tap away on the home screen.

**Done when:** a typical purchase takes one tap and one confirmation.

### E3 — Recurring expenses *(was #43)*
Mark an expense as recurring, and offer it as a checklist when a month is created. Depends on A2 having settled how months come into existence, and pairs naturally with the budget prompt that replaces the rejected default.

**Done when:** creating a month offers the recurring list and creates nothing that wasn't checked.

### E4 — Achievements, illustrated with the sticker pack *(was #44)*
Derive them from the data rather than storing state — recomputing a handful of predicates is cheaper than keeping an awards table honest, and it means they correct themselves when an old expense is edited.

**Asset pack:** `afk-stickers-optimized.zip`, 131 images, numbered 1–136 with 100–104 absent, each resized to a 256px max dimension (down from 15.2MB total to 6.0MB, individual files averaging 47KB). Files 1–4 are animated GIFs; the rest are transparent PNGs. They're hero portraits in sets of roughly four to six expressions per hero, which maps well onto achievement tiers — one hero per achievement family, expression escalating with the tier. The GIFs are the obvious candidates for the rarest achievements, since they move.

**Done when:** editing an old expense correctly revokes an achievement it no longer earns, and the achievement screen loads in under a second on cellular.

---

## Phase F — Settings & data (2 items)

### F1 — Currency as a stored preference *(was #32)*
`fmt()` concatenates a hardcoded dollar sign. Route formatting through `Intl.NumberFormat` with an explicit currency code held on the profile, so it's one decision in one place instead of a string literal repeated across every view.

Explicitly not derived from the browser locale. A phone set to Portuguese in Brazil should still show USD, because the purchases are in USD — the locale can decide separator style, but never the currency.

**Done when:** changing the stored currency changes every amount in the app, and changing the phone's language changes none of them.

### F2 — Manual data export
No automated backups exist on the current Supabase plan. Rather than building backup infrastructure for a small, infrequently-changing dataset, the mitigation is one button in Settings, under Data: **"Export backup."** It queries everything the signed-in user owns and downloads a JSON file. No import path needed — restoring, if it's ever needed, is a manual operation against a two-person dataset, not a feature.

Worth using right after a Phase B schema change, and once before the app becomes the phone's primary way of using this data.

**Done when:** the export button produces a JSON file containing every month and expense the signed-in user owns.

---

## Phase G — iPhone & sync (5 items)

The phase that makes this a phone app.

### G1 — Web app manifest and icons
Name, short name, theme and background colour, standalone display, and the icon set. This is what gives the app its own home-screen icon and its own window with no browser chrome.

The sticker pack is the obvious icon source; render the chosen image down to the standard PNG icon sizes rather than using a GIF.

**Done when:** adding to the home screen on iPhone produces the right icon and name, and launching it shows no browser interface.

### G2 — Service worker for offline loading
Cache the shell — HTML, CSS, the five JavaScript modules, icons — so the app opens instantly and works with no signal. Data continues to come from the localStorage cache and Supabase; the service worker is only responsible for the application itself.

Needs a deliberate update strategy, because a badly cached shell is the one bug that makes an app impossible to fix remotely.

**Done when:** the app opens in airplane mode showing cached data, and a deployed change reaches the phone within one relaunch.

### G3 — Fit the iPhone window properly
In a standalone home-screen window there's no browser chrome to absorb the notch and the home indicator, so content runs underneath both. Needs `viewport-fit=cover` and safe-area insets applied to the header and anything anchored to the bottom.

Two things are already right and shouldn't be disturbed: inputs are at 16px, which is what stops iOS zooming on focus, and the layout already uses `100dvh` rather than `100vh`.

Also needs an answer for refresh, since standalone mode has no pull-to-refresh and no reload button.

**Done when:** nothing sits under the notch or the home indicator on a notched iPhone in either orientation.

### G4 — Fix decimal entry on a Portuguese keyboard
The three money fields are `type="number"` with no `inputmode`. On an iPhone set to Brazilian Portuguese, the numeric keyboard offers a comma as the decimal separator, and a comma in a number input yields an empty value. The person types 4,99 and the field reads as blank with no error explaining why.

This is a live bug on the primary device, not a future concern, and it becomes more visible once the app is launched from the home screen rather than a browser.

**Done when:** typing a comma as the decimal separator on a pt-BR iPhone produces the correct amount.

### G5 — Live sync across devices
Supabase Realtime on months and expenses. Add an expense on the phone and watch it land on the desktop tab left open, which is exactly the shape of how this app gets used.

Must come after A4, or there are two sources of truth writing into a state object that has no rules yet. Also needs a rule for the case where a realtime update arrives for a record the local session is mid-way through writing.

**Done when:** an expense added on one device appears on another within a second without a reload, and an optimistic local write is never overwritten by the echo of itself.

---

## Why the cache stays

The local cache and instant saving are separate concerns, and it's worth keeping them separate in the code as well as in the head.

- **Supabase is the only source of truth.** Every write goes there immediately. The cache is never a buffer of unsaved work — that was the Apps Script design, and it's gone.
- **The cache answers one question:** what does the screen show in the moment before Supabase replies, and what does it show when there's no signal. Without it, every cold start is a spinner. On iPhone that's not an edge case: iOS relaunches backgrounded web apps constantly, so cold starts are the normal way this app will open.
- **One rule keeps it honest.** Only write to the cache after the database confirms. Optimistic updates from A4 render immediately but don't reach the cache until they're real, so a crash mid-write can never leave the cache holding something the database rejected.

A1 is what makes this safe with two accounts. A3 is what makes it honest when the sync fails. G5 keeps it current across devices. All three exist because the cache does.

---

## Suggested order

1. **A1, A2, A7** — the likeliest bug, the thing writing junk to the database on every load, and the cleanup that clears the noise everything else is read through.
2. **G4** — out of phase order on purpose. It's a live bug on the device actually in use, and it's small.
3. **A4, then A3 and A5** — A4 is the decision the other two take their shape from.
4. **A6, A8, then Phase B** — schema changes get cheaper the earlier they happen, and B3 in particular should land before any number is built on top of it.
5. **C4, then G1 to G3** — settings structure first, then the app becomes a phone app, which is the point at which real daily use begins.
6. **E2 and E1** — presets pay off every day; categories gate the analytics and the presets.
7. **Phase D, then G5, then E3 and E4** — the payoff, then sync, then the flavour.

C1, C2 and C3 slot in anywhere. F1 goes with C4. F2 can happen any time after C4 provides the Data section.
