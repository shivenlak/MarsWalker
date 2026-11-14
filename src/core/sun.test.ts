// Validates the Mars24 clock against Curiosity's own REMS records (sol number, Ls, sunrise/sunset).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARS_HOUR_S, marsTime, sunPosition } from "./sun";

const rems = JSON.parse(readFileSync("data/processed/conditions/rems.json", "utf8")).soles as {
  sol: number; date: string; ls: number; sunrise: string; sunset: string;
}[];

const hhmm = (s: string) => +s.slice(0, 2) + +s.slice(3) / 60;

/** Earth Date at a given LMST on a given MSL sol, by stepping from a nearby noon UTC. */
function dateAt(sol: number, lmst: number, guess: Date): Date {
  let t = guess.getTime();
  for (let i = 0; i < 6; i++) {
    const m = marsTime(new Date(t));
    const errH = (m.sol - sol) * 24 + (m.lmst - lmst);
    t -= errH * MARS_HOUR_S * 1000;
  }
  return new Date(t);
}

describe("Mars clock vs Curiosity REMS", () => {
  const sample = rems.filter((_, i) => i % 25 === 0);

  it("Ls matches REMS within 1.5 deg (REMS Ls is an integer; one Earth date spans up to ~0.7 deg of Ls)", () => {
    for (const r of sample) {
      const m = marsTime(new Date(`${r.date}T12:00:00Z`));
      const d = Math.abs(((m.ls - r.ls + 540) % 360) - 180);
      expect(d).toBeLessThan(1.5);
    }
  });

  it("MSL sol number matches REMS (the Earth date overlaps that sol)", () => {
    for (const r of sample) {
      const a = marsTime(new Date(`${r.date}T00:00:00Z`)).sol;
      const b = marsTime(new Date(`${r.date}T23:59:59Z`)).sol;
      expect(r.sol).toBeGreaterThanOrEqual(a);
      expect(r.sol).toBeLessThanOrEqual(b);
    }
  });

  it("sunrise/sunset (sun centre at horizon) within 15 min of REMS", () => {
    for (const r of sample) {
      const noon = dateAt(r.sol, 12, new Date(`${r.date}T12:00:00Z`));
      const m = marsTime(noon);
      const eotH = m.ltst - m.lmst;
      // find LTST where elevation crosses 0 in the morning / evening
      const cross = (from: number, to: number) => {
        let lo = from, hi = to;
        const f = (t: number) => sunPosition(t, m.decl).elevDeg;
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if (Math.sign(f(mid)) === Math.sign(f(lo))) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2 - eotH; // back to LMST (REMS reports LMST)
      };
      expect(Math.abs(cross(3, 12) - hhmm(r.sunrise)) * 60).toBeLessThan(15);
      expect(Math.abs(cross(12, 21) - hhmm(r.sunset)) * 60).toBeLessThan(15);
    }
  });
});
