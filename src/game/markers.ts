// In-world navigation visuals: animated route ribbon draped on the terrain, holographic beacons at
// science stops (with floating labels), the faint "path home" line, and a scan marker for clicks.

import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Terrain } from "./terrain";

export interface P2 { x: number; z: number }

/** Catmull-Rom smoothing of a grid path, resampled every `step` metres. */
export function smoothPath(pts: P2[], step = 2): P2[] {
  if (pts.length < 2) return pts;
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, "centripetal", 0.5);
  const len = curve.getLength();
  const n = Math.max(2, Math.ceil(len / step));
  return curve.getSpacedPoints(n).map((v) => ({ x: v.x, z: v.z }));
}

const ribbonVert = `
attribute float along;
varying float vAlong; varying float vSide;
attribute float side;
void main(){ vAlong = along; vSide = side;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const ribbonFrag = `
uniform float uTime; uniform vec3 uColor; uniform float uDone; uniform float uOpacity;
varying float vAlong; varying float vSide;
#include <logdepthbuf_pars_fragment>
void main(){
  #include <logdepthbuf_fragment>
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float chev = fract(vAlong * 0.25 - uTime * 0.8 - abs(vSide) * 0.35);
  chev = smoothstep(0.0, 0.08, chev) * (1.0 - smoothstep(0.18, 0.3, chev));
  float a = (0.28 + 0.9 * chev) * edge;
  float walked = step(vAlong, uDone);
  vec3 c = mix(uColor, vec3(0.6), walked);
  a *= mix(1.0, 0.25, walked) * uOpacity;
  gl_FragColor = vec4(c * (0.8 + chev * 0.7), a);
}`;

export class RouteRibbon {
  readonly mesh: THREE.Mesh;
  private uni = {
    uTime: { value: 0 }, uColor: { value: new THREE.Color(0x00e5ff) }, uDone: { value: -1 }, uOpacity: { value: 1 },
  };
  /** cumulative distance per smoothed vertex (for progress) */
  pts: P2[] = [];
  cum: number[] = [];

  constructor(private terrain: Terrain, color = 0x00e5ff, private width = 0.7, opacity = 1) {
    this.uni.uColor.value.set(color);
    this.uni.uOpacity.value = opacity;
    const mat = new THREE.ShaderMaterial({
      vertexShader: "#include <common>\n#include <logdepthbuf_pars_vertex>\n" + ribbonVert,
      fragmentShader: "#include <common>\n" + ribbonFrag,
      uniforms: this.uni, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Bumped on every set() so followers know to re-acquire the path. */
  version = 0;

  set(path: P2[]) {
    this.version++;
    this.pts = smoothPath(path, 1.5);
    const n = this.pts.length;
    const pos = new Float32Array(n * 2 * 3), along = new Float32Array(n * 2), side = new Float32Array(n * 2);
    const idx: number[] = [];
    this.cum = [0];
    for (let i = 0; i < n; i++) {
      const a = this.pts[Math.max(i - 1, 0)], b = this.pts[Math.min(i + 1, n - 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const p = this.pts[i];
      if (i > 0) this.cum.push(this.cum[i - 1] + Math.hypot(p.x - this.pts[i - 1].x, p.z - this.pts[i - 1].z));
      for (let s = 0; s < 2; s++) {
        const sg = s === 0 ? -1 : 1;
        const x = p.x - dz * sg * this.width / 2, z = p.z + dx * sg * this.width / 2;
        pos.set([x, this.terrain.heightAt(x, z) + 0.08, z], (i * 2 + s) * 3);
        along[i * 2 + s] = this.cum[i];
        side[i * 2 + s] = sg;
      }
      if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("along", new THREE.BufferAttribute(along, 1));
    g.setAttribute("side", new THREE.BufferAttribute(side, 1));
    g.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /**
   * Distance along the ribbon of the point closest to (x, z). With a hint (a previous `along`), only the
   * stretch from hint-back to hint+ahead is searched, so a route that doubles back on itself can't make
   * the follower jump to the other leg.
   */
  project(x: number, z: number, hint?: number, back = 15, ahead = 40): { along: number; dist: number; index: number } {
    let best = Infinity, bi = 0;
    for (let i = 0; i < this.pts.length; i++) {
      if (hint != null && (this.cum[i] < hint - back || this.cum[i] > hint + ahead)) continue;
      const d = (this.pts[i].x - x) ** 2 + (this.pts[i].z - z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    if (best === Infinity) return this.project(x, z);
    return { along: this.cum[bi] ?? 0, dist: Math.sqrt(best), index: bi };
  }

  /** Unit direction of travel at `along`. */
  tangentAt(along: number): P2 {
    const a = this.pointAt(Math.max(0, along - 1)), b = this.pointAt(Math.min(this.length(), along + 1));
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  }

  pointAt(along: number): P2 {
    const c = this.cum;
    if (!c.length) return { x: 0, z: 0 };
    if (along >= c[c.length - 1]) return this.pts[this.pts.length - 1];
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= along) lo = m; else hi = m; }
    const t = (along - c[lo]) / Math.max(c[hi] - c[lo], 1e-6);
    return { x: this.pts[lo].x + (this.pts[hi].x - this.pts[lo].x) * t, z: this.pts[lo].z + (this.pts[hi].z - this.pts[lo].z) * t };
  }

  length() { return this.cum[this.cum.length - 1] ?? 0; }
  setDone(along: number) { this.uni.uDone.value = along; }
  update(t: number) { this.uni.uTime.value = t; }
  set visible(v: boolean) { this.mesh.visible = v; }
}

// ---------- beacons ----------
const pillarVert = `varying vec2 vUv; varying float vDist; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0);
  vDist = -mv.z; gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;
