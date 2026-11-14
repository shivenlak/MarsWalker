// EVA conditions from cached snapshots: REMS weather analogue (same season, latest Mars year),
// a diurnal temperature curve, and the DONKI space-weather summary.

import type { Sourced } from "../core/config";

export interface RemsSol {
  sol: number; date: string; ls: number | null;
  minAirC: number | null; maxAirC: number | null; minGroundC: number | null; maxGroundC: number | null;
  pressurePa: number | null; opacity: string; sunrise: string; sunset: string; uv: string;
}
export interface Rems { source: string; note: string; fetched: string; soles: RemsSol[] }
export interface Donki {
  source: string; start: string; end: string;
  CME: { time: string; speed: number | null }[] | null;
  SEP: { time: string }[] | null;
  GST: { time: string; kpMax: number }[] | null;
  notifications: { type: string; time: string }[] | null;
  errors?: Record<string, string>;
}

export async function loadConditions(): Promise<{ rems: Rems; donki: Donki | null }> {
  const rems = await (await fetch("conditions/rems.json")).json();
  let donki: Donki | null = null;
  try { donki = await (await fetch("conditions/donki.json")).json(); } catch { /* optional */ }
  return { rems, donki };
}

/** REMS sol with the closest Ls (season) to `ls`, preferring the most recent Mars year. */
export function remsAnalogue(rems: Rems, ls: number): RemsSol {
  let best = rems.soles[0], bestD = Infinity;
  for (const s of rems.soles) {
    if (s.ls == null || s.minAirC == null || s.maxAirC == null) continue;
    const d = Math.abs(((s.ls - ls + 540) % 360) - 180);
    if (d < bestD - 0.5) { best = s; bestD = d; } // soles are newest-first, so ties keep the newer one
  }
  return best;
}

export const DIURNAL: Sourced<string> = {
  value: "cosine between REMS daily min (at sunrise) and max (at 14:00 local)",
  source: "ASSUMED: smooth diurnal curve fitted to REMS daily min/max; REMS publishes only daily extremes in this feed.",
};

/** Air temperature (C) at local solar time `h` using the analogue sol's min/max. */
export function airTempAt(s: RemsSol, h: number): number {
  const lo = s.minAirC ?? -70, hi = s.maxAirC ?? -10;
  const rise = 6, peak = 14;
  let f: number;
  if (h >= rise && h <= peak) f = 0.5 - 0.5 * Math.cos(((h - rise) / (peak - rise)) * Math.PI);
  else {
    const span = 24 - (peak - rise);
    const t = ((h - peak + 24) % 24) / span;
    f = 0.5 + 0.5 * Math.cos(t * Math.PI);
  }
  return lo + (hi - lo) * f;
}

/** Simple space-weather flag from the DONKI snapshot. */
export function spaceWeather(d: Donki | null): { level: "quiet" | "watch" | "unknown"; text: string } {
  if (!d || (d.CME == null && d.SEP == null)) {
    return { level: "unknown", text: "DONKI snapshot unavailable (offline cache empty)" };
  }
  const sep = d.SEP?.length ?? 0;
  const fastCme = (d.CME ?? []).filter((c) => (c.speed ?? 0) > 1000).length;
  if (sep > 0 || fastCme > 0) {
    return { level: "watch", text: `${sep} SEP event(s), ${fastCme} fast CME(s) in ${d.start}..${d.end}` };
  }
  return { level: "quiet", text: `No SEP events and no CMEs > 1000 km/s in ${d.start}..${d.end}` };
}
