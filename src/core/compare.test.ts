// Planner validation on real data: A* vs Curiosity's actual drives between its dated stops.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compare, distToPath, driveSegments, resample, straightLineDev } from "./compare";
import { type Grid, lonLatToXY } from "./grid";

const DIR = "data/processed";
const have = existsSync(`${DIR}/terrain/grid.bin`) && existsSync(`${DIR}/rover/traverse.geojson`);

describe("compare helpers", () => {
  it("distToPath and resample", () => {
    const p = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(distToPath({ x: 5, y: 3 }, p)).toBeCloseTo(3);
    expect(distToPath({ x: 13, y: 4 }, p)).toBeCloseTo(5);
    expect(resample(p, 2.5)).toHaveLength(5);
  });
});

describe.skipIf(!have)("A* vs Curiosity (real drives)", () => {
  it("our hazard map agrees with where Curiosity actually drove", async () => {
    const meta = JSON.parse(readFileSync(`${DIR}/terrain/grid.json`, "utf8"));
    const b = readFileSync(`${DIR}/terrain/grid.bin`);
    const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const n = meta.cols * meta.rows;
    const g: Grid = { ...meta, elev: all.subarray(0, n), slope: all.subarray(n, 2 * n), rough: all.subarray(2 * n) };
    const trav = JSON.parse(readFileSync(`${DIR}/rover/traverse.geojson`, "utf8"));
    const drives = trav.features.map((f: { geometry: { coordinates: number[][] } }) => f.geometry.coordinates.map(([lon, lat]) => lonLatToXY({ lon, lat })));
    const lms = JSON.parse(readFileSync(`${DIR}/landmarks.json`, "utf8")) as { id: string; sol: number; lon: number; lat: number }[];
    const segs = driveSegments(drives, lms.map((l) => ({ id: l.id, sol: l.sol, ...lonLatToXY(l) })));
    expect(segs.length).toBeGreaterThan(3);
    const rows = segs.map((s) => ({ s, c: compare(g, s), straight: straightLineDev(s) })).filter((r) => r.c);
    const f = (x: number) => x.toFixed(0);
    console.table(rows.map(({ s, c, straight }) => ({
      sols: `${s.from.sol}->${s.to.sol}`, curiosity_m: f(c!.curiosityM), astar_m: f(c!.astarM),
      mean_dev_m: f(c!.meanDevM), straight_dev_m: f(straight), within25: f(c!.within25Pct) + "%", cur_passable: f(c!.curPassablePct) + "%", straight_passable: f(c!.straightPassablePct) + "%",
    })));
    const meanA = rows.reduce((a, r) => a + r.c!.meanDevM, 0) / rows.length;
    const meanS = rows.reduce((a, r) => a + r.straight, 0) / rows.length;
    const avg = (k: "curPassablePct" | "straightPassablePct") => rows.reduce((a, r) => a + r.c![k], 0) / rows.length;
    console.log(`hazard map agreement: Curiosity's path ${avg("curPassablePct").toFixed(1)}% passable; straight lines ${avg("straightPassablePct").toFixed(1)}%`);
    expect(avg("curPassablePct")).toBeGreaterThan(90);
    const { isPassable } = await import("./cost");
    const { CURIOSITY, WALKING } = await import("./config");
    const valid = [...Array(n).keys()].filter((i) => !Number.isNaN(g.elev[i]));
    for (const p of [CURIOSITY, WALKING]) {
      const nogo = valid.filter((i) => !isPassable(g, i, p)).length / valid.length * 100;
      console.log(`${p.name}: ${nogo.toFixed(1)}% of the AOI is no-go`);
    }
    const { hazardAgreement } = await import("./compare");
    const h = hazardAgreement(g, drives);
    console.log(`all drives ${h.driveKm.toFixed(1)} km: ${h.driveNoGoPct.toFixed(2)}% on no-go vs ${h.areaNoGoPct.toFixed(1)}% of area -> avoided ${h.avoidance.toFixed(0)}x more than chance`);
    expect(h.avoidance).toBeGreaterThan(5);
    console.log(`segments ${rows.length}: A* mean deviation ${meanA.toFixed(1)} m vs straight line ${meanS.toFixed(1)} m`);
    expect(rows.length).toBeGreaterThan(3);
  });
});
