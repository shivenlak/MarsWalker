import { describe, expect, it } from "vitest";
import { astar } from "./astar";
import { WALKING } from "./config";
import { makeEdgeCost, makeHeuristic } from "./cost";
import type { Grid } from "./grid";
import { planRoute } from "./route";

// Hand-made 10x10 map. '#' = wall / steep, '.' = open. S = start, G = goal.
const MAP = [
  "S....#...G",
  ".....#....",
  ".....#....",
  ".....#....",
  ".....#....",
  ".....#....",
  ".....#....",
  ".....#....",
  ".....#....",
  "..........", // the only gap is in the bottom row
];
const N = 10;
const at = (c: number, r: number) => r * N + c;
const isWall = (i: number) => MAP[Math.floor(i / N)][i % N] === "#";

describe("A* on a hand-made 10x10 grid", () => {
  it("goes around a wall through the only gap", () => {
    const cost = (_a: number, b: number, diag: boolean) => (isWall(b) ? Infinity : diag ? Math.SQRT2 : 1);
    const h = (i: number) => Math.hypot((i % N) - 9, Math.floor(i / N) - 0);
    const path = astar(N, N, at(0, 0), at(9, 0), cost, h)!;

    expect(path).not.toBeNull();
    expect(path[0]).toBe(at(0, 0));
    expect(path[path.length - 1]).toBe(at(9, 0));
    expect(path.some(isWall)).toBe(false);
    expect(path).toContain(at(5, 9)); // must pass through the gap
    // optimal 8-connected length: down-diagonal to gap and back up = 8+...; check it's not absurd
    expect(path.length).toBeLessThanOrEqual(20);
  });

  it("returns null when the goal is sealed off", () => {
    const cost = (_a: number, b: number) => (isWall(b) || b === at(5, 9) ? Infinity : 1);
    expect(astar(N, N, at(0, 0), at(9, 0), cost, () => 0)).toBeNull();
  });
});

describe("terrain cost on a synthetic DTM grid", () => {
  // Flat 10x10 grid, 10 m cells, with a column of 40-degree cells (wall) except a gap at the bottom.
  function grid(): Grid {
    const n = N * N;
    const g: Grid = {
      cols: N, rows: N, cellSize: 10, originX: 0, originY: 0,
      elev: new Float32Array(n), slope: new Float32Array(n).fill(3), rough: new Float32Array(n).fill(0.05),
    };
    for (let i = 0; i < n; i++) if (isWall(i)) g.slope[i] = 40;
    return g;
  }

  it("avoids cells steeper than the walking slope limit", () => {
    const g = grid();
    const path = astar(N, N, at(0, 0), at(9, 0), makeEdgeCost(g, WALKING), makeHeuristic(g, at(9, 0)))!;
    expect(path).not.toBeNull();
    expect(path.some((i) => g.slope[i] > WALKING.maxSlopeDeg.value)).toBe(false);
    expect(path).toContain(at(5, 9));
  });

  it("prefers a short detour over a passable-but-steep shortcut", () => {
    const g = grid();
    for (let i = 0; i < N * N; i++) if (isWall(i)) g.slope[i] = 24; // just under the limit: passable, expensive
    g.slope[at(5, 0)] = 24;
    const path = astar(N, N, at(0, 0), at(9, 0), makeEdgeCost(g, WALKING), makeHeuristic(g, at(9, 0)))!;
    // crossing the steep column is allowed; route should cross it exactly once (one steep cell), not walk along it
    expect(path.filter((i) => g.slope[i] >= 24).length).toBe(1);
  });

  it("planRoute chains base -> stop -> base and reports totals", () => {
    const g = grid();
    // originY = 0 and rows go south, so lat is negative; convert cell centres to lon/lat
    const R = 3396190, toDeg = 180 / Math.PI;
    const ll = (c: number, r: number) => ({ lon: ((c + 0.5) * 10 / R) * toDeg, lat: (-(r + 0.5) * 10 / R) * toDeg });
    const route = planRoute(g, { id: "b", name: "Base", ...ll(0, 0) }, [{ id: "t", name: "Target", ...ll(9, 0) }], WALKING);
    expect(route.legs).toHaveLength(2);
    expect(route.warnings).toEqual([]);
    expect(route.totals.distM).toBeGreaterThan(2 * 90); // longer than straight line because of the wall
    expect(route.points[0].lon).toBeCloseTo(route.points[route.points.length - 1].lon, 9);
  });
});
