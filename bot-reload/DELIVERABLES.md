# Bonus Reload Bot V1 — Bug Fix Deliverables

Reference path (repo layout after flattening the nested clone):
`bot-reload/` at the repo root — this directory now holds
`package.json`, `src/`, `tests/`, `scripts/`, `config/`, `tsconfig*`
directly.

Run everything from `bot-reload/`:

```bash
git clone <this-repo>
cd <this-repo>/bot-reload
npm install
npm run lint
npm run build

All work honors the architectural constraints in the problem statement:

npm test
npm start      # opens the Electron GUI — Windows / desktop only
```

- RuleEngine remains pure.
- BrowserManager stays the ONLY module that imports Playwright.
- Database still owns SQLite only.
- BotEngine still owns workflow, queues, cooldown, verification, retry.

No modules were rewritten unnecessarily; every change is scoped to the
bug it fixes.

---

## Modified files

| File | Fixes | Nature of change |
|------|-------|------------------|
| `src/bot/types.ts`               | #1, #5, #7 | Added `Transaction.txId?`, `SkippedRow.txId?`, `AppConfig.logRetentionDays?`, added `BotMetrics`, extended `CycleReport` with `inlineRetried`, optional `IBrowser.uptimeMs`/`lastRefreshIso`. |
| `src/bot/Selectors.ts`           | #3       | Rewrote as a column-index based single source of truth. Added `cellIdx.*`, kept `legacy` selectors as fallback, added `txIdPatterns`, `approveClass`, `rejectClass`. |
| `src/bot/BrowserManager.ts`      | #1, #3   | Full parser rewrite. `readPendingTransactions()` now uses `row.cells[i]` and extracts `txId` from button id / onclick / data-attributes / row data-attrs. `approveMultipleTransactions()` / `rejectMultipleTransactions()` locate rows by `txId` first, fall back to composite key (`username\|amount\|transactionDate`). `rowIndex` is never used for actions anymore. Added `uptimeMs()` and `lastRefreshIso()` for Bug #5. |
| `src/bot/BotEngine.ts`           | #2, #4, #5 | Cycle now starts with `browser.refresh()` (skipped on the first cycle post-start). Inline retry (`MAX_PASSES = 2`) runs `submit → refresh → verify` inside the SAME cycle when the first pass leaves transactions visible. Retries remain event-driven — no counter, no backoff. Metrics tracker added (`getMetrics()`, rolling 20-sample windows for cycle duration + verification duration). Emits new `"metrics"` event. Loop rearranged so `refreshInterval` fires BEFORE `runOnce()` — the whole `wait → refresh → read → process → verify` sequence is now driven by the setting. |
| `src/bot/Logger.ts`              | #7       | Refactored to open today's file lazily and rotate mid-session when the calendar day changes. `pruneOldLogs()` deletes files older than `retentionDays`. `configureFileSinks(dir, level, retentionDays)` — retention now a first-class parameter. |
| `src/bot/ManualReviewQueue.ts`   | #1       | Carries `txId` on `SkippedRow` so operator manual-reject reuses the stable identifier. |
| `src/main/main.ts`               | #5, #7   | `DEFAULT_CONFIG.logRetentionDays = 30`. `normalizeConfig` clamps it. `Logger.configureFileSinks` is now called with retention. IPC handlers added: `bot:getMetrics`, `bot:pruneLogs`. `engine.on("metrics", …)` forwarded to the renderer. |
| `src/main/preload.ts`            | #5, #7   | New API surface: `getMetrics`, `pruneLogs`, `onMetrics`. `ConfigPayload` extended with `logRetentionDays`. |
| `src/renderer/index.html`        | #5, #6, #7 | Dashboard now includes a runtime-metrics strip (10 tiles). History gets a search input, status filter, page-size selector, page-prev/page-next buttons, sortable column headers. DB Viewer gains a "Prune Old Logs" button. Settings gains "Log File Retention (days)". |
| `src/renderer/scripts/app.js`    | #5, #6, #7 | `renderMetrics()`, `bot.onMetrics()` wiring. History renderer replaced by a stateful list with client-side search / filter / sort / pagination. Prune Log button handler. `logRetentionDays` field in Settings save/load. |
| `src/renderer/styles/app.css`    | #5, #6   | Styles for `.metrics-grid`, `.input-inline`, `.pager`, `.sortable` sort indicators. Responsive breakpoint updated. |
| `config/config.json`             | #7       | Seed value `"logRetentionDays": 30`. |
| `tests/fakes.ts`                 | #1       | FakeBrowser tracks `openedAt`, exposes `uptimeMs()` and `lastRefreshIso()`. Approve / reject removal now prefers `txId` when present. `tx()` helper accepts an optional `txId`. |
| `tests/BugFixes.test.ts`         | new      | Focused unit tests for bugs #1, #2, #4, #5. |
| `tests/Selectors.test.ts`        | new      | jsdom-driven robustness tests for bug #3. Also exercises regex patterns from `Selectors.txIdPatterns`. |
| `tests/LogRotation.test.ts`      | new      | Bug #7 coverage — file creation, retention prune, retention = 0 disabling. |
| `package.json`                   | deps     | `jsdom@22` + `@types/jsdom@21` added as dev-deps. Zero production-dep changes. |

