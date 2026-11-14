// Terrain -> A* edge cost, and the walking-speed model.
// cost(a->b) = 3D distance * slopeMult(b) * roughMult(b) + uphill penalty
// Blocked if b is no-data, steeper than maxSlope, or rougher than maxRough.

import { TOBLER, type TerrainProfile } from "./config";
import type { Grid } from "./grid";

export function isPassable(g: Grid, i: number, p: TerrainProfile): boolean {
  const s = g.slope[i], r = g.rough[i];
  return !(Number.isNaN(g.elev[i]) || s > p.maxSlopeDeg.value || r > p.maxRoughM.value);
}

/** Why a cell is blocked (for UI/debug), or null if passable. */
export function blockReason(g: Grid, i: number, p: TerrainProfile): string | null {
  if (Number.isNaN(g.elev[i])) return "no DTM data";
  if (g.slope[i] > p.maxSlopeDeg.value) return `slope ${g.slope[i].toFixed(0)} deg > ${p.maxSlopeDeg.value}`;
  if (g.rough[i] > p.maxRoughM.value) return `roughness ${g.rough[i].toFixed(2)} m > ${p.maxRoughM.value}`;
  return null;
}

export function makeEdgeCost(g: Grid, p: TerrainProfile) {
  const maxS = p.maxSlopeDeg.value, maxR = p.maxRoughM.value;
  const up = p.uphillMetresPerMetre.value;
  return (from: number, to: number, diagonal: boolean): number => {
    if (!isPassable(g, to, p)) return Infinity;
    const d = diagonal ? g.cellSize * Math.SQRT2 : g.cellSize;
    const dz = g.elev[to] - g.elev[from];
    const dist3d = Math.hypot(d, dz);
    const sm = 1 + p.slopeWeight * (g.slope[to] / maxS) ** 2;
    const rm = 1 + p.roughWeight * (g.rough[to] / maxR);
    return dist3d * sm * rm + up * Math.max(dz, 0);
  };
}

/** Admissible: every edge costs >= its 2D length (multipliers >= 1, penalties >= 0). */
export function makeHeuristic(g: Grid, goal: number) {
  const gc = goal % g.cols, gr = (goal - gc) / g.cols;
  return (i: number) => {
    const c = i % g.cols, r = (i - c) / g.cols;
    return Math.hypot(c - gc, r - gr) * g.cellSize;
  };
}

/** Walking speed (m/s) for a signed grade dz/dx, Tobler-shaped, flat = profile speed. */
export function walkSpeed(grade: number, p: TerrainProfile): number {
  const flat = (p.flatSpeedKmh.value * 1000) / 3600;
  const f = Math.exp(-TOBLER.k * Math.abs(grade + TOBLER.offset)) / Math.exp(-TOBLER.k * TOBLER.offset);
  return flat * f;
}
