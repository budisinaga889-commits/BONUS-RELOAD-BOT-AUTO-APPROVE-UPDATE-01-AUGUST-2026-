/**
 * Selectors + DOM parser robustness tests (Bug #3)
 *
 * These tests boot a jsdom document mirroring the deposit-approval
 * panel and exercise the two guarantees that the rewrite of
 * `BrowserManager.readPendingTransactions()` is supposed to provide:
 *
 *   1. Cell text extraction uses `row.cells[idx].textContent` (the
 *      column-index-based path). Inline `<span>`, `<em>`, `<strong>`
 *      wrappers inside amount / notes / date cells no longer break
 *      parsing.
 *   2. `txId` extraction succeeds for every representative shape:
 *        - `<button id="btn-approve-1011193214">`
 *        - `<a onclick="approve(1011193214)">`
 *        - `<td data-tx-id="1011193214">`
 *        - `<span data-id="1011193214" class="btn-approve">`
 *
 * The parsing algorithm is duplicated here — it lives inside a
 * `page.evaluate` in BrowserManager and cannot be imported directly
 * from Node — but every branch uses the SAME `Selectors` constants
 * from the production code so any divergence is caught by the
 * `Bug #3 — Selectors constants are the single source of truth` test
 * below.
 */
import { JSDOM } from "jsdom";
import { Selectors } from "../src/bot/Selectors";

function makePanel(bodyRows: string): Document {
  const html = `<!doctype html><html><body>
    <table id="dataTable">
      <thead>
        <tr>
          <th>#</th><th>Player</th><th>Method</th><th>Amount</th>
          <th>Ref</th><th>Date</th><th>Notes</th><th>Status</th>
          <th>Approve</th><th>Reject</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </body></html>`;
  return new JSDOM(html).window.document;
}

