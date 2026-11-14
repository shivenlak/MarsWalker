// World props: base habitat, NASA's Curiosity rover at its real latest position, deployable emergency
// shelter, throwable rocks (ballistic under Mars gravity), collectible field specimens, dust devils,
// and Curiosity's real wheel tracks drawn along its traverse.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MARS } from "../core/config";
import type { Grid } from "../core/grid";
import { mulberry, type Terrain } from "./terrain";

const G = MARS.gravity.value;
const white = new THREE.MeshStandardMaterial({ color: 0xeeece6, roughness: 0.75 });
const fabric = new THREE.MeshStandardMaterial({ color: 0xe6e1d6, roughness: 0.95 });
const metal = new THREE.MeshStandardMaterial({ color: 0xa9adb3, metalness: 0.85, roughness: 0.35 });
const dark = new THREE.MeshStandardMaterial({ color: 0x2a2b2f, roughness: 0.7, metalness: 0.3 });
const solar = new THREE.MeshStandardMaterial({ color: 0x14203a, metalness: 0.6, roughness: 0.25, emissive: 0x050a18 });
const gold = new THREE.MeshStandardMaterial({ color: 0xc89a3a, metalness: 0.9, roughness: 0.3 });
const glow = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x9ff7ff, emissiveIntensity: 2.5 });
const amber = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffa040, emissiveIntensity: 2.5 });

function m(g: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, mat);
  o.position.set(x, y, z);
  o.castShadow = true; o.receiveShadow = true;
  return o;
}

// ---------- base habitat ----------
export class Habitat {
  readonly group = new THREE.Group();
  readonly door = new THREE.Vector3();     // world position of the airlock hatch (interaction point)
  readonly radius = 6.5;                   // collision radius around the centre
  readonly center = new THREE.Vector3();
  private lightsOn = false;
  private lamps: THREE.PointLight[] = [];

  constructor(terrain: Terrain, x: number, z: number, heading: number) {
    const y = terrain.heightAt(x, z);
    const g = this.group;
    g.position.set(x, y, z);
    g.rotation.y = -heading;
    this.center.set(x, y, z);
    // inflatable main module (horizontal cylinder on legs), with seams
    const hull = m(new THREE.CapsuleGeometry(2.3, 6, 8, 32), fabric, 0, 3.1, 0);
    hull.rotation.x = Math.PI / 2;
    g.add(hull);
    for (let i = -3; i <= 3; i++) {
      const seam = m(new THREE.TorusGeometry(2.31, 0.04, 6, 40), white, 0, 3.1, i * 1.0);
      g.add(seam);
    }
    for (const sx of [-1.6, 1.6]) for (const sz of [-2.5, 2.5]) {
      g.add(m(new THREE.CylinderGeometry(0.12, 0.18, 1.4, 10), metal, sx, 0.7, sz));
      g.add(m(new THREE.CylinderGeometry(0.4, 0.45, 0.08, 16), metal, sx, 0.04, sz));
    }
    // airlock on the -Z end with a hatch, step ladder, status lights
    const lock = m(new THREE.CylinderGeometry(1.1, 1.1, 2.2, 24), white, 0, 2.2, -5.3);
    lock.rotation.x = Math.PI / 2;
    g.add(lock);
    const hatch = m(new RoundedBoxGeometry(1.1, 1.6, 0.12, 3, 0.1), metal, 0, 2.1, -6.42);
    g.add(hatch);
    g.add(m(new THREE.BoxGeometry(0.5, 0.06, 0.3), glow, 0, 3.05, -6.5));
    for (let i = 0; i < 4; i++) g.add(m(new THREE.BoxGeometry(1.0, 0.05, 0.3), metal, 0, 0.3 + i * 0.4, -6.7 - i * 0.18));
    // solar arrays on two masts
    for (const sx of [-1, 1]) {
      const mast = m(new THREE.CylinderGeometry(0.07, 0.09, 3.4, 8), metal, sx * 6.5, 1.7, 1.5);
      g.add(mast);
      const panel = m(new THREE.BoxGeometry(3.6, 0.05, 2.4), solar, sx * 6.5, 3.5, 1.5);
      panel.rotation.x = -0.35;
      g.add(panel);
      for (let k = -1; k <= 1; k++) g.add(m(new THREE.BoxGeometry(0.02, 0.06, 2.4), metal, sx * 6.5 + k * 1.2, 3.53, 1.5));
    }
    // comm dish + beacon
    g.add(m(new THREE.CylinderGeometry(0.05, 0.05, 2, 8), metal, 2.2, 5.2, 2.6));
    const dish = m(new THREE.SphereGeometry(0.8, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.3), white, 2.2, 6.4, 2.6);
    dish.rotation.x = -0.9;
    g.add(dish);
    g.add(m(new THREE.SphereGeometry(0.12, 10, 8), amber, 0, 5.5, 0));
    // window strip + floodlights
    for (const sx of [-1, 1]) g.add(m(new THREE.BoxGeometry(0.05, 0.25, 3.5), glow, sx * 2.31, 3.4, 0));
    for (const sz of [-4.5, 4.5]) {
      const p = new THREE.PointLight(0xffe6c0, 0, 45, 1.6);
      p.position.set(0, 5.6, sz);
      g.add(p);
      this.lamps.push(p);
    }
    g.updateMatrixWorld(true);
    hatch.getWorldPosition(this.door);
    this.door.y = terrain.heightAt(this.door.x, this.door.z);
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
  }

