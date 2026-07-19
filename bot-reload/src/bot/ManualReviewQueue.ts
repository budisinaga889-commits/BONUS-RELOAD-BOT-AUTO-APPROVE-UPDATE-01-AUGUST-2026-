import { EventEmitter } from "events";
import { SkipReason, SkippedRow, Transaction } from "./types";
import { PendingCache } from "./PendingCache";

/**
 * ManualReviewQueue
 *
 * Internal name: ManualReviewQueue.
 * Dashboard name: "Skipped Transactions".
 *
 * Holds business-skipped transactions (Daily Limit, Bonus Cooldown) that
 * still exist on the panel. The operator can Reject them from the UI.
 * There is NO Manual Approve action.
 *
 * Failed reject attempts remain in the queue (the row is still visible
 * on the panel until a subsequent refresh confirms disappearance).
 *
 * Emits:
 *   "change" — whenever the queue contents change.
 */
export class ManualReviewQueue extends EventEmitter {
  private readonly rows = new Map<string, SkippedRow>();

  size(): number {
    return this.rows.size;
  }

  list(): SkippedRow[] {
    return Array.from(this.rows.values()).sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  }

  /** Add or refresh a skipped tx. Idempotent by key. */
  upsert(tx: Transaction, reason: SkipReason): void {
    const key = PendingCache.keyOf(tx);
    const existing = this.rows.get(key);
    if (existing) {
      // Refresh rowIndex + reason if changed (panel may have re-shuffled rows).
      existing.rowIndex = tx.rowIndex;
      existing.txId = tx.txId || existing.txId;
      existing.reason = reason;
      existing.notes = tx.notes;
    } else {
      this.rows.set(key, {
        key,
        username: tx.username,
        amount: tx.amount,
        notes: tx.notes,
        transactionDate: tx.transactionDate,
        rowIndex: tx.rowIndex,
        txId: tx.txId || "",
        reason,
        addedAt: new Date().toISOString(),
        rejecting: false
      });
    }
    this.emit("change", this.list());
  }

  markRejecting(key: string, on: boolean): void {
    const r = this.rows.get(key);
    if (!r) return;
    r.rejecting = on;
    this.emit("change", this.list());
  }

  /** Drop entries whose keys are NOT in `visibleKeys` (panel confirmed removal). */
  reconcile(visibleKeys: Set<string>): void {
    let changed = false;
    for (const key of Array.from(this.rows.keys())) {
      if (!visibleKeys.has(key)) {
        this.rows.delete(key);
        changed = true;
      }
    }
    if (changed) this.emit("change", this.list());
  }

  get(key: string): SkippedRow | undefined {
    return this.rows.get(key);
  }

  clear(): void {
    if (this.rows.size === 0) return;
    this.rows.clear();
    this.emit("change", this.list());
  }
}
