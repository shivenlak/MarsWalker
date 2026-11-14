// Game HUD (DOM + canvas): compass tape, mission objectives, clock, suit vitals with point-of-no-return,
// interaction prompt, toasts, and a rotating minimap (top-right) that expands into the full mission map.

import { SUIT, RADIATION } from "../core/config";
import type { ReturnCheck, SuitState } from "../core/suit";
import { fmtDist, fmtDur } from "../shared/format";

export interface Objective { id: string; label: string; done: boolean; active: boolean }

export interface HudFrame {
  headingDeg: number;
  markers: { bearing: number; label: string; kind: "next" | "stop" | "base" | "nav"; dist: number }[];
  objectives: Objective[];
  ltst: string; sol: number; ls: number; evaS: number;
  suit: SuitState; ret: ReturnCheck | null; tempC: number | null;
  speed: number; grade: number; slopeDeg: number; elev: number; warp: number;
  navDist: number | null; navTime: number | null; navName: string;
  autopilot: boolean; mode: "third" | "first";
  odometer: number;
  health: number; bagKg: number; bagN: number; bagMax: number;
  alerts: { text: string; level: "info" | "caution" | "danger" }[];
  vehicle: null | { speedKmh: number; battery: number; pitch: number; roll: number; slipping: boolean };
  overlay: string;
  modeLabel: string;
}

export interface MinimapData {
  x: number; z: number; heading: number; camYaw: number;
  plan: { x: number; z: number }[];
  nav: { x: number; z: number }[];
  home: { x: number; z: number }[];
  trail: { x: number; z: number }[];
  stops: { x: number; z: number; label: string; state: string }[];
  scan: { x: number; z: number } | null;
  pois: { x: number; z: number; kind: "landmark" | "landmark-found" | "buggy" | "hab" | "shelter" | "specimen" }[];
}

export class Hud {
  readonly el: HTMLDivElement;
  private compass: HTMLCanvasElement;
  private mini: HTMLCanvasElement;
  private overview = new Image();
  private q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
  private toastTimer = 0;
  miniScale = 1.2;   // m per minimap pixel
  northUp = false;
  onExpand: (() => void) | null = null;