  setLights(on: boolean) {
    if (on === this.lightsOn) return;
    this.lightsOn = on;
    this.lamps.forEach((l) => (l.intensity = on ? 60 : 0));
  }

  /** Push a point out of the habitat footprint (capsule along the module axis, incl. airlock). */
  collide(p: { x: number; z: number }, r = 0.45) {
    const h = this.group.rotation.y; // local -Z (airlock end) direction in world
    const ax = Math.sin(-h) * -1, az = -Math.cos(-h);
    const dx = p.x - this.center.x, dz = p.z - this.center.z;
    const t = THREE.MathUtils.clamp(dx * ax + dz * az, -4.6, 5.6);
    const cx = this.center.x + ax * t, cz = this.center.z + az * t;
    const ex = p.x - cx, ez = p.z - cz, d = Math.hypot(ex, ez);
    const R = (t > 4.4 ? 1.2 : 2.6) + r;
    if (d < R && d > 1e-4) { p.x = cx + (ex / d) * R; p.z = cz + (ez / d) * R; return true; }
    return false;
  }
}

// ---------- NASA's Curiosity (procedural, ~3 m long) ----------
export function makeCuriosity(terrain: Terrain, x: number, z: number, heading: number): THREE.Group {
  const g = new THREE.Group();
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x8e9196, metalness: 0.8, roughness: 0.4 });
  const body = m(new RoundedBoxGeometry(1.9, 0.75, 2.6, 2, 0.06), white, 0, 1.05, 0);
  g.add(body);
  g.add(m(new THREE.BoxGeometry(1.95, 0.05, 2.65), gold, 0, 1.43, 0));
  // rocker-bogie + 6 wheels
  for (const sx of [-1, 1]) {
    g.add(m(new THREE.BoxGeometry(0.08, 0.08, 2.4), metal, sx * 1.15, 0.75, 0));
    for (const sz of [-1.1, 0, 1.1]) {
      const w = m(new THREE.CylinderGeometry(0.25, 0.25, 0.4, 20), wheelMat, sx * 1.35, 0.25, sz);
      w.rotation.z = Math.PI / 2;
      g.add(w);
      g.add(m(new THREE.BoxGeometry(0.06, 0.55, 0.06), metal, sx * 1.15, 0.5, sz));
    }
  }
  // mast with remote-sensing head (Mastcam/ChemCam)
  g.add(m(new THREE.CylinderGeometry(0.07, 0.08, 1.2, 10), metal, 0.6, 2.0, -0.9));
  const head = m(new RoundedBoxGeometry(0.55, 0.32, 0.32, 2, 0.05), white, 0.6, 2.7, -0.95);
  g.add(head);
  g.add(m(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 14), dark, 0.6, 2.72, -1.13));
  // RTG at the rear (finned cylinder, angled)
  const rtg = m(new THREE.CylinderGeometry(0.3, 0.3, 0.7, 16), dark, 0, 1.25, 1.55);
  rtg.rotation.x = -0.6;
  g.add(rtg);
  for (let i = 0; i < 8; i++) {
    const fin = m(new THREE.BoxGeometry(0.02, 0.62, 0.55), dark, Math.cos(i) * 0.35, 1.25, 1.55 + Math.sin(i) * 0.05);
    fin.rotation.set(-0.6, (i / 8) * Math.PI, 0);
    g.add(fin);
  }
  // high-gain antenna disk, arm with turret folded at the front
  const hga = m(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 20), white, -0.6, 1.65, 0.5);
  hga.rotation.x = 0.4;
  g.add(hga);
  g.add(m(new THREE.BoxGeometry(0.1, 0.1, 1.2), metal, 0.4, 0.9, -1.6));
  g.add(m(new RoundedBoxGeometry(0.4, 0.35, 0.4, 2, 0.05), metal, -0.1, 0.8, -1.9));
  const y = terrain.heightAt(x, z);
  g.position.set(x, y, z);
  g.rotation.y = -heading;
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
  return g;
}

