import { describe, expect, it } from "vitest";
import { SUIT } from "./config";
import { metabolicFactor, newSuit, returnCheck, tickSuit } from "./suit";

describe("suit consumables", () => {
  it("one hour of flat walking uses one nominal hour", () => {
    const s = tickSuit(newSuit(), 3600, metabolicFactor(true, 0));
    expect(s.remainingH).toBeCloseTo(SUIT.capacityH.value - 1, 6);
  });

  it("climbing costs more than flat, resting less", () => {
    expect(metabolicFactor(true, 0.2)).toBeGreaterThan(metabolicFactor(true, 0));
    expect(metabolicFactor(false, 0)).toBeLessThan(metabolicFactor(true, 0));
    expect(metabolicFactor(true, 5)).toBe(SUIT.metabolic.value.max);
  });

  it("dose accrues at 0.64 mSv/day (Hassler 2014)", () => {
    const s = tickSuit(newSuit(), 86400, 1);
    expect(s.doseMSv).toBeCloseTo(0.64, 6);
  });

  it("point of no return flips when the walk home no longer fits", () => {
    const fresh = newSuit();
    expect(returnCheck(fresh, 2 * 3600, 6000, 0).status).toBe("ok");
    const late = { ...fresh, remainingH: 2.4 };
    expect(returnCheck(late, 2 * 3600, 6000, 0).status).toBe("critical"); // 2.4 - 2 - 0.5 < 0
    const close = { ...fresh, remainingH: 2.8 };
    expect(returnCheck(close, 2 * 3600, 6000, 0).status).toBe("turn-back"); // margin 0.3 h
  });
});
