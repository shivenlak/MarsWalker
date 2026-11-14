// Survival model for the game: health, suit heater load in the cold, fall damage, oxygen-out,
// emergency shelter. Pure functions over a small state object; the game calls tick() every frame.

import { SURVIVAL } from "./config";

export interface Vitals {
  health: number;        // 0..100
  hypoxiaS: number;      // sim seconds spent with empty consumables
  cause: string | null;  // set when health hits 0
}

export const newVitals = (): Vitals => ({ health: 100, hypoxiaS: 0, cause: null });

/** Extra consumption multiplier from the suit heater at outside temperature tempC. */
export function heaterLoad(tempC: number): number {
  const t = SURVIVAL.heaterOnBelowC.value;
  return tempC < t ? (t - tempC) * SURVIVAL.heaterPerDegree.value : 0;
}

/** Health lost when landing at `speed` m/s (vertical). */
export function impactDamage(speed: number): number {
  const over = speed - SURVIVAL.safeImpactMs.value;
  return over > 0 ? over * SURVIVAL.damagePerMs.value : 0;
}

/** Advance vitals by dtS sim seconds. `consumablesEmpty`: suit O2/power is exhausted. */
export function tickVitals(v: Vitals, dtS: number, consumablesEmpty: boolean, sheltered: boolean): Vitals {
  if (v.cause) return v;
  let { health, hypoxiaS } = v;
  if (consumablesEmpty && !sheltered) {
    hypoxiaS += dtS;
    health -= (100 / SURVIVAL.hypoxiaS.value) * dtS;
  } else {
    hypoxiaS = 0;
    if (sheltered) health = Math.min(100, health + dtS / 360); // slow recovery while resting
  }
  health = Math.max(0, health);
  return { health, hypoxiaS, cause: health <= 0 ? (consumablesEmpty ? "Suit oxygen and power exhausted" : "Injuries") : null };
}

export function damage(v: Vitals, amount: number, cause: string): Vitals {
  if (v.cause || amount <= 0) return v;
  const health = Math.max(0, v.health - amount);
  return { ...v, health, cause: health <= 0 ? cause : null };
}

// ---------- samples ----------
export interface Sample { id: string; name: string; site: string; massKg: number; about: string }

export const SAMPLE_LIMIT_KG = { value: 6, source: "ASSUMED: sample bag mass a suited walker carries comfortably (Apollo sample bags held a few kg each)." };

export function canCarry(bag: Sample[], s: Sample): boolean {
  return bag.reduce((a, b) => a + b.massKg, 0) + s.massKg <= SAMPLE_LIMIT_KG.value;
}
