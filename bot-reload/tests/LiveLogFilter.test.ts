/**
 * Live Log filtering (Task 2)
 *
 * Confirms the operator-facing "log" event stream only carries actionable
 * business events, while the CSV/debug diagnostics still receive
 * everything.
 *
 * Actionable (must reach the operator via `logger.on("log", …)`):
 *   - SUBMITTED, VERIFIED, RETRY, FAILED, INFO
 *   - SKIPPED with reason "Daily Limit"
 *   - SKIPPED with reason "Bonus Cooldown"
 *
 * Silent (must NOT be emitted to the operator, but still written to
 * console + CSV + debug log):
 *   - SKIPPED "Invalid Notes"
 *   - SKIPPED "Invalid Amount"
 *   - SKIPPED "Parse Error"
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BotEngine } from "../src/bot/BotEngine";
import { Database } from "../src/bot/Database";
import { Logger } from "../src/bot/Logger";
import { RuleEngine } from "../src/bot/RuleEngine";
import { AppConfig, LogEntry } from "../src/bot/types";
import { FakeBrowser, tx } from "./fakes";

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    startURL: "", refreshInterval: 3000, minDelay: 0, maxDelay: 0,
    dailyLimitAction: "skip", bonus5000CooldownMinutes: 10,
    cleanupRetentionDays: 90, historyExportPath: "", debugLogLevel: "error",
    ...over
  };
}

function setup(over: Partial<AppConfig> = {}) {
  const file = path.join(os.tmpdir(), `livelog-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(file);
  const logger = new Logger();
  const browser = new FakeBrowser();
  const engine = new BotEngine(browser, db, new RuleEngine(), logger, makeConfig(over));
  const events: LogEntry[] = [];
  logger.on("log", (e) => events.push(e));
  return { engine, browser, db, file, logger, events };
}
function cleanup(db: Database, file: string) {
  db.close();
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

test("Invalid Notes / Invalid Amount are counted in stats but NOT emitted to the Live Log", async () => {
  const { engine, browser, db, file, events } = setup();
  browser.setPending([
    tx("alice", 5000, "Deposit Reguler", "2026-01-15T10:00:00"),   // Invalid Notes
    tx("bob",   7000, "Bonus Reload",    "2026-01-15T10:01:00"),   // Invalid Amount
    tx("carol", 5000, "Bonus Reload",    "2026-01-15T10:02:00")    // valid
  ]);
  await engine.runOnce();

  // Stats reflect all three: 2 skipped (rules) + 1 verified approve.
  expect(engine.getStats().skipped).toBe(2);
  expect(engine.getStats().verified).toBe(1);

  // Live Log events emitted must NOT contain any SKIPPED lines whose
  // reason is Invalid Notes / Invalid Amount / Parse Error.
  const skippedEvents = events.filter((e) => e.status === "SKIPPED");
  const forbiddenReasons = ["Invalid Notes", "Invalid Amount", "Parse Error"];
  for (const e of skippedEvents) {
    expect(forbiddenReasons).not.toContain(e.detail);
  }
  cleanup(db, file);
});

test("Parse Error rows (missing username / bad amount / bad date) are silent in Live Log", async () => {
  const { engine, browser, db, file, events } = setup();
  browser.setPending([
    { username: "", amount: 5000, rawAmount: "5000", notes: "Bonus Reload", rowIndex: 0, transactionDate: "2026-01-15T10:00:00" },
    { username: "u", amount: NaN,  rawAmount: "??",   notes: "Bonus Reload", rowIndex: 1, transactionDate: "2026-01-15T10:01:00" },
    { username: "u", amount: 5000, rawAmount: "5000", notes: "Bonus Reload", rowIndex: 2, transactionDate: "" }
  ]);
  await engine.runOnce();
  expect(engine.getStats().skipped).toBe(3);
  expect(events.filter((e) => e.status === "SKIPPED").length).toBe(0);
  cleanup(db, file);
});

test("Daily Limit SKIPPED entries ARE emitted to the Live Log (actionable business event)", async () => {
  const { engine, browser, db, file, events } = setup({ dailyLimitAction: "skip" });
  browser.setPending([
    tx("dan", 10000, "Bonus Reload", "2026-01-15T09:00:00"),
    tx("dan",  5000, "Bonus Reload", "2026-01-15T09:05:00")   // over the limit
  ]);
  await engine.runOnce();

  const dailyLimitLive = events.filter(
    (e) => e.status === "SKIPPED" && (e.detail ?? "").includes("Daily Limit")
  );
  expect(dailyLimitLive.length).toBe(1);
  cleanup(db, file);
});

test("Bonus Cooldown SKIPPED entries ARE emitted to the Live Log (actionable business event)", async () => {
  const { engine, browser, db, file, events } = setup();
  // Seed a prior 5000 for jane so her next 5000 hits the cooldown.
  browser.setPending([tx("jane", 5000, "Bonus Reload", "2026-01-15T09:00:00")]);
  await engine.runOnce();

  const before = events.filter((e) => e.status === "SKIPPED").length;
  browser.setPending([tx("jane", 5000, "Bonus Reload", "2026-01-15T09:01:00")]);
  await engine.runOnce();
  const after = events.filter((e) => e.status === "SKIPPED").length;

  expect(after - before).toBe(1);
  const cooldownEvent = events
    .filter((e) => e.status === "SKIPPED")
    .find((e) => (e.detail ?? "").includes("Bonus Cooldown"));
  expect(cooldownEvent).toBeDefined();
  cleanup(db, file);
});

test("Silent skips still reach the diagnostic writeSinks path (CSV, debug log, console)", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "brb-log-"));
  const { engine, browser, db, file, logger } = setup();
  logger.configureFileSinks(logDir, "debug");
  browser.setPending([tx("alice", 5000, "Deposit Reguler", "2026-01-15T10:00:00")]); // Invalid Notes
  await engine.runOnce();

  const files = fs.readdirSync(logDir);
  const csv = files.find((f) => f.startsWith("csv-"));
  const dbg = files.find((f) => f.startsWith("debug-"));
  expect(csv).toBeDefined();
  expect(dbg).toBeDefined();
  const csvBody = fs.readFileSync(path.join(logDir, csv!), "utf8");
  expect(csvBody).toMatch(/Invalid Notes/);
  const dbgBody = fs.readFileSync(path.join(logDir, dbg!), "utf8");
  expect(dbgBody).toMatch(/Invalid Notes|SKIPPED/);

  fs.rmSync(logDir, { recursive: true, force: true });
  cleanup(db, file);
});
