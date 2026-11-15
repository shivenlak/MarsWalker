// Touch controls for phones and tablets: a virtual joystick (move / drive) and action buttons that send the
// same keys as the keyboard. Shown only on coarse-pointer devices; drag elsewhere still orbits the camera.

export const isTouch = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

export class TouchControls {
  readonly el: HTMLDivElement;
  /** analog stick, -1..1 (fwd up, right right) */
  stick = { fwd: 0, right: 0 };

  constructor(root: HTMLElement, press: (key: string) => void) {
    this.el = document.createElement("div");
    this.el.className = "touch";
    this.el.hidden = true;
    const btn = (k: string, label: string, title: string) => `<button data-k="${k}" title="${title}">${label}</button>`;
    this.el.innerHTML = `
      <div class="tc-stick"><div class="tc-knob"></div></div>
      <div class="tc-btns">
        ${btn("e", "E", "Interact / board / survey")}${btn("f", "AUTO", "A* autopilot")}${btn("m", "MAP", "Mission map")}
        ${btn("v", "VISOR", "First person")}${btn("q", "SPEC", "Spectrometer")}${btn("r", "EV2", "Send buddy")}
        ${btn("]", "&raquo;", "Time warp up")}${btn("[", "&laquo;", "Time warp down")}${btn("escape", "&#10074;&#10074;", "Pause")}
      </div>`;
    root.appendChild(this.el);
    this.el.querySelectorAll<HTMLButtonElement>(".tc-btns button").forEach((b) => {
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); press(b.dataset.k!); });
    });
    const pad = this.el.querySelector<HTMLElement>(".tc-stick")!, knob = this.el.querySelector<HTMLElement>(".tc-knob")!;
    let id = -1;
    const move = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.stick = { fwd: Math.abs(dy) > 0.18 ? -dy : 0, right: Math.abs(dx) > 0.18 ? dx : 0 };
      knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
    };
    pad.addEventListener("pointerdown", (e) => { e.stopPropagation(); id = e.pointerId; pad.setPointerCapture(id); move(e); });
    pad.addEventListener("pointermove", (e) => { if (e.pointerId === id) move(e); });
    const end = (e: PointerEvent) => { if (e.pointerId !== id) return; id = -1; this.stick = { fwd: 0, right: 0 }; knob.style.transform = ""; };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);
  }

  set visible(v: boolean) { this.el.hidden = !v || !isTouch(); }
}