Files intentionally **NOT** touched (out-of-scope per the constraints):
`RuleEngine.ts`, `Database.ts`, `PendingCache.ts`, `CooldownTracker.ts`,
`portable-paths.ts`, all existing test suites, all electron-builder /
postinstall / rebuild scripts.

---

## Root cause + fix for each bug

### Bug #1 — BrowserManager depended on `rowIndex`

**Why it happened.** Approve / Reject called
`rows[tx.rowIndex]` inside `page.evaluate`. The rowIndex was captured
in the *earlier* read; if a new transaction appeared between the read
and the write, the DOM row set was re-indexed and the click landed on
the wrong row.

**Fix.**
1. `Transaction` now carries a stable `txId` string, extracted during
   `readPendingTransactions()` from the approve/reject button's `id`
   (`btn-approve-<id>`), `onclick` (`approve(<id>)`), or from
   `data-tx-id` / `data-id` attributes on the button, its wrapper, or
   the row itself.
2. `approveMultipleTransactions()` / `rejectMultipleTransactions()`
   build a lookup keyed by `txId` on the LIVE DOM at click time, and
   only fall back to a composite key
   (`username|amount|transactionDate`) when a row lacks any usable id.
3. `rowIndex` is no longer read anywhere on the action path — it is
   kept on the shape purely for legacy display fields inside the
   Skipped Transactions queue.

**Verification.** `tests/BugFixes.test.ts →` *"approve targets the txId,
not the row order (new row inserted mid-cycle is safe)"* — inserts a
new pending row at index 0 between the read step and the write step,
then asserts the recorded approve batch still targets the original
transaction by its `txId`.

### Bug #2 — Panel Refresh Interval only delayed the polling loop

**Why it happened.** The old loop was
`runOnce()` → wait → `runOnce()` → …. `runOnce()` only ever called
`browser.refresh()` *after* it submitted something. If no transactions
existed (or none were valid), the browser never reloaded. Changing
the setting only affected how often BotEngine woke up, not how often
the panel actually reloaded.

**Fix.** The workflow is now the one prescribed in the RFC:

```
wait interval
    ↓
page.reload()
    ↓
wait table
    ↓
read transactions
    ↓
process (validate / cooldown / daily limit)
    ↓
submit (bulk approve / bulk reject)
    ↓
refresh
    ↓
verify
    ↓
(inline retry — bug #4)
```

- The loop calls `setTimeout(refreshInterval)` **first**, then
  `runOnce()`.
- `runOnce()` starts with `browser.refresh()` (skipped on the very
  first cycle after `start()` to preserve the operator's fresh
  login state, then unconditional from cycle 2 onwards).

**Verification.** `tests/BugFixes.test.ts →` *"every polling cycle
after the first performs a browser.refresh() at the top"* and *"top-of-
cycle refresh happens even when the previous cycle submitted nothing"*.
The second test proves an empty panel across two consecutive cycles
still produces exactly two browser refreshes (top-of-cycle) rather
than zero.

### Bug #3 — Fragile selectors

