// Procedural EVA astronaut (no external assets): suit, gold visor, life-support backpack, helmet lights.
// Animated with a low-gravity gait (longer stride, more float) plus idle breathing, hop and kneel poses.

import * as THREE from "three";

const suitMat = new THREE.MeshStandardMaterial({ color: 0xe9e5dc, roughness: 0.82, metalness: 0 });
const softMat = new THREE.MeshStandardMaterial({ color: 0xcfc9bd, roughness: 0.9 });
const jointMat = new THREE.MeshStandardMaterial({ color: 0x8d8a85, roughness: 0.6, metalness: 0.3 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.7, metalness: 0.2 });
const stripeMat = new THREE.MeshStandardMaterial({ color: 0xc8402c, roughness: 0.8 });
export const visorMat = new THREE.MeshStandardMaterial({ color: 0xffc35a, roughness: 0.06, metalness: 1.0, envMapIntensity: 1.6 });
const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 4 });
const cyanMat = new THREE.MeshStandardMaterial({ color: 0x0a2a30, emissive: 0x00e5ff, emissiveIntensity: 2.5 });

function m(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

interface Limb { root: THREE.Group; joint: THREE.Group }

/** Two-segment limb: pivot at top, second pivot at mid (elbow/knee). Hangs along -Y. */
function limb(upperLen: number, lowerLen: number, r: number, endMesh: THREE.Object3D, stripe: boolean): Limb {
  const root = new THREE.Group();
  root.add(m(new THREE.SphereGeometry(r * 1.15, 16, 12), softMat));
  const upper = m(new THREE.CapsuleGeometry(r, upperLen - 2 * r, 6, 14), suitMat, 0, -upperLen / 2, 0);
  root.add(upper);
  if (stripe) root.add(m(new THREE.CylinderGeometry(r * 1.03, r * 1.03, 0.05, 16), stripeMat, 0, -upperLen * 0.35, 0));
  const joint = new THREE.Group();
  joint.position.y = -upperLen;
  joint.add(m(new THREE.SphereGeometry(r * 0.98, 14, 10), jointMat));
  joint.add(m(new THREE.CapsuleGeometry(r * 0.92, lowerLen - 2 * r, 6, 14), suitMat, 0, -lowerLen / 2, 0));
  endMesh.position.y = -lowerLen;
  joint.add(endMesh);
  root.add(joint);
  return { root, joint };
}

export class Astronaut {
  readonly root = new THREE.Group();   // at the feet, faces -Z (north) at heading 0
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private armL: Limb; private armR: Limb; private legL: Limb; private legR: Limb;
  private phase = 0;
  private t = 0;
  readonly visor: THREE.Mesh;
  /** called on each foot plant with the foot's world position */
  onStep: ((foot: THREE.Vector3, left: boolean) => void) | null = null;
  private lastSin = 0;
  private footL = new THREE.Object3D();
  private footR = new THREE.Object3D();
  private kneel = 0;

  constructor() {
    const R = this.root;
    R.add(this.hips);
    this.hips.position.y = 0.98;

    // legs
    const boot = () => {
      const g = new THREE.Group();
      g.add(m(new THREE.BoxGeometry(0.15, 0.1, 0.3), darkMat, 0, -0.03, -0.05));
      g.add(m(new THREE.BoxGeometry(0.155, 0.03, 0.31), jointMat, 0, -0.085, -0.05));
      return g;
    };
    const bl = boot(), br = boot();
    this.legL = limb(0.47, 0.44, 0.085, bl, false);
    this.legR = limb(0.47, 0.44, 0.085, br, false);
    bl.add(this.footL); br.add(this.footR);
    this.footL.position.set(0, -0.1, -0.05); this.footR.position.set(0, -0.1, -0.05);
    this.legL.root.position.set(-0.12, 0, 0);
    this.legR.root.position.set(0.12, 0, 0);
    this.hips.add(this.legL.root, this.legR.root);
    this.hips.add(m(new THREE.CylinderGeometry(0.2, 0.18, 0.18, 20), softMat, 0, 0.02, 0));
    const belt = m(new THREE.TorusGeometry(0.19, 0.025, 8, 24), jointMat, 0, 0.11, 0);
    belt.rotation.x = Math.PI / 2;
    this.hips.add(belt);

    // torso (hard upper torso)
    this.torso.position.y = 0.12;
    this.hips.add(this.torso);
    const hut = m(new THREE.CapsuleGeometry(0.22, 0.28, 8, 20), suitMat, 0, 0.3, 0);
    hut.scale.set(1.05, 1, 0.78);
    this.torso.add(hut);
    // chest display + control module
    this.torso.add(m(new THREE.BoxGeometry(0.22, 0.12, 0.08), softMat, 0, 0.3, -0.19));
    this.torso.add(m(new THREE.BoxGeometry(0.12, 0.04, 0.01), cyanMat, 0, 0.32, -0.235));
    // backpack (PLSS)
    const pack = m(new THREE.BoxGeometry(0.46, 0.62, 0.24), suitMat, 0, 0.36, 0.27);
    this.torso.add(pack);
    this.torso.add(m(new THREE.BoxGeometry(0.4, 0.08, 0.2), jointMat, 0, 0.7, 0.27));
    this.torso.add(m(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 10), darkMat, 0.2, 0.75, 0.3));
    this.torso.add(m(new THREE.SphereGeometry(0.02, 8, 6), lampMat, 0.2, 0.92, 0.3));
    this.torso.add(m(new THREE.BoxGeometry(0.06, 0.2, 0.012), cyanMat, -0.15, 0.4, 0.395));

    // helmet
    this.head.position.y = 0.66;
    this.torso.add(this.head);
    this.head.add(m(new THREE.CylinderGeometry(0.15, 0.17, 0.08, 24), jointMat, 0, -0.04, 0));
    const shell = m(new THREE.SphereGeometry(0.2, 32, 24), suitMat, 0, 0.14, 0.01);
    this.head.add(shell);
    this.visor = m(new THREE.SphereGeometry(0.205, 32, 24, Math.PI * 1.12, Math.PI * 0.76, Math.PI * 0.2, Math.PI * 0.5), visorMat, 0, 0.14, 0.01);
    this.head.add(this.visor);
    for (const sx of [-1, 1]) {
      const lamp = m(new THREE.CylinderGeometry(0.035, 0.035, 0.07, 12), darkMat, sx * 0.17, 0.25, -0.03);
      lamp.rotation.x = Math.PI / 2;
      this.head.add(lamp);
      const glow = m(new THREE.CircleGeometry(0.028, 12), lampMat, sx * 0.17, 0.25, -0.066);
      glow.rotation.y = Math.PI;
      this.head.add(glow);
    }

    // arms
    const glove = () => m(new THREE.SphereGeometry(0.07, 12, 10), darkMat);
    this.armL = limb(0.31, 0.29, 0.068, glove(), true);
    this.armR = limb(0.31, 0.29, 0.068, glove(), true);
    this.armL.root.position.set(-0.3, 0.5, 0);
    this.armR.root.position.set(0.3, 0.5, 0);
    this.armL.root.rotation.z = -0.18;
    this.armR.root.rotation.z = 0.18;
    this.torso.add(this.armL.root, this.armR.root);
    // flip so the model faces -Z
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
  }

  /**
   * speed: ground speed m/s (sim-time), dt: sim seconds, airborne: true during a hop,
   * lean: forward pitch (rad) for climbing, kneel: 0..1 for sampling pose.
   */
  animate(speed: number, dt: number, airborne: boolean, lean: number, kneelTarget: number) {
    this.t += dt;
    const stride = 1.5; // m per full cycle (two steps) - long, floaty low-g stride
    this.phase += (speed / stride) * Math.PI * 2 * dt;
    const s = Math.sin(this.phase);
    const amp = Math.min(speed / 1.1, 1);
    this.kneel += (kneelTarget - this.kneel) * Math.min(dt * 3, 1);
    const k = this.kneel;

    if (airborne) {
      this.legL.root.rotation.x = 0.35; this.legL.joint.rotation.x = -0.7;
      this.legR.root.rotation.x = -0.15; this.legR.joint.rotation.x = -0.35;
      this.armL.root.rotation.x = -0.7; this.armR.root.rotation.x = -0.7;
      this.armL.joint.rotation.x = -0.4; this.armR.joint.rotation.x = -0.4;
    } else {
      const swing = 0.5 * amp;
      this.legL.root.rotation.x = s * swing + k * 1.2;
      this.legR.root.rotation.x = -s * swing - k * 0.2;
      this.legL.joint.rotation.x = -Math.max(0, -Math.cos(this.phase)) * 0.9 * amp - k * 2.0;
      this.legR.joint.rotation.x = -Math.max(0, Math.cos(this.phase)) * 0.9 * amp - k * 0.4;
      this.armL.root.rotation.x = -s * 0.45 * amp - k * 0.6;
      this.armR.root.rotation.x = s * 0.45 * amp - k * 0.9;
      this.armL.joint.rotation.x = -0.35 - 0.3 * amp - k * 0.4;
      this.armR.joint.rotation.x = -0.35 - 0.3 * amp - k * 0.8;
    }
    const breathe = Math.sin(this.t * 1.6) * 0.008;
    this.hips.position.y = 0.98 + Math.abs(Math.cos(this.phase)) * 0.05 * amp + breathe - k * 0.42;
    this.torso.rotation.x = -lean - 0.06 * amp - k * 0.35;
    this.torso.rotation.z = s * 0.03 * amp;
    this.head.rotation.x = k * 0.5;

    // footstep events at the bottom of each half-cycle
    if (!airborne && amp > 0.05 && Math.sign(s) !== Math.sign(this.lastSin) && this.lastSin !== 0) {
      const left = s > 0;
      const f = new THREE.Vector3();
      (left ? this.footR : this.footL).getWorldPosition(f);
      this.onStep?.(f, left);
    }
    this.lastSin = s;
  }

  /** Eye position for first-person view. */
  eye(out: THREE.Vector3) {
    return this.head.localToWorld(out.set(0, 0.14, -0.05));
  }

  setVisible(v: boolean) {
    this.root.visible = v;
  }
}
