import type { Sourced } from "../core/config";

export const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);

export function fmtDur(s: number): string {
  const total = Math.round(s / 60);
  const h = Math.floor(total / 60), m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** Small inline tag: "assumed" (amber) or "sourced" (green), with the full source as a tooltip. */
export function sourceTag(s: Sourced<unknown>): string {
  const assumed = s.source.startsWith("ASSUMED");
  const text = s.source.replace(/"/g, "&quot;");
  return `<span class="tag ${assumed ? "assumed" : "sourced"}" title="${text}">${assumed ? "assumed" : "sourced"}</span>`;
}
