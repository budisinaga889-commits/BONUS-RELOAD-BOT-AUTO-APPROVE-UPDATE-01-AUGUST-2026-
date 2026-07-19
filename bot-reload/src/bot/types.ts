/**
 * Shared type definitions used across all bot modules.
 * Contains NO Playwright / Electron / SQLite imports so that RuleEngine,
 * Logger, ManualReviewQueue, PendingCache and BotEngine remain
 * environment-agnostic (and unit-testable in plain Node).
 */

export type DailyLimitAction = "skip" | "reject";
export type DebugLogLevel = "error" | "warn" | "info" | "debug";

export interface AppConfig {
  startURL: string;
  refreshInterval: number;
  minDelay: number;
  maxDelay: number;
  dailyLimitAction: DailyLimitAction;
  /** Business Cooldown for Rp5.000 bonuses (per user) in minutes. */
  bonus5000CooldownMinutes: number;
  /** Days of Approval History retained by Database Cleanup. */
  cleanupRetentionDays: number;
  /** Absolute directory used by History Export. Empty = ask on save. */
  historyExportPath: string;
  debugLogLevel: DebugLogLevel;
  /**
   * Log-file retention window in days (Bug #7 — Log Rotation). Log
   * files older than this are removed automatically when the sinks
   * are (re)configured. Set to 0 to disable auto-cleanup entirely.
   *
   * Optional so pre-existing test fixtures / stored config JSONs that
   * predate this field keep compiling and loading. Callers that omit
   * it get the default (30 days) applied by `normalizeConfig`.
   */
  logRetentionDays?: number;
}

/** DOM row -> normalized Transaction. No nullable business fields. */
export interface Transaction {
  username: string;
  /** Normalized integer (e.g. "10,000.00" -> 10000). */
  amount: number;
  /** Raw amount cell text from the panel. */
  rawAmount: string;
  notes: string;
  /**
   * Historical field. Kept for backwards compatibility with the
   * ManualReviewQueue / SkippedRow surface. Approve/Reject **never**
   * uses this field anymore — see `txId` below.
   */
  rowIndex: number;
  /**
   * Stable per-transaction identifier extracted from the DOM (approve
   * button `id="btn-approve-<txId>"` or `onclick="approve(<txId>)"`).
   * Used by BrowserManager to identify which panel row to approve /
   * reject, so that inserting a new row before an existing pending
   * transaction NEVER changes which transaction gets approved.
   *
   * Empty / undefined means the row could not be uniquely identified —
   * such rows fall back to a composite key (`username|amount|
   * transactionDate`) driven scan so the bot still degrades gracefully.
   *
   * Optional in the type so pre-existing callers / fixtures that
   * pre-date the field keep compiling; new callers should always
   * populate it.
   */
  txId?: string;
  /**
   * Normalized ISO-8601 without timezone (e.g. "2026-07-15T22:21:52").
   * Empty string ONLY for rows whose date cell was unparseable — such
   * rows are treated as PARSE ERROR and silently skipped.
   */
  transactionDate: string;
}

export type SkipReason =
  | "Invalid Notes"
  | "Invalid Amount"
  | "Parse Error"
  | "Daily Limit"
  | "Bonus Cooldown";

export type RuleDecision =
  | { approve: true }
  | { approve: false; reason: "Invalid Notes" | "Invalid Amount" };

/**
 * Log statuses. In V1 there is NO Optimistic Approval, so APPROVED /
 * REJECTED reflect VERIFIED post-refresh state only. SUBMITTED is emitted
 * for optimistic UX-only feedback but never persisted.
 */
export type LogStatus =
  | "APPROVED"
  | "REJECTED"
  | "SKIPPED"
  | "FAILED"
  | "SUBMITTED"
  | "VERIFIED"
  | "RETRY"
  | "INFO";

export interface LogEntry {
  ts: string;
  username: string;
  amount: number;
  status: LogStatus;
  detail?: string;
  notes?: string;
  /** Milliseconds elapsed between SUBMITTED and VERIFIED (VERIFIED lines only). */
  processDurationMs?: number;
}

