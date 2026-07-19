# PRD — Bonus Reload Bot V1

**Reference repo:** `https://github.com/fitriadijuhar-commits/BOT-APPROVE-RELOAD`
**Working tree:** `/app/bot-reload/bonus-reload-bot`
**Stack:** Electron + TypeScript + Playwright + better-sqlite3 (Vanilla renderer).

## Original problem statement
Continue development of the Electron desktop bot. Fix 7 outstanding
production bugs while preserving the strict architectural boundaries
(RuleEngine pure, only BrowserManager imports Playwright, Database
owns SQLite, BotEngine owns workflow).

## Architecture (preserved)
```
Renderer ── IPC ── BotEngine
                    ├── RuleEngine     (pure validator)
                    ├── PendingCache   (in-memory)
                    ├── ManualReviewQueue (Skipped Transactions)
                    ├── CooldownTracker
                    ├── Database       (SQLite persistence)
                    ├── Logger         (structured + CSV + debug + rotation)
                    └── BrowserManager ── Playwright
```

## What has been implemented (Jan 2026)
| Bug | Status | Delta |
|-----|--------|-------|
| #1 rowIndex → txId identity                | ✅ | `Transaction.txId`, extraction from button id/onclick/data-attrs, txId-based approve/reject dispatch. |
| #2 Panel refresh interval → real browser reload | ✅ | Loop reordered (`wait → refresh → read → process → verify`); refresh at top of every cycle from #2 onward. |
| #3 Robust selectors                        | ✅ | Column-index cell parsing; wrapper-tolerant; legacy fallback preserved. |
| #4 Retry verification                      | ✅ | Inline retry (single pass) inside the same cycle; still event-driven; no counter/backoff. |
| #5 Dashboard metrics                       | ✅ | `BotEngine.getMetrics()`, `bot:getMetrics`, 10-tile metrics grid. |
| #6 DB / History viewer improvements        | ✅ | Search, filter, sort, pagination, existing CSV export retained. |
| #7 Log rotation                            | ✅ | Mid-session daily rotation, retention-based prune, `logRetentionDays` setting, manual prune button. |

Existing production contracts kept intact — see `DELIVERABLES.md` for
per-file scope of change.

## Test results
- TypeScript build: PASS (`npm run build`).
- Lint: PASS (`npm run lint`).
- Unit tests: **64 / 64 pass** across 8 suites
  (`RuleEngine`, `Database`, `portable-paths`, `BotEngine`,
  `LiveLogFilter`, `BugFixes` (new), `Selectors` (new),
  `LogRotation` (new)).

## Backlog (P2)
- Server-side pagination for Approval History (only relevant beyond
  ~50k rows).
- Chart-style visualisation of poll / verify duration trends on the
  Dashboard.
- Read-only SQL console in the DB Viewer tab for support operators.

## Next action items
1. Final GUI verification on a Windows workstation (see
   `DELIVERABLES.md` → *Manual verification steps*).
2. Cut a portable Windows build (`npm run dist:portable`) and confirm
   the `.exe` still ships in one file.
3. When happy, push the current tree to the GitHub repo (via the
   platform's "Save to Github" flow — the repo history is intact).
