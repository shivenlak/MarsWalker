// CRISM hydrated-mineral map (MTRDR HYD browse, FRT000058A3), cropped to the AOI by scripts/fetch_crism.py.
// Decodes the PNG's DNs to physical band depths with the label's scaling, offers a contrast-stretched
// texture for display, a point query for the spectrometer, and the strongest-signal spots for specimens.

import type { Bounds } from "./data";

export interface CrismMeta {
  file: string; product: string; observed: string; bounds: Bounds; width: number; height: number;
  bands: string[]; scale: number[]; offset: number[]; p95: Record<string, number>; legend: string; source: string; url: string;
}

export interface CrismReading {
  sindex2: number; bd2100: number; bd1900: number;
  /** signal relative to the scene's 95th percentile, per band (1 = strong for this scene) */
  rel: [number, number, number];
  label: string;  // interpretation per the product label, hedged
  strength: "none" | "weak" | "moderate" | "strong";
}

export class Crism {
  private constructor(readonly meta: CrismMeta, private dn: Uint8ClampedArray) {}

  static async load(): Promise<Crism | null> {
    try {
      const meta: CrismMeta = await (await fetch("overlays/crism.json")).json();
      const img = new Image();
      img.src = meta.file;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = meta.width; c.height = meta.height;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      return new Crism(meta, g.getImageData(0, 0, meta.width, meta.height).data);
    } catch { return null; }
  }

  private phys(i: number, k: number) { return this.dn[i * 4 + k] * this.meta.scale[k] + this.meta.offset[k]; }

  /** Band depths at lon/lat (nearest 18 m pixel), or null outside / no data. */
  at(lon: number, lat: number): CrismReading | null {
    const b = this.meta.bounds;
    const c = Math.floor(((lon - b.west) / (b.east - b.west)) * this.meta.width);
    const r = Math.floor(((b.north - lat) / (b.north - b.south)) * this.meta.height);
    if (c < 0 || r < 0 || c >= this.meta.width || r >= this.meta.height) return null;
    const i = r * this.meta.width + c;
    if (this.dn[i * 4 + 3] === 0) return null;
    return this.read(i);
  }

  private read(i: number): CrismReading {
    const [s, m, w] = [0, 1, 2].map((k) => this.phys(i, k));
    const p = this.meta.p95, n = this.meta.bands;
    const rel: [number, number, number] = [s / p[n[0]], m / p[n[1]], w / p[n[2]]];
    const top = Math.max(...rel);
    // ASSUMED thresholds on scene-relative signal; the label itself says spectra are needed for a positive ID
    const strength = top > 1.4 ? "strong" : top > 1 ? "moderate" : top > 0.6 ? "weak" : "none";
    let label = "no clear hydration signal";
    if (strength !== "none") {
      if (rel[0] >= rel[1] && rel[2] > 0.6) label = "polyhydrated-sulfate-like (1.9 + 2.4 µm)";
      else if (rel[1] > rel[0]) label = "monohydrated-sulfate-like (2.1 µm)";
      else if (rel[2] >= rel[0]) label = "hydrated mineral (1.9 µm water band)";
      else label = "sulfate index elevated";
    }
    return { sindex2: s, bd2100: m, bd1900: w, rel, label, strength };
  }

  /** Display texture: each band stretched to its scene 99th percentile, alpha from signal strength. */
  stretched(): HTMLCanvasElement {
    const { width: W, height: H } = this.meta;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d")!;
    const out = g.createImageData(W, H);
    const p99 = [0, 1, 2].map((k) => {
      const v: number[] = [];
      for (let i = 0; i < W * H; i++) if (this.dn[i * 4 + 3]) v.push(this.dn[i * 4 + k]);
      v.sort((a, b) => a - b);
      return Math.max(1, v[Math.floor(v.length * 0.99)] ?? 1);
    });
    // 3x3 mean for display only: single 18 m pixels are noisy, coherent patches are the signal
    const sm = (i: number, k: number) => {
      const c = i % W, r = (i - c) / W;
      let a = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= W || rr >= H || !this.dn[(rr * W + cc) * 4 + 3]) continue;
        a += this.dn[(rr * W + cc) * 4 + k]; n++;
      }
      return n ? a / n : 0;
    };
    for (let i = 0; i < W * H; i++) {
      if (!this.dn[i * 4 + 3]) continue;
      const v = [0, 1, 2].map((k) => Math.min(1, sm(i, k) / p99[k]));
      const mx = Math.max(...v);
      // hue from the band mix (normalised so the colour stays vivid); weak signal fades to transparent
      for (let k = 0; k < 3; k++) out.data[i * 4 + k] = Math.round((v[k] / Math.max(mx, 1e-3)) * 255);
      out.data[i * 4 + 3] = Math.round(230 * Math.min(1, Math.max(0, (mx - 0.5) / 0.3)));
    }
    g.putImageData(out, 0, 0);
    return c;
  }

  /** The n strongest-signal pixel centres (lon/lat), at least `spacingPx` apart. */
  hotspots(n: number, spacingPx = 6): { lon: number; lat: number; r: CrismReading }[] {
    const { width: W, height: H, bounds: b } = this.meta;
    const scored: { i: number; s: number }[] = [];
    for (let i = 0; i < W * H; i++) if (this.dn[i * 4 + 3]) { const r = this.read(i); scored.push({ i, s: Math.max(...r.rel) }); }
    scored.sort((a, z) => z.s - a.s);
    const picked: number[] = [];
    for (const { i } of scored) {
      const c = i % W, r = Math.floor(i / W);
      if (picked.every((j) => Math.hypot((j % W) - c, Math.floor(j / W) - r) >= spacingPx)) picked.push(i);
      if (picked.length >= n) break;
    }
    return picked.map((i) => ({
      lon: b.west + (((i % W) + 0.5) / W) * (b.east - b.west),
      lat: b.north - ((Math.floor(i / W) + 0.5) / H) * (b.north - b.south),
      r: this.read(i),
    }));
  }
}
