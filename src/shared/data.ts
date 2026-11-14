// Loads the static files from data/processed (served at the site root by Vite).

import type { Stop } from "../core/route";

export interface StopImage { file: string; sol: number; instrument: string; source: string; credit: string }

export interface StopInfo extends Stop {
  kind: "base" | "science" | "rover";
  sol: number;
  elev: number;
  waypoint: string;
  what: string;
  why: string;
  evidence: string;
  lookFor: string;
  images: StopImage[];
  sample?: { name: string; about: string };
}

export interface Landmark extends Stop {
  kind: "landmark"; sol: number; elev: number; waypoint: string; odometerKm: number | null; images: StopImage[];
}

export interface Bounds { west: number; east: number; south: number; north: number }

export interface Overlays {
  bounds: Bounds;
  hillshade: { file: string; elevMin: number; elevMax: number; source: string };
  slope: { file: string; rampDeg: number[]; source: string };
  themis: { file: string; bounds: Bounds; source: string; note: string };
}

const json = async <T>(path: string): Promise<T> => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Missing ${path} - run the data pipeline (see README)`);
  return r.json();
};

export const loadStops = () => json<StopInfo[]>("stops.json");
export const loadTraverse = () => json<GeoJSON.FeatureCollection>("rover/traverse.geojson");
export const loadLandmarks = () => json<Landmark[]>("landmarks.json");

export async function loadOverlays(): Promise<Overlays> {
  const o = await json<Omit<Overlays, "themis">>("overlays/overlays.json");
  const t = await json<Overlays["themis"]>("overlays/themis.json");
  return { ...o, themis: { file: t.file, bounds: t.bounds, source: t.source, note: t.note } };
}
