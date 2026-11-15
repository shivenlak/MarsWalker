// Player movement on the real terrain: speed from the same Tobler walking model the planner uses,
// a hard limit on climbable slope, low-gravity hops, survey-area boundary, and route-following autopilot.

import * as THREE from "three";
import { MARS, WALKING } from "../core/config";
import { walkSpeed } from "../core/cost";
import type { Astronaut } from "./astronaut";
import type { RouteRibbon } from "./markers";
import type { Terrain } from "./terrain";

export interface Input { fwd: number; right: number; run: boolean; hop: boolean }

export class Player {
  x = 0; z = 0; y = 0;
  heading = 0;        // rad, 0 = north (-Z), clockwise
  speed = 0;          // m/s actual ground speed (sim time)
  grade = 0;          // dz/dx along travel
  hopY = 0; vy = 0; airborne = false;
  moving = false;
  blocked: "" | "steep" | "boundary" = "";
  odometer = 0;       // m walked
  climbed = 0;        // m ascended
  autopilot = false;
  kneel = 0;
  private lastY = 0;
  // autopilot rides the A* ribbon exactly (distance along it), so time warp can't make it overshoot
  private autoAlong = 0;
  private autoVer = -1;
  readonly RUN = { value: 1.5, source: "ASSUMED: low-gravity 'lope' gait ~1.5x walking pace (Apollo crews loped on the Moon)." };

  constructor(private terrain: Terrain, private astro: Astronaut) {}

  place(x: number, z: number, heading = 0) {
    this.x = x; this.z = z; this.heading = heading;
    this.y = this.lastY = this.terrain.heightAt(x, z);
  }

  /**
   * dtSim: sim seconds this frame (real dt x time warp). dtReal for cosmetic hop physics.
   * camYaw: camera heading (rad) so WASD is relative to the view.
   */
  update(dtSim: number, dtReal: number, input: Input, camYaw: number, ribbon: RouteRibbon | null, frozen: boolean) {
    if (this.autopilot && ribbon && ribbon.length() > 0) { this.followRibbon(dtSim, dtReal, ribbon, frozen); return; }
    this.autoVer = -1;
    let dx = 0, dz = 0;
    if (!frozen) {
      if (input.fwd || input.right) {
        // camera-relative: forward = camera heading
        const s = Math.sin(camYaw), c = Math.cos(camYaw);
        dx = s * input.fwd + c * input.right;
        dz = -c * input.fwd + s * input.right;
      }
    }
    const len = Math.hypot(dx, dz);
    this.moving = len > 1e-3;
    let target = 0;
    this.blocked = "";
    if (this.moving) {
      dx /= len; dz /= len;
      const want = Math.atan2(dx, -dz);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dtReal * 8);
      const hx = Math.sin(this.heading), hz = -Math.cos(this.heading);
      const ahead = this.terrain.heightAt(this.x + hx, this.z + hz) - this.terrain.heightAt(this.x, this.z);
      this.grade = ahead;
      target = walkSpeed(ahead, WALKING) * (input.run && !this.autopilot ? this.RUN.value : 1);
      // can't step up a slope steeper than the physical limit
      const nx = this.x + hx * 1.5, nz = this.z + hz * 1.5;
      if (ahead > 0 && this.terrain.slopeDeg(nx, nz) > MARS.maxClimbDeg.value) { target = 0; this.blocked = "steep"; }
      if (!this.terrain.inside(nx, nz, 6)) { target = 0; this.blocked = "boundary"; }
    } else {
      this.grade = 0;
    }
    // smooth acceleration (in sim time, but bounded per real frame so warp stays stable)
    this.speed += (target - this.speed) * Math.min(1, dtReal * 5);
    const step = this.speed * dtSim;
    if (step > 0) {
      const hx = Math.sin(this.heading), hz = -Math.cos(this.heading);
      this.x += hx * step;
      this.z += hz * step;
      this.odometer += step;
    }
    if (this.collide) { const q = { x: this.x, z: this.z }; if (this.collide(q)) { this.x = q.x; this.z = q.z; } }
    const ground = this.terrain.heightAt(this.x, this.z);
    if (ground > this.lastY) this.climbed += ground - this.lastY;
    this.lastY = ground;

