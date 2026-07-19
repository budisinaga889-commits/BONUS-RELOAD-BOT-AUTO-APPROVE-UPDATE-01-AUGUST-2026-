import { EventEmitter } from "events";
import { Database } from "./Database";
import { Logger } from "./Logger";
import { RuleEngine, DAILY_LIMIT_IDR } from "./RuleEngine";
import { PendingCache } from "./PendingCache";
import { ManualReviewQueue } from "./ManualReviewQueue";
import { CooldownTracker } from "./CooldownTracker";
import {
  AppConfig,
  BotMetrics,
  BotStats,
  BotStatus,
  CycleReport,
  IBrowser,
  Transaction
} from "./types";

/**
 * BotEngine — application orchestrator.
 *
 * Owns: workflow, queue, pending cache, daily limit, business cooldown,
 * verification, retry, statistics, manual review queue, dashboard
 * metrics.
 *
 * ============================================================
 *  Polling workflow (Bug #2)
 * ============================================================
 * Each polling cycle now performs the FULL sequence:
 *
 *      wait interval
 *          ↓
 *      page.reload()
 *          ↓
 *      wait table + read transactions
 *          ↓
 *      process (validate + decide)
 *          ↓
 *      submit (bulk approve / bulk reject)
 *          ↓
 *      refresh + verify
 *          ↓
 *      (if still visible)  submit → refresh → verify (inline retry — Bug #4)
 *
 * Changing `refreshInterval` therefore visibly changes how often the
 * browser panel actually reloads, not just how often BotEngine ticks.
 *
 * ============================================================
 *  Retry policy (Bug #4)
 * ============================================================
 * Retries stay event-driven: NO retry counter, NO exponential backoff.
 * We attempt ONE inline retry inside the same cycle (submit → refresh →
 * verify), which shortens the failure feedback loop. Anything still
 * unverified after the inline retry is simply carried into the next
 * polling cycle — where the same event-driven logic applies again.
 *
 * The tx keeps being retried FOREVER until:
 *   - it disappears from the panel, or
 *   - an operator manually rejects it (Skipped Transactions), or
 *   - it becomes invalid (fails RuleEngine).
 *
 * There is NO Optimistic Approval — SQLite / Daily Limit / Approval
 * History are only updated after a refresh confirms disappearance.
 */
export class BotEngine extends EventEmitter {
  private running = false;
  private looping = false;
  private cycleId = 0;
  private stats: BotStats = {
    approved: 0,
    rejected: 0,
    skipped: 0,
    failed: 0,
    verified: 0,
    skippedQueueSize: 0
  };
  private lastStatus: BotStatus = {
    running: false,
    browserOpen: false,
    loggedIn: false,
    integrityIssue: null
  };

  readonly pendingCache = new PendingCache();
  readonly skippedQueue = new ManualReviewQueue();
  private readonly cooldown: CooldownTracker;

  /** Tracks per-cycle submission timestamps so we can compute processDurationMs. */
  private readonly submittedAt = new Map<string, number>();

  // -- Metrics state (Bug #5) --
  private lastCycleReport: CycleReport | null = null;
  private readonly pollDurations: number[] = [];
  private readonly verificationDurations: number[] = [];
  private static readonly METRIC_WINDOW = 20;

  constructor(
    private readonly browser: IBrowser,
    private readonly db: Database,
    private readonly rules: RuleEngine,
    private readonly logger: Logger,
    private config: AppConfig
  ) {
    super();
    this.cooldown = new CooldownTracker(db, config.bonus5000CooldownMinutes);
    this.logger.on("log", (entry) => this.emit("log", entry));
    this.browser.on("closed", () => {
      this.running = false;
      this.emitStatus({ loggedIn: false });
    });
    this.skippedQueue.on("change", () => {
      this.stats.skippedQueueSize = this.skippedQueue.size();
      this.emit("stats", this.getStats());
      this.emit("skipped", this.skippedQueue.list());
      this.emit("metrics", this.getMetrics());
    });
  }

  // ---- public API ----------------------------------------------------------

  updateConfig(cfg: AppConfig): void {
    this.config = cfg;
    this.cooldown.updateWindow(cfg.bonus5000CooldownMinutes);
  }

  getStats(): BotStats {
    return { ...this.stats };
  }

