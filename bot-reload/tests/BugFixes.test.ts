/**
 * Tests protecting the core V1 bug fixes:
 *
 *   Bug #1 — BrowserManager identifies transactions by txId, NOT rowIndex.
 *            Inserting a new row before an existing pending transaction
 *            must NOT change which transaction gets approved.
 *
 *   Bug #2 — Panel Refresh Interval. Each polling cycle must invoke
 *            `browser.refresh()` at the top of the cycle (except the
 *            very first cycle after start) so the setting genuinely
 *            controls how often the browser panel reloads.
 *
 *   Bug #4 — Retry Verification. When a first submit does not clear a
 *            row from the panel, the SAME cycle must submit again,
 *            refresh, and verify again — without waiting for the next
 *            polling cycle and WITHOUT any retry-counter / backoff.
 *
 * Bug #3 (selector robustness) is covered by tests/Selectors.test.ts,
 * which loads the DOM parser via jsdom.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BotEngine } from "../src/bot/BotEngine";
import { Database } from "../src/bot/Database";
import { Logger } from "../src/bot/Logger";
import { RuleEngine } from "../src/bot/RuleEngine";
import { AppConfig, IBrowser, Transaction } from "../src/bot/types";
import { FakeBrowser, tx } from "./fakes";

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    startURL: "", refreshInterval: 3000, minDelay: 0, maxDelay: 0,
    dailyLimitAction: "skip", bonus5000CooldownMinutes: 10,
    cleanupRetentionDays: 90, historyExportPath: "", debugLogLevel: "error",
    logRetentionDays: 30, ...over
  };
}
function setup(over: Partial<AppConfig> = {}) {
  const file = path.join(os.tmpdir(), `bugfix-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(file);
  const logger = new Logger();
  const browser: IBrowser = new FakeBrowser();
  const engine = new BotEngine(browser, db, new RuleEngine(), logger, makeConfig(over));
  return { engine, browser: browser as FakeBrowser, db, file, logger };
}
function cleanup(db: Database, file: string) {
  db.close();
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Bug #1 — identity by txId, not rowIndex
// ---------------------------------------------------------------------------

test("Bug #1 — approve targets the txId, not the row order (new row inserted mid-cycle is safe)", async () => {
  const { engine, browser, db, file } = setup();
  const original = tx("alice", 5000, "Bonus Reload", "2026-01-15T10:00:00", "1000001");
  browser.setPending([original]);

  /**
   * Wrap the browser so that BETWEEN the "read pending" step and the
   * "approve" step, a brand-new transaction lands at row 0 (row order
   * changes). The original tx moves from rowIndex 0 → rowIndex 1.
   * A rowIndex-based approver would now approve the wrong tx.
   */
  const brk = browser as unknown as {
    readPendingTransactions: () => Promise<Transaction[]>;
  };
  const originalRead = brk.readPendingTransactions.bind(browser);
  brk.readPendingTransactions = async () => {
    const list = await originalRead();
    // Inject a new pending row BEFORE the approve call by mutating
    // pending after the read but before the write.
    if (browser.approveBatches.length === 0) {
      browser.setPending([
        tx("intruder", 5000, "Bonus Reload", "2026-01-15T10:00:30", "1000002"),
        original
      ]);
    }
    return list;
  };

  await engine.runOnce();

  // The approve batch must reference the ORIGINAL txId (1000001), not
  // whichever transaction happened to sit at rowIndex 0 when we submitted.
  expect(browser.approveBatches.length).toBe(1);
  expect(browser.approveBatches[0].length).toBe(1);
  expect(browser.approveBatches[0][0].txId).toBe("1000001");
  expect(browser.approveBatches[0][0].username).toBe("alice");
  cleanup(db, file);
});

test("Bug #1 — reject-single from Skipped Transactions carries txId all the way to the browser", async () => {
  const { engine, browser, db, file } = setup({ dailyLimitAction: "skip" });
  browser.setPending([
    tx("kate", 10000, "Bonus Reload", "2026-01-15T10:00:00", "2000001"),
    tx("kate",  5000, "Bonus Reload", "2026-01-15T10:05:00", "2000002")  // over the limit
  ]);
  await engine.runOnce();
  const row = engine.skippedQueue.list()[0];
  expect(row.txId).toBe("2000002");

  browser.setPending([tx("kate", 5000, "Bonus Reload", "2026-01-15T10:05:00", "2000002")]);
  await engine.rejectSkipped(row.key);

  expect(browser.rejectSingles.length).toBe(1);
  expect(browser.rejectSingles[0].txId).toBe("2000002");
  cleanup(db, file);
});

