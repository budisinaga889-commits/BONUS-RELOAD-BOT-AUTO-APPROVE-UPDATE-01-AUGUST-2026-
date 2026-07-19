import { Database } from "./Database";

/**
 * CooldownTracker — Business Cooldown for Rp5.000 bonuses.
 *
 * Rule (from Part 3 clarification): a user may only receive ONE Rp5.000
 * Bonus Reload every 10 minutes. This is NOT a retry cooldown — retries
 * follow the normal polling interval (Part 3 clarification).
 *
 * The tracker is source-of-truth-agnostic: it looks up the last verified
 * Rp5.000 approval directly from the SQLite Approval History and reasons
 * over it. This means the cooldown survives app restarts.
 */
export class CooldownTracker {
  constructor(
    private readonly db: Database,
    /** Cooldown duration in minutes. Defaults to 10 per the specification. */
    private windowMinutes: number
  ) {}

  updateWindow(minutes: number): void {
    this.windowMinutes = Math.max(0, minutes);
  }

  /**
   * `true` if approving a Rp5.000 bonus for `username` NOW is blocked by
   * the Business Cooldown. Always false for amounts other than 5000.
   */
  isBlocked(username: string, amount: number, now: Date = new Date()): boolean {
    if (amount !== 5_000) return false;
    if (this.windowMinutes <= 0) return false;
    const lastIso = this.db.lastApprovedAtForUserAmount(username, 5_000);
    if (!lastIso) return false;
    const last = new Date(lastIso).getTime();
    if (!Number.isFinite(last)) return false;
    return now.getTime() - last < this.windowMinutes * 60 * 1000;
  }
}
