// Procedural xEMU-style astronaut: hard upper torso, convolute soft-goods joints with metal bearings,
// clear pressure bubble + gold-visor assembly, life-support backpack, gloves with fingers, treaded boots.
// Legs use two-bone IK so boots plant on the real terrain (no foot sliding); arms counter-swing.
// Poses: walk/lope, airborne, kneel (sampling), seated (buggy). First-person hides the helmet only.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

// ---------- materials ----------
function fabricNormal(): THREE.Texture {
  const N = 128, d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = (y * N + x) * 4;
    const wx = Math.sin((x / N) * Math.PI * 32), wy = Math.sin((y / N) * Math.PI * 32);
    const n = (Math.random() - 0.5) * 0.25;
    d[k] = 128 + (wx * 0.35 + n) * 127 * 0.5; d[k + 1] = 128 + (wy * 0.35 + n) * 127 * 0.5; d[k + 2] = 255; d[k + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.needsUpdate = true;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
const fabricN = fabricNormal();
const fabric = new THREE.MeshStandardMaterial({ color: 0xeeebe4, roughness: 0.92, normalMap: fabricN, normalScale: new THREE.Vector2(0.6, 0.6) });
const fabricShade = new THREE.MeshStandardMaterial({ color: 0xd9d4ca, roughness: 0.95, normalMap: fabricN, normalScale: new THREE.Vector2(0.8, 0.8) });
const hard = new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: 0.38, metalness: 0.05 });
const metal = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.3, metalness: 0.9 });
const darkMetal = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.45, metalness: 0.8 });
const rubber = new THREE.MeshStandardMaterial({ color: 0x2b2a2c, roughness: 0.85 });
const gloveMat = new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.8, normalMap: fabricN, normalScale: new THREE.Vector2(0.4, 0.4) });
const red = new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 0.8, normalMap: fabricN });
export const visorMat = new THREE.MeshStandardMaterial({ color: 0xe8b04a, roughness: 0.05, metalness: 1.0, envMapIntensity: 1.8 });
const glass = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.02, metalness: 0.1, transparent: true, opacity: 0.18, envMapIntensity: 2, depthWrite: false });
const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d6, emissiveIntensity: 3 });
const screen = new THREE.MeshStandardMaterial({ color: 0x041318, emissive: 0x16c7e0, emissiveIntensity: 1.6 });

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true; o.receiveShadow = true;
  return o;
}
/** Lathe from (radius, y) pairs, y going down from 0. */
function lathe(profile: [number, number][], m: THREE.Material, seg = 20) {
  return mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg), m);
}
function ring(r: number, tube: number, m: THREE.Material, y = 0) {
  const t = mesh(new THREE.TorusGeometry(r, tube, 8, 24), m, 0, y, 0);
  t.rotation.x = Math.PI / 2;
  return t;
}
/** Soft-goods limb segment: tapered tube with convolute rings, hanging along -Y. */
function segment(len: number, r0: number, r1: number, convolutes = 0) {
  const g = new THREE.Group();
  g.add(lathe([[0.001, 0], [r0, -0.01], [r0 * 1.02, -len * 0.3], [r1 * 1.03, -len * 0.75], [r1, -len], [0.001, -len - 0.005]], fabric));
  for (let i = 0; i < convolutes; i++) g.add(ring(r0 * 0.98 - (r0 - r1) * (i / convolutes) * 0.5, 0.012, fabricShade, -len * (0.62 + i * 0.09)));
  return g;
}

interface Leg { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group; side: number }
interface Arm { shoulder: THREE.Group; elbow: THREE.Group; side: number }

const THIGH = 0.46, SHIN = 0.45, ANKLE_H = 0.11;

export class Astronaut {
  readonly root = new THREE.Group();   // at ground under the pelvis; faces -Z at heading 0
  private pelvis = new THREE.Group();
  private torso = new THREE.Group();
  readonly helmet = new THREE.Group();
  private legs: Leg[] = [];
  private arms: Arm[] = [];
  readonly visor: THREE.Mesh;
  readonly lamps: THREE.SpotLight[] = [];
  private phase = 0;
  private t = 0;
  private kneel = 0;
  private seat = 0;
  private lastStance = [true, true];
  onStep: ((foot: THREE.Vector3, left: boolean) => void) | null = null;
  /** ground height sampler (world) for foot IK */
  ground: ((x: number, z: number) => number) | null = null;