  constructor(root: HTMLElement, overviewFile: string, private worldW: number, private worldD: number) {
    this.el = document.createElement("div");
    this.el.className = "ghud";
    this.el.innerHTML = `
      <div class="visor-frame"></div>
      <canvas class="g-compass" width="720" height="84"></canvas>
      <div class="g-panel g-mission">
        <div class="g-title">MISSION <span class="g-clock"></span></div>
        <ul class="g-obj"></ul>
      </div>
      <div class="g-mini-wrap">
        <canvas class="g-mini" width="440" height="440"></canvas>
        <div class="g-mini-ring"></div>
        <div class="g-mini-n">N</div>
        <div class="g-mini-btns">
          <button data-act="zin" title="Zoom in">+</button><button data-act="zout" title="Zoom out">&minus;</button>
          <button data-act="north" title="Toggle north-up">N&uarr;</button>
          <button data-act="expand" title="Open mission map (M)">MAP</button>
        </div>
        <div class="g-mini-info"></div>
      </div>
      <div class="g-panel g-vitals">
        <div class="g-title">SUIT</div>
        <div class="vbar"><label>HEALTH</label><div class="bar"><i class="b-hp"></i></div></div>
        <div class="vbar"><label>O&#8322; / H&#8322;O / PWR</label><div class="bar"><i class="b-cons"></i></div><span class="v-cons"></span></div>
        <div class="vrow"><label>RETURN MARGIN</label><span class="v-ret"></span></div>
        <div class="vrow"><label>DOSE</label><span class="v-dose"></span></div>
        <div class="vrow"><label>EXT TEMP</label><span class="v-temp"></span></div>
        <div class="vrow"><label>GRADE / SLOPE</label><span class="v-slope"></span></div>
        <div class="vrow"><label>PACE</label><span class="v-speed"></span></div>
        <div class="vrow"><label>SAMPLE BAG</label><span class="v-bag"></span></div>
      </div>
      <div class="g-panel g-vehicle"><div class="g-title">BUGGY</div>
        <div class="veh-speed"><b class="vs"></b><small>km/h</small></div>
        <div class="vbar"><label>BATTERY</label><div class="bar"><i class="b-batt"></i></div></div>
        <div class="vrow"><label>PITCH / ROLL</label><span class="v-att"></span></div>
      </div>
      <div class="g-alerts"></div>
      <div class="g-overlay"></div>
      <div class="g-nav"></div>
      <div class="g-prompt"></div>
      <div class="g-toast"></div>
      <div class="g-warn"></div>
      <div class="g-keys">
        <span><b>WASD</b> move</span><span><b>Shift</b> lope</span><span><b>Space</b> hop/brake</span>
        <span><b>E</b> interact</span><span><b>F</b> autopilot</span><span><b>V</b> view</span><span><b>G</b> grab/throw</span>
        <span><b>T</b> data layer</span><span><b>Q</b> scanner</span><span><b>L</b> lamps</span><span><b>B</b> shelter</span>
        <span><b>M</b> map</span><span><b>J</b> journal</span><span><b>[ ]</b> warp</span><span><b>Esc</b> menu</span>
      </div>`;
    root.appendChild(this.el);
    this.compass = this.q("canvas.g-compass");
    this.mini = this.q("canvas.g-mini");
    this.overview.src = overviewFile;
    this.el.querySelectorAll<HTMLButtonElement>(".g-mini-btns button").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = b.dataset.act;
        if (a === "zin") this.miniScale = Math.max(0.3, this.miniScale / 1.5);
        if (a === "zout") this.miniScale = Math.min(12, this.miniScale * 1.5);
        if (a === "north") this.northUp = !this.northUp;
        if (a === "expand") this.onExpand?.();
      };
    });
    this.q<HTMLCanvasElement>("canvas.g-mini").onclick = () => this.onExpand?.();
  }

  set visible(v: boolean) { this.el.hidden = !v; }

  setMode(mode: "third" | "first") { this.el.classList.toggle("visor", mode === "first"); }

  update(f: HudFrame) {
    this.drawCompass(f);
    // mission
    this.q(".g-clock").textContent = `SOL ${f.sol} · ${f.ltst} LTST · EVA ${fmtDur(f.evaS)}`;
    this.q(".g-obj").innerHTML = f.objectives.map((o) =>
      `<li class="${o.done ? "done" : o.active ? "active" : ""}"><i></i>${o.label}</li>`).join("");
    // vitals
    const frac = f.suit.remainingH / SUIT.capacityH.value;
    const bar = this.q<HTMLElement>(".b-cons");
    bar.style.width = `${(frac * 100).toFixed(1)}%`;
    bar.className = `b-cons ${frac < 0.15 ? "danger" : frac < 0.35 ? "caution" : ""}`;
    this.q(".v-cons").textContent = `${(frac * 100).toFixed(0)}% · ${fmtDur(f.suit.remainingH * 3600)}`;
    const ret = this.q<HTMLElement>(".v-ret");
    if (f.ret) {
      ret.textContent = f.ret.marginH >= 0 ? `+${fmtDur(f.ret.marginH * 3600)}` : `${fmtDur(-f.ret.marginH * 3600)} SHORT`;
      ret.className = `v-ret ${f.ret.status}`;
    } else ret.textContent = "--";
    this.q(".v-dose").textContent = `${(f.suit.doseMSv * 1000).toFixed(0)} µSv (${RADIATION.surfaceDoseMSvPerDay.value} mSv/sol)`;
    this.q(".v-temp").textContent = f.tempC == null ? "--" : `${f.tempC.toFixed(0)} °C`;
    const sl = this.q<HTMLElement>(".v-slope");
    sl.textContent = `${(f.grade * 100).toFixed(0)}% · ${f.slopeDeg.toFixed(0)}°`;
    sl.className = `v-slope ${f.slopeDeg > 25 ? "danger" : f.slopeDeg > 15 ? "caution" : ""}`;
    this.q(".v-speed").textContent = `${(f.speed * 3.6).toFixed(1)} km/h · ×${f.warp}`;
    const hp = this.q<HTMLElement>(".b-hp");
    hp.style.width = `${f.health.toFixed(0)}%`;
    hp.className = `b-hp ${f.health < 30 ? "danger" : f.health < 60 ? "caution" : ""}`;
    this.q(".v-bag").textContent = `${f.bagN} · ${f.bagKg.toFixed(1)} / ${f.bagMax} kg`;
    const veh = this.q<HTMLElement>(".g-vehicle");
    veh.hidden = !f.vehicle;
    if (f.vehicle) {
      this.q(".vs").textContent = f.vehicle.speedKmh.toFixed(1);
      const b = this.q<HTMLElement>(".b-batt");
      b.style.width = `${(f.vehicle.battery * 100).toFixed(0)}%`;
      b.className = `b-batt ${f.vehicle.battery < 0.15 ? "danger" : ""}`;
      const att = this.q<HTMLElement>(".v-att");
      att.textContent = `${f.vehicle.pitch.toFixed(0)}° / ${f.vehicle.roll.toFixed(0)}°${f.vehicle.slipping ? " · SLIP" : ""}`;
      att.className = `v-att ${Math.max(Math.abs(f.vehicle.pitch), Math.abs(f.vehicle.roll)) > 25 || f.vehicle.slipping ? "danger" : ""}`;
    }
    const al = this.q(".g-alerts");
    const html = f.alerts.map((a) => `<div class="al ${a.level}">${a.text}</div>`).join("");
    if (al.innerHTML !== html) al.innerHTML = html;
    const ov = this.q(".g-overlay");
    if (ov.innerHTML !== f.overlay) ov.innerHTML = f.overlay;
    const ttl = this.q(".g-mission .g-title");
    if (!ttl.textContent?.startsWith(f.modeLabel)) ttl.firstChild!.textContent = f.modeLabel + " ";
    // nav
    this.q(".g-nav").innerHTML = f.navDist == null ? "" :
      `<div class="nn">${f.navName}</div><div class="nd">${fmtDist(f.navDist)} <small>· ${fmtDur(f.navTime ?? 0)} walk</small></div>
       ${f.autopilot ? `<div class="ap">AUTOPILOT</div>` : ""}`;
  }

  prompt(html: string) {
    const p = this.q<HTMLElement>(".g-prompt");
    if (p.innerHTML !== html) p.innerHTML = html;
    p.classList.toggle("on", !!html);
  }

  warn(text: string) {
    const w = this.q<HTMLElement>(".g-warn");
    if (w.textContent !== text) w.textContent = text;
    w.classList.toggle("on", !!text);
  }

  toast(html: string, ms = 3500) {
    const t = this.q<HTMLElement>(".g-toast");
    t.innerHTML = html;
    t.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove("on"), ms);
  }

  private drawCompass(f: HudFrame) {
    const c = this.compass, g = c.getContext("2d")!;
    const W = c.width, span = 120;
    g.clearRect(0, 0, W, c.height);
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "rgba(0,20,28,0)"); grad.addColorStop(0.15, "rgba(0,20,28,0.55)");
    grad.addColorStop(0.85, "rgba(0,20,28,0.55)"); grad.addColorStop(1, "rgba(0,20,28,0)");
    g.fillStyle = grad;
    g.fillRect(0, 22, W, 34);
    const px = (b: number) => {
      let d = b - f.headingDeg;
      d = ((d + 540) % 360) - 180;
      return W / 2 + (d / span) * W;
    };
    g.font = "600 15px Rajdhani, sans-serif";
    g.textAlign = "center";
    for (let b = 0; b < 360; b += 5) {
      const x = px(b);
      if (x < 0 || x > W) continue;
      const fade = 1 - Math.abs(x - W / 2) / (W / 2);
      g.globalAlpha = Math.max(0.15, fade);
      g.strokeStyle = "#bff";
      g.beginPath();
      g.moveTo(x, 22);
      g.lineTo(x, b % 15 === 0 ? 34 : 28);
      g.stroke();
      if (b % 45 === 0) {
        g.fillStyle = b % 90 === 0 ? "#ff9d00" : "#cff";
        g.fillText(["N", "NE", "E", "SE", "S", "SW", "W", "NW"][b / 45], x, 51);
      } else if (b % 15 === 0) {
        g.fillStyle = "#9cc";
        g.font = "500 12px Rajdhani, sans-serif";
        g.fillText(String(b), x, 50);
        g.font = "600 15px Rajdhani, sans-serif";
      }
    }
    g.globalAlpha = 1;
    for (const m of f.markers) {
      let x = px(m.bearing);
      const off = x < 10 || x > W - 10;
      x = Math.min(Math.max(x, 10), W - 10);
      const col = m.kind === "next" || m.kind === "nav" ? "#00e5ff" : m.kind === "base" ? "#7ff" : "#ff9d00";
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x, 58); g.lineTo(x - 6, 68); g.lineTo(x + 6, 68);
      g.fill();
      if (!off && (m.kind === "next" || m.kind === "nav")) {
        g.font = "600 12px Rajdhani, sans-serif";
        g.fillText(m.label, x, 82);
      }
    }
    g.fillStyle = "#fff";
    g.fillRect(W / 2 - 1, 18, 2, 40);
    g.fillStyle = "rgba(0,20,28,0.8)";
    g.fillRect(W / 2 - 30, 0, 60, 19);
    g.fillStyle = "#fff";
    g.font = "700 14px Orbitron, sans-serif";
    g.fillText(`${String(Math.round(f.headingDeg) % 360).padStart(3, "0")}°`, W / 2, 15);
  }

  /** Minimap: overview image under the player, rotated heading-up (or north-up). */
  drawMinimap(d: MinimapData) {
    const c = this.mini, g = c.getContext("2d")!;
    const S = c.width, R = S / 2;
    const k = 1 / this.miniScale; // px per metre
    const rot = this.northUp ? 0 : -d.camYaw;
    g.save();
    g.clearRect(0, 0, S, S);
    g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = "#1a0f0a"; g.fillRect(0, 0, S, S);
    g.translate(R, R);
    g.rotate(rot);
    g.scale(k, k);
    g.translate(-d.x, -d.z);
    if (this.overview.complete) {
      g.globalAlpha = 0.95;
      g.drawImage(this.overview, 0, 0, this.worldW, this.worldD);
      g.globalAlpha = 1;
    }
    const line = (pts: { x: number; z: number }[], col: string, w: number, dash: number[] = []) => {
      if (pts.length < 2) return;
      g.strokeStyle = col; g.lineWidth = w / k; g.setLineDash(dash.map((v) => v / k));
      g.beginPath(); g.moveTo(pts[0].x, pts[0].z);
      for (const p of pts) g.lineTo(p.x, p.z);
      g.stroke(); g.setLineDash([]);
    };
    line(d.plan, "rgba(255,157,0,0.55)", 3, [6, 5]);
    line(d.trail, "rgba(255,255,255,0.8)", 2.5);
    line(d.home, "rgba(255,90,60,0.9)", 2.5, [4, 4]);
    line(d.nav, "rgba(0,0,0,0.6)", 7);
    line(d.nav, "#00e5ff", 4);
    for (const s of d.stops) {
      g.save();
      g.translate(s.x, s.z);
      g.rotate(-rot);
      g.scale(1 / k, 1 / k);
      g.fillStyle = s.state === "done" ? "#2ea043" : s.state === "base" ? "#00e5ff" : "#ff9d00";
      g.strokeStyle = "#fff"; g.lineWidth = 2;
      g.beginPath(); g.arc(0, 0, 11, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = "#000"; g.font = "700 13px Rajdhani, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(s.label, 0, 1);
      g.restore();
    }
    for (const p of d.pois) {
      g.save();
      g.translate(p.x, p.z);
      g.rotate(-rot);
      g.scale(1 / k, 1 / k);
      if (p.kind === "buggy") { g.fillStyle = "#ffd27a"; g.fillRect(-7, -5, 14, 10); g.strokeStyle = "#000"; g.strokeRect(-7, -5, 14, 10); }
      else if (p.kind === "hab") { g.fillStyle = "#e6e1d6"; g.beginPath(); g.arc(0, 0, 8, 0, Math.PI * 2); g.fill(); g.fillStyle = "#00e5ff"; g.fillRect(-2, -2, 4, 4); }
      else if (p.kind === "shelter") { g.fillStyle = "#ff8a3d"; g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2); g.fill(); }
      else if (p.kind === "specimen") { g.strokeStyle = "#ffe066"; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 5, 0, Math.PI * 2); g.stroke(); }
      else { g.fillStyle = p.kind === "landmark-found" ? "#fff" : "rgba(255,210,122,0.9)"; g.beginPath(); g.moveTo(0, -6); g.lineTo(5, 0); g.lineTo(0, 6); g.lineTo(-5, 0); g.fill(); }
      g.restore();
    }
    if (d.scan) {
      g.strokeStyle = "#7ff6ff"; g.lineWidth = 2 / k;
      g.beginPath(); g.arc(d.scan.x, d.scan.z, 7 / k, 0, Math.PI * 2); g.stroke();
    }
    // player + view cone
    g.translate(d.x, d.z);
    g.rotate(d.camYaw);
    g.scale(1 / k, 1 / k);
    const cone = g.createRadialGradient(0, 0, 0, 0, 0, 90);
    cone.addColorStop(0, "rgba(127,255,255,0.35)"); cone.addColorStop(1, "rgba(127,255,255,0)");
    g.fillStyle = cone;
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 90, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); g.closePath(); g.fill();
    g.rotate(d.heading - d.camYaw);
    g.fillStyle = "#fff"; g.strokeStyle = "#003"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -14); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath();
    g.fill(); g.stroke();
    g.restore();
    // north indicator
    const n = this.q<HTMLElement>(".g-mini-n");
    const a = rot;
    n.style.transform = `translate(${Math.sin(a) * (R - 16) / 2}px, ${-Math.cos(a) * (R - 16) / 2}px)`;
    this.q(".g-mini-info").textContent = `${(this.miniScale * 100).toFixed(0)} m / 100 px`;
  }
}
