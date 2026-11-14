import { describe, expect, it } from "vitest";
import { ROVER, WALKING } from "./config";
import { walkSpeed } from "./cost";
import { canCarry, damage, heaterLoad, impactDamage, newVitals, tickVitals } from "./survival";

describe("survival model", () => {
  it("heater only draws power in the cold", () => {
    expect(heaterLoad(-20)).toBe(0);
    expect(heaterLoad(-80)).toBeGreaterThan(0.4);
  });

  it("a 1 m drop on Mars is harmless, a 6 m drop hurts", () => {
    const v = (h: number) => Math.sqrt(2 * 3.721 * h);
    expect(impactDamage(v(1))).toBe(0);
    expect(impactDamage(v(6))).toBeGreaterThan(20);
  });

  it("empty consumables kill after the hypoxia window unless sheltered", () => {
    let v = newVitals();
    for (let i = 0; i < 61; i++) v = tickVitals(v, 1, true, false);
    expect(v.cause).toMatch(/oxygen/);
    let w = newVitals();
    for (let i = 0; i < 120; i++) w = tickVitals(w, 1, true, true);
    expect(w.cause).toBeNull();
  });

  it("damage is clamped and records a cause", () => {
    const v = damage(newVitals(), 150, "Fall");
    expect(v.health).toBe(0);
    expect(v.cause).toBe("Fall");
  });

  it("sample bag has a mass limit", () => {
    const s = { id: "a", name: "x", site: "s", massKg: 2, about: "" };
    expect(canCarry([s, s], s)).toBe(true);
    expect(canCarry([s, s, s], s)).toBe(false);
  });

  it("buggy is faster than walking on the flat but slows on grades", () => {
    expect(walkSpeed(0, ROVER)).toBeGreaterThan(walkSpeed(0, WALKING));
    expect(walkSpeed(0.3, ROVER)).toBeLessThan(walkSpeed(0, ROVER));
  });
});
