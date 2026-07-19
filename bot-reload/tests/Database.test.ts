import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Database } from "../src/bot/Database";

function tempDb(): { db: Database; file: string } {
  const file = path.join(os.tmpdir(), `bonusbot-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return { db: new Database(file), file };
}

describe("Database — persistence layer", () => {
  test("schema comes up, integrity check passes, initial counts are zero", () => {
    const { db, file } = tempDb();
    expect(db.integrityCheck().ok).toBe(true);
    expect(db.countApprovedToday()).toBe(0);
    expect(db.sumTodayForUser("john")).toBe(0);
    db.close();
    fs.unlinkSync(file);
  });

  test("insertApproval + sumTodayForUser + countApprovedToday", () => {
    const { db, file } = tempDb();
    db.insertApproval({
      username: "alice", amount: 5000, notes: "Bonus Reload",
      transactionDate: "2026-01-15T22:21:52",
      status: "APPROVED", reason: "", processDurationMs: 120,
      verificationResult: "VERIFIED"
    });
    db.insertApproval({
      username: "alice", amount: 5000, notes: "Bonus Reload",
      transactionDate: "2026-01-15T22:31:52",
      status: "APPROVED", reason: "", processDurationMs: 130,
      verificationResult: "VERIFIED"
    });
    db.insertApproval({
      username: "bob", amount: 10000, notes: "Bonus Reload",
      transactionDate: "2026-01-15T22:32:52",
      status: "APPROVED", reason: "", processDurationMs: 150,
      verificationResult: "VERIFIED"
    });
    expect(db.sumTodayForUser("alice")).toBe(10000);
    expect(db.sumTodayForUser("bob")).toBe(10000);
    expect(db.countApprovedToday()).toBe(3);
    db.close();
    fs.unlinkSync(file);
  });

  test("REJECTED rows are excluded from daily-limit sum", () => {
    const { db, file } = tempDb();
    db.insertApproval({
      username: "eve", amount: 10000, notes: "Bonus Reload",
      transactionDate: "2026-01-15T10:00:00",
      status: "APPROVED", reason: "", processDurationMs: 100,
      verificationResult: "VERIFIED"
    });
    db.insertApproval({
      username: "eve", amount: 10000, notes: "Bonus Reload",
      transactionDate: "2026-01-15T10:01:00",
      status: "REJECTED", reason: "Daily Limit", processDurationMs: 100,
      verificationResult: "VERIFIED"
    });
    expect(db.sumTodayForUser("eve")).toBe(10000);
    db.close();
    fs.unlinkSync(file);
  });

  test("lastApprovedAtForUserAmount returns most-recent iso", async () => {
    const { db, file } = tempDb();
    db.insertApproval({
      username: "chris", amount: 5000, notes: "Bonus Reload",
      transactionDate: "2026-01-15T09:00:00",
      status: "APPROVED", reason: "", processDurationMs: 100,
      verificationResult: "VERIFIED"
    });
    // Ensure the second insert has a strictly-later approved_at.
    await new Promise((r) => setTimeout(r, 10));
    db.insertApproval({
      username: "chris", amount: 5000, notes: "Bonus Reload",
      transactionDate: "2026-01-15T09:15:00",
      status: "APPROVED", reason: "", processDurationMs: 100,
      verificationResult: "VERIFIED"
    });
    const last = db.lastApprovedAtForUserAmount("chris", 5000);
    expect(last).not.toBeNull();
    expect(new Date(last!).getTime()).toBeGreaterThan(0);
    db.close();
    fs.unlinkSync(file);
  });

  test("cleanup removes older rows", () => {
    const { db, file } = tempDb();
    // Insert a synthetic "old" row by writing directly through insertApproval and
    // then aging its `date`.
    db.insertApproval({
      username: "old", amount: 5000, notes: "Bonus Reload",
      transactionDate: "2020-01-01T00:00:00",
      status: "APPROVED", reason: "", processDurationMs: 0,
      verificationResult: "VERIFIED"
    });
    const dbAny = db as unknown as { db: import("better-sqlite3").Database };
    dbAny.db.prepare("UPDATE approved_history SET date = '2020-01-01'").run();
    const removed = db.cleanup(30);
    expect(removed).toBeGreaterThanOrEqual(1);
    db.close();
    fs.unlinkSync(file);
  });

  test("history export writes CSV", () => {
    const { db, file } = tempDb();
    db.insertApproval({
      username: "csv", amount: 5000, notes: "Bonus Reload",
      transactionDate: "2026-01-15T22:00:00",
      status: "APPROVED", reason: "", processDurationMs: 100,
      verificationResult: "VERIFIED"
    });
    const out = path.join(os.tmpdir(), `hist-${Date.now()}.csv`);
    const n = db.exportHistoryCsv(out);
    expect(n).toBe(1);
    const content = fs.readFileSync(out, "utf8");
    expect(content).toMatch(/^id,date,userid,amount/);
    expect(content).toContain("csv");
    fs.unlinkSync(out);
    db.close();
    fs.unlinkSync(file);
  });
});
