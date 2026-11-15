// Validation against reality: run our A* between two of Curiosity's real stopping points and compare the
// result with the path the rover team actually drove (MMGIS traverse). If the planner picks a similar
// line through the same terrain, that is evidence it reasons about the ground the way real planners do.

import { CURIOSITY, type TerrainProfile } from "./config";
import { isPassable } from "./cost";
import { type Grid, type XY, xyToIdx, xyToLonLat } from "./grid";
import { routeThrough } from "./route";

export interface Mark { id: string; sol: number; x: number; y: number }

export interface DriveSegment {
  from: Mark; to: Mark;
  path: XY[];   // Curiosity's drives between the two stops, in order
}

export interface Comparison {
  seg: DriveSegment;
  astar: XY[];
  curiosityM: number;   // length of the real drive (2D)
  astarM: number;       // length of the A* route (2D)
  meanDevM: number;     // mean distance from each A* point to Curiosity's path
  maxDevM: number;
  within25Pct: number;  // share of A* points within 25 m of the real drive
  curPassablePct: number; // share of Curiosity's path that our profile also rates passable
  straightDevM: number;   // baseline: straight line's mean distance to Curiosity's path
  straightPassablePct: number; // baseline: share of the straight line on passable cells
  ms: number;
}

const len = (p: XY[]) => p.reduce((a, q, i) => (i ? a + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0);

/** Distance from point q to polyline p. */
export function distToPath(q: XY, p: XY[]): number {
  let best = Infinity;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy)));
  }
  return p.length === 1 ? Math.hypot(q.x - p[0].x, q.y - p[0].y) : best;
}

/** Resample a polyline every `step` metres (so metrics don't depend on vertex density). */
export function resample(p: XY[], step: number): XY[] {
  if (p.length < 2) return p.slice();
  const out: XY[] = [p[0]];
  let carry = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    let t = step - carry;
    while (t <= d) { out.push({ x: a.x + ((b.x - a.x) * t) / d, y: a.y + ((b.y - a.y) * t) / d }); t += step; }
    carry = d - (t - step);
  }
  const last = p[p.length - 1], prev = out[out.length - 1];
  if (Math.hypot(last.x - prev.x, last.y - prev.y) > 1e-6) out.push(last);
  return out;
}

/**
 * Cut Curiosity's drive log into segments between consecutive dated stops. `drives` are the traverse
 * features in mission order; each mark is matched to the drive whose end point is nearest to it.
 */
export function driveSegments(drives: XY[][], marks: Mark[], minLenM = 120): DriveSegment[] {
  const ends = drives.map((d) => d[d.length - 1]);
  const nearestDrive = (m: Mark) => {
    let bi = -1, bd = Infinity;
    ends.forEach((e, i) => { const d = Math.hypot(e.x - m.x, e.y - m.y); if (d < bd) { bd = d; bi = i; } });
    return bd < 15 ? bi : -1;
  };
  const sorted = marks.slice().sort((a, b) => a.sol - b.sol);
  const out: DriveSegment[] = [];
  for (let k = 1; k < sorted.length; k++) {
    const a = nearestDrive(sorted[k - 1]), b = nearestDrive(sorted[k]);
    if (a < 0 || b <= a) continue;
    const path = drives.slice(a + 1, b + 1).flat();
    if (path.length < 2 || len(path) < minLenM) continue;
    out.push({ from: sorted[k - 1], to: sorted[k], path });
  }
  return out;
}

export function compare(g: Grid, seg: DriveSegment, p: TerrainProfile = CURIOSITY): Comparison | null {
  const t0 = performance.now();
  const st = (m: Mark) => ({ id: m.id, name: m.id, ...xyToLonLat(m) });
  const r = routeThrough(g, [st(seg.from), st(seg.to)], p);
  if (!r.legs.length) return null;
  const astar = r.points.map((q) => ({ x: q.x, y: q.y }));
  const cur = resample(seg.path, 5);
  const devs = resample(astar, 5).map((q) => distToPath(q, seg.path));
  const passPct = (pts: XY[]) => (pts.filter((q) => { const i = xyToIdx(g, q); return i >= 0 && isPassable(g, i, p); }).length / pts.length) * 100;
  const line = resample([seg.from, seg.to], 5);
  return {
    seg, astar,
    curiosityM: len(seg.path), astarM: len(astar),
    meanDevM: devs.reduce((a, b) => a + b, 0) / devs.length,
    maxDevM: Math.max(...devs),
    within25Pct: (devs.filter((d) => d <= 25).length / devs.length) * 100,
    curPassablePct: passPct(cur),
    straightDevM: straightLineDev(seg),
    straightPassablePct: passPct(line),
    ms: performance.now() - t0,
  };
}

/**
 * Baseline for honesty: the same metrics for a straight line between the two stops. A* should beat it,
 * otherwise "close to Curiosity" just means the stops are close together.
 */
export function straightLineDev(seg: DriveSegment): number {
  const line = resample([seg.from, seg.to], 5);
  return line.reduce((a, q) => a + distToPath(q, seg.path), 0) / line.length;
}

/**
 * Hazard-map validation over every drive in the area: what share of Curiosity's real path lies on cells
 * the profile rates passable, versus the share of the whole area that is passable. If the rover (driven by
 * a team with full HiRISE + Navcam knowledge) avoided our no-go cells far more than chance, the map is
 * picking up real hazards.
 */
export function hazardAgreement(g: Grid, drives: XY[][], p: TerrainProfile = CURIOSITY) {
  let on = 0, tot = 0;
  for (const d of drives) for (const q of resample(d, 5)) {
    const i = xyToIdx(g, q);
    if (i < 0 || Number.isNaN(g.elev[i])) continue;
    tot++; if (isPassable(g, i, p)) on++;
  }
  let valid = 0, nogo = 0;
  for (let i = 0; i < g.elev.length; i++) {
    if (Number.isNaN(g.elev[i])) continue;
    valid++; if (!isPassable(g, i, p)) nogo++;
  }
  const driveNoGoPct = tot ? ((tot - on) / tot) * 100 : 0;
  const areaNoGoPct = (nogo / valid) * 100;
  return { driveKm: (tot * 5) / 1000, drivePassablePct: 100 - driveNoGoPct, driveNoGoPct, areaNoGoPct, avoidance: areaNoGoPct / Math.max(driveNoGoPct, 0.01) };
}
