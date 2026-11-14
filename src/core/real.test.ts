// Smoke test on the real preprocessed Gale grid (skipped if data hasn't been built).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WALKING } from "./config";
import { isPassable } from "./cost";
import type { Grid } from "./grid";
import { planRoute, type Stop } from "./route";

const DIR = "data/processed";
const have = existsSync(`${DIR}/terrain/grid.bin`) && existsSync(`${DIR}/stops.json`);

function load(): { g: Grid; stops: Stop[] } {
  const meta = JSON.parse(readFileSync(`${DIR}/terrain/grid.json`, "utf8"));
  const b = readFileSync(`${DIR}/terrain/grid.bin`);
  const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const n = meta.cols * meta.rows;
  const g: Grid = { ...meta, elev: all.subarray(0, n), slope: all.subarray(n, 2 * n), rough: all.subarray(2 * n) };
  return { g, stops: JSON.parse(readFileSync(`${DIR}/stops.json`, "utf8")) };
}

describe.skipIf(!have)("real Gale terrain", () => {
  it("plans base -> Gediz -> boxwork entry -> boxwork main -> base", () => {
    const { g, stops } = load();
    const [base, ...targets] = stops;
    const r = planRoute(g, base, targets, WALKING);
    const blocked = r.points.filter((p) => {
      const c = Math.floor((p.x - g.originX) / g.cellSize), row = Math.floor((g.originY - p.y) / g.cellSize);
      return !isPassable(g, row * g.cols + c, WALKING);
    });
    console.log(
      `route: ${(r.totals.distM / 1000).toFixed(2)} km, +${r.totals.climbM.toFixed(0)}/-${r.totals.descentM.toFixed(0)} m, ` +
      `walk ${(r.totals.walkS / 3600).toFixed(2)} h, EVA ${(r.totals.evaS / 3600).toFixed(2)} h, ` +
      `${r.points.length} pts, ${r.computeMs.toFixed(0)} ms, warnings: ${JSON.stringify(r.warnings)}`,
    );
    r.legs.forEach((l) => console.log(`  ${l.fromId} -> ${l.toId}: ${(l.distM / 1000).toFixed(2)} km, +${l.climbM.toFixed(0)} m, ${(l.walkS / 60).toFixed(0)} min`));
    expect(r.legs).toHaveLength(4);
    expect(blocked).toHaveLength(0);
  });
});