**Why it happened.** The old parser used
`td:nth-child(N)` + descendant selectors like
`td:nth-child(9) span.btn-approve`. Any inline `<span>` / `<em>` /
`<strong>` wrapper injected by the panel (or a new CSS iteration on
the operator side) could break the descendant match, and any column
re-ordering would silently swap which cell contained what.

**Fix.** `Selectors.cellIdx.*` documents the ZERO-BASED index of every
column. The parser uses `row.cells[idx].textContent` (with
`.replace(/\s+/g, " ").trim()`), which:
- Ignores wrapper tags entirely (`textContent` walks the subtree).
- Falls back to the legacy nested selector if the direct cell yields
  empty text — so an unexpectedly padded column layout still parses.
- Buttons are located by, in order, (a) any element inside the cell
  whose class contains the expected substring, (b) any clickable-ish
  element inside the cell, (c) an `id`-prefixed element anywhere on
  the row, (d) any element on the row whose class contains the
  substring.

**Verification.** `tests/Selectors.test.ts` runs six DOM shapes
through the parser (plain, `<span>` / `<em>` / `<strong>` in every
cell, row-level `data-tx-id`, span-level `data-id`, no-id fallback,
multiple-row uniqueness). All assertions pass under jsdom.

### Bug #4 — Retry Verification waited for the next polling cycle

**Why it happened.** After a first-pass verification failure the code
just re-queued the tx via `retriedNext` and returned. The next
attempt was gated behind `refreshInterval`.

**Fix.** Introduced an **inline retry** (single, un-counted) inside
`runOnce()`:

- If a submitted tx is still visible after `refresh → verify`, the
  same cycle immediately does `submit → refresh → verify` a second
  time, in-place.
- Everything about the retry stays event-driven — no retry counter,
  no exponential backoff, no maximum retry age. Anything still
  unverified after the inline retry is carried into the NEXT polling
  cycle (which will again run the same submit → verify → inline retry).
- Result: a tx that clears on the operator side will VERIFY on the
  first cycle, halving worst-case verification latency.
- The tx keeps being retried forever until (a) it disappears, (b) an
  operator manually rejects it (Skipped Transactions), or (c) it fails
  validation.

`CycleReport` gained an `inlineRetried` counter so the dashboard /
tests can distinguish the two kinds of retry.

