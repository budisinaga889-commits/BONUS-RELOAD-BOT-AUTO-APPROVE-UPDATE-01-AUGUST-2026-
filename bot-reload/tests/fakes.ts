/**
 * Test-only in-memory stub for the IBrowser contract. Lets us drive the
 * full BotEngine verification flow without launching Playwright. Every
 * write records the batch so tests can assert single-round-trip behaviour
 * (Performance Contract §14).
 */
import { EventEmitter } from "events";
import { IBrowser, Transaction } from "../src/bot/types";

export class FakeBrowser extends EventEmitter implements IBrowser {
  private open = false;
  private loggedIn = true;
  private pending: Transaction[] = [];
  private openedAt = 0;
  private lastRefreshAt = 0;

  public approveBatches: Transaction[][] = [];
  public rejectBatches: Transaction[][] = [];
  public rejectSingles: Transaction[] = [];
  public refreshes = 0;
  /** When true, a submitted approve DOES NOT remove the tx from the panel. */
  public sabotageApprove = false;
  public sabotageReject  = false;
  /** When set, the next read call throws. */
  public throwOnNextRead: string | null = null;

  setPending(list: Transaction[]) { this.pending = list; }
  setLoggedIn(v: boolean) { this.loggedIn = v; }

  isOpen() { return this.open; }
  async launch(_startURL?: string) { this.open = true; this.openedAt = Date.now(); }
  async openPanel(_url?: string) { this.open = true; this.openedAt = Date.now(); }
  async isLoggedIn() { return this.loggedIn; }

  uptimeMs(): number { return this.open && this.openedAt ? Date.now() - this.openedAt : 0; }
  lastRefreshIso(): string | null {
    return this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null;
  }

  async readPendingTransactions(): Promise<Transaction[]> {
    if (this.throwOnNextRead) {
      const msg = this.throwOnNextRead;
      this.throwOnNextRead = null;
      throw new Error(msg);
    }
    // Return a fresh copy with reindexed rowIndex so tests match the real DOM.
    return this.pending.map((tx, i) => ({ ...tx, rowIndex: i }));
  }

  async approveMultipleTransactions(txs: Transaction[]) {
    this.approveBatches.push(txs.map((t) => ({ ...t })));
    if (!this.sabotageApprove) {
      const rmById = new Set(txs.filter((t) => t.txId).map((t) => t.txId));
      const rmByKey = new Set(txs.map((t) => `${t.username}|${t.amount}|${t.transactionDate}`));
      this.pending = this.pending.filter((t) => {
        if (t.txId && rmById.has(t.txId)) return false;
        if (rmByKey.has(`${t.username}|${t.amount}|${t.transactionDate}`)) return false;
        return true;
      });
    }
  }
  async rejectMultipleTransactions(txs: Transaction[]) {
    this.rejectBatches.push(txs.map((t) => ({ ...t })));
    if (!this.sabotageReject) {
      const rmById = new Set(txs.filter((t) => t.txId).map((t) => t.txId));
      const rmByKey = new Set(txs.map((t) => `${t.username}|${t.amount}|${t.transactionDate}`));
      this.pending = this.pending.filter((t) => {
        if (t.txId && rmById.has(t.txId)) return false;
        if (rmByKey.has(`${t.username}|${t.amount}|${t.transactionDate}`)) return false;
        return true;
      });
    }
  }
  async rejectSingleTransaction(tx: Transaction) {
    this.rejectSingles.push({ ...tx });
    if (!this.sabotageReject) {
      const key = `${tx.username}|${tx.amount}|${tx.transactionDate}`;
      this.pending = this.pending.filter(
        (t) => (tx.txId ? t.txId !== tx.txId : true) &&
               `${t.username}|${t.amount}|${t.transactionDate}` !== key
      );
    }
  }
  async refresh() {
    this.refreshes += 1;
    this.lastRefreshAt = Date.now();
  }
  async close() { this.open = false; this.openedAt = 0; this.emit("closed"); }
}

export function tx(
  username: string,
  amount: number,
  notes: string,
  transactionDate = "2026-01-15T22:21:52",
  txId = ""
): Transaction {
  return {
    username,
    amount,
    rawAmount: String(amount),
    notes,
    rowIndex: 0,
    txId,
    transactionDate
  };
}