const pillarFrag = `uniform vec3 uColor; uniform float uTime; uniform float uOn; varying vec2 vUv; varying float vDist;
#include <logdepthbuf_pars_fragment>
void main(){
  #include <logdepthbuf_fragment>
  float fade = pow(max(1.0 - vUv.y, 0.0), 1.6);
  float band = 0.6 + 0.4 * sin(vUv.y * 40.0 - uTime * 3.0);
  float edge = pow(max(sin(vUv.x * 3.14159), 0.0), 0.6);
  float near = smoothstep(8.0, 60.0, vDist);
  gl_FragColor = vec4(uColor * 2.2, fade * band * 0.55 * uOn * (0.4 + 0.6 * edge) * near); }`;

export interface Beacon {
  id: string;
  group: THREE.Group;
  label: HTMLDivElement;
  setState(s: "next" | "pending" | "done" | "base"): void;
}

export function makeBeacon(terrain: Terrain, id: string, name: string, x: number, z: number, n: string, time: { value: number }): Beacon {
  const group = new THREE.Group();
  const y = terrain.heightAt(x, z);
  group.position.set(x, y, z);
  const color = new THREE.Color(0xff9d00);
  const uni = { uColor: { value: color }, uTime: time, uOn: { value: 1 } };
  const pillarMat = new THREE.ShaderMaterial({
    vertexShader: "#include <common>\n#include <logdepthbuf_pars_vertex>\n" + pillarVert,
    fragmentShader: "#include <common>\n" + pillarFrag,
    uniforms: uni, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 80, 24, 1, true), pillarMat);
  pillar.position.y = 40;
  group.add(pillar);
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(4.6, 5, 64).rotateX(-Math.PI / 2), ringMat);
  ring.position.y = 0.25;
  group.add(ring);
  const inner = new THREE.Mesh(new THREE.RingGeometry(1.4, 1.6, 48).rotateX(-Math.PI / 2), ringMat);
  inner.position.y = 0.25;
  group.add(inner);
  // drape the rings: lift to the highest ground under the outer ring
  let maxY = y;
  for (let a = 0; a < 12; a++) maxY = Math.max(maxY, terrain.heightAt(x + Math.cos(a) * 5, z + Math.sin(a) * 5));
  ring.position.y = inner.position.y = maxY - y + 0.2;

  const label = document.createElement("div");
  label.className = "beacon-label";
  label.innerHTML = `<span class="bn">${n}</span><span class="bt">${name}</span><span class="bd"></span>`;
  const obj = new CSS2DObject(label);
  obj.position.set(0, 9, 0);
  group.add(obj);

  group.onBeforeRender = () => {};
  const tick = () => {
    const s = 1 + 0.06 * Math.sin(time.value * 2);
    ring.scale.set(s, 1, s);
  };
  (group as THREE.Group & { tick?: () => void }).userData.tick = tick;

  return {
    id, group, label,
    setState(s) {
      const c = s === "done" ? 0x2ea043 : s === "base" ? 0x00e5ff : 0xff9d00;
      color.set(c);
      ringMat.color.set(c);
      uni.uOn.value = s === "pending" ? 0.35 : s === "done" ? 0.25 : 1;
      label.dataset.state = s;
    },
  };
}

// ---------- scan marker ----------
export class ScanMarker {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private t = 0;
  constructor() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x7ff6ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, toneMapped: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.0, 48).rotateX(-Math.PI / 2), mat);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3, 6), mat);
    stem.position.y = 1.5;
    const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.25), mat);
    tip.position.y = 3.2;
    this.group.add(this.ring, stem, tip);
    this.group.visible = false;
  }
  show(x: number, y: number, z: number) {
    this.group.position.set(x, y + 0.1, z);
    this.group.visible = true;
    this.t = 0;
  }
  update(dt: number) {
    if (!this.group.visible) return;
    this.t += dt;
    const s = 1 + (this.t * 2) % 1.5;
    this.ring.scale.set(s, 1, s);
    this.group.children[2].rotation.y += dt * 2;
  }
  hide() { this.group.visible = false; }
}
