// Mission map (Planner): full-screen Leaflet map over the game. Used as the pre-EVA briefing and as the
// expanded minimap mid-EVA. Layer stack, stop selection -> live A* replan + EVA budget, clickable legs with
// elevation profiles, click-anywhere terrain readout with "navigate here", live player/trail/nav overlays.

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { EVA, SUIT, WALKING } from "../core/config";
import { blockReason } from "../core/cost";
import { lonLatToXY, xyToIdx } from "../core/grid";
import { planRoute, type Leg, type Route } from "../core/route";
import { fmtClock, MARS_HOUR_S } from "../core/sun";
import type { Overlays, StopInfo } from "../shared/data";
import { loadOverlays, loadTraverse } from "../shared/data";
import { fmtDist, fmtDur, sourceTag } from "../shared/format";
import { setRoute, store } from "../shared/store";

export interface LL { lon: number; lat: number }

export interface BriefingInfo {
  sol: number; ls: number; dateText: string;
  sunrise: string; sunset: string;
  weather: string; weatherSource: string;
  spaceWx: { level: string; text: string };
}

interface ThemisMeta { bounds: Overlays["bounds"]; width: number; height: number; dn: number[] }

export class MissionMap {
  readonly el: HTMLDivElement;
  private map!: L.Map;
  private routeLayer = L.layerGroup();
  private liveLayer = L.layerGroup();
  private player = L.marker([0, 0], { icon: L.divIcon({ className: "map-player", html: "<i></i>", iconSize: [26, 26] }) });
  private included = new Set<string>();
  private themis: ThemisMeta | null = null;
  private selectedLeg = -1;
  private bounds: L.LatLngBoundsExpression = [[0, 0], [0, 0]];
  private fitted = false;
  mode: "briefing" | "map" = "briefing";
  startHour = 9;

  onNavigate: ((p: LL, label: string) => void) | null = null;
  onBegin: (() => void) | null = null;
  onClose: (() => void) | null = null;
  onPlanChange: ((r: Route | null) => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "mission-map";
    this.el.hidden = true;
    this.el.innerHTML = `
      <aside class="mm-side">
        <div class="mm-head">
          <h2 class="mm-title">EVA PLANNER</h2>
          <button class="mm-close" title="Back to EVA (M / Esc)">&times;</button>
        </div>
        <section class="mm-brief"></section>
        <section><h3>Science stops</h3><div class="mm-stops"></div>
          <p class="note">Crew: ${WALKING.name}. Router limits: slope ${WALKING.maxSlopeDeg.value}&deg; ${sourceTag(WALKING.maxSlopeDeg)},
          roughness ${WALKING.maxRoughM.value} m ${sourceTag(WALKING.maxRoughM)}.</p></section>
        <section><h3>EVA budget</h3><div class="mm-budget"></div></section>
        <section class="mm-detail-wrap"><h3>Selection</h3><div class="mm-detail"><p class="note">Click a route leg, a stop, or any point on the map.</p></div></section>
        <section><h3>Layers</h3><div class="mm-layers"></div></section>
        <div class="mm-begin"></div>
      </aside>
      <div class="mm-map"></div>`;
    root.appendChild(this.el);
    this.el.querySelector<HTMLButtonElement>(".mm-close")!.onclick = () => this.onClose?.();
  }

  async init() {
    const ov = await loadOverlays();
    this.themis = await (await fetch("overlays/themis.json")).json();
    const b = ov.bounds;
    this.bounds = [[b.south, b.west], [b.north, b.east]];
    this.map = L.map(this.el.querySelector<HTMLElement>(".mm-map")!, { minZoom: 12, maxZoom: 19, zoomSnap: 0.25 })
      .fitBounds([[b.south, b.west], [b.north, b.east]]);
    L.tileLayer("tiles/hirise/{z}/{x}/{y}.jpg", {
      minZoom: 12, maxZoom: 19, maxNativeZoom: 17, attribution: "HiRISE: NASA/JPL-Caltech/UArizona via NASA MMGIS",
    }).addTo(this.map);
    const layers = await this.buildLayers(ov);
    this.renderLayerPanel(layers);
    this.routeLayer.addTo(this.map);
    this.liveLayer.addTo(this.map);
    this.renderStopList();
    this.map.on("click", (e: L.LeafletMouseEvent) => this.readout(e.latlng));
    this.replan();
  }

