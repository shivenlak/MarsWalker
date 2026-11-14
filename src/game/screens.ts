// Full-screen game UI: loading, title, science survey panel, and the post-EVA debrief.

import { EVA } from "../core/config";
import type { StopInfo } from "../shared/data";
import { fmtDist, fmtDur } from "../shared/format";

export class Screens {
  readonly el: HTMLDivElement;
  private q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
  onPlan: (() => void) | null = null;
  onQuick: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "screens";
    this.el.innerHTML = `
      <div class="scr loading on">
        <div class="logo">MARSWALK</div>
        <div class="sub">Loading Gale Crater from the HiRISE 1 m terrain model…</div>
        <div class="lbar"><i></i></div>
        <div class="lmsg"></div>
      </div>
      <div class="scr title">
        <div class="t-top">
          <div class="logo">MARSWALK</div>
          <div class="sub">A walkable EVA on lower Mount Sharp, Gale Crater</div>
          <div class="sub2"></div>
        </div>
        <div class="t-menu">
          <button class="btn big" data-act="plan">PLAN EVA</button>
          <button class="btn" data-act="quick">QUICK START</button>
        </div>
        <div class="t-foot">Every metre of ground is real: USGS 1 m HiRISE terrain · HiRISE colour · HRSC-MOLA Mount Sharp ·
          Curiosity traverse, Navcam images and REMS weather. NASA Space Apps 2026.</div>
      </div>
      <div class="scr survey">
        <div class="sv-card">
          <div class="sv-head"><span class="sv-n"></span><h2></h2><button class="sv-x" title="Leave (Esc)">&times;</button></div>
          <div class="sv-body">
            <div class="sv-gallery"><img class="sv-main"><div class="sv-thumbs"></div><div class="src sv-cap"></div></div>
            <div class="sv-text"></div>
          </div>
          <div class="sv-tasks"></div>
        </div>
      </div>
      <div class="scr debrief">
        <div class="db-card"></div>
      </div>
      <div class="lightbox"><img></div>`;
    root.appendChild(this.el);
    this.el.querySelector<HTMLButtonElement>("[data-act=plan]")!.onclick = () => this.onPlan?.();
    this.el.querySelector<HTMLButtonElement>("[data-act=quick]")!.onclick = () => this.onQuick?.();
    const lb = this.q<HTMLElement>(".lightbox");
    lb.onclick = () => lb.classList.remove("on");
  }

  private only(name: string | null) {
    this.el.querySelectorAll(".scr").forEach((s) => s.classList.toggle("on", !!name && s.classList.contains(name)));
  }

  progress(f: number, msg: string) {
    this.q<HTMLElement>(".lbar i").style.width = `${(f * 100).toFixed(0)}%`;
    this.q(".lmsg").textContent = msg;
  }

  title(sub2: string) { this.q(".title .sub2").innerHTML = sub2; this.only("title"); }
  hideAll() { this.only(null); }
  get surveyOpen() { return this.q(".survey").classList.contains("on"); }

  // ---------- survey ----------
  /** tasks: done flags. onTask(i) starts task i (the game runs its clock). */
  survey(stop: StopInfo, n: string, tasks: { label: string; min: number; done: boolean; running: boolean; progress: number }[],
    onTask: (i: number) => void, onLeave: () => void) {
    const first = !this.surveyOpen;
    this.only("survey");
    if (first) {
      this.q(".sv-n").textContent = n;
      this.q(".sv-head h2").textContent = stop.name;
      this.q(".sv-text").innerHTML = `
        <p><b>What:</b> ${stop.what}</p><p><b>Why it matters:</b> ${stop.why}</p>
        <p class="look"><b>Look for:</b> ${stop.lookFor}</p>
        <p class="src"><b>Evidence:</b> ${stop.evidence}<br>Position: ${stop.waypoint}, elev ${stop.elev.toFixed(0)} m</p>`;
      const main = this.q<HTMLImageElement>(".sv-main");
      const cap = this.q(".sv-cap");
      const pick = (i: number) => {
        const im = stop.images[i];
        if (!im) return;
        main.src = im.file;
        cap.textContent = `${im.instrument}, sol ${im.sol}. ${im.credit}`;
      };
      this.q(".sv-thumbs").innerHTML = stop.images.map((im, i) => `<img src="${im.file}" data-i="${i}">`).join("");
      this.el.querySelectorAll<HTMLImageElement>(".sv-thumbs img").forEach((t) => (t.onclick = () => pick(+t.dataset.i!)));
      main.onclick = () => { const lb = this.q<HTMLElement>(".lightbox"); lb.querySelector("img")!.src = main.src; lb.classList.add("on"); };
      pick(0);
      this.q<HTMLButtonElement>(".sv-x").onclick = onLeave;
    }
    const busy = tasks.some((t) => t.running);
    this.q(".sv-tasks").innerHTML = tasks.map((t, i) => `
      <button class="task ${t.done ? "done" : ""} ${t.running ? "running" : ""}" data-i="${i}" ${t.done || busy ? "disabled" : ""}>
        <i style="width:${(t.progress * 100).toFixed(0)}%"></i>
        <span>${t.done ? "&#10003; " : ""}${t.label}</span><small>${t.min} min</small>
      </button>`).join("") +
      `<button class="task leave" ${busy ? "disabled" : ""}>${tasks.every((t) => t.done) ? "Continue EVA &rarr;" : "Leave site"}</button>`;
    this.el.querySelectorAll<HTMLButtonElement>(".sv-tasks .task[data-i]").forEach((b) => (b.onclick = () => onTask(+b.dataset.i!)));
    this.q<HTMLButtonElement>(".sv-tasks .leave").onclick = onLeave;
  }

  // ---------- debrief ----------
  debrief(d: {
    success: boolean; stopsDone: number; stopsTotal: number; distM: number; planDistM: number; evaS: number; planEvaS: number;
    climbM: number; doseMSv: number; remainingPct: number; reason: string;
  }, onAgain: () => void) {
    this.only("debrief");
    const row = (k: string, v: string, p = "") => `<tr><td>${k}</td><td>${v}</td><td class="src">${p}</td></tr>`;
    this.q(".db-card").innerHTML = `
      <div class="logo small">${d.success ? "EVA COMPLETE" : "EVA ENDED"}</div>
      <p class="sub">${d.reason}</p>
      <table class="db">
        <tr><th></th><th>Actual</th><th>Plan</th></tr>
        ${row("Science stops surveyed", `${d.stopsDone} / ${d.stopsTotal}`)}
        ${row("Distance walked", fmtDist(d.distM), fmtDist(d.planDistM))}
        ${row("EVA duration", fmtDur(d.evaS), fmtDur(d.planEvaS))}
        ${row("Climb", `+${d.climbM.toFixed(0)} m`)}
        ${row("Radiation dose", `${(d.doseMSv * 1000).toFixed(0)} µSv`, "0.64 mSv/sol, Hassler 2014")}
        ${row("Consumables left", `${d.remainingPct.toFixed(0)}%`)}
      </table>
      <p class="src">Plan = A* route + ${EVA.stopDwellMin.value} min per stop. Actual walking distance is measured on the 2 m terrain, which is why it can differ from the plan (computed on 10 m cells).</p>
      <button class="btn big again">NEW EVA</button>`;
    this.q<HTMLButtonElement>(".again").onclick = onAgain;
  }
}
