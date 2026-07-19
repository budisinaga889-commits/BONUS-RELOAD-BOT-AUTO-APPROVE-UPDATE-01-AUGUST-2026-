import BetterSqlite3, { Database as SqliteDb, Statement } from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { HistoryRow } from "./types";

/**
 * Database
 *
 * Persistence layer — VERIFIED approvals ONLY (Part 5 §11).
 *
 * Never stores:
 *   - Pending transactions
 *   - Queued transactions
 *   - Submitted-but-unverified transactions
 *
 * Tables:
 *   - schema_version
 *   - approved_history   (VERIFIED approvals + verified rejects)
 *   - settings           (future ready)
 *
 * Contains NO business logic — no daily limit check, no cooldown check.
 * It exposes primitives that BotEngine composes into business decisions.
 */

const SCHEMA_VERSION = 2;

export interface ApprovalInsert {
  username: string;
  amount: number;
  notes: string;
  transactionDate: string;
  status: "APPROVED" | "REJECTED";
  reason: string;
  processDurationMs: number | null;
  verificationResult: "VERIFIED" | "MANUAL" | "N/A";
}

export class Database {
  private db: SqliteDb;

  private stmtInsert!: Statement;
  private stmtSumTodayForUser!: Statement;
  private stmtCountToday!: Statement;
  private stmtCountApprovedForUserSince!: Statement;
  private stmtRecentBonusForUser!: Statement;
  private stmtListHistory!: Statement;
  private stmtCleanup!: Statement;
  private stmtSetSetting!: Statement;
  private stmtGetSetting!: Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.prepareStatements();
  }

  // ---- Schema --------------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS approved_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        userid TEXT NOT NULL,
        amount INTEGER NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        transaction_date TEXT NOT NULL DEFAULT '',
        approved_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'APPROVED',
        reason TEXT NOT NULL DEFAULT '',
        process_duration_ms INTEGER,
        verification_result TEXT NOT NULL DEFAULT 'VERIFIED'
      );
      CREATE INDEX IF NOT EXISTS idx_history_date_user
        ON approved_history(date, userid);
      CREATE INDEX IF NOT EXISTS idx_history_approved_at
        ON approved_history(approved_at DESC);
      CREATE INDEX IF NOT EXISTS idx_history_user_amount_time
        ON approved_history(userid, amount, approved_at DESC);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const row = this.db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;

    if (!row) {
      this.db
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(SCHEMA_VERSION);
    } else if (row.version < SCHEMA_VERSION) {
      // Additive migrations only; every ALTER already exists via CREATE IF NOT EXISTS
      // + defensive column adds below in case an older DB predates them.
      this.addColumnIfMissing("approved_history", "notes", "TEXT NOT NULL DEFAULT ''");
      this.addColumnIfMissing("approved_history", "transaction_date", "TEXT NOT NULL DEFAULT ''");
      this.addColumnIfMissing("approved_history", "status", "TEXT NOT NULL DEFAULT 'APPROVED'");
      this.addColumnIfMissing("approved_history", "reason", "TEXT NOT NULL DEFAULT ''");
      this.addColumnIfMissing("approved_history", "process_duration_ms", "INTEGER");
      this.addColumnIfMissing("approved_history", "verification_result", "TEXT NOT NULL DEFAULT 'VERIFIED'");
      this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    }
  }

  private addColumnIfMissing(table: string, column: string, def: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def};`);
    }
  }

  private prepareStatements(): void {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO approved_history
         (date, userid, amount, notes, transaction_date, approved_at,
          status, reason, process_duration_ms, verification_result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtSumTodayForUser = this.db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM approved_history
        WHERE date = ? AND userid = ? AND status = 'APPROVED'`
    );
    this.stmtCountToday = this.db.prepare(
      `SELECT COUNT(*) AS c
         FROM approved_history
        WHERE date = ? AND status = 'APPROVED'`
    );
    this.stmtCountApprovedForUserSince = this.db.prepare(
      `SELECT COUNT(*) AS c
         FROM approved_history
        WHERE userid = ? AND amount = ? AND approved_at >= ? AND status = 'APPROVED'`
    );
    this.stmtRecentBonusForUser = this.db.prepare(
      `SELECT approved_at
         FROM approved_history
        WHERE userid = ? AND amount = ? AND status = 'APPROVED'
        ORDER BY approved_at DESC
        LIMIT 1`
    );
    this.stmtListHistory = this.db.prepare(
      `SELECT id, date, userid, amount, notes, transaction_date, approved_at,
              status, reason, process_duration_ms, verification_result
         FROM approved_history
        ORDER BY id DESC
        LIMIT ? OFFSET ?`
    );
    this.stmtCleanup = this.db.prepare(
      `DELETE FROM approved_history WHERE date < ?`
    );
    this.stmtSetSetting = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    this.stmtGetSetting = this.db.prepare(
      `SELECT value FROM settings WHERE key = ?`
    );
  }

  // ---- Helpers -------------------------------------------------------------

  /** Local calendar day, formatted YYYY-MM-DD. */
  static todayLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
  }

  // ---- Reads ---------------------------------------------------------------

  sumTodayForUser(userid: string): number {
    const row = this.stmtSumTodayForUser.get(Database.todayLocal(), userid) as { total: number };
    return row.total | 0;
  }

  countApprovedToday(): number {
    const row = this.stmtCountToday.get(Database.todayLocal()) as { c: number };
    return row.c | 0;
  }

  /**
   * Timestamp (ISO) of the most recent approved bonus for the user at the
   * given amount. Used by CooldownTracker to enforce the 10-minute
   * Business Cooldown on Rp5.000. Returns null if none exists.
   */
  lastApprovedAtForUserAmount(userid: string, amount: number): string | null {
    const row = this.stmtRecentBonusForUser.get(userid, amount) as
      | { approved_at: string }
      | undefined;
    return row ? row.approved_at : null;
  }

  listHistory(limit = 500, offset = 0): HistoryRow[] {
    const rows = this.stmtListHistory.all(limit, offset) as Array<{
      id: number;
      userid: string;
      amount: number;
      notes: string;
      transaction_date: string;
      approved_at: string;
      status: "APPROVED" | "REJECTED" | "SKIPPED";
      reason: string;
      process_duration_ms: number | null;
      verification_result: "VERIFIED" | "MANUAL" | "N/A";
    }>;
    return rows.map((r) => ({
      id: r.id,
      pid: r.id,
      time: r.approved_at,
      player: r.userid,
      amount: r.amount,
      bonusReload: r.notes,
      status: r.status,
      reason: r.reason,
      processDurationMs: r.process_duration_ms,
      verificationResult: r.verification_result
    }));
  }

  // ---- Writes --------------------------------------------------------------

  insertApproval(row: ApprovalInsert): number {
    const info = this.stmtInsert.run(
      Database.todayLocal(),
      row.username,
      row.amount,
      row.notes,
      row.transactionDate,
      new Date().toISOString(),
      row.status,
      row.reason,
      row.processDurationMs,
      row.verificationResult
    );
    return Number(info.lastInsertRowid);
  }

  /** Delete history older than `retentionDays`. Returns rows deleted. */
  cleanup(retentionDays: number): number {
    const d = new Date();
    d.setDate(d.getDate() - Math.max(1, retentionDays));
    const cutoff = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
    const info = this.stmtCleanup.run(cutoff);
    return Number(info.changes);
  }

  setSetting(key: string, value: string): void {
    this.stmtSetSetting.run(key, value);
  }

  getSetting(key: string): string | null {
    const row = this.stmtGetSetting.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /** Startup Integrity Check — cheap sanity queries on the DB file. */
  integrityCheck(): { ok: boolean; message: string } {
    try {
      const rows = this.db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
      const first = rows[0]?.integrity_check ?? "";
      if (first !== "ok") return { ok: false, message: `SQLite integrity_check: ${first}` };
      const v = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
        | { version: number }
        | undefined;
      if (!v || v.version !== SCHEMA_VERSION) {
        return { ok: false, message: `Unexpected schema version ${v?.version ?? "null"}, expected ${SCHEMA_VERSION}` };
      }
      return { ok: true, message: "OK" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Export ALL history to a CSV file at `filePath`. Returns rows exported. */
  exportHistoryCsv(filePath: string): number {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const rows = this.db
      .prepare(
        `SELECT id, date, userid, amount, notes, transaction_date, approved_at,
                status, reason, process_duration_ms, verification_result
           FROM approved_history
          ORDER BY id ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const esc = (v: unknown): string => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header =
      "id,date,userid,amount,notes,transaction_date,approved_at,status,reason,process_duration_ms,verification_result\n";
    const body = rows
      .map((r) =>
        [
          r.id, r.date, r.userid, r.amount, r.notes, r.transaction_date,
          r.approved_at, r.status, r.reason, r.process_duration_ms, r.verification_result
        ].map(esc).join(",")
      )
      .join("\n");
    fs.writeFileSync(filePath, header + body + (body ? "\n" : ""), "utf8");
    return rows.length;
  }

  close(): void {
    this.db.close();
  }
}