  show(mode: "briefing" | "map", info?: BriefingInfo) {
    this.mode = mode;
    this.el.hidden = false;
    this.el.classList.toggle("briefing", mode === "briefing");
    this.el.querySelector(".mm-title")!.textContent = mode === "briefing" ? "MISSION BRIEFING" : "MISSION MAP";
    this.el.querySelector<HTMLElement>(".mm-close")!.hidden = mode === "briefing";
    if (info) this.renderBrief(info);
    this.el.querySelector<HTMLElement>(".mm-brief")!.hidden = mode !== "briefing";
    this.renderBegin();
    setTimeout(() => {
      this.map.invalidateSize();
      if (!this.fitted) { this.map.fitBounds(this.bounds); this.fitted = true; }
    }, 0);
  }
  hide() { this.el.hidden = true; }
  get open() { return !this.el.hidden; }

  // ---------- live overlays from the game ----------
  setLive(p: LL & { headingDeg: number }, trail: LL[], nav: LL[], home: LL[]) {
    if (this.el.hidden) return;
    this.liveLayer.clearLayers();
    const ll = (a: LL[]) => a.map((q) => [q.lat, q.lon] as [number, number]);
    if (home.length > 1) L.polyline(ll(home), { color: "#ff5a3c", weight: 3, dashArray: "6 6" }).addTo(this.liveLayer);
    if (trail.length > 1) L.polyline(ll(trail), { color: "#fff", weight: 3, opacity: 0.9 }).addTo(this.liveLayer);
    if (nav.length > 1) L.polyline(ll(nav), { color: "#00e5ff", weight: 5, opacity: 0.95 }).addTo(this.liveLayer);
    this.player.setLatLng([p.lat, p.lon]).addTo(this.liveLayer);
    const el = this.player.getElement()?.querySelector("i") as HTMLElement | null;
    if (el) el.style.transform = `rotate(${p.headingDeg}deg)`;
  }

  centerOn(p: LL) { this.map.setView([p.lat, p.lon], Math.max(this.map.getZoom(), 16)); }

  // ---------- layers ----------
  private async buildLayers(ov: Overlays) {
    const bb = (b: Overlays["bounds"]): L.LatLngBoundsExpression => [[b.south, b.west], [b.north, b.east]];
    const traverse = L.geoJSON(await loadTraverse(), { style: { color: "#ffd27a", weight: 2, dashArray: "4 4", opacity: 0.8 } });
    const pins = L.layerGroup(store.stops.map((s) => this.stopMarker(s)));
    return [
      { name: "Science stops", layer: pins as L.Layer, on: true, opacity: 1, source: "Positions from Curiosity waypoints at the cited sol" },
      { name: "Curiosity's real traverse", layer: traverse as L.Layer, on: true, opacity: 1, source: "NASA/JPL-Caltech MSL traverse (MMGIS)" },
      { name: "Slope", layer: L.imageOverlay(ov.slope.file, bb(ov.bounds)) as L.Layer, on: false, opacity: 0.55,
        source: ov.slope.source, legend: "green <10&deg; · yellow 10-20&deg; · red 20-30&deg; · dark >30&deg;" },
      { name: "Elevation (hillshade)", layer: L.imageOverlay(ov.hillshade.file, bb(ov.bounds)) as L.Layer, on: false, opacity: 0.6,
        source: ov.hillshade.source, legend: `${ov.hillshade.elevMin.toFixed(0)} m (blue) to ${ov.hillshade.elevMax.toFixed(0)} m (tan)` },
      { name: "Thermal (THEMIS day IR)", layer: L.imageOverlay(ov.themis.file, bb(ov.themis.bounds)) as L.Layer, on: false, opacity: 0.5,
        source: ov.themis.source, legend: "blue = cooler by day, orange = warmer (relative, ~81 m/px)" },
    ];
  }

  private renderLayerPanel(defs: { name: string; layer: L.Layer; on: boolean; opacity: number; source: string; legend?: string }[]) {
    const el = this.el.querySelector(".mm-layers")!;
    for (const d of defs) {
      const row = document.createElement("div");
      row.className = "layer-row";
      const hasOpacity = "setOpacity" in d.layer;
      row.innerHTML = `<label><input type="checkbox" ${d.on ? "checked" : ""}> ${d.name}</label>
        ${hasOpacity ? `<input type="range" min="0" max="1" step="0.05" value="${d.opacity}">` : ""}
        <div class="src">${d.legend ? d.legend + "<br>" : ""}${d.source}</div>`;
      const cb = row.querySelector<HTMLInputElement>("input[type=checkbox]")!;
      const sl = row.querySelector<HTMLInputElement>("input[type=range]");
      const apply = () => {
        if (cb.checked) d.layer.addTo(this.map); else d.layer.remove();
        if (sl) (d.layer as L.ImageOverlay).setOpacity(+sl.value);
      };
      cb.onchange = apply;
      if (sl) sl.oninput = apply;
      apply();
      el.appendChild(row);
    }
  }

