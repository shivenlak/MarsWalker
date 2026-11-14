// Tiny shared state between Planner and HUD. No framework: plain object + listeners.

import type { Grid } from "../core/grid";
import type { Route, RoutePoint } from "../core/route";
import type { StopInfo } from "./data";

export interface SimState {
  running: boolean;
  evaS: number;          // walking seconds elapsed along the route
  pos: RoutePoint | null;
  headingDeg: number;    // direction of travel, 0 = north, clockwise
}

export const store = {
  grid: null as Grid | null,
  stops: [] as StopInfo[],
  route: null as Route | null,
  sim: { running: false, evaS: 0, pos: null, headingDeg: 0 } as SimState,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  listeners.forEach((fn) => fn());
}

export function setRoute(r: Route | null) {
  store.route = r;
  store.sim = { running: false, evaS: 0, pos: r?.points[0] ?? null, headingDeg: 0 };
  emit();
}
