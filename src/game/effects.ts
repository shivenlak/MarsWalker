// Surface effects: boot prints, dust puffs that fall under Mars gravity, drifting ambient dust,
// and a rock field around the player whose density follows the real DTM roughness grid.

import * as THREE from "three";
import { MARS } from "../core/config";
import type { Grid } from "../core/grid";
import { mulberry, type Terrain } from "./terrain";

const G = MARS.gravity.value;

// ---------- footprints ----------
export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly max = 1500;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private nrm = new THREE.Vector3();

  constructor(private terrain: Terrain, w = 0.17, h = 0.33, tex: THREE.Texture = treadTexture()) {
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const geo = new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  add(x: number, z: number, headingRad: number) {
    const y = this.terrain.heightAt(x, z) + 0.015;
    this.terrain.normalAt(x, z, this.nrm);
    this.q.setFromUnitVectors(this.up, this.nrm);
    const yaw = new THREE.Quaternion().setFromAxisAngle(this.up, -headingRad);
    this.m.compose(new THREE.Vector3(x, y, z), this.q.multiply(yaw), new THREE.Vector3(1, 1, 1));
    this.mesh.setMatrixAt(this.n % this.max, this.m);
    this.n++;
    this.mesh.count = Math.min(this.n, this.max);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export function wheelTrackTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(45,24,14,0.5)"; g.fillRect(3, 0, 26, 64);
  g.fillStyle = "rgba(20,10,5,0.5)";
  for (let y = 0; y < 64; y += 8) { g.beginPath(); g.moveTo(3, y); g.lineTo(16, y + 5); g.lineTo(29, y); g.lineTo(29, y + 3); g.lineTo(16, y + 8); g.lineTo(3, y + 3); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function treadTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(60,30,18,0.0)";
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = "rgba(55,28,16,0.55)";
  g.beginPath();
  g.roundRect(6, 4, 52, 120, 24);
  g.fill();
  g.fillStyle = "rgba(25,12,6,0.55)";
  for (let y = 12; y < 120; y += 12) g.fillRect(12, y, 40, 5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function softDot(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.4, "rgba(255,255,255,0.5)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------- dust puffs (ballistic under Mars gravity, slow drag in thin air) ----------
export class DustPuffs {
  readonly points: THREE.Points;
  private readonly max = 600;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private alpha: Float32Array;
  private next = 0;

  constructor(private terrain: Terrain) {
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.alpha = new Float32Array(this.max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("alpha", new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: softDot() }, uColor: { value: new THREE.Color(0xb98a62) } },
      vertexShader: `attribute float alpha; varying float vA;
        void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = 180.0 * (0.25 + 0.6 * (1.0 - alpha)) / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uTex; uniform vec3 uColor; varying float vA;
        void main(){ float a = texture2D(uTex, gl_PointCoord).a * vA * 0.55; if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a); }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  burst(p: THREE.Vector3, n = 10, power = 1) {
    const r = Math.random;
    for (let k = 0; k < n; k++) {
      const i = this.next++ % this.max;
      this.pos.set([p.x + (r() - 0.5) * 0.2, p.y + 0.03, p.z + (r() - 0.5) * 0.2], i * 3);
      const a = r() * Math.PI * 2, s = (0.3 + r() * 0.6) * power;
      this.vel.set([Math.cos(a) * s, (0.4 + r() * 0.9) * power, Math.sin(a) * s], i * 3);
      this.life[i] = 1;
    }
  }

  update(dt: number, wind: THREE.Vector3) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt * 0.45;
      const k = i * 3;
      this.vel[k + 1] -= G * 0.25 * dt; // fine dust: drag-limited fall
      this.vel[k] += (wind.x - this.vel[k]) * dt * 0.6;
      this.vel[k + 2] += (wind.z - this.vel[k + 2]) * dt * 0.6;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const ground = this.terrain.heightAt(this.pos[k], this.pos[k + 2]);
      if (this.pos[k + 1] < ground) { this.pos[k + 1] = ground; this.vel[k + 1] = 0; }
      this.alpha[i] = Math.max(0, this.life[i]);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.alpha.needsUpdate = true;
  }
}

// ---------- ambient airborne dust around the camera ----------
export class AmbientDust {
  readonly points: THREE.Points;
  private readonly n = 2500;
  private readonly box = 60;

  constructor() {
    const pos = new Float32Array(this.n * 3);
    for (let i = 0; i < pos.length; i++) pos[i] = (Math.random() - 0.5) * this.box;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      map: softDot(), color: 0xe0b48a, size: 0.06, transparent: true, opacity: 0.35, depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  update(dt: number, center: THREE.Vector3, wind: THREE.Vector3) {
    const p = this.points.geometry.attributes.position.array as Float32Array;
    const h = this.box / 2;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      p[k] += (wind.x + Math.sin(i + p[k + 1]) * 0.2) * dt;
      p[k + 1] += Math.sin(i * 0.37 + p[k] * 0.1) * 0.05 * dt;
      p[k + 2] += (wind.z + Math.cos(i + p[k]) * 0.2) * dt;
      for (let a = 0; a < 3; a++) {
        const c = a === 0 ? center.x : a === 1 ? center.y + 10 : center.z;
        if (p[k + a] - c > h) p[k + a] -= this.box;
        if (p[k + a] - c < -h) p[k + a] += this.box;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------- rocks: instanced, scattered around the player, density from DTM roughness ----------
export class Rocks {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private center = new THREE.Vector2(1e9, 1e9);
  private readonly radius = 140;
  private readonly cell = 3; // m: one candidate rock per cell

  constructor(private terrain: Terrain, private grid: Grid) {
    const mats = [0x6b4a36, 0x5a3d2d, 0x7a5a44, 0x4a3328].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, flatShading: true }));
    for (let v = 0; v < 4; v++) {
      const geo = rockGeometry(v + 1);
      const im = new THREE.InstancedMesh(geo, mats[v], 2600);
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.count = 0;
      this.meshes.push(im);
      this.group.add(im);
    }
  }

  /** Re-scatter when the player has moved > 35 m from the last scatter centre. */
  update(px: number, pz: number) {
    if (Math.hypot(px - this.center.x, pz - this.center.y) < 35) return;
    this.center.set(px, pz);
    const counts = [0, 0, 0, 0];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const e = new THREE.Euler();
    const c0 = Math.floor((px - this.radius) / this.cell), c1 = Math.floor((px + this.radius) / this.cell);
    const r0 = Math.floor((pz - this.radius) / this.cell), r1 = Math.floor((pz + this.radius) / this.cell);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const rnd = mulberry((c * 73856093) ^ (r * 19349663));
        const x = (c + rnd()) * this.cell, z = (r + rnd()) * this.cell;
        if (!this.terrain.inside(x, z, 1) || Math.hypot(x - px, z - pz) > this.radius) continue;
        // roughness of the 10 m cell (m RMS) -> rock probability
        const gi = Math.floor(z / this.grid.cellSize) * this.grid.cols + Math.floor(x / this.grid.cellSize);
        const rough = this.grid.rough[gi] || 0.05;
        const prob = Math.min(0.08 + rough * 1.6, 0.9);
        if (rnd() > prob) continue;
        // power-law size: mostly pebbles, a few boulders
        const size = 0.06 + 0.9 * Math.pow(rnd(), 4.5) * (0.5 + rough * 2);
        const v = Math.floor(rnd() * 4);
        if (counts[v] >= 2600) continue;
        p.set(x, this.terrain.heightAt(x, z) - size * 0.25, z);
        e.set(rnd() * 0.6, rnd() * Math.PI * 2, rnd() * 0.6);
        q.setFromEuler(e);
        s.set(size * (0.8 + rnd() * 0.6), size * (0.5 + rnd() * 0.5), size * (0.8 + rnd() * 0.6));
        m4.compose(p, q, s);
        this.meshes[v].setMatrixAt(counts[v]++, m4);
      }
    }
    this.meshes.forEach((im, v) => { im.count = counts[v]; im.instanceMatrix.needsUpdate = true; });
  }
}

function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const rnd = mulberry(seed * 977);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const k1 = new THREE.Vector3(rnd(), rnd(), rnd()).normalize();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = 0.75 + 0.35 * Math.sin(v.dot(k1) * 4 + seed) * 0.5 + rnd() * 0.18;
    v.multiplyScalar(n);
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.3; // flat-ish base
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