  // ---------- stops + plan ----------
  private stopMarker(s: StopInfo): L.Marker {
    const n = store.stops.indexOf(s);
    const icon = L.divIcon({ className: `pin pin-${s.kind}`, html: s.kind === "base" ? "&#8962;" : String(n), iconSize: [28, 28] });
    const mk = L.marker([s.lat, s.lon], { icon });
    mk.on("click", (e) => { L.DomEvent.stopPropagation(e); this.showStop(s); });
    return mk;
  }

  private showStop(s: StopInfo) {
    const imgs = s.images.slice(0, 3).map((i) => `<img src="${i.file}" title="${i.instrument} sol ${i.sol}">`).join("");
    this.detail(`
      <div class="card"><h4>${s.name}</h4>
        <p><b>What:</b> ${s.what}</p><p><b>Why it matters:</b> ${s.why}</p><p><b>Look for:</b> ${s.lookFor}</p>
        <div class="thumbs">${imgs}</div>
        <p class="src"><b>Evidence:</b> ${s.evidence}<br>Position: ${s.waypoint}, elev ${s.elev.toFixed(0)} m. ${s.images[0]?.credit ?? ""}</p>
        ${this.mode === "map" ? `<button class="btn nav-btn">Navigate here</button>` : ""}
      </div>`, () => this.onNavigate?.(s, s.name.split(" - ")[0]));
  }