// ---------------------------------------------------------------------------
// Bug #2 — refresh interval truly controls browser reload frequency
// ---------------------------------------------------------------------------

test("Bug #2 — every polling cycle after the first performs a browser.refresh() at the top", async () => {
  const { engine, browser, db, file } = setup();
  // Empty panel — no submit, no verify. Just cycles.
  browser.setPending([]);

  await engine.runOnce();                       // cycle 1 — no top-of-cycle refresh
  expect(browser.refreshes).toBe(0);

  await engine.runOnce();                       // cycle 2 — refresh at the top
  expect(browser.refreshes).toBeGreaterThanOrEqual(1);

  await engine.runOnce();                       // cycle 3 — another top-of-cycle refresh
  expect(browser.refreshes).toBeGreaterThanOrEqual(2);
  cleanup(db, file);
});

test("Bug #2 — top-of-cycle refresh happens even when the previous cycle submitted nothing", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([]);
  await engine.runOnce();                       // cycle 1 — no refresh
  await engine.runOnce();                       // cycle 2 — refresh even though nothing was submitted last cycle
  await engine.runOnce();                       // cycle 3 — refresh even though nothing was submitted last cycle
  // Two top-of-cycle refreshes (cycles 2 & 3). No submit-time refreshes
  // fired because no batch was ever queued.
  expect(browser.refreshes).toBe(2);
  cleanup(db, file);
});

// ---------------------------------------------------------------------------
// Bug #4 — inline retry inside the same cycle (submit → refresh → verify → retry)
// ---------------------------------------------------------------------------

test("Bug #4 — first-pass failure triggers an inline retry inside the same cycle", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("liam", 5000, "Bonus Reload", "2026-01-15T09:00:00", "3000001")]);

  // Sabotage only the FIRST submit; then let the retry succeed.
  browser.sabotageApprove = true;
  const originalApprove = browser.approveMultipleTransactions.bind(browser);
  browser.approveMultipleTransactions = async (txs: Transaction[]) => {
    await originalApprove(txs);
    // After the first submit, drop sabotage so the retry inside the SAME
    // cycle clears the row.
    browser.sabotageApprove = false;
  };

  const r = await engine.runOnce();

  // TWO submits inside a single cycle — first one sabotaged, second one clears.
  expect(browser.approveBatches.length).toBe(2);
  expect(r.inlineRetried).toBeGreaterThanOrEqual(1);
  expect(r.verifiedApprove).toBe(1);
  expect(r.retriedNext).toBe(0);
  expect(db.sumTodayForUser("liam")).toBe(5000);
  cleanup(db, file);
});

test("Bug #4 — inline retry that STILL fails is carried over as retriedNext (event-driven, no counter)", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("mia", 5000, "Bonus Reload", "2026-01-15T09:00:00", "3000002")]);
  browser.sabotageApprove = true;                                       // permanent sabotage

  const r = await engine.runOnce();
  expect(browser.approveBatches.length).toBe(2);                        // one submit + one inline retry
  expect(r.verifiedApprove).toBe(0);
  expect(r.retriedNext).toBe(1);                                        // carried over to next cycle
  expect(db.sumTodayForUser("mia")).toBe(0);                            // no optimistic approval

  // Second cycle keeps retrying — still event-driven, no backoff.
  browser.sabotageApprove = false;
  const r2 = await engine.runOnce();
  expect(r2.verifiedApprove).toBe(1);
  expect(db.sumTodayForUser("mia")).toBe(5000);
  cleanup(db, file);
});

// ---------------------------------------------------------------------------
// Metrics (Bug #5) — smoke test that Dashboard payload is populated.
// ---------------------------------------------------------------------------

test("Bug #5 — engine.getMetrics() returns a populated snapshot after a cycle", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("nick", 10000, "Bonus Reload", "2026-01-15T09:00:00", "4000001")]);
  await browser.launch("");                        // ensures uptimeMs > 0
  const before = engine.getMetrics();
  expect(before.cyclesCompleted).toBe(0);
  expect(before.memoryRssBytes).toBeGreaterThan(0);

  await engine.runOnce();
  const after = engine.getMetrics();
  expect(after.cyclesCompleted).toBe(1);
  expect(after.pendingCount).toBe(1);
  expect(after.lastPollDurationMs).toBeGreaterThanOrEqual(0);
  expect(after.avgVerificationMs).toBeGreaterThanOrEqual(0);
  expect(after.browserUptimeMs).toBeGreaterThanOrEqual(0);
  cleanup(db, file);
});