// ---------- emergency shelter ----------
export class Shelter {
  readonly group = new THREE.Group();
  deployed = false;
  private t = 0;
  constructor() {
    const dome = m(new THREE.SphereGeometry(2.2, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.9 }));
    this.group.add(dome);
    for (let i = 0; i < 6; i++) {
      const rib = m(new THREE.TorusGeometry(2.21, 0.05, 6, 32, Math.PI), white);
      rib.rotation.y = (i / 6) * Math.PI;
      this.group.add(rib);
    }
    const door = m(new THREE.CircleGeometry(0.7, 20), dark, 0, 0.75, -2.1);
    door.rotation.y = Math.PI;
    this.group.add(door);
    this.group.add(m(new THREE.SphereGeometry(0.08, 8, 6), amber, 0, 2.25, 0));
    this.group.visible = false;
  }
  deploy(x: number, y: number, z: number, heading: number) {
    this.group.position.set(x, y, z);
    this.group.rotation.y = -heading;
    this.group.visible = true;
    this.deployed = true;
    this.t = 0;
  }
  update(dt: number) {
    if (!this.deployed) return;
    this.t = Math.min(1, this.t + dt / 2.5);
    const e = 1 - Math.pow(1 - this.t, 3);
    this.group.scale.set(e, Math.max(0.05, e), e); // inflates
  }
}

// ---------- throwable rocks with Mars-gravity physics ----------
interface Body { mesh: THREE.Mesh; v: THREE.Vector3; r: number; held: boolean; rest: boolean }
export class LooseRocks {
  readonly group = new THREE.Group();
  readonly bodies: Body[] = [];
  onImpact: ((p: THREE.Vector3, speed: number) => void) | null = null;

  constructor(private terrain: Terrain, spots: { x: number; z: number }[]) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x6d4b37, roughness: 0.95, flatShading: true });
    const rnd = mulberry(99);
    for (const s of spots) {
      for (let k = 0; k < 4; k++) {
        const r = 0.08 + rnd() * 0.1;
        const geo = new THREE.IcosahedronGeometry(r, 0);
        const mesh = m(geo, mat);
        const x = s.x + (rnd() - 0.5) * 10, z = s.z + (rnd() - 0.5) * 10;
        mesh.position.set(x, terrain.heightAt(x, z) + r * 0.7, z);
        this.group.add(mesh);
        this.bodies.push({ mesh, v: new THREE.Vector3(), r, held: false, rest: true });
      }
    }
  }

  nearest(p: THREE.Vector3, maxD = 2.2): Body | null {
    let best: Body | null = null, bd = maxD;
    for (const b of this.bodies) { const d = b.mesh.position.distanceTo(p); if (!b.held && d < bd) { bd = d; best = b; } }
    return best;
  }

  throw(b: Body, from: THREE.Vector3, dir: THREE.Vector3, speed = 8) {
    b.held = false; b.rest = false;
    b.mesh.position.copy(from);
    b.v.copy(dir).normalize().multiplyScalar(speed);
  }

  /** Kick rocks the walker/buggy runs into. */
  push(p: THREE.Vector3, vel: THREE.Vector3, reach: number) {
    for (const b of this.bodies) {
      if (b.held) continue;
      const d = Math.hypot(b.mesh.position.x - p.x, b.mesh.position.z - p.z);
      if (d < reach && vel.lengthSq() > 0.04) {
        b.rest = false;
        b.v.set(vel.x * 1.4 + (Math.random() - 0.5), 0.8 + vel.length() * 0.4, vel.z * 1.4 + (Math.random() - 0.5));
      }
    }
  }

  update(dt: number, hand: THREE.Vector3 | null) {
    for (const b of this.bodies) {
      const p = b.mesh.position;
      if (b.held && hand) { p.copy(hand); continue; }
      if (b.rest) continue;
      b.v.y -= G * dt;
      p.addScaledVector(b.v, dt);
      b.mesh.rotation.x += b.v.z * dt * 3; b.mesh.rotation.z -= b.v.x * dt * 3;
      const gy = this.terrain.heightAt(p.x, p.z) + b.r * 0.7;
      if (p.y < gy) {
        p.y = gy;
        const impact = -b.v.y;
        if (impact > 1.5) this.onImpact?.(p.clone(), impact);
        b.v.y = impact * 0.3;            // low bounce on loose regolith
        b.v.x *= 0.6; b.v.z *= 0.6;
        if (b.v.length() < 0.25) { b.v.set(0, 0, 0); b.rest = true; }
      }
    }
  }
}

