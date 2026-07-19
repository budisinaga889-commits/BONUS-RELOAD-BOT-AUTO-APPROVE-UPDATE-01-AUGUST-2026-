import {
  BrowserContext,
  chromium,
  LaunchOptions,
  Page
} from "playwright";
import { EventEmitter } from "events";
import * as path from "path";
import { Selectors } from "./Selectors";
import { IBrowser, Transaction } from "./types";

/**
 * BrowserManager
 *
 * The ONLY module that imports `playwright`.
 * Responsibilities:
 *   - Launch browser + open panel
 *   - Read pending transactions
 *   - Bulk Approve / Bulk Reject inside a SINGLE `page.evaluate()`
 *   - Reject Single (from Skipped Transactions)
 *   - Refresh panel
 *   - Browser health flag + uptime
 *
 * Explicitly does NOT:
 *   - Enforce Daily Limit / Cooldown / Retry / Verification / Queue / SQLite
 *   - Apply any business rule (that lives in RuleEngine + BotEngine)
 *
 * ------------------------------------------------------------
 *  Robust DOM parsing (Bug #3)
 * ------------------------------------------------------------
 * `readPendingTransactions()` uses `row.cells[n]` (positional cell
 * access) instead of nested `td:nth-child()` descendant selectors, so
 * that inline `<span>`, `<em>` and `<strong>` wrappers inside the
 * amount / notes / date cells no longer break parsing. Buttons are
 * located by:
 *   1) `data-tx-id` / `data-id` attribute lookup, otherwise
 *   2) a `[id^="btn-approve-"]` / `[id^="btn-reject-"]` scan, otherwise
 *   3) a class-name substring match (`.btn-approve` / `.warning`).
 *
 * ------------------------------------------------------------
 *  Stable identity (Bug #1)
 * ------------------------------------------------------------
 * The DOM parser extracts a `txId` for every row (from the approve
 * button id / onclick / data-attribute). Approve / Reject actions then
 * target `[data-tx-id="X"]` or the button matching that id — NEVER
 * `rows[rowIndex]`. This makes the workflow safe against panel
 * re-orderings caused by a new transaction landing mid-cycle.
 */
