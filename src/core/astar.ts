// Plain A* on a 2D grid, 8-connected. Knows nothing about terrain:
// the caller supplies edgeCost (Infinity = blocked) and an admissible heuristic.

export type EdgeCost = (from: number, to: number, diagonal: boolean) => number;
export type Heuristic = (i: number) => number;

const NEIGHBOURS: [number, number, boolean][] = [
  [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false],
  [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true],
];

/** Returns the list of cell indices from start to goal (inclusive), or null if unreachable. */
export function astar(
  cols: number, rows: number, start: number, goal: number,
  edgeCost: EdgeCost, h: Heuristic,
): number[] | null {
  const n = cols * rows;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new MinHeap();
  g[start] = 0;
  open.push(start, h(start));

  while (open.size > 0) {
    const cur = open.pop();
    if (cur === goal) return reconstruct(came, goal);
    if (closed[cur]) continue; // stale heap entry (lazy deletion)
    closed[cur] = 1;
    const cx = cur % cols, cy = (cur - cx) / cols;
    for (const [dx, dy, diag] of NEIGHBOURS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nb = ny * cols + nx;
      if (closed[nb]) continue;
      const c = edgeCost(cur, nb, diag);
      if (!isFinite(c)) continue;
      const tentative = g[cur] + c;
      if (tentative < g[nb]) {
        g[nb] = tentative;
        came[nb] = cur;
        open.push(nb, tentative + h(nb));
      }
    }
  }
  return null;
}

function reconstruct(came: Int32Array, goal: number): number[] {
  const path = [goal];
  let c = goal;
  while (came[c] !== -1) { c = came[c]; path.push(c); }
  return path.reverse();
}

/** Binary min-heap of (item, priority). */
class MinHeap {
  private items: number[] = [];
  private pri: number[] = [];
  get size() { return this.items.length; }

  push(item: number, p: number) {
    this.items.push(item); this.pri.push(p);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.pri[parent] <= this.pri[i]) break;
      this.swap(i, parent); i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastI = this.items.pop()!, lastP = this.pri.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastI; this.pri[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.items.length && this.pri[l] < this.pri[m]) m = l;
        if (r < this.items.length && this.pri[r] < this.pri[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.pri[a], this.pri[b]] = [this.pri[b], this.pri[a]];
  }
}
