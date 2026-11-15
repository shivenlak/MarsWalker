// EV2, the second crew member. NASA never does solo EVAs, so the buddy walks with you, rides in the
// buggy's passenger seat, and can be sent (R) to fetch a specimen: it plans its own A* route there and
// back on the real terrain, then hands the sample over (or drops it at the habitat if your bag is full).

import * as THREE from "three";
import { WALKING } from "../core/config";
import { walkSpeed } from "../core/cost";
import type { Grid } from "../core/grid";
import { routeThrough } from "../core/route";
import { Astronaut } from "./astronaut";
import type { Buggy } from "./buggy";
import type { P2 } from "./markers";
import type { Specimen } from "./props";
import type { Terrain } from "./terrain";

type Mode = "follow" | "fetch" | "return" | "ride";

export class Buddy {
  readonly astro = new Astronaut(false);
  x = 0; z = 0; y = 0; heading = 0; speed = 0;
  mode: Mode = "follow";
  target: Specimen | null = null;
  carrying: Specimen | null = null;
  private path: P2[] = [];
  private cum: number[] = [];
  private along = 0;
  private replanT = 0;
  /** buddy picked the specimen up */
  onTake: ((s: Specimen) => void) | null = null;
  /** buddy is back beside you with a specimen; return true if you took it */
  onHandover: ((s: Specimen) => boolean) | null = null;
  onSay: ((msg: string) => void) | null = null;

  constructor(private terrain: Terrain, private grid: Grid) {
    this.astro.ground = (x, z) => terrain.heightAt(x, z);
  }

  place(x: number, z: number, heading: number) {
    this.x = x; this.z = z; this.heading = heading; this.y = this.terrain.heightAt(x, z);
    this.mode = "follow"; this.target = null; this.carrying = null; this.path = []; this.speed = 0;
    this.astro.root.quaternion.identity();
  }

  get status(): string {
    if (this.mode === "fetch" && this.target) return `EV2 fetching ${this.target.name} · ${Math.round(Math.hypot(this.target.x - this.x, this.target.z - this.z))} m`;
    if (this.mode === "return") return `EV2 returning with ${this.carrying?.name ?? "a sample"}`;
    return "";
  }