**Verification.** `tests/BugFixes.test.ts →` *"first-pass failure
triggers an inline retry inside the same cycle"* (two submits, one
refresh cycle, verified) and *"inline retry that STILL fails is
carried over as retriedNext (event-driven, no counter)"*. The existing
event-driven retry test (`tests/BotEngine.test.ts →` *"Retry policy —
never time-bounded, stops as soon as tx disappears"*) continues to
pass — 5 sabotaged cycles ≠ 5 in-count, so the policy is still purely
event-driven.

### Bug #5 — Dashboard Improvements

Added `BotEngine.getMetrics()` returning a `BotMetrics` snapshot:
`pendingCount`, `retryCount`, `lastPollDurationMs`,
`avgPollDurationMs`, `lastRefreshAt`, `browserUptimeMs`, `queueSize`,
`avgVerificationMs`, `memoryRssBytes` (via `process.memoryUsage()`),
`cyclesCompleted`. A rolling window of 20 cycles feeds the averages.

- IPC: `bot:getMetrics`, forwarded through preload as
  `bot.getMetrics()` / `bot.onMetrics()`.
- Renderer: new `.metrics-grid` on the Dashboard displays 10 tiles
  refreshed on every cycle. No redesign — the tile strip lives between
  the existing stats grid and the two-column log/queue area.

**Verification.** `tests/BugFixes.test.ts →` *"engine.getMetrics()
returns a populated snapshot after a cycle"* asserts values are wired
end-to-end.

### Bug #6 — Database Viewer Improvements

The "Approval History" tab (which is the operator-facing view of the
DB) gained:
- Free-text search across `player`, `bonusReload`, `reason`, `status`,
  `verificationResult`.
- Status filter (`ALL / APPROVED / REJECTED / SKIPPED`).
- Column sort — click any header (PID / Time / Player / Amount /
  Bonus Reload / Status / Reason / Duration / Verification). Sort
  direction toggles with each click; the active column shows an arrow.
- Pagination — 25 / 50 / 100 / 250 per page selector plus prev/next
  buttons and a "N of M" counter.
- Existing `Export CSV` is untouched (still hits `bot:exportHistory`
  → `db.exportHistoryCsv`, exports the full history).

The DB Viewer tab keeps its Integrity + Cleanup buttons unchanged and
now also exposes a **Prune Old Logs** button (Bug #7).

DB schema was NOT touched.

### Bug #7 — Log Rotation

The Logger already wrote per-day files (`csv-YYYY-MM-DD.csv`,
`debug-YYYY-MM-DD.log`) but did not rotate mid-session and never
deleted anything. Now:

- Every write calls `rollIfNeeded()`. When the local calendar day
  changes, the CSV / debug paths are rebuilt for the new day and (if
  necessary) the CSV header is re-written.
- `pruneOldLogs()` deletes any file in the log directory whose name
  contains a `YYYY-MM-DD` stamp older than `logRetentionDays`. Called
  on every `configureFileSinks` call (which itself is called on
  startup and on every config save).
- Renderer exposes both:
  - A **Settings → Log File Retention (days)** input (0 disables
    auto-cleanup entirely).
  - A **DB Viewer → Prune Old Logs** button that runs the prune on
    demand and reports how many files were removed.

**Verification.** `tests/LogRotation.test.ts` covers today-file
creation, retention-based pruning, retention = 0 disabling, and CSV
append semantics.

---

## Architectural decisions

- **Two-pass verification is the right amount of inline retry.**
  A single inline retry cuts worst-case verification latency in half
  without breaking the event-driven contract. Anything unresolved
  after the inline retry is naturally carried to the next polling
  cycle — the outer loop preserves the same "retry forever until
  disappearance / manual reject / invalid" invariant.
- **Metrics live on BotEngine.** BotEngine already owns the polling
  loop and knows exactly when a cycle starts / ends, when a
  transaction is submitted, and when it is verified. Moving metrics
  into a separate module would have leaked BotEngine internals.
- **BrowserManager owns uptime + last-refresh.** Only the module that
  actually opens the browser can accurately report when it opened;
  only the code that calls `page.reload()` can attribute the
  timestamp. `IBrowser.uptimeMs` / `lastRefreshIso` are marked
  optional so unit tests (with the fake) keep the surface minimal.
- **Selectors constants are the single source of truth.** The parser
  reads column indexes and class substrings from `Selectors`; the
  legacy CSS selectors survive purely as a defensive fallback. Future
  panel changes edit `Selectors.ts` only.
- **txId is optional.** Some panels genuinely lack a stable per-row
  identifier. The composite key
  (`username|amount|transactionDate`) is retained as a graceful
  fallback so the bot degrades gracefully rather than blocking.
- **Renderer stays vanilla JS.** No bundler, no framework — the tab
  layout and existing IIFE guard are preserved. Search/sort/paginate
  are client-side because the entire history typically fits in a
  single `bot.getHistory(5000, 0)` fetch, keeping the DB layer free
  of query builders.

---

## Test results

Run from `/app/bot-reload/bonus-reload-bot`:

### TypeScript build

```
$ npm run build
> npm run clean && npm run build:main && npm run build:renderer
> tsc -p tsconfig.main.json      # succeeded, no errors
> node scripts/copy-renderer.js  # succeeded
```

### Lint (typecheck main + renderer types)

```
$ npm run lint
> tsc --noEmit -p tsconfig.main.json
(exit 0)
```

### Unit tests

```
$ npm test
Test Suites: 8 passed, 8 total
Tests:       64 passed, 64 total
```

Suite breakdown:

| Suite | Tests | Notes |
|------|-------|-------|
| `tests/RuleEngine.test.ts`     | 6 pre-existing | untouched |
| `tests/Database.test.ts`       | 6 pre-existing | untouched |
| `tests/portable-paths.test.ts` | 7 pre-existing | untouched |
| `tests/BotEngine.test.ts`      | 15 pre-existing | untouched — all still pass with the new workflow |
| `tests/LiveLogFilter.test.ts`  | 5 pre-existing | untouched |
| `tests/BugFixes.test.ts`       | 7 NEW | bugs #1, #2, #4, #5 |
| `tests/Selectors.test.ts`      | 14 NEW | bug #3 (7 DOM parser tests + 7 regex-pattern tests) |
| `tests/LogRotation.test.ts`    | 4 NEW | bug #7 |
| **Total**                      | **64 / 64** | |

### Manual verification steps (Windows workstation)

Because this environment is a headless Linux container with no
display server, the Electron GUI cannot be launched here. On Windows:

1. **Portable build**
   `npm install`
   `npm run dist:portable`
   Confirms the electron-rebuild + electron-builder pipeline still
   produces a single `.exe`. No `package.json` / native module contracts
   were altered.

2. **Bug #1 smoke test (needs a stub panel)**
   Serve a local HTML panel (or use the real production panel) that
   emits rows with `id="btn-approve-<txId>"`. Start the bot, then
   during a polling cycle prepend a new row to the DOM by hand from
   DevTools. Confirm the log line
   `[hh:mm:ss] VERIFIED  <player> ...` names the ORIGINAL player, not
   the newly-inserted one.

3. **Bug #2 smoke test**
   Set `refreshInterval` to `10000` from Settings, click "Save
   Configuration". Confirm the browser panel visibly reloads
   approximately every 10 s. Change it to `1500`, save; the reload
   cadence should visibly speed up.

4. **Bug #4 smoke test**
   Point the bot at a panel where `approve()` succeeds only on the
   second click (simulate with any test panel). The Live Log should
   show `SUBMITTED → RETRY (inline) → VERIFIED` within a single
   cycle, and `retryCount` on the Dashboard should tick back to zero.

5. **Bug #5 smoke test**
   Start the bot and watch the 10-tile metrics strip on the Dashboard
   populate. Poll (last/avg) and Verify (avg) should update after each
   cycle; Browser uptime should increment monotonically while the
   panel is open; Memory (RSS) should show a live number.

6. **Bug #6 smoke test**
   Go to Approval History. Type a partial player name in the search
   box → table filters live. Click a column header → arrows appear
   and the sort direction toggles. Change page size / prev / next
   pages. Export CSV still works.

7. **Bug #7 smoke test**
   In Settings, set Log File Retention (days) to a small value like
   `2` and save. Copy an older `csv-YYYY-MM-DD.csv` into `data/logs/`.
   Click **Prune Old Logs** on the DB Viewer tab; the file should
   disappear and the result box report `removed <n> old log files`.

---

## New risks / caveats

- **Panels without any stable identifier.** If the target panel emits
  neither `id="btn-approve-<n>"`, nor `onclick="approve(<n>)"`, nor
  any `data-*` attribute, `txId` will be empty and BrowserManager
  falls back to the composite key (`username|amount|
  transactionDate`). This is safer than `rowIndex` (composite keys are
  stable across re-orderings) but two rows sharing the same
  user/amount/date within the same panel — extremely unlikely in
  practice — would be indistinguishable. If that ever happens, the
  panel needs a data attribute.
- **Inline retry doubles work per cycle in the failure case.** In the
  common happy path the retry is skipped (both bulk arrays empty →
  early break); when things go wrong the cycle now costs 2 × submit +
  1 × extra refresh + 1 × extra read. Cycle-duration averages account
  for this. The refresh count is exactly what the RFC prescribes.
- **`row.cells[idx]` requires `<tr>` to be inside a `<table>`.** The
  reference panel already satisfies this. If the panel skin ever
  detaches rows from their table, the legacy `td:nth-child`
  fallbacks kick in — which is why they were preserved.

---

## Known remaining issues

None resulting from this task. The problem statement's 7 items are
all addressed. Optional follow-ups (out of scope for V1):

- Server-side pagination for the Approval History if it ever grows
  past ~50k rows.
- A dedicated "raw SQL" viewer inside the DB Viewer tab for support
  operators (would require a read-only exec).
- Chart-style visualisation of `avgPollDurationMs` over time.

None of these are blockers.
