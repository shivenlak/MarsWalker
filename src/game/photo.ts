// Photo mode: hides the HUD, frees the camera (orbit / pan / zoom), lets you pick the time of day and lens,
// and saves a PNG of the frame. Made for submission images and slides.

export interface PhotoState { on: boolean; hour: number | null; fov: number; yaw: number; pitch: number; dist: number; fx: number; fz: number; vignette: boolean }

export class PhotoMode {
  readonly el: HTMLDivElement;
  state: PhotoState = { on: false, hour: null, fov: 50, yaw: 0, pitch: 0.25, dist: 9, fx: 0, fz: 0, vignette: true };
  onCapture: (() => void) | null = null;
  onExit: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "photo";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="ph-vig"></div>
      <div class="ph-panel">
        <div class="ph-title">PHOTO MODE</div>
        <label>Sun (local solar time) <b class="ph-hv"></b><input class="ph-h" type="range" min="5.5" max="19" step="0.05"></label>
        <label>Lens <b class="ph-fv"></b><input class="ph-f" type="range" min="15" max="90" step="1"></label>
        <label class="ph-row"><input class="ph-v" type="checkbox" checked> Vignette</label>
        <p class="src">Drag to orbit · wheel to zoom · WASD to move · Space to capture · C / Esc to exit</p>
        <div class="ph-btns"><button class="btn small ph-cap">CAPTURE PNG</button><button class="btn small ph-x">EXIT</button></div>
      </div>
      <div class="ph-flash"></div>`;
    root.appendChild(this.el);
    const h = this.el.querySelector<HTMLInputElement>(".ph-h")!;
    const f = this.el.querySelector<HTMLInputElement>(".ph-f")!;
    const v = this.el.querySelector<HTMLInputElement>(".ph-v")!;
    h.oninput = () => { this.state.hour = +h.value; this.labels(); };
    f.oninput = () => { this.state.fov = +f.value; this.labels(); };
    v.onchange = () => { this.state.vignette = v.checked; this.el.classList.toggle("novig", !v.checked); };
    this.el.querySelector<HTMLButtonElement>(".ph-cap")!.onclick = () => this.onCapture?.();
    this.el.querySelector<HTMLButtonElement>(".ph-x")!.onclick = () => this.onExit?.();
  }

  private labels() {
    const hh = this.state.hour ?? 12;
    this.el.querySelector(".ph-hv")!.textContent = `${String(Math.floor(hh)).padStart(2, "0")}:${String(Math.round((hh % 1) * 60) % 60).padStart(2, "0")}`;
    this.el.querySelector(".ph-fv")!.textContent = `${this.state.fov}° (${Math.round(18 / Math.tan((this.state.fov * Math.PI) / 360))} mm)`;
  }

  open(at: { x: number; z: number; yaw: number; hour: number }) {
    Object.assign(this.state, { on: true, hour: at.hour, fx: at.x, fz: at.z, yaw: at.yaw, pitch: 0.22, dist: 9 });
    this.el.querySelector<HTMLInputElement>(".ph-h")!.value = String(at.hour);
    this.el.querySelector<HTMLInputElement>(".ph-f")!.value = String(this.state.fov);
    this.labels();
    this.el.hidden = false;
  }
  close() { this.state.on = false; this.state.hour = null; this.el.hidden = true; }

  /** Save the canvas as a PNG (call right after rendering, in the same task). */
  save(canvas: HTMLCanvasElement) {
    const a = document.createElement("a");
    a.download = `marswalk-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
    const fl = this.el.querySelector<HTMLElement>(".ph-flash")!;
    fl.classList.remove("go"); void fl.offsetWidth; fl.classList.add("go");
  }
}
