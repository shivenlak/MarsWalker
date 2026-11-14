// Mode B - HUD: first-person visor overlay for following the planned route.
// MVP: compass tape, next-stop bearing/distance, slope-ahead light, simulate-walk.

import { WALKING } from "../core/config";
import { bearingDeg, positionAt, slopeAhead } from "../core/nav";
import { lonLatToXY } from "../core/grid";
import { fmtDist, fmtDur } from "../shared/format";
import { emit, store, subscribe } from "../shared/store";

let canvas: HTMLCanvasElement;
let raf = 0;
let lastT = 0;
let speed = 120; // simulated seconds per real second

export function initHud(root: HTMLElement) {
  root.innerHTML = `
    <img id="hud-bg" alt="">
    <div class="visor"></div>
    <canvas id="compass" width="720" height="70"></canvas>
    <div class="hud-panel hud-left">
      <div class="hud-label">SLOPE AHEAD (30 m)</div>
      <div id="hud-slope" class="slope-light"></div>
      <div class="hud-label">WALKED</div><div id="hud-walked" class="hud-big"></div>
      <div class="hud-label">EVA WALK TIME</div><div id="hud-time" class="hud-big"></div>
    </div>
    <div class="hud-panel hud-right">
      <div class="hud-label">NEXT</div><div id="hud-next" class="hud-big"></div>
      <div class="hud-label">ROUTE DISTANCE</div><div id="hud-dist" class="hud-big"></div>
      <div class="hud-label">BEARING</div><div id="hud-brg" class="hud-big"></div>
      <div id="hud-look" class="hud-look"></div>
    </div>
    <div class="hud-controls">
      <button id="hud-play">&#9654; Simulate walk</button>
      <select id="hud-speed">
        <option value="60">x60</option><option value="120" selected>x120</option><option value="300">x300</option>
      </select>
      <button id="hud-reset">Reset</button>
      <span class="hud-note">Simulated position (no GPS). Image: Curiosity Navcam at the next stop.</span>
    </div>`;
  canvas = root.querySelector("#compass")!;
  root.querySelector<HTMLButtonElement>("#hud-play")!.onclick = toggle;
  root.querySelector<HTMLButtonElement>("#hud-reset")!.onclick = () => {
    stop(); store.sim.evaS = 0; update(); emit();
  };
  root.querySelector<HTMLSelectElement>("#hud-speed")!.onchange = (e) => {
    speed = +(e.target as HTMLSelectElement).value;
  };
  subscribe(render);
  update();
}

function toggle() {
  if (store.sim.running) stop(); else start();
}

function start() {
  if (!store.route) return;
  if (store.sim.evaS >= store.route.totals.walkS) store.sim.evaS = 0;
  store.sim.running = true;
  lastT = performance.now();
  raf = requestAnimationFrame(tick);
  render();
}

function stop() {
  store.sim.running = false;
  cancelAnimationFrame(raf);
  render();
}

function tick(now: number) {
  const dt = (now - lastT) / 1000;
  lastT = now;
  store.sim.evaS += dt * speed;
  update();
  emit(); // planner moves its marker too
  if (store.route && store.sim.evaS >= store.route.totals.walkS) { stop(); return; }
  if (store.sim.running) raf = requestAnimationFrame(tick);
}

/** Recompute sim position/heading from evaS. */
function update() {
  const r = store.route;
  if (!r) return;
  const nav = positionAt(r, store.sim.evaS);
  store.sim.pos = nav.pos;
  store.sim.headingDeg = nav.headingDeg;
}

function render() {
  const r = store.route;
  const $ = (id: string) => document.getElementById(id)!;
  ($("hud-play") as HTMLButtonElement).innerHTML = store.sim.running ? "&#10074;&#10074; Pause" : "&#9654; Simulate walk";
  if (!r || !store.sim.pos) { $("hud-next").textContent = "No route planned"; return; }

  const nav = positionAt(r, store.sim.evaS);
  const leg = r.legs[nav.legIndex];
  const next = store.stops.find((s) => s.id === leg.toId)!;
  const brg = bearingDeg(nav.pos, lonLatToXY(next));
  const remaining = r.points[leg.endIndex].cumDistM - nav.pos.cumDistM;

  $("hud-next").textContent = nav.done ? "EVA complete - at base" : next.name;
  $("hud-dist").textContent = fmtDist(Math.max(0, remaining));
  $("hud-brg").textContent = `${brg.toFixed(0).padStart(3, "0")}°`;
  $("hud-look").textContent = next.lookFor ? `Look for: ${next.lookFor}` : "";
  $("hud-walked").textContent = fmtDist(nav.pos.cumDistM);
  $("hud-time").textContent = `${fmtDur(store.sim.evaS)} / ${fmtDur(r.totals.walkS)}`;

  const s = slopeAhead(r, store.sim.evaS);
  const max = WALKING.maxSlopeDeg.value;
  const light = $("hud-slope");
  light.className = "slope-light " + (s < 0.6 * max ? "ok" : s < 0.85 * max ? "caution" : "danger");
  light.textContent = `${s.toFixed(0)}°`;

  const img = next.images[0]?.file;
  const bg = $("hud-bg") as HTMLImageElement;
  if (img && !bg.src.endsWith(img)) bg.src = img;

  drawCompass(nav.headingDeg, brg);
}

function drawCompass(heading: number, target: number) {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height, pxPerDeg = W / 120; // show +/- 60 deg
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,20,30,0.45)";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = ctx.fillStyle = "#7ff";
  ctx.font = "14px ui-monospace, monospace";
  ctx.textAlign = "center";
  const labels: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
  for (let d = Math.floor(heading - 60); d <= heading + 60; d++) {
    const dd = ((d % 360) + 360) % 360;
    if (dd % 5) continue;
    const x = W / 2 + (d - heading) * pxPerDeg;
    const major = dd % 15 === 0;
    ctx.beginPath(); ctx.moveTo(x, H - 4); ctx.lineTo(x, H - (major ? 22 : 12)); ctx.stroke();
    if (labels[dd] || dd % 30 === 0) ctx.fillText(labels[dd] ?? String(dd), x, H - 30);
  }
  // target bearing marker
  let rel = ((target - heading + 540) % 360) - 180;
  const clamped = Math.max(-60, Math.min(60, rel));
  const tx = W / 2 + clamped * pxPerDeg;
  ctx.fillStyle = Math.abs(rel) > 60 ? "#fa0" : "#0f8";
  ctx.beginPath(); ctx.moveTo(tx, 4); ctx.lineTo(tx - 8, 16); ctx.lineTo(tx + 8, 16); ctx.fill();
  // heading caret
  ctx.fillStyle = "#fff";
  ctx.fillText(`${heading.toFixed(0).padStart(3, "0")}°`, W / 2, 18);
  ctx.beginPath(); ctx.moveTo(W / 2, H - 2); ctx.lineTo(W / 2 - 6, H - 12); ctx.lineTo(W / 2 + 6, H - 12); ctx.fill();
}

export function onShowHud() {
  update();
  render();
}

export function onHideHud() {
  stop();
}
