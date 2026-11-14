// Drivable crew buggy (Apollo-LRV-class): 4 wire-mesh wheels sampled on the real terrain, chassis pitch/roll
// from wheel contacts, 4-wheel steering, grade-dependent traction, ballistic jumps under Mars gravity,
// rollover, battery drain by distance (LRV range), headlights, wheel dust and tracks.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { BUGGY, MARS, ROVER } from "../core/config";
import type { Terrain } from "./terrain";

const L = 2.3, TRACK = 1.8, WHEEL_R = 0.41; // LRV: 2.3 m wheelbase, 1.83 m tread, 81.8 cm wheels
const G = MARS.gravity.value;

const frameMat = new THREE.MeshStandardMaterial({ color: 0xb5b8bd, metalness: 0.85, roughness: 0.35 });
const panelMat = new THREE.MeshStandardMaterial({ color: 0x9a9da3, metalness: 0.6, roughness: 0.5 });
const goldMat = new THREE.MeshStandardMaterial({ color: 0xc89a3a, metalness: 0.9, roughness: 0.3 });
const seatMat = new THREE.MeshStandardMaterial({ color: 0x3c4a5a, roughness: 0.9 });
const tireMat = new THREE.MeshStandardMaterial({ color: 0x7d7f84, metalness: 0.7, roughness: 0.55, wireframe: false });
const treadMat = new THREE.MeshStandardMaterial({ color: 0xa79a7c, metalness: 0.6, roughness: 0.5 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.7, metalness: 0.3 });
const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf0eee8, roughness: 0.5 });
const lightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3dc, emissiveIntensity: 0 });
const screenMat = new THREE.MeshStandardMaterial({ color: 0x041318, emissive: 0x16c7e0, emissiveIntensity: 1.4 });

function m(g: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, mat);
  o.position.set(x, y, z);
  o.castShadow = true; o.receiveShadow = true;
  return o;
}

export interface DriveInput { throttle: number; steer: number; brake: boolean }

export class Buggy {
  readonly root = new THREE.Group();     // chassis frame origin at axle-centre height
  readonly seat = new THREE.Object3D();  // driver seat anchor
  private wheels: { g: THREE.Group; spin: THREE.Group; fx: number; fz: number }[] = [];
  readonly lights: THREE.SpotLight[] = [];
  x = 0; z = 0; y = 0;
  heading = 0; speed = 0; steer = 0;
  pitch = 0; roll = 0;
  vy = 0; airborne = false;
  battery = 1;   // 0..1
  odometer = 0;
  flipped = false;
  slipping = false;
  onLand: ((impact: number) => void) | null = null;
  onRoll: (() => void) | null = null;
  onWheel: ((p: THREE.Vector3, speed: number) => void) | null = null;
  private wheelSpin = 0;
  private dustT = 0;