  private renderStopList() {
    const el = this.el.querySelector(".mm-stops")!;
    const science = store.stops.filter((s) => s.kind === "science");
    science.forEach((s) => this.included.add(s.id));
    el.innerHTML = science.map((s) => `
      <label class="stop-row"><input type="checkbox" data-id="${s.id}" checked>
        <span class="pin-inline">${store.stops.indexOf(s)}</span> ${s.name}</label>`).join("");
    el.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.onchange = () => { cb.checked ? this.included.add(cb.dataset.id!) : this.included.delete(cb.dataset.id!); this.replan(); };
    });
  }

  private replan() {
    const base = store.stops.find((s) => s.kind === "base")!;
    const targets = store.stops.filter((s) => s.kind === "science" && this.included.has(s.id));
    const r = targets.length ? planRoute(store.grid!, base, targets, WALKING) : null;
    setRoute(r);
    this.drawRoute(r);
    this.renderBudget(r);
    this.renderBegin();
    this.onPlanChange?.(r);
  }

  private drawRoute(r: Route | null) {
    this.routeLayer.clearLayers();
    if (!r) return;
    r.legs.forEach((leg, i) => {
      const ll = r.points.slice(leg.startIndex, leg.endIndex + 1).map((p) => [p.lat, p.lon] as [number, number]);
      L.polyline(ll, { color: "#000", weight: 9, opacity: 0.45 }).addTo(this.routeLayer);
      const line = L.polyline(ll, { color: i === this.selectedLeg ? "#fff" : "#ff9d00", weight: 5, opacity: 0.95 }).addTo(this.routeLayer);
      line.on("click", (e) => { L.DomEvent.stopPropagation(e); this.selectedLeg = i; this.drawRoute(r); this.showLeg(r, leg, i); });
      line.on("mouseover", () => line.setStyle({ weight: 8 }));
      line.on("mouseout", () => line.setStyle({ weight: 5 }));
    });
  }

  private stopName(id: string) { return store.stops.find((s) => s.id === id)?.name.split(" - ")[0] ?? id; }

  private showLeg(r: Route, leg: Leg, i: number) {
    const pts = r.points.slice(leg.startIndex, leg.endIndex + 1);
    const maxSlope = Math.max(...pts.map((p) => p.slope));
    const steep = pts.filter((p) => p.slope > 15).length / pts.length;
    const elevs = pts.map((p) => p.elev);
    const d0 = pts[0].cumDistM;
    this.detail(`
      <div class="card"><h4>Leg ${i + 1}: ${this.stopName(leg.fromId)} &rarr; ${this.stopName(leg.toId)}</h4>
        <div class="kpis small">
          <div><span>${fmtDist(leg.distM)}</span>distance</div>
          <div><span>${fmtDur(leg.walkS)}</span>walking</div>
          <div><span>+${leg.climbM.toFixed(0)} / -${leg.descentM.toFixed(0)} m</span>climb / descent</div>
          <div><span>${maxSlope.toFixed(0)}&deg;</span>steepest cell (p90)</div>
        </div>
        <canvas class="profile" width="600" height="150"></canvas>
        <p class="src">Elevation profile along the A* path (10 m cells, DTM). ${(steep * 100).toFixed(0)}% of the leg is on cells steeper than 15&deg;.</p>
      </div>`);
    const c = this.el.querySelector<HTMLCanvasElement>("canvas.profile")!;
    const g = c.getContext("2d")!;
    const lo = Math.min(...elevs), hi = Math.max(...elevs), span = Math.max(hi - lo, 5);
    const W = c.width, H = c.height, pad = 24;
    const X = (p: (typeof pts)[0]) => pad + ((p.cumDistM - d0) / Math.max(leg.distM, 1)) * (W - 2 * pad);
    const Y = (e: number) => H - pad - ((e - lo) / span) * (H - 2 * pad);
    g.fillStyle = "#0d1117"; g.fillRect(0, 0, W, H);
    const grad = g.createLinearGradient(0, pad, 0, H);
    grad.addColorStop(0, "rgba(255,157,0,0.5)"); grad.addColorStop(1, "rgba(255,157,0,0.02)");
    g.beginPath(); g.moveTo(X(pts[0]), H - pad);
    pts.forEach((p) => g.lineTo(X(p), Y(p.elev)));
    g.lineTo(X(pts[pts.length - 1]), H - pad); g.closePath();
    g.fillStyle = grad; g.fill();
    for (let k = 1; k < pts.length; k++) {
      const s = pts[k].slope;
      g.strokeStyle = s > 20 ? "#f85149" : s > 10 ? "#d29922" : "#2ea043";
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(X(pts[k - 1]), Y(pts[k - 1].elev)); g.lineTo(X(pts[k]), Y(pts[k].elev)); g.stroke();
    }
    g.fillStyle = "#8b949e"; g.font = "12px Rajdhani, sans-serif";
    g.fillText(`${hi.toFixed(0)} m`, 2, pad - 6); g.fillText(`${lo.toFixed(0)} m`, 2, H - 6);
    g.textAlign = "right"; g.fillText(fmtDist(leg.distM), W - 2, H - 6);
  }

  private readout(ll: L.LatLng) {
    const g = store.grid!;
    const i = xyToIdx(g, lonLatToXY({ lon: ll.lng, lat: ll.lat }));
    if (i < 0) { this.detail(`<p class="note">Outside the DTM survey area.</p>`); return; }
    const why = blockReason(g, i, WALKING);
    let themis = "";
    const t = this.themis;
    if (t) {
      const cx = Math.floor(((ll.lng - t.bounds.west) / (t.bounds.east - t.bounds.west)) * t.width);
      const cy = Math.floor(((t.bounds.north - ll.lat) / (t.bounds.north - t.bounds.south)) * t.height);
      const dn = t.dn[cy * t.width + cx];
      if (dn !== undefined) themis = `<div><span>${dn}</span>THEMIS day-IR DN</div>`;
    }
    L.popup({ closeButton: false, className: "scan-pop" }).setLatLng(ll)
      .setContent(`<b>${why ? "&#9888; NO-GO" : "&#10003; WALKABLE"}</b>`).openOn(this.map);
    this.detail(`
      <div class="card"><h4>Terrain scan</h4>
        <div class="kpis small">
          <div><span>${g.elev[i].toFixed(0)} m</span>elevation</div>
          <div><span>${g.slope[i].toFixed(0)}&deg;</span>slope (p90, 2 m)</div>
          <div><span>${g.rough[i].toFixed(2)} m</span>roughness (RMS)</div>
          ${themis}
        </div>
        <p class="${why ? "warn" : "ok-text"}">${why ? `Blocked for walking: ${why}` : "Passable for the walking profile"}</p>
        <p class="src">${ll.lat.toFixed(5)}&deg;, ${ll.lng.toFixed(5)}&deg; · 10 m cell from the USGS 1 m DTM</p>
        ${this.mode === "map" ? `<button class="btn nav-btn" ${why ? "disabled" : ""}>Navigate here (A*)</button>` : ""}
      </div>`, () => this.onNavigate?.({ lon: ll.lng, lat: ll.lat }, "Waypoint"));
  }

  private detail(html: string, onNav?: () => void) {
    const el = this.el.querySelector(".mm-detail")!;
    el.innerHTML = html;
    const b = el.querySelector<HTMLButtonElement>(".nav-btn");
    if (b && onNav) b.onclick = onNav;
    this.el.querySelector(".mm-detail-wrap")!.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private renderBudget(r: Route | null) {
    const el = this.el.querySelector(".mm-budget")!;
    if (!r) { el.innerHTML = `<p class="note">Select at least one stop.</p>`; return; }
    const t = r.totals;
    const over = t.evaS > EVA.maxDurationH.value * 3600;
    const endH = this.startHour + t.evaS / MARS_HOUR_S;
    el.innerHTML = `
      <div class="kpis">
        <div><span>${fmtDist(t.distM)}</span>distance (3D)</div>
        <div><span>+${t.climbM.toFixed(0)} / -${t.descentM.toFixed(0)} m</span>climb / descent</div>
        <div><span>${fmtDur(t.walkS)}</span>walking</div>
        <div class="${over ? "bad" : ""}"><span>${fmtDur(t.evaS)}</span>total EVA</div>
      </div>
      <table class="legs"><tr><th>Leg</th><th>Dist</th><th>Climb</th><th>Time</th></tr>
        ${r.legs.map((l, i) => `<tr data-leg="${i}"><td>${this.stopName(l.fromId)} &rarr; ${this.stopName(l.toId)}</td><td>${fmtDist(l.distM)}</td>
          <td>+${l.climbM.toFixed(0)} m</td><td>${fmtDur(l.walkS)}</td></tr>`).join("")}
      </table>
      <p class="note">Pace ${WALKING.flatSpeedKmh.value} km/h on flat, Tobler-shaped on grades ${sourceTag(WALKING.flatSpeedKmh)} ·
        ${EVA.stopDwellMin.value} min per stop ${sourceTag(EVA.stopDwellMin)} · EVA limit ${EVA.maxDurationH.value} h ${sourceTag(EVA.maxDurationH)} ·
        suit ${SUIT.capacityH.value} h incl. ${SUIT.reserveH.value * 60} min reserve ${sourceTag(SUIT.capacityH)}.
        Back at base ~${fmtClock(endH)} local (Mars hours ≈ Earth hours × 1.027).</p>
      ${r.warnings.map((w) => `<p class="warn">&#9888; ${w}</p>`).join("")}
      <p class="src">A* over ${store.grid!.cols}&times;${store.grid!.rows} cells (${store.grid!.cellSize} m) in ${r.computeMs.toFixed(0)} ms. Click a leg on the map or below for its profile.</p>`;
    el.querySelectorAll<HTMLTableRowElement>("tr[data-leg]").forEach((tr) => {
      tr.onclick = () => { const i = +tr.dataset.leg!; this.selectedLeg = i; this.drawRoute(r); this.showLeg(r, r.legs[i], i); };
    });
  }

  private renderBrief(b: BriefingInfo) {
    const sw = b.spaceWx;
    this.el.querySelector(".mm-brief")!.innerHTML = `
      <h3>Conditions</h3>
      <div class="kpis small">
        <div><span>Sol ${b.sol}</span>Curiosity mission sol</div>
        <div><span>Ls ${b.ls.toFixed(0)}&deg;</span>season</div>
        <div><span>${b.sunrise} / ${b.sunset}</span>sunrise / sunset (LTST)</div>
        <div class="${sw.level === "watch" ? "bad" : ""}"><span>${sw.level.toUpperCase()}</span>space weather</div>
      </div>
      <p class="note">${b.dateText}. ${b.weather} <span class="tag sourced" title="${b.weatherSource}">sourced</span></p>
      <p class="note">${sw.text} <span class="tag ${sw.level === "unknown" ? "assumed" : "sourced"}" title="NASA CCMC DONKI snapshot">DONKI</span></p>
      <label class="start-time">EVA start (local true solar time)
        <select>${[7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((h) => `<option value="${h}" ${h === this.startHour ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select>
      </label>`;
    const sel = this.el.querySelector<HTMLSelectElement>(".start-time select")!;
    sel.onchange = () => { this.startHour = +sel.value; this.renderBudget(store.route); };
  }

  private renderBegin() {
    const el = this.el.querySelector(".mm-begin")!;
    if (this.mode !== "briefing") { el.innerHTML = ""; return; }
    el.innerHTML = `<button class="btn big" ${store.route ? "" : "disabled"}>BEGIN EVA &rarr;</button>`;
    el.querySelector<HTMLButtonElement>("button")!.onclick = () => this.onBegin?.();
  }
}
