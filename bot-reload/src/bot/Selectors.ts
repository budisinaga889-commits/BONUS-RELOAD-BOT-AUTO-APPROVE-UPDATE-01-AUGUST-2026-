/**
 * Selectors.ts
 *
 * Single source of truth for DOM selectors on the deposit-approval panel.
 *
 * Approve/Reject confirmation is a native `confirm()` dialog handled by a
 * persistent `page.on("dialog", …)` listener in BrowserManager. There is
 * NO HTML modal selector and NO alert selector — the panel emits ONE
 * global alert per bulk submit which cannot be correlated to individual
 * transactions.
 *
 * ============================================================
 *  Robust selector strategy (Bug #3)
 * ============================================================
 * Cells are addressed by ZERO-BASED COLUMN INDEX (`cellIdx.*`) instead
 * of `td:nth-child(...)` + descendant selectors. This tolerates inline
 * `<span>`, `<em>`, `<strong>` wrappers inside cells and generally
 * survives minor cosmetic HTML changes.
 *
 * The legacy CSS selectors are preserved as `legacy` fallbacks so the
 * DOM parser can still function when the cell layout is unexpectedly
 * padded with extra columns.
 */
export const Selectors = {
  table: "#dataTable",
  rows: "tr.deposit-row",

  /**
   * Zero-based column indexes on each `tr.deposit-row`. Values map to
   * the reference panel documented in the RFC. If the panel is ever
   * re-shuffled, ONLY these need to change — the parser code is
   * layout-agnostic.
   */
  cellIdx: {
    player: 1,
    paymentMethod: 2,
    amount: 3,
    date: 5,
    notes: 6,
    approve: 8,
    reject: 9
  },

  /** Legacy nested selectors — kept purely as a fallback. */
  legacy: {
    player: "td:nth-child(2) a",
    paymentMethod: "td:nth-child(3)",
    amount: "td:nth-child(4)",
    date: "td:nth-child(6)",
    notes: "td:nth-child(7)",
    approve: "td:nth-child(9) span.btn-approve",
    reject: "td:nth-child(10) span.label.warning"
  },

  /**
   * Regex patterns used to extract a stable transaction id from an
   * approve / reject button. Any of these matching produces the txId
   * captured in group 1.
   *
   * Common shapes seen in the wild:
   *   `<button id="btn-approve-1011193214">`
   *   `<a  onclick="approve(1011193214)">`
   *   `<span data-id="1011193214" class="btn-approve">`
   *   `<td>… data-tx-id="1011193214" …</td>`
   */
  txIdPatterns: [
    /btn[-_]?approve[-_]?(\d{4,})/i,
    /btn[-_]?reject[-_]?(\d{4,})/i,
    /\bapprove\s*\(\s*['"]?(\d{4,})['"]?\s*\)/i,
    /\breject\s*\(\s*['"]?(\d{4,})['"]?\s*\)/i,
    /\bdata-(?:tx-?id|id|deposit-id|transaction-id)\s*=\s*['"]?(\d{4,})['"]?/i
  ] as ReadonlyArray<RegExp>,

  /**
   * Class-name substrings that identify approve / reject buttons no
   * matter which cell they end up in. Used as a last-resort fallback
   * by the robust parser.
   */
  approveClass: "btn-approve",
  rejectClass: "warning"
} as const;

export type SelectorMap = Readonly<Record<string, unknown>>;