  constructor(private terrain: Terrain) {
    const R = this.root;
    const body = new THREE.Group();
    body.position.y = 0.25;
    R.add(body);
    // chassis: 3 hinged sections of tubular frame + floor
    for (const sx of [-0.55, 0.55]) body.add(m(new THREE.BoxGeometry(0.06, 0.06, 3.0), frameMat, sx, 0, 0));
    for (const z of [-1.3, -0.5, 0.4, 1.3]) body.add(m(new THREE.BoxGeometry(1.2, 0.05, 0.05), frameMat, 0, 0, z));
    body.add(m(new THREE.BoxGeometry(1.1, 0.03, 2.6), panelMat, 0, -0.02, 0));
    // fenders (LRV gold/orange fiberglass)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const f = m(new THREE.CylinderGeometry(0.46, 0.46, 0.26, 18, 1, true, -Math.PI / 2, Math.PI), goldMat, sx * TRACK / 2, 0.1, sz * L / 2);
      f.rotation.z = Math.PI / 2;
      body.add(f);
    }
    // seats (two crew) with frames
    for (const sx of [-0.33, 0.33]) {
      body.add(m(new RoundedBoxGeometry(0.46, 0.06, 0.46, 2, 0.02), seatMat, sx, 0.12, 0.25));
      body.add(m(new RoundedBoxGeometry(0.46, 0.5, 0.06, 2, 0.02), seatMat, sx, 0.38, 0.5));
      body.add(m(new THREE.BoxGeometry(0.03, 0.4, 0.03), frameMat, sx - 0.22, 0.3, 0.5));
    }
    this.seat.position.set(-0.33, 0.05 + 0.25, 0.32);
    R.add(this.seat);
    // control & display console, hand controller
    body.add(m(new RoundedBoxGeometry(0.5, 0.35, 0.18, 2, 0.03), whiteMat, 0, 0.42, -0.35));
    body.add(m(new THREE.BoxGeometry(0.3, 0.14, 0.01), screenMat, 0, 0.47, -0.445));
    body.add(m(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 8), darkMat, 0, 0.25, -0.12));
    // high-gain antenna (umbrella dish on a mast), low-gain helix, camera
    body.add(m(new THREE.CylinderGeometry(0.02, 0.02, 1.2, 8), frameMat, 0.45, 0.6, -1.0));
    const dish = m(new THREE.ConeGeometry(0.48, 0.18, 24, 1, true), whiteMat, 0.45, 1.25, -1.0);
    dish.rotation.x = Math.PI * 0.65;
    body.add(dish);
    body.add(m(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8), frameMat, -0.45, 0.45, -1.1));
    body.add(m(new RoundedBoxGeometry(0.16, 0.12, 0.22, 2, 0.02), darkMat, -0.45, 0.95, -1.1));
    // rear pallet: tools + sample stowage
    body.add(m(new RoundedBoxGeometry(1.0, 0.35, 0.5, 2, 0.04), whiteMat, 0, 0.2, 1.35));
    body.add(m(new RoundedBoxGeometry(0.4, 0.2, 0.35, 2, 0.03), goldMat, 0.25, 0.47, 1.35));
    // batteries + front electronics
    body.add(m(new RoundedBoxGeometry(0.9, 0.2, 0.45, 2, 0.04), whiteMat, 0, 0.12, -1.25));
    // headlights
    for (const sx of [-0.35, 0.35]) {
      const housing = m(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 14), darkMat, sx, 0.3, -1.52);
      housing.rotation.x = Math.PI / 2;
      body.add(housing);
      const lens = m(new THREE.CircleGeometry(0.05, 14), lightMat, sx, 0.3, -1.565);
      lens.rotation.y = Math.PI;
      body.add(lens);
      const s = new THREE.SpotLight(0xfff3dc, 0, 70, 0.55, 0.5, 1.2);
      s.position.set(sx, 0.55, -1.5);
      s.target.position.set(sx * 2, -1, -14);
      body.add(s, s.target);
      this.lights.push(s);
    }

    // wheels: wire-mesh tyre (torus) + chevron treads + hub, on suspension arms
    for (const [fx, fz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const g = new THREE.Group();
      const spin = new THREE.Group();
      g.add(spin);
      const tyre = m(new THREE.TorusGeometry(WHEEL_R - 0.06, 0.07, 10, 28), tireMat);
      tyre.rotation.y = Math.PI / 2;
      spin.add(tyre);
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        const tr = m(new THREE.BoxGeometry(0.2, 0.02, 0.06), treadMat, 0, Math.cos(a) * WHEEL_R, Math.sin(a) * WHEEL_R);
        tr.rotation.x = a;
        spin.add(tr);
      }
      const hub = m(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 14), frameMat);
      hub.rotation.z = Math.PI / 2;
      spin.add(hub);
      for (let i = 0; i < 6; i++) {
        const sp = m(new THREE.BoxGeometry(0.02, WHEEL_R * 1.7, 0.02), frameMat);
        sp.rotation.x = (i / 6) * Math.PI;
        spin.add(sp);
      }
      const arm = m(new THREE.BoxGeometry(0.5, 0.05, 0.06), frameMat, -fx * 0.3, 0.12, 0);
      g.add(arm);
      R.add(g);
      this.wheels.push({ g, spin, fx, fz });
    }
    R.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
  }

  place(x: number, z: number, heading: number) {
    this.x = x; this.z = z; this.heading = heading;
    this.speed = 0; this.vy = 0; this.airborne = false; this.flipped = false;
    this.y = this.groundY().y;
    this.pose();
  }

  setLights(on: boolean) {
    this.lights.forEach((l) => (l.intensity = on ? 40 : 0));
    lightMat.emissiveIntensity = on ? 4 : 0;
  }

  /** Wheel contact points (world) for the current heading. */
  private contacts() {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    return this.wheels.map((w) => {
      const lx = w.fx * TRACK / 2, lz = w.fz * L / 2; // local: +x right, +z back
      const x = this.x + c * lx - s * lz, z = this.z + s * lx + c * lz;
      return { x, z, h: this.terrain.heightAt(x, z) };
    });
  }

  private groundY() {
    const w = this.contacts();
    const front = (w[0].h + w[1].h) / 2, rear = (w[2].h + w[3].h) / 2;
    const left = (w[0].h + w[2].h) / 2, right = (w[1].h + w[3].h) / 2;
    return { y: (front + rear) / 2 + WHEEL_R, pitch: Math.atan2(front - rear, L), roll: Math.atan2(left - right, TRACK), w };
  }

  update(dtSim: number, dtReal: number, input: DriveInput) {
    if (this.flipped) { this.speed *= 0.9; this.pose(); return; }
    const maxV = (BUGGY.maxSpeedKmh.value * 1000) / 3600;
    // steering eases off at speed; 4-wheel steering halves the turning radius
    const steerTarget = input.steer * 0.55 * (1 - 0.45 * Math.min(Math.abs(this.speed) / maxV, 1));
    this.steer += (steerTarget - this.steer) * Math.min(1, dtReal * 4);
    const gnd = this.groundY();
    // traction: grade along the heading (positive = climbing when moving forward)
    const grade = Math.tan(gnd.pitch);
    const slopeDeg = Math.abs(gnd.pitch) * 180 / Math.PI;
    this.slipping = slopeDeg > ROVER.maxSlopeDeg.value + 5;
    const traction = this.slipping ? 0.15 : 1;
    let acc = 0;
    if (!this.airborne && this.battery > 0) acc += input.throttle * 1.0 * traction;
    acc -= G * Math.sin(gnd.pitch) * (this.airborne ? 0 : 1) * (this.slipping ? 1 : 0.35); // gravity along slope (brakes hold most of it)
    acc -= Math.sign(this.speed) * 0.15; // rolling resistance
    if (input.brake || (input.throttle === 0 && Math.abs(this.speed) < 0.3)) acc -= Math.sign(this.speed) * Math.min(Math.abs(this.speed) / Math.max(dtSim, 1e-3), 2.5);
    this.speed = THREE.MathUtils.clamp(this.speed + acc * dtSim, -1.5, maxV);
    if (this.battery <= 0) this.speed *= 0.98;
    // kinematic bicycle model with 4-wheel steering (effective wheelbase L/2)
    this.heading += (this.speed / (L / 2)) * Math.tan(this.steer) * dtSim;
    const step = this.speed * dtSim;
    const nx = this.x + Math.sin(this.heading) * step, nz = this.z - Math.cos(this.heading) * step;
    if (this.terrain.inside(nx, nz, 6)) { this.x = nx; this.z = nz; } else this.speed = 0;
    this.odometer += Math.abs(step);
    this.battery = Math.max(0, this.battery - (Math.abs(step) / (BUGGY.rangeKm.value * 1000)) * (1 + Math.max(grade, 0) * 3));

    // vertical: follow the suspension, or fly when the ground drops away faster than gravity
    const g2 = this.groundY();
    if (this.airborne) {
      this.vy -= G * dtReal;
      this.y += this.vy * dtReal;
      if (this.y <= g2.y) {
        const impact = -this.vy;
        this.y = g2.y; this.vy = 0; this.airborne = false;
        this.onLand?.(impact);
      }
    } else {
      const drop = this.y - g2.y;
      if (drop > 0.35 && Math.abs(this.speed) > 1.5) { this.airborne = true; this.vy = Math.max(0, (this.y - this.prevY) / Math.max(dtReal, 1e-3)) * 0.5; }
      else this.y = g2.y;
    }
    this.prevY = this.y;
    // body attitude eases toward the wheel plane
    const k = Math.min(1, dtReal * (this.airborne ? 1 : 8));
    this.pitch += (g2.pitch - this.pitch) * k;
    this.roll += (g2.roll - this.roll) * k;
    if (Math.abs(this.roll) * 180 / Math.PI > BUGGY.rolloverDeg.value || Math.abs(this.pitch) * 180 / Math.PI > BUGGY.rolloverDeg.value + 10) {
      this.flipped = true;
      this.onRoll?.();
    }
    this.wheelSpin += (step / WHEEL_R);
    this.pose();
    // wheel dust
    this.dustT -= dtReal;
    if (Math.abs(this.speed) > 0.8 && !this.airborne && this.dustT <= 0) {
      this.dustT = 0.06;
      for (const c of g2.w.slice(2)) this.onWheel?.(new THREE.Vector3(c.x, c.h, c.z), Math.abs(this.speed));
    }
  }
  private prevY = 0;

  private pose() {
    const R = this.root;
    R.position.set(this.x, this.y, this.z);
    // heading about Y (clockwise from north), then pitch (nose up = +) and roll
    R.rotation.set(0, 0, 0);
    R.rotateY(-this.heading);  // model front is local -Z, like the astronaut
    R.rotateX(this.pitch);     // nose up when the front wheels are higher
    R.rotateZ(this.flipped ? Math.PI * 0.6 : -this.roll); // left side up when left wheels are higher
    for (const w of this.wheels) {
      w.g.position.set(w.fx * TRACK / 2, 0, w.fz * L / 2);
      w.g.rotation.y = (w.fz < 0 ? -1 : 1) * this.steer;
      w.spin.rotation.x = -this.wheelSpin;
    }
  }

  /** Driver-seat world position and the chassis quaternion (for seating the astronaut). */
  seatPose(pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.root.updateMatrixWorld();
    this.seat.getWorldPosition(pos);
    this.root.getWorldQuaternion(quat);
  }

  get pos() { return new THREE.Vector3(this.x, this.y, this.z); }
}
