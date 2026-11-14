// Navigation helpers shared by Planner and HUD: position along a route, bearings, distances.

import type { XY } from "./grid";
import type { Route, RoutePoint } from "./route";

/** Bearing from a to b in degrees, 0 = north, clockwise. Projected metres, so fine at this scale. */
export function bearingDeg(a: XY, b: XY): number {
  return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
}

export function distM(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export interface NavState {
  pos: RoutePoint;
  legIndex: number;     // which leg we're on
  headingDeg: number;   // direction of travel
  done: boolean;
}

/** Interpolated position after `walkS` seconds of walking along the route. */
export function positionAt(route: Route, walkS: number): NavState {
  const pts = route.points;
  const last = pts[pts.length - 1];
  if (walkS >= last.cumWalkS) {
    return { pos: last, legIndex: route.legs.length - 1, headingDeg: bearingDeg(pts[pts.length - 2] ?? last, last), done: true };
  }
  // binary search for the segment containing walkS
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].cumWalkS <= walkS) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const t = (walkS - a.cumWalkS) / Math.max(b.cumWalkS - a.cumWalkS, 1e-9);
  const lerp = (u: number, v: number) => u + (v - u) * t;
  const pos: RoutePoint = {
    lon: lerp(a.lon, b.lon), lat: lerp(a.lat, b.lat), x: lerp(a.x, b.x), y: lerp(a.y, b.y),
    elev: lerp(a.elev, b.elev), slope: b.slope, cumDistM: lerp(a.cumDistM, b.cumDistM), cumWalkS: walkS,
  };
  const legIndex = Math.max(0, route.legs.findIndex((l) => hi <= l.endIndex));
  // heading: look a few points ahead to smooth out grid zig-zags
  const ahead = pts[Math.min(hi + 3, pts.length - 1)];
  return { pos, legIndex, headingDeg: bearingDeg(pos, ahead), done: false };
}

/** Max cell slope within `lookM` metres ahead along the route. */
export function slopeAhead(route: Route, walkS: number, lookM = 30): number {
  const { pos } = positionAt(route, walkS);
  let m = 0;
  for (const p of route.points) {
    if (p.cumDistM < pos.cumDistM) continue;
    if (p.cumDistM > pos.cumDistM + lookM) break;
    m = Math.max(m, p.slope);
  }
  return m;
}