export interface BotStats {
  approved: number;
  rejected: number;
  skipped: number;
  failed: number;
  /** Verified approvals in this session (subset of `approved`). */
  verified: number;
  /** Transactions currently sitting in Skipped Transactions. */
  skippedQueueSize: number;
}

export interface BotStatus {
  running: boolean;
  browserOpen: boolean;
  loggedIn: boolean;
  /** Present if a Startup Integrity Check failed (renderer surfaces this). */
  integrityIssue?: string | null;
}

/**
 * Minimal browser surface consumed by BotEngine. Every non-trivial method
 * is fire-and-forget: they submit inside ONE page.evaluate() and return.
 */
export interface IBrowser {
  isOpen(): boolean;
  launch(startURL: string): Promise<void>;
  openPanel(url: string): Promise<void>;
  isLoggedIn(): Promise<boolean>;
  readPendingTransactions(): Promise<Transaction[]>;
  approveMultipleTransactions(txs: Transaction[]): Promise<void>;
  rejectMultipleTransactions(txs: Transaction[]): Promise<void>;
  rejectSingleTransaction(tx: Transaction): Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
  on(event: "closed", listener: () => void): unknown;
  /** Optional — browser session uptime for Dashboard metrics. */
  uptimeMs?(): number;
  /** Optional — ISO timestamp of the last successful refresh. */
  lastRefreshIso?(): string | null;
}

/** Row shape returned to the renderer for Approval History. */
export interface HistoryRow {
  id: number;
  pid: number;
  time: string;
  player: string;
  amount: number;
  bonusReload: string;
  status: "APPROVED" | "REJECTED" | "SKIPPED";
  reason: string;
  processDurationMs: number | null;
  verificationResult: "VERIFIED" | "MANUAL" | "N/A";
}

/** Row shape returned to the renderer for the Skipped Transactions queue. */
export interface SkippedRow {
  key: string;
  username: string;
  amount: number;
  notes: string;
  transactionDate: string;
  rowIndex: number;
  /** See Transaction.txId for the field's contract. Empty when unknown. */
  txId?: string;
  reason: SkipReason;
  addedAt: string;
  rejecting: boolean;
}

/** Result payload returned by the BotEngine after every polling cycle. */
export interface CycleReport {
  cycleId: number;
  visible: number;
  submittedApprove: number;
  submittedReject: number;
  verifiedApprove: number;
  verifiedReject: number;
  retriedNext: number;
  /**
   * Inline retries — transactions that failed the FIRST verification
   * pass, got resubmitted in the SAME cycle, and were verified on the
   * second pass. `retriedNext` still counts transactions that even the
   * inline retry could not clear (they will be re-attempted on the
   * next polling cycle).
   */
  inlineRetried: number;
  durationMs: number;
}

/**
 * Rich runtime metrics surfaced to the renderer Dashboard.
 * Bug #5 (Dashboard Improvements). All values are point-in-time
 * snapshots so the renderer can render them without further math.
 */
export interface BotMetrics {
  /** Pending transactions currently visible on the panel (last cycle). */
  pendingCount: number;
  /** Transactions carried over as retries into the NEXT polling cycle. */
  retryCount: number;
  /** Duration of the most recent polling cycle, in ms. */
  lastPollDurationMs: number;
  /** Simple rolling average of the last N cycle durations, in ms. */
  avgPollDurationMs: number;
  /** ISO-8601 timestamp of the last successful browser refresh. */
  lastRefreshAt: string | null;
  /** Milliseconds since the browser was opened (0 when closed). */
  browserUptimeMs: number;
  /** Skipped Transactions queue size (business skips awaiting operator). */
  queueSize: number;
  /** Rolling average of SUBMITTED → VERIFIED durations across the session. */
  avgVerificationMs: number;
  /** Node process memory usage in bytes (RSS). */
  memoryRssBytes: number;
  /** Cycles completed since the bot started. */
  cyclesCompleted: number;
}