export class BrowserManager extends EventEmitter implements IBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Timestamp of the moment the browser context was opened. */
  private openedAt = 0;
  /** Timestamp of the last successful panel refresh. */
  private lastRefreshAt: number = 0;

  constructor(private readonly userDataDir: string) {
    super();
  }

  // ---- lifecycle -----------------------------------------------------------

  isOpen(): boolean {
    return !!this.context && !!this.page && !this.page.isClosed();
  }

  getPage(): Page | null {
    return this.page;
  }

  /**
   * Milliseconds since the browser context was opened. Returns 0 when
   * the browser is not currently open.
   */
  uptimeMs(): number {
    if (!this.isOpen() || !this.openedAt) return 0;
    return Date.now() - this.openedAt;
  }

  /** ISO timestamp of the last successful panel refresh — null when none yet. */
  lastRefreshIso(): string | null {
    return this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null;
  }

  async openPanel(url: string): Promise<void> {
    await this.launch(url);
  }

  async launch(startURL: string): Promise<void> {
    if (this.isOpen()) return;

    this.context = await chromium.launchPersistentContext(
      path.resolve(this.userDataDir),
      this.buildLaunchOptions()
    );
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.openedAt = Date.now();

    // Auto-accept every native `confirm()` — the panel uses it for both
    // Approve and Reject dialogs.
    this.page.on("dialog", (d) => d.accept().catch(() => {}));

    this.context.on("close", () => {
      this.context = null;
      this.page = null;
      this.openedAt = 0;
      this.emit("closed");
    });
    this.page.on("close", () => this.emit("closed"));

    if (startURL) await this.gotoSafe(startURL);
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
      this.openedAt = 0;
    }
  }

  // ---- reads ---------------------------------------------------------------

  async isLoggedIn(): Promise<boolean> {
    if (!this.page) return false;
    return !!(await this.page.$(Selectors.table));
  }

  async readPendingTransactions(): Promise<Transaction[]> {
    if (!this.page) return [];
    await this.page
      .waitForSelector(Selectors.table, { timeout: 5_000 })
      .catch(() => {});

    // Serialise everything the DOM script needs. Regexes have to be sent
    // over as source strings and reconstructed in the evaluate context.
    const payload = {
      rows:        Selectors.rows,
      cellIdx:     Selectors.cellIdx,
      legacy:      Selectors.legacy,
      txIdPatterns: Selectors.txIdPatterns.map((r) => ({ source: r.source, flags: r.flags })),
      approveClass: Selectors.approveClass,
      rejectClass:  Selectors.rejectClass
    };

    return await this.page.evaluate((sel) => {
      const patterns = sel.txIdPatterns.map(
        (p) => new RegExp(p.source, p.flags)
      );

      const normalizeDate = (raw: string): string => {
        if (!raw) return "";
        const trimmed = raw.replace(/\s+/g, " ").trim();
        // dd/mm/yyyy HH:MM(:SS)?
        const m = trimmed.match(
          /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)$/
        );
        if (!m) return trimmed;
        const dd = m[1].padStart(2, "0");
        const mm = m[2].padStart(2, "0");
        const yyyy = m[3];
        const time = m[4].length === 5 ? `${m[4]}:00` : m[4];
        return `${yyyy}-${mm}-${dd}T${time}`;
      };

      /**
       * Return the trimmed textContent of a table cell — tolerant of
       * inline wrappers (span/em/strong/b/i/...).
       */
      const cellText = (row: HTMLTableRowElement, idx: number, fallbackSel: string): string => {
        const cell = row.cells?.[idx] as HTMLElement | undefined;
        if (cell) {
          const t = (cell.textContent || "").replace(/\s+/g, " ").trim();
          if (t) return t;
        }
        // Fallback to legacy selector (may still match).
        const legacyEl = row.querySelector(fallbackSel);
        return (legacyEl?.textContent || "").replace(/\s+/g, " ").trim();
      };

      /**
       * Locate an actionable button (approve/reject) within a row.
       * Order of preference:
       *   1. row.cells[expectedIdx] direct child (any depth)
       *   2. row.querySelector by class-substring
       *   3. row.querySelector by button id prefix (`btn-approve-*`)
       */
      const findButton = (
        row: HTMLTableRowElement,
        expectedIdx: number,
        classSubstr: string,
        idPrefix: string
      ): HTMLElement | null => {
        const cell = row.cells?.[expectedIdx] as HTMLElement | undefined;
        if (cell) {
          // Any nested element carrying the class substring counts.
          const inCell = cell.querySelector(`[class*="${classSubstr}"]`) as HTMLElement | null;
          if (inCell) return inCell;
          // Or any button-like element (a, button, span) inside the cell.
          const clickable = cell.querySelector("button,a,span,div,i,em") as HTMLElement | null;
          if (clickable) return clickable;
        }
        const byId = row.querySelector(`[id^="${idPrefix}"]`) as HTMLElement | null;
        if (byId) return byId;
        const byClass = row.querySelector(`[class*="${classSubstr}"]`) as HTMLElement | null;
        return byClass;
      };

      /**
       * Extract a stable transaction id from anything on the row that
       * has it — approve button, reject button, row itself.
       */
      const extractTxId = (row: HTMLTableRowElement): string => {
        // 1) Direct data attributes on the row.
        const attrs: Array<string | null> = [
          row.getAttribute("data-tx-id"),
          row.getAttribute("data-id"),
          row.getAttribute("data-deposit-id"),
          row.getAttribute("data-transaction-id")
        ];
        for (const a of attrs) {
          if (a && /^\d{3,}$/.test(a.trim())) return a.trim();
        }

        // 2) Approve / reject buttons often carry the id.
        const approve = findButton(row, sel.cellIdx.approve, sel.approveClass, "btn-approve-");
        const reject = findButton(row, sel.cellIdx.reject, sel.rejectClass, "btn-reject-");
        const candidates: string[] = [];
        for (const el of [approve, reject]) {
          if (!el) continue;
          const id = el.id || "";
          const onclick = el.getAttribute("onclick") || "";
          const cls = el.getAttribute("class") || "";
          // Raw attribute values (already unquoted). Digit-only values
          // like "1011193214" go straight through as the txId.
          const dataAttrs = [
            el.getAttribute("data-tx-id"),
            el.getAttribute("data-id"),
            el.getAttribute("data-deposit-id"),
            el.getAttribute("data-transaction-id")
          ];
          for (const v of dataAttrs) {
            if (v && /^\d{3,}$/.test(v.trim())) return v.trim();
          }
          candidates.push(id, onclick, cls);
          // Walk up two ancestors — the id sometimes sits on the wrapper.
          let p: HTMLElement | null = el.parentElement;
          for (let i = 0; i < 2 && p; i++, p = p.parentElement) {
            const pDataAttrs = [
              p.getAttribute("data-tx-id"),
              p.getAttribute("data-id"),
              p.getAttribute("data-deposit-id"),
              p.getAttribute("data-transaction-id")
            ];
            for (const v of pDataAttrs) {
              if (v && /^\d{3,}$/.test(v.trim())) return v.trim();
            }
            candidates.push(
              p.id || "",
              p.getAttribute("onclick") || ""
            );
          }
        }

        for (const c of candidates) {
          if (!c) continue;
          for (const rx of patterns) {
            const m = c.match(rx);
            if (m && m[1]) return m[1];
          }
        }
        return "";
      };

      const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>(sel.rows));
      return rows.map((row, index) => {
        // Player cell — legacy selector has a nested `<a>` element. Use
        // the anchor's text when present, otherwise fall back to full
        // cell text (which handles the "no anchor" panel skin).
        const playerCell = row.cells?.[sel.cellIdx.player] as HTMLElement | undefined;
        let player = "";
        if (playerCell) {
          const anchor = playerCell.querySelector("a");
          player = ((anchor?.textContent || playerCell.textContent) || "")
            .replace(/\s+/g, " ")
            .trim();
        } else {
          const legacyEl = row.querySelector(sel.legacy.player);
          player = (legacyEl?.textContent || "").replace(/\s+/g, " ").trim();
        }

        const rawAmount = cellText(row, sel.cellIdx.amount, sel.legacy.amount) || "0";
        const notes     = cellText(row, sel.cellIdx.notes,  sel.legacy.notes);
        const rawDate   = cellText(row, sel.cellIdx.date,   sel.legacy.date);

        const txId = extractTxId(row);

        return {
          username: player,
          rawAmount,
          amount: parseFloat(rawAmount.replace(/[^0-9.-]/g, "") || "0"),
          notes,
          rowIndex: index,
          txId,
          transactionDate: normalizeDate(rawDate)
        } as Transaction;
      });
    }, payload);
  }

  // ---- writes --------------------------------------------------------------

  async approveMultipleTransactions(txs: Transaction[]): Promise<void> {
    if (!this.page) throw new Error("Browser page is not active");
    if (txs.length === 0) return;
    await this.dispatchBulk(txs, "approve");
  }

  async rejectMultipleTransactions(txs: Transaction[]): Promise<void> {
    if (!this.page) throw new Error("Browser page is not active");
    if (txs.length === 0) return;
    await this.dispatchBulk(txs, "reject");
  }

  async rejectSingleTransaction(tx: Transaction): Promise<void> {
    await this.rejectMultipleTransactions([tx]);
  }

  /**
   * Bulk approve/reject inside a SINGLE `page.evaluate` (performance
   * contract). Rows are located by `txId` first; when a row has no
   * `txId`, we fall back to a composite key
   * (`username|amount|transactionDate`) that we re-derive on the panel
   * side. `rowIndex` is NEVER used.
   */
  private async dispatchBulk(
    txs: Transaction[],
    action: "approve" | "reject"
  ): Promise<void> {
    if (!this.page) return;
    const payload = {
      action,
      rows: Selectors.rows,
      cellIdx: Selectors.cellIdx,
      legacy: Selectors.legacy,
      txIdPatterns: Selectors.txIdPatterns.map((r) => ({ source: r.source, flags: r.flags })),
      approveClass: Selectors.approveClass,
      rejectClass:  Selectors.rejectClass,
      txs: txs.map((t) => ({
        txId: t.txId || "",
        username: t.username,
        amount: t.amount,
        transactionDate: t.transactionDate
      }))
    };
    await this.page.evaluate(({ action, rows: rowsSel, cellIdx, legacy,
                               txIdPatterns, approveClass, rejectClass, txs }) => {
      const patterns = txIdPatterns.map(
        (p: { source: string; flags: string }) => new RegExp(p.source, p.flags)
      );
      const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>(rowsSel));

      /* Reused helpers — kept inline to avoid additional page.evaluate
         calls (performance contract §14). */
      const cellText = (row: HTMLTableRowElement, idx: number, fallbackSel: string): string => {
        const cell = row.cells?.[idx] as HTMLElement | undefined;
        if (cell) {
          const t = (cell.textContent || "").replace(/\s+/g, " ").trim();
          if (t) return t;
        }
        const legacyEl = row.querySelector(fallbackSel);
        return (legacyEl?.textContent || "").replace(/\s+/g, " ").trim();
      };
      const findButton = (
        row: HTMLTableRowElement,
        expectedIdx: number,
        classSubstr: string,
        idPrefix: string
      ): HTMLElement | null => {
        const cell = row.cells?.[expectedIdx] as HTMLElement | undefined;
        if (cell) {
          const inCell = cell.querySelector(`[class*="${classSubstr}"]`) as HTMLElement | null;
          if (inCell) return inCell;
          const clickable = cell.querySelector("button,a,span,div,i,em") as HTMLElement | null;
          if (clickable) return clickable;
        }
        const byId = row.querySelector(`[id^="${idPrefix}"]`) as HTMLElement | null;
        if (byId) return byId;
        const byClass = row.querySelector(`[class*="${classSubstr}"]`) as HTMLElement | null;
        return byClass;
      };
      const rowTxId = (row: HTMLTableRowElement): string => {
        const attrs: Array<string | null> = [
          row.getAttribute("data-tx-id"),
          row.getAttribute("data-id"),
          row.getAttribute("data-deposit-id"),
          row.getAttribute("data-transaction-id")
        ];
        for (const a of attrs) if (a && /^\d{3,}$/.test(a.trim())) return a.trim();

        const approveBtn = findButton(row, cellIdx.approve, approveClass, "btn-approve-");
        const rejectBtn  = findButton(row, cellIdx.reject,  rejectClass,  "btn-reject-");
        const candidates: string[] = [];
        for (const el of [approveBtn, rejectBtn]) {
          if (!el) continue;
          const dataAttrs = [
            el.getAttribute("data-tx-id"),
            el.getAttribute("data-id"),
            el.getAttribute("data-deposit-id"),
            el.getAttribute("data-transaction-id")
          ];
          for (const v of dataAttrs) {
            if (v && /^\d{3,}$/.test(v.trim())) return v.trim();
          }
          candidates.push(
            el.id || "",
            el.getAttribute("onclick") || "",
            el.getAttribute("class") || ""
          );
          let p: HTMLElement | null = el.parentElement;
          for (let i = 0; i < 2 && p; i++, p = p.parentElement) {
            const pDataAttrs = [
              p.getAttribute("data-tx-id"),
              p.getAttribute("data-id"),
              p.getAttribute("data-deposit-id"),
              p.getAttribute("data-transaction-id")
            ];
            for (const v of pDataAttrs) {
              if (v && /^\d{3,}$/.test(v.trim())) return v.trim();
            }
            candidates.push(
              p.id || "",
              p.getAttribute("onclick") || ""
            );
          }
        }
        for (const c of candidates) {
          if (!c) continue;
          for (const rx of patterns) {
            const m = c.match(rx);
            if (m && m[1]) return m[1];
          }
        }
        return "";
      };
      const rowCompositeKey = (row: HTMLTableRowElement): string => {
        // Match parsing logic in read path so composite keys align.
        const playerCell = row.cells?.[cellIdx.player] as HTMLElement | undefined;
        let player = "";
        if (playerCell) {
          const anchor = playerCell.querySelector("a");
          player = ((anchor?.textContent || playerCell.textContent) || "")
            .replace(/\s+/g, " ")
            .trim();
        } else {
          const legacyEl = row.querySelector(legacy.player);
          player = (legacyEl?.textContent || "").replace(/\s+/g, " ").trim();
        }
        const rawAmount = cellText(row, cellIdx.amount, legacy.amount) || "0";
        const amount = parseFloat(rawAmount.replace(/[^0-9.-]/g, "") || "0");
        const rawDate = cellText(row, cellIdx.date, legacy.date);
        const trimmed = rawDate.replace(/\s+/g, " ").trim();
        const m = trimmed.match(
          /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)$/
        );
        let iso = trimmed;
        if (m) {
          const dd = m[1].padStart(2, "0");
          const mm = m[2].padStart(2, "0");
          const yyyy = m[3];
          const time = m[4].length === 5 ? `${m[4]}:00` : m[4];
          iso = `${yyyy}-${mm}-${dd}T${time}`;
        }
        return `${player}|${amount}|${iso}`;
      };

      // Build a lookup from txId AND composite key to the row's button.
      const byTxId       = new Map<string, HTMLElement>();
      const byComposite  = new Map<string, HTMLElement>();
      const buttonSel    = action === "approve" ? approveClass : rejectClass;
      const idPrefix     = action === "approve" ? "btn-approve-" : "btn-reject-";
      const buttonCellIdx = action === "approve" ? cellIdx.approve : cellIdx.reject;

      for (const row of rows) {
        const btn = findButton(row, buttonCellIdx, buttonSel, idPrefix);
        if (!btn) continue;
        const id = rowTxId(row);
        if (id) byTxId.set(id, btn);
        byComposite.set(rowCompositeKey(row), btn);
      }

      // Auto-accept the native confirm() dialogs the panel throws up.
      const originalConfirm = window.confirm;
      window.confirm = () => true;
      try {
        for (const tx of txs) {
          let btn: HTMLElement | undefined = tx.txId ? byTxId.get(tx.txId) : undefined;
          if (!btn) {
            const composite = `${tx.username}|${tx.amount}|${tx.transactionDate}`;
            btn = byComposite.get(composite);
          }
          if (btn) btn.click();
        }
      } finally {
        window.confirm = originalConfirm;
      }
    }, payload);
  }

  async refresh(): Promise<void> {
    if (!this.page) return;
    await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page
      .waitForSelector(Selectors.table, { timeout: 5_000 })
      .catch(() => {});
    this.lastRefreshAt = Date.now();
  }

  // ---- internals -----------------------------------------------------------

  private buildLaunchOptions(): LaunchOptions {
    const headless = process.env.BOT_HEADLESS === "1";
    const envChannel = process.env.BOT_BROWSER_CHANNEL;
    const opts: LaunchOptions = {
      headless,
      viewport: null,
      args: headless ? [] : ["--start-maximized"]
    } as LaunchOptions;
    if (envChannel === undefined) {
      (opts as { channel?: string }).channel = "chrome";
    } else if (envChannel !== "") {
      (opts as { channel?: string }).channel = envChannel;
    }
    return opts;
  }

  private async gotoSafe(url: string): Promise<void> {
    if (!this.page) return;
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
}
