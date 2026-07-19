import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { LogEntry, LogStatus, DebugLogLevel } from "./types";

/**
 * Logger
 *
 * Responsibilities:
 *   - Emit structured `log` events (renderer Live Log + tests).
 *   - Append every entry to a per-day CSV file (`csv-YYYY-MM-DD.csv`).
 *   - Append a human-readable per-day debug log file.
 *   - Rotate to a new file automatically when the calendar day changes
 *     mid-session (Bug #7).
 *   - Prune log files older than the configured retention window.
 *
 * Must never mutate workflow.
 */
export class Logger extends EventEmitter {
  private logDir: string | null = null;
  private csvPath: string | null = null;
  private debugPath: string | null = null;
  private currentDay: string | null = null;
  private level: DebugLogLevel = "info";
  /** Retention window for log-file cleanup, in days. 0 = never delete. */
  private retentionDays = 30;

  private static readonly LEVEL_RANK: Record<DebugLogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
  };

  /**
   * Optional filesystem sinks. When `dir` is empty, only in-memory events fire.
   * Safe to call repeatedly — every call resets/refreshes the sinks and
   * updates the retention window.
   */
  configureFileSinks(
    dir: string,
    level: DebugLogLevel = "info",
    retentionDays = 30
  ): void {
    this.level = level;
    this.retentionDays = Math.max(0, retentionDays | 0);
    if (!dir) {
      this.logDir = null;
      this.csvPath = null;
      this.debugPath = null;
      this.currentDay = null;
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    this.logDir = dir;
    this.rollIfNeeded(/* force */ true);
    this.pruneOldLogs();
  }

  /** Force-run the retention prune. Exposed for tests / cleanup task. */
  pruneOldLogs(): number {
    if (!this.logDir || this.retentionDays <= 0) return 0;
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.logDir);
    } catch {
      return 0;
    }
    for (const f of files) {
      // Match `csv-YYYY-MM-DD.csv` / `debug-YYYY-MM-DD.log` / plain `YYYY-MM-DD.log`.
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      const t = Date.parse(m[1] + "T00:00:00Z");
      if (!Number.isFinite(t) || t >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(this.logDir, f));
        removed++;
      } catch { /* ignore individual failures */ }
    }
    return removed;
  }

  /** Current CSV file path (for tests + export). Null when disabled. */
  currentCsvPath(): string | null { return this.csvPath; }
  currentDebugPath(): string | null { return this.debugPath; }

  private static todayLocal(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, "0");
    const dd = d.getDate().toString().padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  /**
   * Move to today's CSV / debug files if the day changed. `force` re-opens
   * even when the day hasn't changed (used from configureFileSinks).
   */
  private rollIfNeeded(force = false): void {
    if (!this.logDir) return;
    const day = Logger.todayLocal();
    if (!force && day === this.currentDay) return;
    this.currentDay = day;
    this.csvPath = path.join(this.logDir, `csv-${day}.csv`);
    this.debugPath = path.join(this.logDir, `debug-${day}.log`);
    if (!fs.existsSync(this.csvPath)) {
      fs.writeFileSync(
        this.csvPath,
        "timestamp,status,username,amount,detail,notes\n",
        "utf8"
      );
    }
  }

  private static pad(n: number): string {
    return n.toString().padStart(2, "0");
  }
  private static nowHHMMSS(): string {
    const d = new Date();
    return `${Logger.pad(d.getHours())}:${Logger.pad(d.getMinutes())}:${Logger.pad(d.getSeconds())}`;
  }

  /**
   * Emit an entry. `notes` and `processDurationMs` are optional.
   *
   * When `silent` is true, the entry is written to CSV / debug log /
   * console (diagnostics preserved) but the `"log"` event is NOT
   * emitted — so the operator-facing Live Log stays quiet. Use this
   * for high-frequency, non-actionable events (Invalid Notes, Invalid
   * Amount, Parse Error).
   */
  emitLog(
    status: LogStatus,
    username: string,
    amount: number,
    detail?: string,
    notes?: string,
    processDurationMs?: number,
    silent = false
  ): LogEntry {
    const entry: LogEntry = {
      ts: Logger.nowHHMMSS(),
      username,
      amount,
      status,
      detail,
      notes,
      processDurationMs
    };
    if (!silent) this.emit("log", entry);
    this.writeSinks(entry);
    return entry;
  }

  info(msg: string): LogEntry {
    return this.emitLog("INFO", "-", 0, msg);
  }

  private writeSinks(entry: LogEntry): void {
    // Console line (always).
    const line = `[${entry.ts}] ${entry.status.padEnd(9)} ${entry.username || "-"} ${entry.amount || ""} ${entry.detail ?? ""}`.trim();
    // eslint-disable-next-line no-console
    console.log(line);

    // Roll to today's file if the calendar day changed since the last write.
    this.rollIfNeeded();

    // CSV sink.
    if (this.csvPath) {
      const esc = (v: unknown): string => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      try {
        fs.appendFileSync(
          this.csvPath,
          [
            entry.ts,
            entry.status,
            esc(entry.username),
            entry.amount,
            esc(entry.detail),
            esc(entry.notes)
          ].join(",") + "\n",
          "utf8"
        );
      } catch { /* disk full / permission errors are non-fatal for logs */ }
    }

    // Debug log sink (respects level).
    if (this.debugPath) {
      const rank = Logger.LEVEL_RANK;
      const entryLevel: DebugLogLevel =
        entry.status === "FAILED" ? "error" :
        entry.status === "RETRY" || entry.status === "SKIPPED" ? "warn" :
        entry.status === "INFO" || entry.status === "APPROVED" ||
        entry.status === "REJECTED" || entry.status === "VERIFIED" ||
        entry.status === "SUBMITTED" ? "info" : "debug";
      if (rank[entryLevel] <= rank[this.level]) {
        try { fs.appendFileSync(this.debugPath, line + "\n", "utf8"); }
        catch { /* ignore */ }
      }
    }
  }
}