  /** stripes: EV1 (commander) wears red stripes, EV2 a plain suit, as on NASA EVAs */
  constructor(stripes = true) {
    this.root.add(this.pelvis);
    this.pelvis.position.y = 1.0;

    // ---- lower torso / brief ----
    const brief = lathe([[0.001, 0.08], [0.2, 0.06], [0.215, -0.02], [0.2, -0.12], [0.12, -0.18], [0.001, -0.19]], fabric, 24);
    brief.scale.z = 0.8;
    this.pelvis.add(brief);
    this.pelvis.add(ring(0.205, 0.022, metal, 0.07)); // waist bearing
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.11, -0.1, 0);
      const hb = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 20), metal);
      hb.rotation.z = Math.PI / 2; hb.position.x = side * 0.02;
      hip.add(hb);
      hip.add(segment(THIGH, 0.1, 0.085, 2));
      const stripe = mesh(new THREE.CylinderGeometry(0.097, 0.095, 0.05, 20), red, 0, -0.18, 0);
      if (side < 0 && stripes) hip.add(stripe);
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      knee.add(mesh(new THREE.SphereGeometry(0.088, 16, 12), fabricShade));
      for (let i = 0; i < 3; i++) knee.add(ring(0.088, 0.013, fabricShade, 0.03 - i * 0.03));
      knee.add(segment(SHIN, 0.085, 0.07, 1));
      const ankle = new THREE.Group();
      ankle.position.y = -SHIN;
      ankle.add(ring(0.072, 0.016, metal, 0.01));
      // boot: sole + upper + toe cap + tread blocks
      const boot = new THREE.Group();
      boot.add(mesh(new RoundedBoxGeometry(0.15, 0.13, 0.3, 3, 0.04), hard, 0, -0.035, -0.045));
      boot.add(mesh(new RoundedBoxGeometry(0.16, 0.045, 0.32, 2, 0.015), rubber, 0, -0.1, -0.045));
      boot.add(mesh(new RoundedBoxGeometry(0.13, 0.06, 0.08, 2, 0.02), darkMetal, 0, -0.06, -0.17));
      for (let i = 0; i < 5; i++) boot.add(mesh(new THREE.BoxGeometry(0.14, 0.012, 0.025), rubber, 0, -0.127, 0.08 - i * 0.055));
      ankle.add(boot);
      knee.add(ankle);
      hip.add(knee);
      this.pelvis.add(hip);
      this.legs.push({ hip, knee, ankle, side });
    }

    // ---- hard upper torso (HUT) ----
    this.torso.position.y = 0.09;
    this.pelvis.add(this.torso);
    const hut = lathe([[0.001, 0.62], [0.13, 0.6], [0.24, 0.52], [0.27, 0.38], [0.26, 0.2], [0.22, 0.06], [0.2, 0.0], [0.001, -0.005]], hard, 28);
    hut.scale.z = 0.78;
    this.torso.add(hut);
    this.torso.add(ring(0.2, 0.02, metal, 0.01));
    // display & control module on the chest
    const dcm = mesh(new RoundedBoxGeometry(0.28, 0.13, 0.11, 3, 0.025), hard, 0, 0.3, -0.24);
    this.torso.add(dcm);
    this.torso.add(mesh(new THREE.BoxGeometry(0.11, 0.05, 0.005), screen, -0.04, 0.32, -0.298));
    for (let i = 0; i < 3; i++) {
      const knob = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.025, 12), darkMetal, 0.06 + i * 0.03, 0.3, -0.3);
      knob.rotation.x = Math.PI / 2;
      this.torso.add(knob);
    }
    this.torso.add(mesh(new RoundedBoxGeometry(0.08, 0.03, 0.03, 2, 0.01), red, 0.09, 0.355, -0.29)); // purge valve tab
    // ---- PLSS backpack ----
    const pack = mesh(new RoundedBoxGeometry(0.5, 0.66, 0.26, 4, 0.06), hard, 0, 0.32, 0.29);
    this.torso.add(pack);
    this.torso.add(mesh(new RoundedBoxGeometry(0.44, 0.1, 0.06, 2, 0.02), fabricShade, 0, 0.6, 0.43));
    for (let i = 0; i < 4; i++) this.torso.add(mesh(new THREE.BoxGeometry(0.3, 0.012, 0.01), darkMetal, 0, 0.12 + i * 0.04, 0.425));
    const ant = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.28, 6), darkMetal, 0.2, 0.78, 0.33);
    this.torso.add(ant);
    this.torso.add(mesh(new THREE.SphereGeometry(0.018, 8, 6), lamp, 0.2, 0.93, 0.33));

    // ---- helmet: neck ring, clear bubble, visor assembly, lamps, camera ----
    this.helmet.position.y = 0.6;
    this.torso.add(this.helmet);
    this.helmet.add(ring(0.16, 0.026, metal, 0));
    const bubble = mesh(new THREE.SphereGeometry(0.19, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.62), glass, 0, 0.12, -0.01);
    bubble.castShadow = false;
    this.helmet.add(bubble);
    // visor assembly shell (white, open at the front) and the gold visor (front cap)
    // visor-assembly shell wraps the back and top, leaving the front open over the gold visor
    this.helmet.add(mesh(new THREE.SphereGeometry(0.205, 32, 24, Math.PI * 1.83, Math.PI * 1.34, 0, Math.PI * 0.6), hard, 0, 0.12, 0));
    this.visor = mesh(new THREE.SphereGeometry(0.2, 32, 24, Math.PI * 1.17, Math.PI * 0.66, Math.PI * 0.17, Math.PI * 0.42), visorMat, 0, 0.12, 0);
    this.helmet.add(this.visor);
    for (const sx of [-1, 1]) {
      const housing = mesh(new RoundedBoxGeometry(0.06, 0.07, 0.09, 2, 0.015), hard, sx * 0.19, 0.2, -0.02);
      this.helmet.add(housing);
      const lens = mesh(new THREE.CircleGeometry(0.02, 12), lamp, sx * 0.19, 0.2, -0.067);
      lens.rotation.y = Math.PI;
      this.helmet.add(lens);
      const spot = new THREE.SpotLight(0xfff1dd, 0, 45, 0.5, 0.6, 1.4);
      spot.position.set(sx * 0.19, 0.2, -0.08);
      spot.target.position.set(sx * 0.1, -0.6, -6);
      this.helmet.add(spot, spot.target);
      this.lamps.push(spot);
    }

    // ---- arms ----
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.29, 0.47, 0.0);
      const sb = mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.06, 20), metal);
      sb.rotation.z = Math.PI / 2; shoulder.add(sb);
      shoulder.add(segment(0.3, 0.075, 0.068, 2));
      if (side > 0 && stripes) shoulder.add(mesh(new THREE.CylinderGeometry(0.074, 0.073, 0.045, 20), red, 0, -0.12, 0));
      const elbow = new THREE.Group();
      elbow.position.y = -0.3;
      for (let i = 0; i < 3; i++) elbow.add(ring(0.066, 0.012, fabricShade, 0.02 - i * 0.025));
      elbow.add(segment(0.26, 0.066, 0.055, 0));
      elbow.add(ring(0.058, 0.016, metal, -0.26)); // wrist bearing
      // glove: gauntlet, palm, fingers, thumb
      const hand = new THREE.Group();
      hand.position.y = -0.3;
      hand.add(mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.07, 14), gloveMat, 0, 0.02, 0));
      hand.add(mesh(new RoundedBoxGeometry(0.085, 0.1, 0.045, 2, 0.02), gloveMat, 0, -0.05, 0));
      for (let f = 0; f < 4; f++) {
        const finger = mesh(new THREE.CapsuleGeometry(0.011, 0.045, 3, 8), gloveMat, -0.03 + f * 0.02, -0.12, -0.01);
        finger.rotation.x = 0.35;
        hand.add(finger);
      }
      const thumb = mesh(new THREE.CapsuleGeometry(0.012, 0.035, 3, 8), gloveMat, side * -0.045, -0.06, -0.025);
      thumb.rotation.z = side * 0.6;
      hand.add(thumb);
      elbow.add(hand);
      shoulder.add(elbow);
      this.torso.add(shoulder);
      this.arms.push({ shoulder, elbow, side });
    }
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
  }

  /** First-person: hide the helmet so the camera can sit inside it, keep the body visible. */
  setFirstPerson(fp: boolean) { this.helmet.visible = !fp; }
  setVisible(v: boolean) { this.root.visible = v; }
  setLamps(on: boolean) { this.lamps.forEach((l) => (l.intensity = on ? 9 : 0)); }

  /**
   * speed m/s (visual), dt real s, airborne, lean rad, kneel 0..1, seated 0..1.
   * Uses `ground` for foot placement; root must already be positioned at the body's ground point.
   */
  animate(speed: number, dt: number, airborne: boolean, lean: number, kneelTarget: number, seatTarget = 0) {
    this.t += dt;
    this.kneel += (kneelTarget - this.kneel) * Math.min(dt * 3, 1);
    this.seat += (seatTarget - this.seat) * Math.min(dt * 4, 1);
    const amp = Math.min(speed / 1.0, 1);
    const stride = THREE.MathUtils.clamp(0.35 + speed * 0.55, 0.35, 1.5); // low-g: long strides
    this.phase = (this.phase + (speed / Math.max(stride, 0.01)) * dt * (speed > 0.03 ? 1 : 0)) % 1;

    const R = this.root;
    R.updateMatrixWorld();
    const heading = -R.rotation.y; // clockwise from north
    const fwd = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading));
    const right = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
    const gAt = (x: number, z: number) => (this.ground ? this.ground(x, z) : R.position.y);
    const breathe = Math.sin(this.t * 1.7) * 0.006;

    if (this.seat > 0.01) {
      // seated in the buggy
      this.pelvis.position.y = 0.55;
      this.torso.rotation.set(0.15 * this.seat, 0, 0);
      for (const l of this.legs) { l.hip.rotation.set(1.45 * this.seat, 0, 0); l.knee.rotation.x = -1.4 * this.seat; l.ankle.rotation.x = 0.0; }
      for (const a of this.arms) { a.shoulder.rotation.set(0.9 * this.seat, 0, a.side * 0.12); a.elbow.rotation.x = 0.7 * this.seat; }
      return;
    }

    // ---- legs: gait foot targets -> two-bone IK on the terrain ----
    const hipOff = 0.1; // hip pivot below pelvis origin
    const hipH = 1.0;   // nominal pelvis height
    const k = this.kneel;
    let lowest = Infinity;
    const plan = this.legs.map((l, i) => {
      const ph = (this.phase + i * 0.5) % 1;
      const stance = ph < 0.6;
      let f: number, lift: number;
      if (stance) { f = stride / 2 - (ph / 0.6) * stride; lift = 0; }
      else { const s = (ph - 0.6) / 0.4; const e = s * s * (3 - 2 * s); f = -stride / 2 + e * stride; lift = Math.sin(s * Math.PI) * (0.08 + 0.12 * amp); }
      f *= amp;
      lift *= amp;
      if (airborne) { f = i ? -0.15 : 0.25; lift = 0.25; }
      const lateral = l.side * 0.12;
      const fx = R.position.x + fwd.x * f + right.x * lateral, fz = R.position.z + fwd.z * f + right.z * lateral;
      const gy = airborne ? 0 : gAt(fx, fz) - R.position.y; // ground under this foot, relative to root
      lowest = Math.min(lowest, gy);
      // footstep event at heel strike
      if (stance && !this.lastStance[i] && amp > 0.05 && !airborne) this.onStep?.(new THREE.Vector3(fx, gAt(fx, fz), fz), l.side < 0);
      this.lastStance[i] = stance;
      return { f, lift, gy };
    });
    // pelvis: sit low enough that both feet reach the ground, bob with the gait, drop when kneeling
    const bob = Math.abs(Math.cos(this.phase * Math.PI * 2)) * 0.035 * amp;
    const pelvisY = hipH + Math.min(0, lowest) + bob + breathe - k * 0.45 - 0.03 * amp;
    this.pelvis.position.y = pelvisY;
    this.legs.forEach((l, i) => {
      const p = plan[i];
      if (k > 0.05 && i === 0) { // kneeling: left knee down, right foot forward
        l.hip.rotation.x = THREE.MathUtils.lerp(l.hip.rotation.x, -0.2, k);
        l.knee.rotation.x = THREE.MathUtils.lerp(l.knee.rotation.x, -2.0, k);
        l.ankle.rotation.x = 0.4 * k;
        return;
      }
      const down = pelvisY - hipOff - (p.gy + p.lift + ANKLE_H);
      const fwdDist = p.f;
      const D = THREE.MathUtils.clamp(Math.hypot(fwdDist, down), Math.abs(THIGH - SHIN) + 0.01, THIGH + SHIN - 0.002);
      const theta = Math.atan2(fwdDist, down);
      const alpha = Math.acos(THREE.MathUtils.clamp((THIGH * THIGH + D * D - SHIN * SHIN) / (2 * THIGH * D), -1, 1));
      const beta = Math.PI - Math.acos(THREE.MathUtils.clamp((THIGH * THIGH + SHIN * SHIN - D * D) / (2 * THIGH * SHIN), -1, 1));
      l.hip.rotation.x = theta + alpha;
      l.knee.rotation.x = -beta;
      l.ankle.rotation.x = -(l.hip.rotation.x + l.knee.rotation.x) * 0.9 + lean * 0.5; // keep the sole roughly level
    });

    // ---- torso + arms ----
    const s = Math.sin(this.phase * Math.PI * 2);
    this.torso.rotation.x = -lean - 0.05 * amp - k * 0.45;
    this.torso.rotation.y = s * 0.05 * amp;
    this.torso.rotation.z = Math.sin(this.phase * Math.PI * 2) * 0.02 * amp;
    this.arms.forEach((a, i) => {
      const swing = (i ? -s : s) * 0.42 * amp;
      a.shoulder.rotation.set(swing - k * (i ? 0.9 : 0.5) + (airborne ? -0.6 : 0), 0, a.side * (0.16 + 0.04 * amp));
      a.elbow.rotation.x = 0.35 + 0.35 * amp + k * 0.6 + (airborne ? 0.4 : 0);
    });
  }

  /** Eye position (inside the helmet) in world space. */
  eye(out: THREE.Vector3) {
    return this.helmet.localToWorld(out.set(0, 0.11, -0.04));
  }
}
