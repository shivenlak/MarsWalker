// Earth-Mars distance checked against published close approaches and a conjunction.
import { describe, expect, it } from "vitest";
import { commLink } from "./space";

describe("Earth-Mars comm link (JPL approximate elements)", () => {
  it("2003-08-27 closest approach: 55.76 million km (NASA)", () => {
    expect(commLink(new Date("2003-08-27T09:51:00Z")).distKm / 1e6).toBeCloseTo(55.76, 0);
  });
  it("2020-10-06 closest approach: 62.07 million km (NASA)", () => {
    expect(commLink(new Date("2020-10-06T14:18:00Z")).distKm / 1e6).toBeCloseTo(62.07, 0);
  });
  it("light time stays in the published 3-22 min range over a synodic period", () => {
    for (let d = 0; d < 800; d += 10) {
      const m = commLink(new Date(Date.UTC(2025, 0, 1) + d * 86400000)).oneWayS / 60;
      expect(m).toBeGreaterThan(3); expect(m).toBeLessThan(22.5);
    }
  });
  it("2026-01-09 solar conjunction: Mars within ~1 deg of the Sun", () => {
    expect(commLink(new Date("2026-01-09T12:00:00Z")).sunAngleDeg).toBeLessThan(2);
  });
});
