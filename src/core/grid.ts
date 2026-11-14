// Terrain grid: elevation / slope / roughness per 10 m cell, plus coordinate helpers.
// Projection matches the USGS Gale DEM: x = R*lon_rad, y = R*lat_rad (metres).

export const R_MARS = 3396190;

export interface Grid {
  cols: number;
  rows: number;
  cellSize: number; // metres
  originX: number;  // projected metres, top-left corner of cell (0,0)
  originY: number;
  elev: Float32Array;  // m, NaN = no data
  slope: Float32Array; // deg (p90 of 2 m slopes in cell)
  rough: Float32Array; // m (RMS residual about best-fit plane)
}

export interface XY { x: number; y: number }
export interface LonLat { lon: number; lat: number }

const DEG = Math.PI / 180;

export function lonLatToXY(p: LonLat): XY {
  return { x: R_MARS * p.lon * DEG, y: R_MARS * p.lat * DEG };
}

export function xyToLonLat(p: XY): LonLat {
  return { lon: p.x / R_MARS / DEG, lat: p.y / R_MARS / DEG };
}

export function idx(g: Grid, col: number, row: number): number {
  return row * g.cols + col;
}

export function colRow(g: Grid, i: number): [number, number] {
  return [i % g.cols, Math.floor(i / g.cols)];
}

/** Cell index containing a projected point, or -1 if outside the grid. */
export function xyToIdx(g: Grid, p: XY): number {
  const col = Math.floor((p.x - g.originX) / g.cellSize);
  const row = Math.floor((g.originY - p.y) / g.cellSize);
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return -1;
  return idx(g, col, row);
}

/** Projected centre of a cell. */
export function idxToXY(g: Grid, i: number): XY {
  const [c, r] = colRow(g, i);
  return { x: g.originX + (c + 0.5) * g.cellSize, y: g.originY - (r + 0.5) * g.cellSize };
}

/** Load grid.json + grid.bin produced by scripts/build_terrain.py. */
export async function loadGrid(base = ""): Promise<Grid> {
  const meta = await (await fetch(`${base}terrain/grid.json`)).json();
  const buf = await (await fetch(`${base}terrain/grid.bin`)).arrayBuffer();
  const n = meta.cols * meta.rows;
  const all = new Float32Array(buf);
  return {
    cols: meta.cols, rows: meta.rows, cellSize: meta.cellSize,
    originX: meta.originX, originY: meta.originY,
    elev: all.subarray(0, n), slope: all.subarray(n, 2 * n), rough: all.subarray(2 * n, 3 * n),
  };
}
