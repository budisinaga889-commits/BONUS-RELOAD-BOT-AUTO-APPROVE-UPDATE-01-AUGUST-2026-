# Bonus Reload Bot — V1

Production-hardened rebuild of the deposit-approval bot. Full **Electron +
TypeScript + Playwright + better-sqlite3** stack.

## Guarantees

- **No Optimistic Approval.** SQLite is only ever written *after* the panel
  refresh confirms the transaction disappeared (Part 3 §Verification).
- **Daily Limit never exceeded.** Rp10.000 per user per calendar day is
  enforced by the BotEngine before *and* after every submit.
- **Duplicate protection.** Same-panel duplicates are dropped inside one
  cycle via the in-memory Pending Cache keyed by
  `${username}|${amount}|${transactionDate}`.
- **Event-driven retries.** No fixed counter, no exponential backoff — a
  transaction is simply re-evaluated on every polling cycle while it
  still exists in the panel and no business-final block applies.
- **Bulk performance preserved.** Bulk Approve and Bulk Reject fire inside
  a *single* `page.evaluate()`, exactly like the reference implementation.
- **Business Cooldown.** Rp5.000 bonuses are limited to one per user every
  10 minutes (configurable). Rp10.000 bonuses are only bound by the
  Daily Limit.

## Architecture

```
Renderer  ->  IPC  ->  BotEngine
                        ├── RuleEngine   (pure validator)
                        ├── PendingCache (in-memory)
                        ├── ManualReviewQueue (Skipped Transactions)
                        ├── CooldownTracker
                        ├── Database     (SQLite persistence only)
                        ├── Logger       (structured + CSV + debug)
                        └── BrowserManager -> Playwright
```

Dependencies are strictly one-directional — no module reaches upward.
The **only** module that imports `playwright` is `BrowserManager`.

## Getting started

```bash
npm install     # installs deps AND auto-rebuilds better-sqlite3 for Electron
npm run build
npm start       # launches Electron
```

The `postinstall` hook runs `@electron/rebuild` automatically so that
`better-sqlite3` (a native Node addon) is compiled against Electron's
`NODE_MODULE_VERSION` — no manual rebuild is ever required. When
running `npm test`, a `pretest` hook flips it back to the Node ABI just
for Jest, then `postinstall` is only re-triggered on the next `npm
install`.

### Utility scripts

| Command                    | What it does                                                        |
|----------------------------|---------------------------------------------------------------------|
| `npm run rebuild:native`   | Force-rebuild native modules for the current Electron version.      |
| `npm run rebuild:node`     | Rebuild native modules for the plain Node.js ABI (useful for tests).|
| `SKIP_ELECTRON_REBUILD=1 npm install` | Skip the Electron rebuild (CI / test-only setups).       |

To produce a distributable installer:

```bash
npm run dist:portable   # Windows PORTABLE .exe (single-file, no install)
npm run dist:linux      # Linux AppImage
npm run dist            # every default target for the current OS
```

## Portable Windows build

The Windows target is `electron-builder`'s **portable** target — a single
self-contained `.exe` that extracts at launch, uses **zero** system
locations, and requires **no installer or admin privileges**.

### Portable data layout

Every writable byte lives next to the `.exe` under a `data/`
sub-directory. Nothing is written to `%APPDATA%`, `%LOCALAPPDATA%`,
`%TEMP%` or the Registry:

```
Bonus Reload Bot-1.0.0-portable.exe
data/
├── bonusbot.db          ← SQLite Approval History
├── config.json          ← writable config (seeded on first run)
├── browser-profile/     ← persistent Playwright/Chrome profile
├── logs/                ← daily CSV + debug log
├── exports/             ← default target of History Export
├── electron/            ← Electron session storage
├── cache/               ← Electron HTTP cache
└── temp/                ← Electron temp files
```

### Data-root resolution order

1. `BONUS_BOT_DATA_DIR` env var — explicit override (e.g. a shared network drive).
2. `PORTABLE_EXECUTABLE_DIR` — set by electron-builder's portable runtime; points to the folder containing the `.exe`.
3. Directory of `process.execPath` — packaged non-portable fallback.
4. `process.cwd()` — dev / `npm start` fallback.

### Upgrading

Replace the `.exe` in place. Because the `data/` folder is not touched
by the extraction step, **all Approval History, config, browser
sessions and logs are preserved** automatically.

### Moving to another PC

Copy the whole folder (`.exe` + `data/`) to the target machine. No
registry keys, no user-profile references — everything travels with
the folder.

To produce other installer targets:

## Running the acceptance test suite

```bash
npm test
```

Covers the mandatory acceptance tests (Part 4) headlessly via an in-memory
fake browser:

- Daily Limit (skip + reject modes)
- Duplicate Protection
- Pending Cache
- Verification (pass, fail, operator override)
- Retry (event-driven)
- Business Cooldown (Rp5.000 / 10 min)
- Manual Review Queue + Manual Reject
- Approval History content
- Performance (single `page.evaluate` per bulk)
- Database integrity + cleanup

## Configuration (config/config.json)

| Key                          | Default | Purpose                                                 |
|------------------------------|--------:|---------------------------------------------------------|
| `startURL`                   |    `""` | Panel URL opened by "Open Panel".                       |
| `refreshInterval`            |  `3000` | Polling interval in ms.                                 |
| `dailyLimitAction`           |`"skip"` | `skip` → Manual Review Queue, `reject` → Bulk Reject.   |
| `bonus5000CooldownMinutes`   |    `10` | Business Cooldown window for Rp5.000 per user.          |
| `cleanupRetentionDays`       |    `90` | Days of history retained by Database Cleanup.           |
| `historyExportPath`          |    `""` | Fixed export path (empty = show Save dialog).           |
| `debugLogLevel`              |`"info"` | `error` / `warn` / `info` / `debug`.                    |

## Environment variables

| Variable              | Effect                                              |
|-----------------------|-----------------------------------------------------|
| `BOT_HEADLESS=1`      | Launch Playwright headless.                         |
| `BOT_BROWSER_CHANNEL` | Force a specific browser channel (default: chrome). |

## Data locations

Development:  `./userdata/`, `./bonusbot.db`, `./logs/`, `./config/config.json`
Packaged:     `<userData>/chrome-profile`, `<userData>/bonusbot.db`,
              `<userData>/logs`, `<resources>/config/config.json`

## Module contracts (Part 5 §6)

- **BrowserManager** – Playwright automation only. No business logic, no DB.
- **BotEngine** – Owns workflow, queues, daily limit, cooldown, retry, verification.
- **RuleEngine** – Pure validator (notes + amount). No DB, no browser, no side effects.
- **Database** – Persistence only. VERIFIED approvals + rejects; never pending.
- **Logger** – Logging only (memory event stream + CSV + debug log file).
- **ManualReviewQueue** – In-memory Skipped Transactions.
- **Renderer** – Presentation only. No business logic.
