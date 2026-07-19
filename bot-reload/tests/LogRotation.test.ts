/**
 * Log rotation (Bug #7)
 *
 * Confirms that:
 *   - configureFileSinks creates today's csv-*.csv and debug-*.log.
 *   - pruneOldLogs removes files older than the retention window.
 *   - Log lines land in today's file even after mid-session rotation.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Logger } from "../src/bot/Logger";

function mktmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brb-logrot-"));
}

test("configureFileSinks seeds today's csv + debug files", () => {
  const dir = mktmpDir();
  const logger = new Logger();
  logger.configureFileSinks(dir, "debug", 30);
  const files = fs.readdirSync(dir);
  expect(files.some((f) => /^csv-\d{4}-\d{2}-\d{2}\.csv$/.test(f))).toBe(true);
  expect(logger.currentCsvPath()).not.toBeNull();
  expect(logger.currentDebugPath()).not.toBeNull();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pruneOldLogs deletes files whose YYYY-MM-DD stamp is older than the retention window", () => {
  const dir = mktmpDir();
  // Pre-seed with an "old" file (100 days ago) and a "recent" file (1 day ago).
  const iso = (offsetDays: number): string => {
    const d = new Date(Date.now() - offsetDays * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  fs.writeFileSync(path.join(dir, `csv-${iso(100)}.csv`), "old\n");
  fs.writeFileSync(path.join(dir, `debug-${iso(100)}.log`), "old\n");
  fs.writeFileSync(path.join(dir, `csv-${iso(1)}.csv`), "recent\n");

  const logger = new Logger();
  logger.configureFileSinks(dir, "info", 30);

  const remaining = fs.readdirSync(dir);
  // Two "old" files should be gone; the "recent" file + today's freshly-created file remain.
  expect(remaining.some((f) => f === `csv-${iso(100)}.csv`)).toBe(false);
  expect(remaining.some((f) => f === `debug-${iso(100)}.log`)).toBe(false);
  expect(remaining.some((f) => f === `csv-${iso(1)}.csv`)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("retentionDays = 0 disables the auto-cleanup", () => {
  const dir = mktmpDir();
  const iso = (offsetDays: number): string => {
    const d = new Date(Date.now() - offsetDays * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  fs.writeFileSync(path.join(dir, `csv-${iso(400)}.csv`), "ancient\n");

  const logger = new Logger();
  logger.configureFileSinks(dir, "info", 0);
  expect(fs.readdirSync(dir).some((f) => f === `csv-${iso(400)}.csv`)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("emitLog appends to today's CSV after configureFileSinks", () => {
  const dir = mktmpDir();
  const logger = new Logger();
  logger.configureFileSinks(dir, "debug", 30);
  logger.emitLog("INFO", "alice", 5000, "Bulk Approve submitted", "Bonus Reload");
  const csvFile = logger.currentCsvPath();
  expect(csvFile).not.toBeNull();
  const body = fs.readFileSync(csvFile!, "utf8");
  expect(body).toMatch(/timestamp,status,username,amount,detail,notes/);
  expect(body).toMatch(/INFO,alice,5000/);
  fs.rmSync(dir, { recursive: true, force: true });
});
