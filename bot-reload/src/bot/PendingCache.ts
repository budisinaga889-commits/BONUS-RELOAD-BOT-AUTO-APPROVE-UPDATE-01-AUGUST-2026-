import { Transaction } from "./types";

/**
 * PendingCache
 *
 * In-memory Set of transaction keys currently visible on the panel.
 * Purpose: dedupe rows within the SAME polling cycle and across cycles that
 * happen before the panel actually refreshes. It NEVER outlives the
 * bot session.
 *
 * Key formula (Part 5 §8): `${username}|${amount}|${transactionDate}`.
 *
 * The cache is:
 *   - populated in the DISCOVERED → NORMALIZED phase,
 *   - pruned every cycle so it always mirrors the panel,
 *   - fully cleared on stop().
 */
export class PendingCache {
  private readonly set = new Set<string>();

  static keyOf(tx: Pick<Transaction, "username" | "amount" | "transactionDate">): string {
    return `${tx.username}|${tx.amount}|${tx.transactionDate}`;
  }

  has(tx: Transaction): boolean {
    return this.set.has(PendingCache.keyOf(tx));
  }
  hasKey(key: string): boolean {
    return this.set.has(key);
  }

  add(tx: Transaction): void {
    this.set.add(PendingCache.keyOf(tx));
  }

  delete(tx: Transaction): void {
    this.set.delete(PendingCache.keyOf(tx));
  }

  size(): number {
    return this.set.size;
  }

  /** Drop entries whose keys are not present in `visibleKeys`. */
  reconcile(visibleKeys: Set<string>): void {
    for (const key of Array.from(this.set)) {
      if (!visibleKeys.has(key)) this.set.delete(key);
    }
  }

  clear(): void {
    this.set.clear();
  }

  keys(): string[] {
    return Array.from(this.set);
  }
}
