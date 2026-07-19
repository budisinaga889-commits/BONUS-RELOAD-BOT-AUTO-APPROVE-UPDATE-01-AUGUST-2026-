import { RuleEngine, BONUS_RELOAD_REGEX, ALLOWED_AMOUNTS, DAILY_LIMIT_IDR } from "../src/bot/RuleEngine";
import { tx } from "./fakes";

describe("RuleEngine — pure validator", () => {
  const rules = new RuleEngine();

  test("Rule 1 — accepts notes containing BONUS RELOAD (case-insensitive)", () => {
    expect(rules.evaluate(tx("u", 5000, "Bonus Reload"))).toEqual({ approve: true });
    expect(rules.evaluate(tx("u", 5000, "bonus  reload"))).toEqual({ approve: true });
    expect(rules.evaluate(tx("u", 5000, "MY BONUS RELOAD PROMO"))).toEqual({ approve: true });
  });

  test("Rule 1 — rejects notes without BONUS RELOAD", () => {
    expect(rules.evaluate(tx("u", 5000, "Deposit Reguler"))).toEqual({
      approve: false, reason: "Invalid Notes"
    });
    expect(rules.evaluate(tx("u", 5000, ""))).toEqual({
      approve: false, reason: "Invalid Notes"
    });
  });

  test("Rule 2 — accepts exactly 5000 and 10000", () => {
    for (const a of [5000, 10000]) {
      expect(rules.evaluate(tx("u", a, "Bonus Reload"))).toEqual({ approve: true });
    }
  });

  test("Rule 2 — rejects any other amount", () => {
    for (const a of [4999, 5001, 9999, 10001, 15000, 20000, 0, -5000]) {
      expect(rules.evaluate(tx("u", a, "Bonus Reload"))).toEqual({
        approve: false, reason: "Invalid Amount"
      });
    }
  });

  test("normalizeAmount handles various DOM formats", () => {
    expect(RuleEngine.normalizeAmount("10,000.00")).toBe(10000);
    expect(RuleEngine.normalizeAmount("Rp 5,000")).toBe(5000);
    expect(RuleEngine.normalizeAmount("5000")).toBe(5000);
    expect(RuleEngine.normalizeAmount("abc")).toBeNaN();
    expect(RuleEngine.normalizeAmount("")).toBeNaN();
  });

  test("constants match spec", () => {
    expect(DAILY_LIMIT_IDR).toBe(10000);
    expect([...ALLOWED_AMOUNTS]).toEqual([5000, 10000]);
    expect(BONUS_RELOAD_REGEX.test("bonus reload")).toBe(true);
  });
});