// ---------- collectible field specimens ----------
export interface Specimen { id: string; x: number; z: number; name: string; about: string; massKg: number; site: string; taken: boolean; mesh: THREE.Mesh }

const SPECIMEN_TYPES: Record<string, { name: string; about: string; color: number }> = {
  gediz: { name: "Sulfur-bearing stone", about: "Pale yellow, light stone like the elemental-sulfur rocks Curiosity crushed in Gediz Vallis.", color: 0xd8c25a },
  kings_canyon: { name: "Channel cobble", about: "Rounded cobble carried down Gediz Vallis by a debris flow.", color: 0x6b5a4c },
  mineral_king: { name: "Cemented gray chip", about: "Hard, gray, fine-grained sulfate-unit bedrock.", color: 0x8a8580 },
  boxwork_entry: { name: "Boxwork vein fragment", about: "Light mineral vein from a boxwork ridge - groundwater cemented this fracture.", color: 0xe7ddc8 },
  boxwork_main: { name: "Ridge-cement chip", about: "Resistant ridge material from the boxwork network.", color: 0xd9ccb0 },
  altadena: { name: "Layered bedrock chip", about: "Thinly layered sulfate-unit bedrock from the boxwork's edge.", color: 0x9a6a4c },
  basque_lakes: { name: "Pale upper-unit chip", about: "Pale layered rock from higher up Mount Sharp.", color: 0xc9a98a },
  plain: { name: "Sulfate-unit pebble", about: "Ordinary sulfate-bearing bedrock, the backbone of lower Mount Sharp.", color: 0x8c5e44 },
};

export class Specimens {
  readonly group = new THREE.Group();
  readonly list: Specimen[] = [];
  private t = 0;
  constructor(terrain: Terrain, grid: Grid, sites: { id: string; x: number; z: number }[]) {
    const rnd = mulberry(4242);
    const passable = (x: number, z: number) => {
      const i = Math.floor(z / grid.cellSize) * grid.cols + Math.floor(x / grid.cellSize);
      return grid.slope[i] < 22 && grid.rough[i] < 0.45;
    };
    const add = (site: string, x: number, z: number) => {
      if (!terrain.inside(x, z, 20) || !passable(x, z)) return;
      const t = SPECIMEN_TYPES[site] ?? SPECIMEN_TYPES.plain;
      const mat = new THREE.MeshStandardMaterial({ color: t.color, roughness: 0.6, emissive: t.color, emissiveIntensity: 0.0 });
      const mesh = m(new THREE.DodecahedronGeometry(0.11, 0), mat, x, terrain.heightAt(x, z) + 0.06, z);
      mesh.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      this.group.add(mesh);
      this.list.push({ id: `sp${this.list.length}`, x, z, name: t.name, about: t.about, massKg: +(0.2 + rnd() * 0.5).toFixed(2), site, taken: false, mesh });
    };
    for (const s of sites) for (let k = 0; k < 3; k++) {
      const a = rnd() * Math.PI * 2, d = 35 + rnd() * 80;
      add(s.id, s.x + Math.cos(a) * d, s.z + Math.sin(a) * d);
    }
    for (let k = 0; k < 16; k++) add("plain", rnd() * terrain.meta.width, rnd() * terrain.meta.depth);
  }

