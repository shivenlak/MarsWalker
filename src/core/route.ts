// Multi-stop EVA route: chain A* between consecutive stops, then back to base.
// Produces the polyline plus per-leg and total distance / climb / time.

import { astar } from "./astar";
import { EVA, type TerrainProfile } from "./config";
import { isPassable, makeEdgeCost, makeHeuristic, walkSpeed } from "./cost";
import { type Grid, colRow, idx, idxToXY, lonLatToXY, xyToIdx, xyToLonLat } from "./grid";

export interface Stop { id: string; name: string; lon: number; lat: number }

export interface RoutePoint {
  lon: number; lat: number; x: number; y: number;
  elev: number;
  slope: number;     // cell p90 slope (deg)
  cumDistM: number;  // 3D distance from EVA start
  cumWalkS: number;  // walking time from EVA start (excludes dwell)
}

export interface Leg {
  fromId: string; toId: string;
  startIndex: number; endIndex: number; // into Route.points
  distM: number; climbM: number; descentM: number; walkS: number;
}

export interface Route {
  points: RoutePoint[];
  legs: Leg[];
  stops: Stop[]; // in visiting order, base first and last
  totals: { distM: number; climbM: number; descentM: number; walkS: number; dwellS: number; evaS: number };
  warnings: string[];
  computeMs: number;
}

/** Nearest passable cell (BFS ring search) so a stop on a boulder still routes. */
function snapToPassable(g: Grid, i: number, p: TerrainProfile, maxRing = 6): number {
  if (isPassable(g, i, p)) return i;
  const [c0, r0] = colRow(g, i);
  for (let ring = 1; ring <= maxRing; ring++) {
    let best = -1, bestD = Infinity;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const c = c0 + dc, r = r0 + dr;
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const j = idx(g, c, r);
        const d = dr * dr + dc * dc;
        if (isPassable(g, j, p) && d < bestD) { best = j; bestD = d; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** EVA plan: base -> each target -> back to base, with dwell time at every target. */
export function planRoute(g: Grid, base: Stop, targets: Stop[], p: TerrainProfile): Route {
  return routeThrough(g, [base, ...targets, base], p, targets.length);
}

/** A* through an ordered list of points (e.g. [player, target] for live navigation). */
export function routeThrough(g: Grid, order: Stop[], p: TerrainProfile, dwellStops = 0): Route {
  const t0 = performance.now();
  const warnings: string[] = [];
  const cost = makeEdgeCost(g, p);

  const cells = order.map((s) => {
    const raw = xyToIdx(g, lonLatToXY(s));
    if (raw < 0) throw new Error(`${s.name} is outside the terrain grid`);
    const snapped = snapToPassable(g, raw, p);
    if (snapped < 0) throw new Error(`${s.name} has no passable ground nearby`);
    if (snapped !== raw) warnings.push(`${s.name}: moved to nearest passable cell`);
    return snapped;
  });

  const points: RoutePoint[] = [];
  const legs: Leg[] = [];
  let cumD = 0, cumT = 0;

  for (let k = 0; k < cells.length - 1; k++) {
    const path = astar(g.cols, g.rows, cells[k], cells[k + 1], cost, makeHeuristic(g, cells[k + 1]));
    if (!path) {
      warnings.push(`No safe path from ${order[k].name} to ${order[k + 1].name}`);
      continue;
    }
    const leg: Leg = {
      fromId: order[k].id, toId: order[k + 1].id,
      startIndex: points.length, endIndex: 0, distM: 0, climbM: 0, descentM: 0, walkS: 0,
    };
    path.forEach((cell, j) => {
      if (j > 0) {
        const prev = path[j - 1];
        const a = idxToXY(g, prev), b = idxToXY(g, cell);
        const d2 = Math.hypot(b.x - a.x, b.y - a.y);
        const dz = g.elev[cell] - g.elev[prev];
        const d3 = Math.hypot(d2, dz);
        const t = d3 / walkSpeed(dz / d2, p);
        leg.distM += d3; leg.walkS += t;
        if (dz > 0) leg.climbM += dz; else leg.descentM -= dz;
        cumD += d3; cumT += t;
      } else if (k > 0) {
        return; // first cell of this leg = last cell of previous leg
      }
      const xy = idxToXY(g, cell);
      points.push({
        ...xy, ...xyToLonLat(xy), elev: g.elev[cell], slope: g.slope[cell],
        cumDistM: cumD, cumWalkS: cumT,
      });
    });
    leg.endIndex = points.length - 1;
    legs.push(leg);
  }

  const sum = (f: (l: Leg) => number) => legs.reduce((a, l) => a + f(l), 0);
  const walkS = sum((l) => l.walkS);
  const dwellS = dwellStops * EVA.stopDwellMin.value * 60;
  return {
    points, legs, stops: order, warnings,
    totals: {
      distM: sum((l) => l.distM), climbM: sum((l) => l.climbM), descentM: sum((l) => l.descentM),
      walkS, dwellS, evaS: walkS + dwellS,
    },
    computeMs: performance.now() - t0,
  };
}
