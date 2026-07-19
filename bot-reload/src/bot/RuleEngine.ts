import { RuleDecision, Transaction } from "./types";

/**
 * RuleEngine — PURE validation only.
 *
 * Validates:
 *   Rule 1 — notes must contain "BONUS RELOAD" (case-insensitive, any whitespace).
 *   Rule 2 — amount must be exactly 5000 OR 10000.
 *
 * Explicitly does NOT know about:
 *   - Daily Limit    (BotEngine)
 *   - Business Cooldown for 5000 (BotEngine + CooldownTracker)
 *   - Pending Cache  (BotEngine + PendingCache)
 *   - Browser        (BrowserManager)
 *   - SQLite         (Database)
 *
 * This keeps the rule engine 100% side-effect free and trivially testable.
 */

export const DAILY_LIMIT_IDR = 10_000;
export const ALLOWED_AMOUNTS: ReadonlyArray<number> = [5_000, 10_000];
export const BONUS_RELOAD_REGEX = /bonus\s*reload/i;

export class RuleEngine {
  /**
   * Normalise a DOM amount string like "10,000.00" or "Rp 5,000" into an
   * integer. Returns NaN when there are no usable digits.
   */
  static normalizeAmount(raw: string): number {
    if (!raw) return NaN;
    const cleaned = raw.replace(/[^0-9.-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return NaN;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  }

  evaluate(tx: Transaction): RuleDecision {
    if (!BONUS_RELOAD_REGEX.test(tx.notes ?? "")) {
      return { approve: false, reason: "Invalid Notes" };
    }
    if (!ALLOWED_AMOUNTS.includes(tx.amount)) {
      return { approve: false, reason: "Invalid Amount" };
    }
    return { approve: true };
  }
}