  /** Plan an A* walking route from the buddy to (x, z). */
  private route(x: number, z: number): boolean {
    const a = this.terrain.lonLat(this.x, this.z), b = this.terrain.lonLat(x, z);
    const r = routeThrough(this.grid, [{ id: "ev2", name: "EV2", ...a }, { id: "t", name: "target", ...b }], WALKING);
    if (!r.legs.length) return false;
    this.path = [{ x: this.x, z: this.z }, ...r.points.map((p) => this.terrain.toWorld(p)), { x, z }];
    this.cum = [0];
    for (let i = 1; i < this.path.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.path[i].x - this.path[i - 1].x, this.path[i].z - this.path[i - 1].z));
    this.along = 0;
    return true;
  }

  private pointAt(d: number): P2 {
    const c = this.cum;
    if (d >= c[c.length - 1]) return this.path[this.path.length - 1];
    let i = 1;
    while (c[i] < d) i++;
    const t = (d - c[i - 1]) / Math.max(c[i] - c[i - 1], 1e-6);
    return { x: this.path[i - 1].x + (this.path[i].x - this.path[i - 1].x) * t, z: this.path[i - 1].z + (this.path[i].z - this.path[i - 1].z) * t };
  }

  send(s: Specimen): boolean {
    if (this.mode === "ride" || this.carrying) return false;
    if (!this.route(s.x, s.z)) return false;
    this.target = s; this.mode = "fetch";
    return true;
  }

  /**
   * dtSim: sim seconds (time warp); dtReal for animation. leader = the player. Movement follows the planned
   * path by distance, so it stays exact under time warp (same approach as the player autopilot).
   */
  update(dtSim: number, dtReal: number, leader: { x: number; z: number; heading: number }, driving: boolean, buggy: Buggy) {
    const R = this.astro.root;
    if (driving && this.mode !== "fetch") {
      if (this.mode !== "ride") this.mode = "ride";
      const pos = new THREE.Vector3(), q = new THREE.Quaternion();
      buggy.seatPose(pos, q, true);
      R.position.copy(pos); R.quaternion.copy(q);
      this.x = pos.x; this.z = pos.z; this.y = pos.y; this.heading = buggy.heading;
      this.astro.animate(0, dtReal, false, 0, 0, 1);
      return;
    }
    if (this.mode === "ride") {
      // step out on the passenger side
      const h = buggy.heading;
      this.place(buggy.x + Math.cos(h) * 2.8, buggy.z + Math.sin(h) * 2.8, h);
    }
    R.quaternion.identity();

    let goal: P2 | null = null;
    let step = 0;
    if (this.mode === "follow") {
      // walk to a spot 3.5 m behind and to the right of the leader
      const hx = Math.sin(leader.heading), hz = -Math.cos(leader.heading);
      goal = { x: leader.x - hx * 3.5 - hz * 2.2, z: leader.z - hz * 3.5 + hx * 2.2 };
      const d = Math.hypot(goal.x - this.x, goal.z - this.z);
      if (d > 120) { this.place(goal.x, goal.z, leader.heading); return; } // left far behind (e.g. a long sleep)
      const want = d > 1.2 ? walkSpeed(this.grade(goal), WALKING) * Math.min(1.5, 0.6 + d / 6) : 0;
      this.speed += (want - this.speed) * Math.min(1, dtReal * 4);
      step = Math.min(this.speed * dtSim, Math.max(0, d - 0.8));
      if (d > 0.01) {
        this.x += ((goal.x - this.x) / d) * step;
        this.z += ((goal.z - this.z) / d) * step;
      }
    } else if (this.path.length > 1) {
      const end = this.cum[this.cum.length - 1];
      const here = this.pointAt(this.along), ahead = this.pointAt(this.along + 1);
      goal = ahead;
      this.speed += (walkSpeed(this.grade(ahead, here), WALKING) * 1.2 - this.speed) * Math.min(1, dtReal * 4);
      step = Math.min(this.speed * dtSim, end - this.along);
      this.along += step;
      const p = this.pointAt(this.along);
      this.x = p.x; this.z = p.z;
      if (this.mode === "return") {
        this.replanT -= dtSim;
        const last = this.path[this.path.length - 1];
        if (this.replanT <= 0 && Math.hypot(last.x - leader.x, last.z - leader.z) > 8) { this.replanT = 20; this.route(leader.x, leader.z); }
      }
      if (this.along >= end - 0.05) this.arrive(leader);
    }
    if (goal && step > 1e-4) {
      const want = Math.atan2(goal.x - this.x, -(goal.z - this.z));
      let d = want - this.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dtReal * 6 + dtSim);
    }
    this.y = this.terrain.heightAt(this.x, this.z);
    R.position.set(this.x, this.y, this.z);
    R.rotation.set(0, -this.heading, 0);
    const anim = Math.min(this.speed * Math.max(dtSim / Math.max(dtReal, 1e-6), 1), 2.6);
    this.astro.animate(step > 1e-4 ? anim : 0, dtReal, false, 0, this.mode === "fetch" && this.along > 0 && !this.path.length ? 1 : 0);
  }

  private grade(to: P2, from: P2 = { x: this.x, z: this.z }) {
    const d = Math.max(Math.hypot(to.x - from.x, to.z - from.z), 0.5);
    return (this.terrain.heightAt(to.x, to.z) - this.terrain.heightAt(from.x, from.z)) / d;
  }

  private arrive(leader: { x: number; z: number }) {
    if (this.mode === "fetch" && this.target) {
      const s = this.target;
      this.target = null;
      if (s.taken) { this.onSay?.("EV2: someone already took that one. Coming back."); }
      else { this.carrying = s; this.onTake?.(s); this.onSay?.(`EV2: got the ${s.name}. Heading back to you.`); }
      this.mode = "return"; this.replanT = 0;
      if (!this.route(leader.x, leader.z)) { this.mode = "follow"; this.path = []; }
    } else if (this.mode === "return") {
      this.path = [];
      if (this.carrying && this.onHandover?.(this.carrying)) this.carrying = null;
      this.mode = "follow";
    }
  }
}