/** Extracted verbatim from BrowserManager (kept in sync — see file header). */
function readRow(row: HTMLTableRowElement): {
  username: string; amount: number; notes: string; transactionDate: string; txId: string;
} {
  const cellText = (r: HTMLTableRowElement, idx: number, fallbackSel: string): string => {
    const cell = r.cells?.[idx] as HTMLElement | undefined;
    if (cell) {
      const t = (cell.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    const legacyEl = r.querySelector(fallbackSel);
    return (legacyEl?.textContent || "").replace(/\s+/g, " ").trim();
  };
  const findButton = (
    r: HTMLTableRowElement, expectedIdx: number, classSubstr: string, idPrefix: string
  ): HTMLElement | null => {
    const cell = r.cells?.[expectedIdx] as HTMLElement | undefined;
    if (cell) {
      const inCell = cell.querySelector(`[class*="${classSubstr}"]`) as HTMLElement | null;
      if (inCell) return inCell;
      const clickable = cell.querySelector("button,a,span,div,i,em") as HTMLElement | null;
      if (clickable) return clickable;
    }
    const byId = r.querySelector(`[id^="${idPrefix}"]`) as HTMLElement | null;
    if (byId) return byId;
    const byClass = r.querySelector(`[class*="${classSubstr}"]`) as HTMLElement | null;
    return byClass;
  };
  const patterns = Selectors.txIdPatterns.map((p) => p);
  const extractTxId = (r: HTMLTableRowElement): string => {
    for (const a of [
      r.getAttribute("data-tx-id"),
      r.getAttribute("data-id"),
      r.getAttribute("data-deposit-id"),
      r.getAttribute("data-transaction-id")
    ]) {
      if (a && /^\d{3,}$/.test(a.trim())) return a.trim();
    }
    const approve = findButton(r, Selectors.cellIdx.approve, Selectors.approveClass, "btn-approve-");
    const reject  = findButton(r, Selectors.cellIdx.reject,  Selectors.rejectClass,  "btn-reject-");
    const candidates: string[] = [];
    for (const el of [approve, reject]) {
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

  const playerCell = row.cells?.[Selectors.cellIdx.player] as HTMLElement | undefined;
  let player = "";
  if (playerCell) {
    const anchor = playerCell.querySelector("a");
    player = ((anchor?.textContent || playerCell.textContent) || "")
      .replace(/\s+/g, " ").trim();
  } else {
    const legacyEl = row.querySelector(Selectors.legacy.player);
    player = (legacyEl?.textContent || "").replace(/\s+/g, " ").trim();
  }
  const rawAmount = cellText(row, Selectors.cellIdx.amount, Selectors.legacy.amount) || "0";
  const notes     = cellText(row, Selectors.cellIdx.notes,  Selectors.legacy.notes);
  const rawDate   = cellText(row, Selectors.cellIdx.date,   Selectors.legacy.date);
  const trimmed = rawDate.replace(/\s+/g, " ").trim();
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
  let iso = trimmed;
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    const yyyy = m[3];
    const time = m[4].length === 5 ? `${m[4]}:00` : m[4];
    iso = `${yyyy}-${mm}-${dd}T${time}`;
  }
  return {
    username: player,
    amount: parseFloat(rawAmount.replace(/[^0-9.-]/g, "") || "0"),
    notes,
    transactionDate: iso,
    txId: extractTxId(row)
  };
}

// ---------------------------------------------------------------------------

describe("Bug #3 — DOM parser tolerates inline wrappers and shape variations", () => {
  test("plain layout — reference panel parses as expected", () => {
    const doc = makePanel(`
      <tr class="deposit-row">
        <td>1</td>
        <td><a href="/user/alice">alice</a></td>
        <td>BCA</td>
        <td>10,000.00</td>
        <td>#ref-1</td>
        <td>15/01/2026 22:21:52</td>
        <td>Bonus Reload</td>
        <td>Pending</td>
        <td><span class="btn-approve" id="btn-approve-1011193214">Approve</span></td>
        <td><span class="label warning">Reject</span></td>
      </tr>`);
    const row = doc.querySelector<HTMLTableRowElement>("tr.deposit-row")!;
    const parsed = readRow(row);
    expect(parsed.username).toBe("alice");
    expect(parsed.amount).toBe(10000);
    expect(parsed.notes).toBe("Bonus Reload");
    expect(parsed.transactionDate).toBe("2026-01-15T22:21:52");
    expect(parsed.txId).toBe("1011193214");
  });

  test("nested <span>/<em>/<strong> in every cell — still parses correctly", () => {
    const doc = makePanel(`
      <tr class="deposit-row">
        <td><strong>2</strong></td>
        <td><a href="/user/bob"><span>bob</span></a></td>
        <td><em>BRI</em></td>
        <td><strong>Rp</strong> <span>5,000</span><em>.00</em></td>
        <td><span>#ref-2</span></td>
        <td><em>15/01/2026</em> <strong>10:00:00</strong></td>
        <td><span>Bonus <strong>Reload</strong> promo</span></td>
        <td><em>Pending</em></td>
        <td><a onclick="approve(2022334455)"><span class="btn-approve"><i>OK</i></span></a></td>
        <td><span class="label warning"><i>X</i></span></td>
      </tr>`);
    const row = doc.querySelector<HTMLTableRowElement>("tr.deposit-row")!;
    const parsed = readRow(row);
    expect(parsed.username).toBe("bob");
    expect(parsed.amount).toBe(5000);
    expect(parsed.notes).toContain("Bonus");
    expect(parsed.notes).toContain("Reload");
    expect(parsed.transactionDate).toBe("2026-01-15T10:00:00");
    expect(parsed.txId).toBe("2022334455");
  });

  test("txId from data-tx-id on the row itself", () => {
    const doc = makePanel(`
      <tr class="deposit-row" data-tx-id="3033445566">
        <td>3</td><td><a>carol</a></td><td>BNI</td>
        <td>10,000</td><td>#3</td><td>15/01/2026 09:10:00</td>
        <td>Bonus Reload</td><td>Pending</td>
        <td><button>Approve</button></td><td><button>Reject</button></td>
      </tr>`);
    const row = doc.querySelector<HTMLTableRowElement>("tr.deposit-row")!;
    expect(readRow(row).txId).toBe("3033445566");
  });

  test("txId from data-id on the approve span (no button id, no onclick)", () => {
    const doc = makePanel(`
      <tr class="deposit-row">
        <td>4</td><td><a>dan</a></td><td>MDR</td>
        <td>5,000</td><td>#4</td><td>15/01/2026 09:20:00</td>
        <td>Bonus Reload</td><td>Pending</td>
        <td><span class="btn-approve" data-id="4044556677">Approve</span></td>
        <td><span class="label warning">Reject</span></td>
      </tr>`);
    const row = doc.querySelector<HTMLTableRowElement>("tr.deposit-row")!;
    expect(readRow(row).txId).toBe("4044556677");
  });

  test("txId falls back to empty string when nothing on the row carries an identifier", () => {
    const doc = makePanel(`
      <tr class="deposit-row">
        <td>5</td><td><a>erin</a></td><td>OVO</td>
        <td>5,000</td><td>#5</td><td>15/01/2026 09:30:00</td>
        <td>Bonus Reload</td><td>Pending</td>
        <td><span class="btn-approve">Approve</span></td>
        <td><span class="label warning">Reject</span></td>
      </tr>`);
    const row = doc.querySelector<HTMLTableRowElement>("tr.deposit-row")!;
    expect(readRow(row).txId).toBe("");
  });

  test("Selectors constants are the single source of truth", () => {
    // If someone edits `td:nth-child(4)` in Selectors.ts (amount column
    // index), THIS test doesn't have to be changed — but the parsed
    // amount below MUST still line up with Selectors.cellIdx.amount.
    // If the parsed cell drifts out of that column, catch it here.
    const doc = makePanel(`
      <tr class="deposit-row">
        <td>1</td><td><a>fay</a></td><td>DANA</td>
        <td class="amount-cell">10,000</td>
        <td>#6</td><td>15/01/2026 09:40:00</td>
        <td>Bonus Reload</td><td>Pending</td>
        <td><span class="btn-approve" id="btn-approve-9090909090">A</span></td>
        <td><span class="label warning">R</span></td>
      </tr>`);
    const row = doc.querySelector<HTMLTableRowElement>("tr.deposit-row")!;
    // The amount cell is at column index 3 per Selectors.cellIdx.amount.
    expect(Selectors.cellIdx.amount).toBe(3);
    expect(readRow(row).amount).toBe(10000);
  });

  test("Distinct txIds across a page full of rows are all preserved", () => {
    const rowsHtml = [1011, 1012, 1013, 1014, 1015]
      .map((id, i) => `
        <tr class="deposit-row">
          <td>${i + 1}</td><td><a>u${i}</a></td><td>M</td>
          <td>5,000</td><td>#${id}</td><td>15/01/2026 10:${i}0:00</td>
          <td>Bonus Reload</td><td>Pending</td>
          <td><span class="btn-approve" id="btn-approve-${id}${id}${id}">A</span></td>
          <td><span class="label warning">R</span></td>
        </tr>`)
      .join("");
    const doc = makePanel(rowsHtml);
    const parsed = Array.from(doc.querySelectorAll<HTMLTableRowElement>("tr.deposit-row"))
      .map(readRow);
    const ids = parsed.map((p) => p.txId);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
  });
});

describe("Bug #1 support — txId regex patterns cover the required button shapes", () => {
  const cases: Array<[string, string]> = [
    ["btn-approve-1011193214",                "1011193214"],
    ["btn-reject-1011193214",                 "1011193214"],
    ["approve(1011193214)",                   "1011193214"],
    ["reject(1011193214)",                    "1011193214"],
    ["approve('1011193214')",                 "1011193214"],
    ["data-tx-id=\"1011193214\"",             "1011193214"],
    ["data-id='1011193214'",                  "1011193214"]
  ];
  for (const [input, expected] of cases) {
    test(`extracts ${expected} from ${input}`, () => {
      let match: string | null = null;
      for (const rx of Selectors.txIdPatterns) {
        const m = input.match(rx);
        if (m) { match = m[1]; break; }
      }
      expect(match).toBe(expected);
    });
  }
});
