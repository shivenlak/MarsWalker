// Attract / guided demo: a captioned tour that drives the real game systems (A* planner, validation,
// autopilot, sampling, EV2, buggy, storm, night, photo mode). Any key or click hands control back.
// Doubles as the recorded submission video: start it with ?demo in the URL and screen-record.

export interface DemoStep {
  cap: string;           // headline caption
  sub?: string;          // smaller line: the data source / what is real
  dur: number;           // seconds
  run?: () => void;      // once at step start
  tick?: (t: number, dt: number) => void; // every frame during the step (t = seconds into the step)
}

export class Director {
  readonly el: HTMLDivElement;
  private steps: DemoStep[] = [];
  private i = -1;
  private t = 0;
  active = false;
  onEnd: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "demo";
    this.el.hidden = true;
    this.el.innerHTML = `<div class="dm-cap"><div class="dm-h"></div><div class="dm-s"></div></div>
      <div class="dm-bar"><i></i></div><div class="dm-hint">DEMO · press any key or click to take control</div>`;
    root.appendChild(this.el);
  }

  start(steps: DemoStep[]) {
    this.steps = steps; this.i = -1; this.t = 0; this.active = true;
    this.el.hidden = false;
    this.next();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.el.hidden = true;
    this.onEnd?.();
  }

  private next() {
    this.i++;
    this.t = 0;
    const s = this.steps[this.i];
    if (!s) { this.stop(); return; }
    const cap = this.el.querySelector<HTMLElement>(".dm-cap")!;
    cap.classList.remove("in"); void cap.offsetWidth; cap.classList.add("in");
    this.el.querySelector(".dm-h")!.innerHTML = s.cap;
    this.el.querySelector(".dm-s")!.innerHTML = s.sub ?? "";
    try { s.run?.(); } catch (e) { console.warn("demo step failed", e); }
  }

  update(dt: number) {
    if (!this.active) return;
    const s = this.steps[this.i];
    if (!s) return;
    this.t += dt;
    try { s.tick?.(this.t, dt); } catch (e) { console.warn("demo tick failed", e); }
    const total = this.steps.reduce((a, q) => a + q.dur, 0);
    const done = this.steps.slice(0, this.i).reduce((a, q) => a + q.dur, 0) + Math.min(this.t, s.dur);
    this.el.querySelector<HTMLElement>(".dm-bar i")!.style.width = `${(done / total) * 100}%`;
    if (this.t >= s.dur) this.next();
  }
}