  /** Dashboard metrics snapshot (Bug #5). Safe to call at any time. */
  getMetrics(): BotMetrics {
    const last = this.lastCycleReport;
    const avg = (arr: number[]): number =>
      arr.length === 0 ? 0 : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    const uptime = typeof this.browser.uptimeMs === "function" ? this.browser.uptimeMs() : 0;
    const lastRefreshAt =
      typeof this.browser.lastRefreshIso === "function" ? this.browser.lastRefreshIso() : null;
    const mem = process.memoryUsage();
    return {
      pendingCount: last?.visible ?? 0,
      retryCount: last?.retriedNext ?? 0,
      lastPollDurationMs: last?.durationMs ?? 0,
      avgPollDurationMs: avg(this.pollDurations),
      lastRefreshAt,
      browserUptimeMs: uptime,
      queueSize: this.skippedQueue.size(),
      avgVerificationMs: avg(this.verificationDurations),
      memoryRssBytes: mem.rss,
      cyclesCompleted: this.cycleId
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.browser.isOpen()) {
      await this.browser.launch(this.config.startURL);
    }
    this.running = true;
    this.resetStats();
    this.pendingCache.clear();
    this.skippedQueue.clear();
    this.submittedAt.clear();
    this.pollDurations.length = 0;
    this.verificationDurations.length = 0;
    this.lastCycleReport = null;
    this.emitStatus({ loggedIn: false });
    this.logger.info("Bot started — waiting for login…");
    await this.waitForLogin();
    if (!this.running) return;
    this.logger.info("Login detected. Monitoring pending transactions.");
    this.emitStatus({ loggedIn: true });
    void this.loop();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.looping) {
      const loggedIn = await this.browser.isLoggedIn().catch(() => false);
      this.emitStatus({ loggedIn });
      return;
    }
    this.running = false;
    this.pendingCache.clear();
    this.submittedAt.clear();
    this.logger.info("Bot stopped.");
    const loggedIn = await this.browser.isLoggedIn().catch(() => false);
    this.emitStatus({ loggedIn });
  }

  /**
   * Operator action from the Skipped Transactions panel — Reject one tx.
   * Failure keeps the tx in the queue (spec: "Failed reject remains in queue").
   */
  async rejectSkipped(key: string): Promise<boolean> {
    const row = this.skippedQueue.get(key);
    if (!row) return false;
    this.skippedQueue.markRejecting(key, true);
    try {
      await this.browser.rejectSingleTransaction({
        username: row.username,
        amount: row.amount,
        rawAmount: String(row.amount),
        notes: row.notes,
        rowIndex: row.rowIndex,
        txId: row.txId || "",
        transactionDate: row.transactionDate
      });
      this.logger.emitLog(
        "REJECTED",
        row.username,
        row.amount,
        `Manual reject queued (Skipped Transactions)`,
        row.notes
      );
      return true;
    } catch (err) {
      this.logger.emitLog(
        "FAILED",
        row.username,
        row.amount,
        `Manual reject failed: ${(err as Error).message}`,
        row.notes
      );
      return false;
    } finally {
      this.skippedQueue.markRejecting(key, false);
    }
  }

  // ---- Verification-based polling cycle ------------------------------------

  /**
   * ONE full polling cycle. Public for unit tests; the actual loop
   * calls this in a while(running) loop, waiting `refreshInterval` ms
   * BEFORE each call.
   *
   * Steps:
   *   0. Refresh panel (Bug #2 — every cycle starts with a real reload).
   *   1. Read pending transactions → normalize → build key set.
   *   2. Validate (RuleEngine) + Cooldown + Daily Limit → pick toApprove / toReject.
   *   3. Submit — Bulk Approve + Bulk Reject.
   *   4. Refresh panel.
   *   5. Re-read + verify (VERIFIED for gone, else stay pending).
   *   6. Inline retry (Bug #4) — for anything still visible we do
   *      one more submit → refresh → verify inside the SAME cycle.
   *      Anything still visible after that is retried on the next
   *      polling cycle (still event-driven, still no counter).
   *
   * `runCycleOnce()` from the UI calls this ONCE without the
   * loop-level wait; the initial refresh at step 0 is skipped for the
   * very first cycle after `start()` so we don't clobber the operator's
   * fresh login.
   */
  async runOnce(): Promise<CycleReport> {
    const cycleStart = Date.now();
    const cycleId = ++this.cycleId;

    // Step 0 — Refresh panel EVERY cycle so `refreshInterval` truly
    // controls browser reload frequency. Skipped on cycle 1 to keep the
    // "just logged in" state.
    if (cycleId > 1) {
      try { await this.browser.refresh(); } catch { /* refresh failures are non-fatal */ }
    }

    // Step 1 — DISCOVERED + NORMALIZED
    const preTxs = await this.readSafe();
    const visibleKeysPre = this.buildVisibleKeys(preTxs);
    this.pendingCache.reconcile(visibleKeysPre);
    this.skippedQueue.reconcile(visibleKeysPre);

    // Step 2 — VALIDATED / COOLDOWN / DAILY LIMIT / QUEUED
    const simulated = new Map<string, number>();
    const getSimulated = (u: string): number => {
      if (!simulated.has(u)) simulated.set(u, this.db.sumTodayForUser(u));
      return simulated.get(u)!;
    };

    const toApprove: Transaction[] = [];
    const toReject: Transaction[] = [];

    for (const tx of preTxs) {
      // Parse-error rows: silent skip.
      if (!tx.username || !Number.isFinite(tx.amount) || !tx.transactionDate) {
        this.stats.skipped += 1;
        this.emit("stats", this.getStats());
        this.logger.emitLog(
          "SKIPPED", tx.username || "-", Number.isFinite(tx.amount) ? tx.amount : 0,
          "Parse Error", tx.notes, undefined, /* silent */ true
        );
        continue;
      }

      // Rules 1 & 2 (RuleEngine — pure validation).
      const decision = this.rules.evaluate(tx);
      if (!decision.approve) {
        // Invalid Notes / Invalid Amount — silent in the operator Live Log.
        this.stats.skipped += 1;
        this.emit("stats", this.getStats());
        this.logger.emitLog(
          "SKIPPED", tx.username, tx.amount, decision.reason,
          tx.notes, undefined, /* silent */ true
        );
        continue;
      }

      // Business Cooldown (Rp5.000 / 10 minutes / per user).
      if (this.cooldown.isBlocked(tx.username, tx.amount)) {
        this.stats.skipped += 1;
        this.emit("stats", this.getStats());
        this.skippedQueue.upsert(tx, "Bonus Cooldown");
        this.logger.emitLog(
          "SKIPPED",
          tx.username,
          tx.amount,
          "Bonus Cooldown (Rp5.000 / 10m)",
          tx.notes
        );
        continue;
      }

      // Daily Limit (owned by BotEngine).
      const already = getSimulated(tx.username);
      if (already + tx.amount > DAILY_LIMIT_IDR) {
        if (this.config.dailyLimitAction === "reject") {
          toReject.push(tx);
          this.pendingCache.add(tx);
          this.submittedAt.set(PendingCache.keyOf(tx), Date.now());
          this.stats.rejected += 1;
          this.emit("stats", this.getStats());
          this.logger.emitLog(
            "SUBMITTED",
            tx.username,
            tx.amount,
            "Queued for Bulk Reject (Daily Limit)",
            tx.notes
          );
        } else {
          this.stats.skipped += 1;
          this.emit("stats", this.getStats());
          this.skippedQueue.upsert(tx, "Daily Limit");
          this.logger.emitLog("SKIPPED", tx.username, tx.amount, "Daily Limit", tx.notes);
        }
        continue;
      }

      // Approve path.
      toApprove.push(tx);
      this.pendingCache.add(tx);
      this.submittedAt.set(PendingCache.keyOf(tx), Date.now());
      simulated.set(tx.username, already + tx.amount);
      this.logger.emitLog(
        "SUBMITTED",
        tx.username,
        tx.amount,
        "Queued for Bulk Approve",
        tx.notes
      );
    }

    // ------------------------------------------------------------
    //  Submit + Verify (with ONE inline retry)
    // ------------------------------------------------------------
    let remainingApprove = toApprove.slice();
    let remainingReject  = toReject.slice();
    let verifiedApprove = 0;
    let verifiedReject  = 0;
    let inlineRetried   = 0;
    let visibleKeysPost = visibleKeysPre;
    // MAX_PASSES = 2  → submit + verify, then ONE inline retry.
    const MAX_PASSES = 2;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      if (remainingApprove.length === 0 && remainingReject.length === 0) break;

      // ---- Submit ----
      let submitApproveOk = remainingApprove.length === 0;
      let submitRejectOk  = remainingReject.length  === 0;
      if (remainingApprove.length > 0) {
        try {
          await this.browser.approveMultipleTransactions(remainingApprove);
          submitApproveOk = true;
          this.logger.info(
            `Bulk Approve submitted — ${remainingApprove.length} tx${pass > 0 ? " (retry)" : ""}.`
          );
        } catch (err) {
          this.stats.failed += 1;
          this.emit("stats", this.getStats());
          this.logger.emitLog("FAILED", "BULK APPROVE", 0, (err as Error).message);
        }
      }
      if (remainingReject.length > 0) {
        try {
          await this.browser.rejectMultipleTransactions(remainingReject);
          submitRejectOk = true;
          this.logger.info(
            `Bulk Reject submitted — ${remainingReject.length} tx${pass > 0 ? " (retry)" : ""}.`
          );
        } catch (err) {
          this.stats.failed += 1;
          this.emit("stats", this.getStats());
          this.logger.emitLog("FAILED", "BULK REJECT", 0, (err as Error).message);
        }
      }

      // ---- Refresh + Re-read ----
      if (submitApproveOk || submitRejectOk) {
        try { await this.browser.refresh(); } catch { /* retry next pass */ }
      }
      const postTxs = await this.readSafe();
      visibleKeysPost = this.buildVisibleKeys(postTxs);

      // ---- Verify ----
      const stillApprove: Transaction[] = [];
      if (submitApproveOk) {
        for (const tx of remainingApprove) {
          const key = PendingCache.keyOf(tx);
          const t0 = this.submittedAt.get(key) ?? cycleStart;
          const dur = Date.now() - t0;
          if (!visibleKeysPost.has(key)) {
            // VERIFIED — persist.
            this.db.insertApproval({
              username: tx.username,
              amount: tx.amount,
              notes: tx.notes,
              transactionDate: tx.transactionDate,
              status: "APPROVED",
              reason: "",
              processDurationMs: dur,
              verificationResult: "VERIFIED"
            });
            this.stats.approved += 1;
            this.stats.verified += 1;
            this.pendingCache.delete(tx);
            this.submittedAt.delete(key);
            verifiedApprove++;
            this.verificationDurations.push(dur);
            if (this.verificationDurations.length > BotEngine.METRIC_WINDOW) {
              this.verificationDurations.shift();
            }
            this.logger.emitLog(
              "VERIFIED",
              tx.username,
              tx.amount,
              pass === 0 ? "Approve verified" : "Approve verified (after inline retry)",
              tx.notes,
              dur
            );
          } else {
            stillApprove.push(tx);
          }
        }
      } else {
        // Submit itself failed — everything stays for next pass / next cycle.
        stillApprove.push(...remainingApprove);
      }

      const stillReject: Transaction[] = [];
      if (submitRejectOk) {
        for (const tx of remainingReject) {
          const key = PendingCache.keyOf(tx);
          const t0 = this.submittedAt.get(key) ?? cycleStart;
          const dur = Date.now() - t0;
          if (!visibleKeysPost.has(key)) {
            this.db.insertApproval({
              username: tx.username,
              amount: tx.amount,
              notes: tx.notes,
              transactionDate: tx.transactionDate,
              status: "REJECTED",
              reason: "Daily Limit",
              processDurationMs: dur,
              verificationResult: "VERIFIED"
            });
            this.pendingCache.delete(tx);
            this.submittedAt.delete(key);
            verifiedReject++;
            this.verificationDurations.push(dur);
            if (this.verificationDurations.length > BotEngine.METRIC_WINDOW) {
              this.verificationDurations.shift();
            }
            this.logger.emitLog(
              "VERIFIED",
              tx.username,
              tx.amount,
              pass === 0
                ? "Reject verified (Daily Limit)"
                : "Reject verified (Daily Limit) (after inline retry)",
              tx.notes,
              dur
            );
          } else {
            stillReject.push(tx);
          }
        }
      } else {
        stillReject.push(...remainingReject);
      }

      // Nothing left to retry? Stop early.
      if (stillApprove.length === 0 && stillReject.length === 0) {
        remainingApprove = [];
        remainingReject  = [];
        break;
      }

      // Prepare for inline retry (only if we still have another pass).
      if (pass < MAX_PASSES - 1) {
        for (const tx of stillApprove) {
          inlineRetried++;
          this.logger.emitLog(
            "RETRY",
            tx.username,
            tx.amount,
            "Verification failed — inline retry",
            tx.notes
          );
        }
        for (const tx of stillReject) {
          inlineRetried++;
          this.logger.emitLog(
            "RETRY",
            tx.username,
            tx.amount,
            "Reject verification failed — inline retry",
            tx.notes
          );
        }
      }

      remainingApprove = stillApprove;
      remainingReject  = stillReject;
    }

    // Anything still visible → carried into the NEXT polling cycle
    // (event-driven, no counter, no backoff).
    let retriedNext = 0;
    for (const tx of remainingApprove) {
      retriedNext++;
      this.logger.emitLog(
        "RETRY",
        tx.username,
        tx.amount,
        "Verification failed — will retry next cycle",
        tx.notes
      );
      // Remove from pending cache so next cycle can re-queue it.
      this.pendingCache.delete(tx);
      this.submittedAt.delete(PendingCache.keyOf(tx));
    }
    for (const tx of remainingReject) {
      retriedNext++;
      this.logger.emitLog(
        "RETRY",
        tx.username,
        tx.amount,
        "Reject verification failed — will retry next cycle",
        tx.notes
      );
      this.pendingCache.delete(tx);
      this.submittedAt.delete(PendingCache.keyOf(tx));
    }

    // Reconcile queues once more against the freshest panel snapshot.
    this.pendingCache.reconcile(visibleKeysPost);
    this.skippedQueue.reconcile(visibleKeysPost);
    this.stats.skippedQueueSize = this.skippedQueue.size();
    this.emit("stats", this.getStats());

    const durationMs = Date.now() - cycleStart;
    this.pollDurations.push(durationMs);
    if (this.pollDurations.length > BotEngine.METRIC_WINDOW) this.pollDurations.shift();

    const report: CycleReport = {
      cycleId,
      visible: preTxs.length,
      submittedApprove: toApprove.length,
      submittedReject: toReject.length,
      verifiedApprove,
      verifiedReject,
      retriedNext,
      inlineRetried,
      durationMs
    };
    this.lastCycleReport = report;
    this.emit("cycle", report);
    this.emit("metrics", this.getMetrics());
    return report;
  }

  // ---- internals -----------------------------------------------------------

  private async readSafe(): Promise<Transaction[]> {
    try {
      return await this.browser.readPendingTransactions();
    } catch (err) {
      this.logger.emitLog("FAILED", "READ", 0, `Panel read failed: ${(err as Error).message}`);
      this.stats.failed += 1;
      this.emit("stats", this.getStats());
      return [];
    }
  }

  private buildVisibleKeys(txs: Transaction[]): Set<string> {
    const s = new Set<string>();
    for (const tx of txs) {
      if (tx.username && Number.isFinite(tx.amount) && tx.transactionDate) {
        s.add(PendingCache.keyOf(tx));
      }
    }
    return s;
  }

  private resetStats(): void {
    this.stats = {
      approved: 0,
      rejected: 0,
      skipped: 0,
      failed: 0,
      verified: 0,
      skippedQueueSize: this.skippedQueue.size()
    };
    this.emit("stats", this.getStats());
  }

  private emitStatus(patch: Partial<BotStatus>): void {
    this.lastStatus = {
      running: this.running,
      browserOpen: this.browser.isOpen(),
      loggedIn: this.lastStatus.loggedIn,
      integrityIssue: this.lastStatus.integrityIssue ?? null,
      ...patch
    };
    this.emit("status", this.lastStatus);
  }

  setIntegrityIssue(msg: string | null): void {
    this.lastStatus.integrityIssue = msg;
    this.emit("status", this.lastStatus);
  }

  private async waitForLogin(): Promise<void> {
    let ticks = 0;
    while (this.running) {
      const ok = await this.browser.isLoggedIn().catch(() => false);
      if (ok) return;
      if (ticks > 0 && ticks % 15 === 0) this.logger.info("Still waiting for login…");
      ticks += 1;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private async loop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.running) {
        // Wait FIRST — this is what the operator-visible refreshInterval
        // controls. `runOnce()` will then perform: refresh → read →
        // process → submit → refresh → verify (+ inline retry).
        await new Promise((r) =>
          setTimeout(r, Math.max(500, this.config.refreshInterval))
        );
        if (!this.running) break;
        try {
          await this.runOnce();
        } catch (err) {
          this.stats.failed += 1;
          this.emit("stats", this.getStats());
          this.logger.emitLog("FAILED", "-", 0, `Loop error: ${(err as Error).message}`);
        }
      }
    } finally {
      this.looping = false;
    }
  }
}
