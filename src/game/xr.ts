// WebXR: stand on Mars in a VR headset. The camera rides a rig placed at the astronaut's feet (the headset
// adds your real head pose on top), the left thumbstick walks or drives relative to where you look, and the
// right trigger toggles the A* autopilot. Post-processing is skipped in VR (EffectComposer can't render to XR).

import * as THREE from "three";

export class XRMode {
  readonly rig = new THREE.Group();
  readonly button: HTMLButtonElement;
  supported = false;
  stick = { fwd: 0, right: 0 };
  onTrigger: (() => void) | null = null;
  private session: XRSession | null = null;
  private triggerDown = false;

  constructor(private renderer: THREE.WebGLRenderer, private camera: THREE.PerspectiveCamera, scene: THREE.Scene, root: HTMLElement) {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    scene.add(this.rig);
    this.button = document.createElement("button");
    this.button.className = "btn small xr-btn";
    this.button.textContent = "ENTER VR";
    this.button.hidden = true;
    this.button.onclick = () => (this.session ? this.session.end() : this.enter());
    root.appendChild(this.button);
    (navigator as Navigator & { xr?: XRSystem }).xr?.isSessionSupported("immersive-vr").then((ok) => {
      this.supported = ok;
      this.button.hidden = !ok;
    }).catch(() => {});
  }

  get presenting() { return this.renderer.xr.isPresenting; }

  private async enter() {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) return;
    const s = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
    this.session = s;
    await this.renderer.xr.setSession(s);
    this.rig.add(this.camera);
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(0, 0, 0);
    this.button.textContent = "EXIT VR";
    s.addEventListener("end", () => {
      this.session = null;
      this.rig.parent?.add(this.camera); // back into the scene
      this.button.textContent = "ENTER VR";
    });
  }

  /** Place the rig on the ground at (x, y, z). Returns the head's world yaw (for movement direction). */
  update(x: number, y: number, z: number): number {
    this.rig.position.set(x, y, z);
    const s = this.session;
    this.stick = { fwd: 0, right: 0 };
    let trig = false;
    if (s) for (const src of s.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      if (src.handedness !== "right" && gp.axes.length >= 4) {
        const ax = gp.axes[2], ay = gp.axes[3];
        this.stick = { fwd: Math.abs(ay) > 0.2 ? -ay : 0, right: Math.abs(ax) > 0.2 ? ax : 0 };
      }
      if (src.handedness === "right" && gp.buttons[0]?.pressed) trig = true;
    }
    if (trig && !this.triggerDown) this.onTrigger?.();
    this.triggerDown = trig;
    const xc = this.renderer.xr.getCamera();
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(xc.quaternion);
    return Math.atan2(d.x, -d.z);
  }
}