    this.settle(step, dtSim, dtReal, input.hop && !frozen);
  }

  /**
   * Autopilot: advance a distance along the ribbon (Tobler speed for the local grade x sim time) and stand
   * exactly on it. Position never depends on how fast the heading turns, so the track is identical at x1
   * and x60 warp. The ribbon is the A* route, which already respects the slope limit.
   */
  private followRibbon(dtSim: number, dtReal: number, ribbon: RouteRibbon, frozen: boolean) {
    if (this.autoVer !== ribbon.version) {
      this.autoVer = ribbon.version;
      this.autoAlong = ribbon.project(this.x, this.z).along;
    }
    const end = ribbon.length();
    const t = ribbon.tangentAt(this.autoAlong);
    const here = ribbon.pointAt(this.autoAlong);
    const h0 = this.terrain.heightAt(here.x, here.z);
    this.grade = this.terrain.heightAt(here.x + t.x, here.z + t.z) - h0;
    const target = frozen || this.autoAlong >= end - 0.05 ? 0 : walkSpeed(this.grade, WALKING);
    this.speed += (target - this.speed) * Math.min(1, dtReal * 5);
    if (target === 0 && this.speed < 0.02) this.speed = 0;
    const step = Math.min(this.speed * dtSim, end - this.autoAlong);
    this.autoAlong += step;
    this.odometer += step;
    // if something nudged us off the line (dust devil, habitat wall), blend back onto it
    const p = ribbon.pointAt(this.autoAlong);
    const k = Math.min(1, dtSim * 2 + (step > 0 ? 0.5 : 0));
    this.x += (p.x - this.x) * k;
    this.z += (p.z - this.z) * k;
    this.moving = this.speed > 0.02;
    this.blocked = "";
    // body turns to face the path (cosmetic only)
    const want = Math.atan2(t.x, -t.z);
    let d = want - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dtReal * 8 + dtSim * 2);
    const ground = this.terrain.heightAt(this.x, this.z);
    if (ground > this.lastY) this.climbed += ground - this.lastY;
    this.lastY = ground;
    this.settle(step, dtSim, dtReal, false);
  }

  /** Vertical physics + posing the model, shared by manual walking and autopilot. */
  private settle(step: number, dtSim: number, dtReal: number, hop: boolean) {
    const ground = this.terrain.heightAt(this.x, this.z);
    // vertical: hops and falls under Mars gravity (real time). Walking off a ledge = free fall.
    if (hop && !this.airborne) { this.vy = 1.7; this.airborne = true; }
    if (this.airborne) {
      this.vy -= MARS.gravity.value * dtReal;
      this.y += this.vy * dtReal;
      if (this.y <= ground) { const impact = -this.vy; this.y = ground; this.vy = 0; this.airborne = false; this.onLand?.(impact); }
    } else {
      const ledge = Math.max(0.45, step * 0.75);
      if (this.y - ground > ledge) { this.airborne = true; this.vy = 0; }
      else this.y = ground;
    }
    this.hopY = Math.max(0, this.y - ground);

    // pose the model: stand on the ground, face heading, lean into climbs
    const r = this.astro.root;
    r.position.set(this.x, this.y, this.z);
    r.rotation.set(0, -this.heading, 0);
    const animSpeed = Math.min(this.speed * Math.max(dtSim / Math.max(dtReal, 1e-6), 1), 2.6);
    this.astro.animate(animSpeed, dtReal, this.airborne, Math.max(-0.15, Math.min(this.grade * 0.8, 0.35)), this.kneel);
  }

  onLand: ((impactMs: number) => void) | null = null;
  collide: ((p: { x: number; z: number }) => boolean) | null = null;

  get pos() { return new THREE.Vector3(this.x, this.y, this.z); }
}
