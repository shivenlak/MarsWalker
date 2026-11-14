// Suit consumables + point-of-no-return. Pure functions, no UI.
// Consumables are tracked in "nominal hours" (hours at metabolic factor 1.0).

import { SUIT, RADIATION } from "./config";

export interface SuitState {
  remainingH: number;   // nominal hours left (O2 / water / battery, shared budget)
  doseMSv: number;      // accumulated dose
  elapsedS: number;     // EVA clock (s)
}

export const newSuit = (): SuitState => ({ remainingH: SUIT.capacityH.value, doseMSv: 0, elapsedS: 0 });

/** Consumption multiplier for an activity. grade = dz/dx along travel (0 if resting). */
export function metabolicFactor(moving: boolean, grade: number): number {
  const m = SUIT.metabolic.value;
  if (!moving) return m.rest;
  if (grade < -0.02) return m.downhill;
  return Math.min(m.flat + m.perGradeUp * Math.max(grade, 0), m.max);
}

/** Advance the suit by dt seconds of sim time. */
export function tickSuit(s: SuitState, dtS: number, factor: number): SuitState {
  return {
    remainingH: Math.max(0, s.remainingH - (dtS / 3600) * factor),
    doseMSv: s.doseMSv + (RADIATION.surfaceDoseMSvPerDay.value * dtS) / 86400,
    elapsedS: s.elapsedS + dtS,
  };
}

export interface ReturnCheck {
  needH: number;        // nominal hours needed to walk home
  marginH: number;      // remaining - need - reserve (negative = past the point of no return)
  status: "ok" | "turn-back" | "critical";
}

/**
 * Point of no return: can we still get home with the reserve intact?
 * returnWalkS = walking time of the A* path home; returnClimbM raises the metabolic cost.
 */
export function returnCheck(s: SuitState, returnWalkS: number, returnDistM: number, returnClimbM: number): ReturnCheck {
  const grade = returnDistM > 0 ? returnClimbM / returnDistM : 0;
  const needH = (returnWalkS / 3600) * metabolicFactor(true, grade);
  const marginH = s.remainingH - needH - SUIT.reserveH.value;
  const status = marginH < 0 ? "critical" : marginH < 0.5 ? "turn-back" : "ok";
  return { needH, marginH, status };
}
