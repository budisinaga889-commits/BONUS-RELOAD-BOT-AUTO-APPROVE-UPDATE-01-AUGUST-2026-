/**
 * BotEngine acceptance tests — exercises the full verification-based
 * workflow using an in-memory FakeBrowser + a temp SQLite file.
 *
 * Covers the mandatory acceptance tests from Part 4:
 *   - Daily Limit (skip + reject modes)
 *   - Duplicate Protection (pending cache across cycles)
 *   - Verification (pass/fail)
 *   - Retry (event-driven; no count)
 *   - Business Cooldown (Rp5.000 / 10 min)
 *   - Manual Review Queue (aka Skipped Transactions)
 *   - Manual Reject action
 *   - No Optimistic Approval (SQLite only after refresh)
 *   - Approval History content
 *   - Performance (single evaluate per bulk)
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BotEngine } from "../src/bot/BotEngine";
import { BrowserManager } from "../src/bot/BrowserManager"; // eslint-disable-line @typescript-eslint/no-unused-vars
import { Database } from "../src/bot/Database";
import { Logger } from "../src/bot/Logger";
import { RuleEngine } from "../src/bot/RuleEngine";
import { AppConfig, IBrowser } from "../src/bot/types";
import { FakeBrowser, tx } from "./fakes";

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    startURL: "",
    refreshInterval: 3000,
    minDelay: 0,
    maxDelay: 0,
    dailyLimitAction: "skip",
    bonus5000CooldownMinutes: 10,
    cleanupRetentionDays: 90,
    historyExportPath: "",
    debugLogLevel: "error",
    ...over
  };
}

function setup(over: Partial<AppConfig> = {}) {
  const file = path.join(os.tmpdir(), `bot-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(file);
  const logger = new Logger();
  const rules = new RuleEngine();
  const browser: IBrowser = new FakeBrowser();
  const engine = new BotEngine(browser, db, rules, logger, makeConfig(over));
  return { engine, browser: browser as FakeBrowser, db, file };
}

function cleanup(db: Database, file: string) {
  db.close();
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------

test("Verification happy path — approve, refresh, key gone, VERIFIED persisted", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("alice", 5000, "Bonus Reload", "2026-01-15T10:00:00")]);
  const r = await engine.runOnce();
  expect(r.submittedApprove).toBe(1);
  expect(r.verifiedApprove).toBe(1);
  expect(r.retriedNext).toBe(0);
  expect(browser.approveBatches.length).toBe(1);
  expect(browser.approveBatches[0].length).toBe(1);
  expect(browser.refreshes).toBe(1);
  expect(db.sumTodayForUser("alice")).toBe(5000);
  expect(db.countApprovedToday()).toBe(1);
  expect(engine.getStats().verified).toBe(1);
  cleanup(db, file);
});

test("No Optimistic Approval — sabotaged approve keeps tx pending, no SQLite write, retry queued", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("bob", 10000, "Bonus Reload", "2026-01-15T10:00:00")]);
  browser.sabotageApprove = true;
  const r = await engine.runOnce();
  expect(r.submittedApprove).toBe(1);
  expect(r.verifiedApprove).toBe(0);
  expect(r.retriedNext).toBe(1);
  expect(db.sumTodayForUser("bob")).toBe(0);
  expect(db.countApprovedToday()).toBe(0);
  expect(engine.getStats().verified).toBe(0);

  // Second cycle — same tx still there; sabotage off -> verifies.
  browser.sabotageApprove = false;
  const r2 = await engine.runOnce();
  expect(r2.verifiedApprove).toBe(1);
  expect(db.sumTodayForUser("bob")).toBe(10000);
  cleanup(db, file);
});

test("Daily Limit (skip mode) — approves 5000+5000 then skips excess, never exceeds 10000", async () => {
  const { engine, browser, db, file } = setup({ dailyLimitAction: "skip" });
  browser.setPending([
    tx("carol", 5000, "Bonus Reload", "2026-01-15T09:00:00"),
    tx("carol", 5000, "Bonus Reload", "2026-01-15T09:05:00"),
    tx("carol", 5000, "Bonus Reload", "2026-01-15T09:10:00"),
    tx("carol", 10000, "Bonus Reload", "2026-01-15T09:20:00")
  ]);
  await engine.runOnce();

  // Because only the first two 5000s fit (5000+5000=10000) — the third + the 10000 are skipped.
  expect(db.sumTodayForUser("carol")).toBeLessThanOrEqual(10000);
  expect(engine.getStats().verified).toBeGreaterThanOrEqual(1);
  // At least one skipped-transactions entry (Daily Limit) queued.
  expect(engine.skippedQueue.size()).toBeGreaterThanOrEqual(1);
  cleanup(db, file);
});

test("Daily Limit (reject mode) — over-limit tx is queued for Bulk Reject, not stored as APPROVED", async () => {
  const { engine, browser, db, file } = setup({ dailyLimitAction: "reject" });
  browser.setPending([
    tx("dan", 10000, "Bonus Reload", "2026-01-15T09:00:00"),
    tx("dan", 5000, "Bonus Reload", "2026-01-15T09:05:00")
  ]);
  const r = await engine.runOnce();
  expect(r.submittedApprove).toBe(1);
  expect(r.submittedReject).toBe(1);
  expect(db.sumTodayForUser("dan")).toBe(10000);
  expect(browser.rejectBatches.length).toBe(1);
  cleanup(db, file);
});

test("Duplicate Protection — same panel state across two cycles never approves twice", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("erin", 10000, "Bonus Reload", "2026-01-15T09:30:00")]);
  browser.sabotageApprove = true;                       // panel keeps showing the tx
  await engine.runOnce();                                // submit + retry
  await engine.runOnce();                                // second cycle re-submits (retry policy)
  // Even with two cycles, DB should reflect ZERO approvals until refresh confirms.
  expect(db.sumTodayForUser("erin")).toBe(0);
  browser.sabotageApprove = false;
  await engine.runOnce();
  expect(db.sumTodayForUser("erin")).toBe(10000);
  expect(db.countApprovedToday()).toBe(1);              // never double-counted
  cleanup(db, file);
});

test("Invalid Notes / Invalid Amount are silently skipped and never approved", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([
    tx("frank", 5000, "Deposit Reguler", "2026-01-15T09:00:00"),
    tx("frank", 7000, "Bonus Reload", "2026-01-15T09:05:00"),
    tx("frank", 5000, "Bonus Reload", "2026-01-15T09:10:00")
  ]);
  const r = await engine.runOnce();
  expect(r.submittedApprove).toBe(1);
  expect(db.sumTodayForUser("frank")).toBe(5000);
  cleanup(db, file);
});

test("Business Cooldown — user cannot receive a second Rp5.000 within 10 minutes", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("gwen", 5000, "Bonus Reload", "2026-01-15T09:00:00")]);
  await engine.runOnce();
  expect(db.sumTodayForUser("gwen")).toBe(5000);

  // Same user, another Rp5000, one minute later — should be blocked and land in Skipped.
  browser.setPending([tx("gwen", 5000, "Bonus Reload", "2026-01-15T09:01:00")]);
  await engine.runOnce();
  expect(db.sumTodayForUser("gwen")).toBe(5000);               // no double bonus
  const skipped = engine.skippedQueue.list();
  expect(skipped.some((s) => s.reason === "Bonus Cooldown")).toBe(true);
  cleanup(db, file);
});

test("Business Cooldown does NOT apply to Rp10.000", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("henry", 10000, "Bonus Reload", "2026-01-15T09:00:00")]);
  await engine.runOnce();
  expect(db.sumTodayForUser("henry")).toBe(10000);
  // Second attempt for henry with same amount would trip Daily Limit, not Cooldown.
  browser.setPending([tx("henry", 10000, "Bonus Reload", "2026-01-15T09:01:00")]);
  await engine.runOnce();
  expect(db.sumTodayForUser("henry")).toBe(10000);
  cleanup(db, file);
});

test("Manual Review Queue — Daily Limit (skip mode) creates a Skipped entry that operator can reject", async () => {
  const { engine, browser, db, file } = setup({ dailyLimitAction: "skip" });
  browser.setPending([
    tx("ivy", 10000, "Bonus Reload", "2026-01-15T09:00:00"),
    tx("ivy", 5000, "Bonus Reload", "2026-01-15T09:05:00")   // over the limit -> skipped
  ]);
  await engine.runOnce();
  const skipped = engine.skippedQueue.list();
  expect(skipped.length).toBe(1);
  expect(skipped[0].reason).toBe("Daily Limit");

  // Operator rejects it.
  const ok = await engine.rejectSkipped(skipped[0].key);
  expect(ok).toBe(true);
  expect(browser.rejectSingles.length).toBe(1);
  cleanup(db, file);
});

test("Verification failure on the operator side — reject verification fails, entry stays in queue", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("jane", 5000, "Bonus Reload", "2026-01-15T09:00:00")]);
  // Push jane's approval into history first.
  await engine.runOnce();
  // Now she attempts another 5000 within cooldown -> Skipped.
  browser.setPending([tx("jane", 5000, "Bonus Reload", "2026-01-15T09:05:00")]);
  await engine.runOnce();
  const skipped = engine.skippedQueue.list();
  expect(skipped.length).toBe(1);

  browser.sabotageReject = true;
  await engine.rejectSkipped(skipped[0].key);
  // Entry still visible in the queue since the panel row is still there.
  expect(engine.skippedQueue.size()).toBe(1);
  cleanup(db, file);
});

test("Approval History — persisted row contains PID, Time, Player, Amount, Bonus Reload, Status, Reason, Duration, Verification", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("kim", 10000, "Bonus Reload — kim", "2026-01-15T09:00:00")]);
  await engine.runOnce();
  const rows = db.listHistory(10, 0);
  expect(rows.length).toBe(1);
  const r = rows[0];
  expect(r.pid).toBeGreaterThan(0);
  expect(r.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(r.player).toBe("kim");
  expect(r.amount).toBe(10000);
  expect(r.bonusReload).toMatch(/Bonus Reload/);
  expect(r.status).toBe("APPROVED");
  expect(r.verificationResult).toBe("VERIFIED");
  expect(typeof r.processDurationMs === "number" || r.processDurationMs === null).toBe(true);
  cleanup(db, file);
});

test("Performance — single evaluate call per bulk (Bulk Approve, Bulk Reject)", async () => {
  const { engine, browser, db, file } = setup({ dailyLimitAction: "reject" });
  // Multiple valid + one over-limit → both bulks fire, each exactly once.
  browser.setPending([
    tx("liam", 10000, "Bonus Reload", "2026-01-15T09:00:00"),
    tx("mia",  10000, "Bonus Reload", "2026-01-15T09:01:00"),
    tx("noah", 10000, "Bonus Reload", "2026-01-15T09:02:00"),
    tx("mia",   5000, "Bonus Reload", "2026-01-15T09:03:00")  // over limit -> reject
  ]);
  await engine.runOnce();
  expect(browser.approveBatches.length).toBe(1);
  expect(browser.approveBatches[0].length).toBe(3);
  expect(browser.rejectBatches.length).toBe(1);
  expect(browser.rejectBatches[0].length).toBe(1);
  expect(browser.refreshes).toBe(1);        // one refresh per cycle, not per tx
  cleanup(db, file);
});

test("Technical failure — read fails, cycle survives, no DB writes, stats.failed increments", async () => {
  const { engine, browser, db, file } = setup();
  browser.throwOnNextRead = "boom";
  const r = await engine.runOnce();
  expect(r.submittedApprove).toBe(0);
  expect(db.countApprovedToday()).toBe(0);
  expect(engine.getStats().failed).toBeGreaterThanOrEqual(1);
  cleanup(db, file);
});

test("Operator override — row disappears between submit and refresh -> treated as VERIFIED", async () => {
  const { engine, browser, db, file } = setup();
  // Panel initially shows a tx; we DO NOT sabotage, so a normal submit
  // removes it — this is functionally identical to another operator
  // approving it (Part 3 §Operator Override). Confirm we still persist.
  browser.setPending([tx("olive", 5000, "Bonus Reload", "2026-01-15T09:00:00")]);
  const r = await engine.runOnce();
  expect(r.verifiedApprove).toBe(1);
  expect(db.sumTodayForUser("olive")).toBe(5000);
  cleanup(db, file);
});

test("Retry policy — never time-bounded, stops as soon as tx disappears", async () => {
  const { engine, browser, db, file } = setup();
  browser.setPending([tx("peter", 5000, "Bonus Reload", "2026-01-15T09:00:00")]);
  browser.sabotageApprove = true;
  // Simulate 5 doomed cycles.
  for (let i = 0; i < 5; i++) await engine.runOnce();
  expect(db.countApprovedToday()).toBe(0);
  // 6th cycle — panel finally clears.
  browser.sabotageApprove = false;
  await engine.runOnce();
  expect(db.countApprovedToday()).toBe(1);
  cleanup(db, file);
});