  nearest(x: number, z: number): { s: Specimen; d: number } | null {
    let best: Specimen | null = null, bd = Infinity;
    for (const s of this.list) { if (s.taken) continue; const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
    return best ? { s: best, d: bd } : null;
  }

  take(s: Specimen) { s.taken = true; s.mesh.visible = false; }

  /** Glint: specimens shimmer when the scanner is on or the walker is close. */
  update(dt: number, x: number, z: number, scanner: boolean) {
    this.t += dt;
    for (const s of this.list) {
      if (s.taken) continue;
      const d = Math.hypot(s.x - x, s.z - z);
      const on = scanner ? Math.max(0, 1 - d / 250) : Math.max(0, 1 - d / 12);
      (s.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = on * (0.6 + 0.6 * Math.sin(this.t * 5 + s.x));
      s.mesh.scale.setScalar(scanner ? 1 + on * 1.5 : 1);
    }
  }
}

// ---------- dust devils ----------
export class DustDevils {
  readonly group = new THREE.Group();
  private devils: { pts: THREE.Points; x: number; z: number; vx: number; vz: number; life: number; h: number; r: number }[] = [];
  private t = 0;
  constructor(private terrain: Terrain) {}

  private spawn(cx: number, cz: number) {
    const n = 900, pos = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) seed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.PointsMaterial({ color: 0xc9a07a, size: 1.6, transparent: true, opacity: 0.22, depthWrite: false, sizeAttenuation: true });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.group.add(pts);
    const a = Math.random() * Math.PI * 2;
    this.devils.push({ pts, x: cx + Math.cos(a) * 250, z: cz + Math.sin(a) * 250, vx: (Math.random() - 0.5) * 4, vz: (Math.random() - 0.5) * 4, life: 1, h: 60 + Math.random() * 120, r: 3 + Math.random() * 5 });
  }

  /** Returns the distance to the nearest devil (m). active: daytime convective hours. */
  update(dt: number, dtSim: number, px: number, pz: number, active: boolean): number {
    this.t += dt;
    if (active && this.devils.length < 2 && Math.random() < dtSim / 600) this.spawn(px, pz);
    let nearest = Infinity;
    for (const d of this.devils) {
      d.x += d.vx * dtSim * 0.2; d.z += d.vz * dtSim * 0.2;
      // drift toward the walker a little so they are actually seen
      d.vx += Math.sign(px - d.x) * dt * 0.05; d.vz += Math.sign(pz - d.z) * dt * 0.05;
      d.life -= dtSim / 1800;
      const p = d.pts.geometry.attributes.position.array as Float32Array;
      const seed = d.pts.geometry.attributes.seed.array as Float32Array;
      const gy = this.terrain.heightAt(d.x, d.z);
      for (let i = 0; i < seed.length; i++) {
        const s = seed[i], hh = ((s * 997 + this.t * (0.05 + s * 0.1)) % 1);
        const ang = s * 60 + this.t * (3 + s * 2);
        const rad = d.r * (0.4 + hh * 1.2) * (0.6 + 0.4 * Math.sin(s * 30));
        p[i * 3] = d.x + Math.cos(ang) * rad; p[i * 3 + 1] = gy + hh * d.h; p[i * 3 + 2] = d.z + Math.sin(ang) * rad;
      }
      d.pts.geometry.attributes.position.needsUpdate = true;
      (d.pts.material as THREE.PointsMaterial).opacity = 0.22 * Math.min(1, d.life * 4);
      nearest = Math.min(nearest, Math.hypot(d.x - px, d.z - pz));
    }
    this.devils = this.devils.filter((d) => {
      if (d.life > 0 && this.terrain.inside(d.x, d.z, -400)) return true;
      this.group.remove(d.pts); d.pts.geometry.dispose();
      return false;
    });
    return nearest;
  }
}

// ---------- Curiosity's real wheel tracks along its traverse ----------
export function makeTracks(terrain: Terrain, lines: { x: number; z: number }[][]): THREE.InstancedMesh {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 64;
  const g2 = c.getContext("2d")!;
  g2.fillStyle = "rgba(40,22,12,0.45)";
  g2.fillRect(2, 0, 28, 64);
  g2.fillStyle = "rgba(15,8,4,0.55)";
  for (let y = 2; y < 64; y += 9) g2.fillRect(2, y, 28, 3);       // grousers
  g2.fillStyle = "rgba(90,60,40,0.5)";                             // Morse-code 'JPL' holes in the real wheels
  [[6, 6], [6, 18], [14, 6], [22, 6], [14, 30], [22, 42], [6, 50]].forEach(([x, y]) => g2.fillRect(x, y, 4, 4));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const geo = new THREE.PlaneGeometry(0.4, 0.9).rotateX(-Math.PI / 2);
  const pts: { x: number; z: number; h: number }[] = [];
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L > 200) continue; // gaps in the traverse file
      const h = Math.atan2(b.x - a.x, -(b.z - a.z));
      for (let s = 0; s < L; s += 0.85) {
        const t = s / L;
        pts.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h });
      }
    }
  }
  const im = new THREE.InstancedMesh(geo, mat, pts.length * 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3();
  let k = 0;
  for (const p of pts) {
    for (const side of [-1.4, 1.4]) { // Curiosity's track width ~2.8 m
      const x = p.x + Math.cos(p.h) * side, z = p.z + Math.sin(p.h) * side;
      terrain.normalAt(x, z, n);
      q.setFromUnitVectors(up, n).multiply(new THREE.Quaternion().setFromAxisAngle(up, -p.h));
      m4.compose(new THREE.Vector3(x, terrain.heightAt(x, z) + 0.02, z), q, new THREE.Vector3(1, 1, 1));
      im.setMatrixAt(k++, m4);
    }
  }
  im.count = k;
  im.receiveShadow = true;
  im.frustumCulled = false;
  return im;
}
