// Mission map (Planner): full-screen Leaflet map over the game. Used as the pre-EVA briefing and as the
// expanded minimap mid-EVA. Layer stack, stop selection -> live A* replan + EVA budget, clickable legs with
// elevation profiles, click-anywhere terrain readout with "navigate here", live player/trail/nav overlays.

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { CURIOSITY, EVA, RADIATION, ROVER, SUIT, WALKING, withSlopeLimit, type TerrainProfile } from "../core/config";
import { compare, driveSegments, hazardAgreement, type Comparison, type DriveSegment } from "../core/compare";
import { blockReason } from "../core/cost";
import { lonLatToXY, xyToIdx, xyToLonLat, type XY } from "../core/grid";
import { nearestReachable, planRoute, routeThrough, type Leg, type Route, type Stop } from "../core/route";
import { fmtClock, MARS_HOUR_S } from "../core/sun";
import type { Overlays, StopInfo } from "../shared/data";
import { loadLandmarks, loadOverlays, loadTraverse } from "../shared/data";
import { fmtDist, fmtDur, sourceTag } from "../shared/format";
import { setRoute, store } from "../shared/store";

export interface LL { lon: number; lat: number }

export interface BriefingInfo {
  sol: number; ls: number; dateText: string;
  sunrise: string; sunset: string;
  weather: string; weatherSource: string;
  spaceWx: { level: string; text: string };
  comm?: { distKm: number; oneWayS: number; sunAngleDeg: number };
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
  profile: TerrainProfile = WALKING;
  travel: "walk" | "buggy" = "walk";
  private extras = L.layerGroup();
  private valLayer = L.layerGroup();
  private order: string[] = [];     // visiting order of the included stops (scenario picker can change it)
  private sunsetH = 18;
  private drives: XY[][] = [];
  private segs: DriveSegment[] = [];
  private comps: Map<number, Comparison | null> = new Map();
  startHour = 9;
  /** fired when the crew slope limit changes so the game can re-plan live */
  onCapability: (() => void) | null = null;

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
        <section><h3>Travel</h3><div class="seg mm-prof"><button data-p="walk" class="on">On foot</button><button data-p="buggy">Buggy</button></div>
          <p class="note mm-prof-note"></p>
          <label class="mm-cap">Crew slope limit <b class="mm-cap-v">25&deg;</b>
            <input type="range" min="12" max="30" step="1" value="25"></label>
          <p class="src mm-cap-note">Lower it for a tired or injured crew member, a stretcher carry, or a heavy tool load: A* re-plans live.</p></section>
        <section><h3>Science stops</h3><div class="mm-stops"></div>
          <p class="note">Crew: ${WALKING.name}. Router limits: slope ${WALKING.maxSlopeDeg.value}&deg; ${sourceTag(WALKING.maxSlopeDeg)},
          roughness ${WALKING.maxRoughM.value} m ${sourceTag(WALKING.maxRoughM)}.</p></section>
        <section><h3>EVA budget</h3><div class="mm-budget"></div>
          <div class="mm-tools"><button class="btn small mm-scen">Compare scenarios</button><button class="btn small mm-val">Validate vs Curiosity</button></div></section>
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
    this.extras.addTo(this.map);
    this.liveLayer.addTo(this.map);
    this.valLayer.addTo(this.map);
    this.el.querySelectorAll<HTMLButtonElement>(".mm-prof button").forEach((b) => (b.onclick = () => this.setProfile(b.dataset.p === "buggy" ? ROVER : WALKING)));
    const cap = this.el.querySelector<HTMLInputElement>(".mm-cap input")!;
    cap.oninput = () => {
      store.crewSlopeDeg = +cap.value;
      this.el.querySelector(".mm-cap-v")!.innerHTML = `${cap.value}&deg;`;
      if (this.travel === "walk") this.setProfile(WALKING);
      this.onCapability?.();
    };
    this.el.querySelector<HTMLButtonElement>(".mm-scen")!.onclick = () => this.scenarios();
    this.el.querySelector<HTMLButtonElement>(".mm-val")!.onclick = () => this.validate();
    // Curiosity's drives (projected) + its dated stops, for the planner validation
    const trav = await loadTraverse();
    this.drives = trav.features.map((f) => (f.geometry as GeoJSON.LineString).coordinates.map(([lon, lat]) => lonLatToXY({ lon, lat })));
    const lms = await loadLandmarks();
    this.segs = driveSegments(this.drives, lms.map((l) => ({ id: l.id, sol: l.sol, ...lonLatToXY(l) })));
    this.renderStopList();
    this.map.on("click", (e: L.LeafletMouseEvent) => this.readout(e.latlng));
    this.replan();
  }

  setProfile(p: TerrainProfile) {
    this.travel = p === ROVER ? "buggy" : "walk";
    this.profile = this.travel === "buggy" ? ROVER : withSlopeLimit(WALKING, store.crewSlopeDeg);
    this.el.querySelectorAll<HTMLButtonElement>(".mm-prof button").forEach((b) => b.classList.toggle("on", (b.dataset.p === "buggy") === (this.travel === "buggy")));
    this.el.querySelector<HTMLElement>(".mm-cap")!.hidden = this.travel === "buggy";
    this.el.querySelector<HTMLElement>(".mm-cap-note")!.hidden = this.travel === "buggy";
    this.el.querySelector(".mm-prof-note")!.innerHTML = this.travel === "buggy"
      ? `A* with buggy limits: slope ${ROVER.maxSlopeDeg.value}&deg; ${sourceTag(ROVER.maxSlopeDeg)}, relief ${ROVER.maxRoughM.value} m ${sourceTag(ROVER.maxRoughM)}, ${ROVER.flatSpeedKmh.value} km/h ${sourceTag(ROVER.flatSpeedKmh)}. Sites the buggy can't reach get a park point; walk the rest.`
      : `A* with walking limits (below).`;
    this.replan();
  }

  /** Static markers: Curiosity's stopping points (found ones highlighted). */
  setLandmarks(list: (LL & { name: string; found: boolean })[]) {
    this.extras.clearLayers();
    for (const l of list) {
      L.circleMarker([l.lat, l.lon], { radius: 5, color: l.found ? "#fff" : "#ffd27a", weight: 2, fillOpacity: l.found ? 0.9 : 0.2 })
        .bindTooltip(l.found ? l.name : "Curiosity stop (undiscovered)").addTo(this.extras);
    }
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
  setLive(p: LL & { headingDeg: number }, trail: LL[], nav: LL[], home: LL[], buggy?: LL) {
    if (this.el.hidden) return;
    this.liveLayer.clearLayers();
    const ll = (a: LL[]) => a.map((q) => [q.lat, q.lon] as [number, number]);
    if (home.length > 1) L.polyline(ll(home), { color: "#ff5a3c", weight: 3, dashArray: "6 6" }).addTo(this.liveLayer);
    if (trail.length > 1) L.polyline(ll(trail), { color: "#fff", weight: 3, opacity: 0.9 }).addTo(this.liveLayer);
    if (nav.length > 1) L.polyline(ll(nav), { color: "#00e5ff", weight: 5, opacity: 0.95 }).addTo(this.liveLayer);
    if (buggy) L.marker([buggy.lat, buggy.lon], { icon: L.divIcon({ className: "map-buggy", html: "&#9635;", iconSize: [20, 20] }) }).bindTooltip("Buggy").addTo(this.liveLayer);
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
      ...(store.crism ? [{ name: "Minerals (CRISM hydration)", layer: L.imageOverlay(store.crism.stretched().toDataURL(), bb(store.crism.meta.bounds)) as L.Layer, on: false, opacity: 0.7,
        source: `${store.crism.meta.source} Observed ${store.crism.meta.observed}. Contrast-stretched per band for visibility.`, legend: store.crism.meta.legend }] : []),
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
    const DEFAULT = new Set(["gediz", "boxwork_entry", "boxwork_main"]);
    science.forEach((s) => { if (DEFAULT.has(s.id)) this.included.add(s.id); });
    el.innerHTML = science.map((s) => `
      <label class="stop-row"><input type="checkbox" data-id="${s.id}" ${DEFAULT.has(s.id) ? "checked" : ""}>
        <span class="pin-inline">${store.stops.indexOf(s)}</span> ${s.name}</label>`).join("");
    el.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.onchange = () => { cb.checked ? this.included.add(cb.dataset.id!) : this.included.delete(cb.dataset.id!); this.order = []; this.replan(); };
    });
  }

  /** Included stops in visiting order (the scenario picker can reorder them). */
  private targets(): StopInfo[] {
    const sci = store.stops.filter((s) => s.kind === "science" && this.included.has(s.id));
    const rank = (s: StopInfo) => { const i = this.order.indexOf(s.id); return i < 0 ? 1000 + store.stops.indexOf(s) : i; };
    return sci.sort((a, b) => rank(a) - rank(b));
  }

  /** A* plan base -> targets (in order) -> base, on foot or by buggy (park and walk where it can't reach). */
  private buildRoute(travel: "walk" | "buggy", targets: Stop[]): Route | null {
    if (!targets.length) return null;
    const base = store.stops.find((s) => s.kind === "base")!;
    if (travel === "walk") return planRoute(store.grid!, base, targets, withSlopeLimit(WALKING, store.crewSlopeDeg));
    const order: Stop[] = [base];
    const notes: string[] = [];
    for (const t of targets) {
      const direct = routeThrough(store.grid!, [order[order.length - 1], t], ROVER);
      if (direct.legs.length) { order.push(t); continue; }
      const park = nearestReachable(store.grid!, base, t, ROVER);
      if (park) { order.push({ ...park.stop, name: `${t.name.split(" - ")[0]} (park, walk ${park.gapM.toFixed(0)} m)` }); notes.push(`${t.name.split(" - ")[0]}: buggy parks ${park.gapM.toFixed(0)} m away, walk the rest`); }
    }
    order.push(base);
    const r = routeThrough(store.grid!, order, ROVER, targets.length);
    r.warnings = [...notes, ...r.warnings.filter((w) => !w.startsWith("No safe path"))];
    return r;
  }

  private replan() {
    const r = this.buildRoute(this.travel, this.targets());
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

  private stopName(id: string) {
    const s = store.stops.find((q) => q.id === id) ?? store.route?.stops.find((q) => q.id === id);
    return s?.name.split(" - ")[0] ?? id;
  }

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
    const why = blockReason(g, i, this.profile);
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
        ${(() => { const r = store.crism?.at(ll.lng, ll.lat); return r ? `<p class="note"><b>CRISM (orbit, 18 m):</b> ${r.label} · ${r.strength}<br><span class="src">SINDEX2 ${r.sindex2.toFixed(4)} · BD2100 ${r.bd2100.toFixed(4)} · BD1900 ${r.bd1900.toFixed(4)}</span></p>` : ""; })()}
        <p class="${why ? "warn" : "ok-text"}">${why ? `Blocked for ${this.travel === "buggy" ? "the buggy" : "walking"}: ${why}` : `Passable ${this.travel === "buggy" ? "for the buggy" : "on foot"} (${this.profile.maxSlopeDeg.value}&deg; limit)`}</p>
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
    const broken = r.warnings.some((w) => w.startsWith("No safe path"));
    const endH = this.startHour + t.evaS / MARS_HOUR_S;
    el.innerHTML = `
      ${broken ? `<p class="infeasible">&#9888; NOT FEASIBLE with these limits: some stops can't be reached safely (see below). Totals cover only the reachable legs.</p>` : ""}
      <div class="kpis">
        <div><span>${fmtDist(t.distM)}</span>distance (3D)</div>
        <div><span>+${t.climbM.toFixed(0)} / -${t.descentM.toFixed(0)} m</span>climb / descent</div>
        <div><span>${fmtDur(t.walkS)}</span>${this.travel === "buggy" ? "driving" : "walking"}</div>
        <div class="${over ? "bad" : ""}"><span>${fmtDur(t.evaS)}</span>total EVA</div>
      </div>
      <table class="legs"><tr><th>Leg</th><th>Dist</th><th>Climb</th><th>Time</th></tr>
        ${r.legs.map((l, i) => `<tr data-leg="${i}"><td>${this.stopName(l.fromId)} &rarr; ${this.stopName(l.toId)}</td><td>${fmtDist(l.distM)}</td>
          <td>+${l.climbM.toFixed(0)} m</td><td>${fmtDur(l.walkS)}</td></tr>`).join("")}
      </table>
      <p class="note">${this.travel === "buggy" ? `Buggy ${ROVER.flatSpeedKmh.value} km/h on flat, slower on grades ${sourceTag(ROVER.flatSpeedKmh)}` : `Pace ${WALKING.flatSpeedKmh.value} km/h on flat, Tobler-shaped on grades ${sourceTag(WALKING.flatSpeedKmh)}`} ·
        ${EVA.stopDwellMin.value} min per stop ${sourceTag(EVA.stopDwellMin)} · EVA limit ${EVA.maxDurationH.value} h ${sourceTag(EVA.maxDurationH)} ·
        suit ${SUIT.capacityH.value} h incl. ${SUIT.reserveH.value * 60} min reserve ${sourceTag(SUIT.capacityH)}.
        Back at base ~${fmtClock(endH)} local (Mars hours ≈ Earth hours × 1.027).</p>
      ${r.warnings.map((w) => `<p class="warn">&#9888; ${w}</p>`).join("")}
      <p class="src">A* (${this.profile.name}) over ${store.grid!.cols}&times;${store.grid!.rows} cells (${store.grid!.cellSize} m) in ${r.computeMs.toFixed(0)} ms. Click a leg on the map or below for its profile.</p>`;
    el.querySelectorAll<HTMLTableRowElement>("tr[data-leg]").forEach((tr) => {
      tr.onclick = () => { const i = +tr.dataset.leg!; this.selectedLeg = i; this.drawRoute(r); this.showLeg(r, r.legs[i], i); };
    });
  }

  private renderBrief(b: BriefingInfo) {
    const sw = b.spaceWx;
    const [sh, sm] = b.sunset.split(":").map(Number);
    if (isFinite(sh)) this.sunsetH = sh + (sm || 0) / 60;
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
      ${b.comm ? `<p class="note"><b>Earth link:</b> ${(b.comm.distKm / 1e6).toFixed(0)} million km, <b>${fmtDur(b.comm.oneWayS)}</b> one-way light time (${fmtDur(2 * b.comm.oneWayS)} round trip). Mission Control can't steer this EVA in real time, so the crew needs an onboard planner. <span class="tag sourced" title="JPL Approximate Positions of the Planets (Standish), checked against the 2003 and 2020 close approaches">JPL</span></p>` : ""}
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

  // ---------- what-if scenarios ----------
  /**
   * Same science, different plans: every visiting order x {on foot, buggy} x start times. Each row is a
   * full A* plan with time, distance, climb, steepest cell, suit use, dose and daylight margin, so a crew
   * can see the trade-offs before committing. "Use" applies the order, travel mode and start time.
   */
  scenarios() {
    const tg = this.targets();
    if (!tg.length) { this.detail(`<p class="note">Select at least one stop first.</p>`); return; }
    const perms = (a: StopInfo[]): StopInfo[][] => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
    const orders = perms(tg).slice(0, 24);
    type Row = { order: StopInfo[]; travel: "walk" | "buggy"; start: number; r: Route; endH: number; marginH: number; suitPct: number; doseUSv: number; maxSlope: number; score: number };
    const rows: Row[] = [];
    const t0 = performance.now();
    for (const travel of ["walk", "buggy"] as const) for (const order of orders) {
      const r = this.buildRoute(travel, order);
      if (!r || !r.legs.length || r.warnings.some((w) => w.startsWith("No safe path"))) continue;
      const maxSlope = Math.max(...r.points.map((p) => p.slope));
      // consumables: walking at ~1.0x nominal, seated driving at rest rate (SUIT.metabolic), stops at rest
      const met = travel === "buggy" ? SUIT.metabolic.value.rest : SUIT.metabolic.value.flat;
      const usedH = (r.totals.walkS * met + r.totals.dwellS * SUIT.metabolic.value.rest) / 3600;
      for (const start of [7, 9, 12, 15]) {
        const endH = start + r.totals.evaS / MARS_HOUR_S;
        const marginH = this.sunsetH - endH;
        const suitPct = (usedH / SUIT.capacityH.value) * 100;
        const doseUSv = RADIATION.surfaceDoseMSvPerDay.value * 1000 * r.totals.evaS / 86400;
        // lower is better: time, plus heavy penalties for ending after sunset or eating into the reserve
        const score = r.totals.evaS / 3600 + (marginH < 0.5 ? 10 + (0.5 - marginH) * 5 : 0) + (suitPct > 90 ? 10 : 0) + maxSlope / 30;
        rows.push({ order, travel, start, r, endH, marginH, suitPct, doseUSv, maxSlope, score });
      }
    }
    const ms = performance.now() - t0;
    rows.sort((a, b) => a.score - b.score);
    // one row per (order, travel) at its best start time; keep the best walking and buggy plans side by side
    const seen = new Set<string>();
    const best = rows.filter((w) => { const k = w.travel + w.order.map((q) => q.id).join(); if (seen.has(k)) return false; seen.add(k); return true; });
    const top = [...best.filter((w) => w.travel === "buggy").slice(0, 4), ...best.filter((w) => w.travel === "walk").slice(0, 4)].sort((a, b) => a.score - b.score);
    const nm = (s: StopInfo) => String(store.stops.indexOf(s));
    this.detail(`
      <div class="card"><h4>What-if scenarios</h4>
        <p class="note">${orders.length} visiting orders &times; on foot / buggy &times; 4 start times = ${rows.length} full A* plans in ${ms.toFixed(0)} ms. Best start time per plan, best first.</p>
        <table class="legs scen"><tr><th></th><th>Order</th><th>Window</th><th>EVA</th><th>Dark in</th><th>Suit</th><th></th></tr>
        ${top.map((w, i) => `<tr class="${w.marginH < 0 ? "bad" : ""}" title="steepest cell ${w.maxSlope.toFixed(0)}°, dose ${w.doseUSv.toFixed(0)} µSv"><td>${w.travel === "buggy" ? "&#9635;" : "&#9673;"}</td>
          <td>${w.order.map(nm).join("&rarr;")}</td><td>${fmtClock(w.start)}&ndash;${fmtClock(w.endH)}</td>
          <td>${fmtDur(w.r.totals.evaS)}</td>
          <td>${w.marginH >= 0 ? "+" : ""}${w.marginH.toFixed(1)} h</td><td>${w.suitPct.toFixed(0)}%</td>
          <td><button class="use" data-i="${i}">Use</button></td></tr>`).join("")}
        </table>
        <p class="src">&#9635; buggy &nbsp; &#9673; on foot · hover a row for its steepest cell and radiation dose.</p>
        <p class="src">Sunset ${fmtClock(this.sunsetH)} LTST from the REMS analogue sol. Suit = consumables used vs ${SUIT.capacityH.value} h capacity ${sourceTag(SUIT.capacityH)}
          (seated driving at the rest rate). Dose ${RADIATION.surfaceDoseMSvPerDay.value} mSv/day ${sourceTag(RADIATION.surfaceDoseMSvPerDay)}.
          Ranking: EVA hours + penalties for ending &lt; 30 min before sunset or using &gt; 90% of the suit, + steepness.</p>
      </div>`);
    this.el.querySelectorAll<HTMLButtonElement>(".scen .use").forEach((b) => (b.onclick = () => {
      const w = top[+b.dataset.i!];
      this.order = w.order.map((s) => s.id);
      this.startHour = w.start;
      const sel = this.el.querySelector<HTMLSelectElement>(".start-time select");
      if (sel) sel.value = String(w.start);
      this.setProfile(w.travel === "buggy" ? ROVER : WALKING);
      this.onTravel?.(w.travel, w.start);
    }));
  }
  onTravel: ((t: "walk" | "buggy", startHour: number) => void) | null = null;

  // ---------- validation against Curiosity ----------
  validate(pick = -1) {
    if (!this.segs.length) { this.detail(`<p class="note">Curiosity's traverse isn't loaded.</p>`); return; }
    const h = hazardAgreement(store.grid!, this.drives, CURIOSITY);
    const hw = hazardAgreement(store.grid!, this.drives, this.travel === "buggy" ? ROVER : this.profile);
    const get = (i: number) => { if (!this.comps.has(i)) this.comps.set(i, compare(store.grid!, this.segs[i])); return this.comps.get(i)!; };
    const all = this.segs.map((_, i) => get(i)).filter((c): c is Comparison => !!c);
    const mean = (f: (c: Comparison) => number) => all.reduce((a, c) => a + f(c), 0) / Math.max(all.length, 1);
    this.valLayer.clearLayers();
    const ll = (p: XY[]) => p.map((q) => { const g = xyToLonLat(q); return [g.lat, g.lon] as [number, number]; });
    const sel = pick >= 0 ? get(pick) : null;
    if (sel) {
      L.polyline(ll(sel.seg.path), { color: "#ffd27a", weight: 6, opacity: 0.95 }).bindTooltip(`Curiosity, sols ${sel.seg.from.sol}-${sel.seg.to.sol}`).addTo(this.valLayer);
      L.polyline(ll(sel.astar), { color: "#00e5ff", weight: 4, opacity: 0.95, dashArray: "8 6" }).bindTooltip("Our A*").addTo(this.valLayer);
      this.map.fitBounds(L.latLngBounds([...ll(sel.seg.path), ...ll(sel.astar)]).pad(0.3));
    }
    this.detail(`
      <div class="card"><h4>Validation: our planner vs Curiosity</h4>
        <p class="note">Curiosity's team picked every drive with full HiRISE and Navcam knowledge. Does our hazard map agree with where they actually drove?</p>
        <div class="kpis small">
          <div><span>${h.driveKm.toFixed(1)} km</span>Curiosity drives in the area</div>
          <div><span>${h.drivePassablePct.toFixed(1)}%</span>of them on cells we rate passable (rover limits)</div>
          <div><span>${h.areaNoGoPct.toFixed(1)}%</span>of the whole area is no-go</div>
          <div class="good"><span>${h.avoidance.toFixed(0)}&times;</span>no-go cells avoided vs chance</div>
        </div>
        <p class="note">With the current ${this.travel === "buggy" ? "buggy" : "walking"} limits (${(this.travel === "buggy" ? ROVER : this.profile).maxSlopeDeg.value}&deg;), ${hw.drivePassablePct.toFixed(1)}% of Curiosity's path is passable, ${hw.areaNoGoPct.toFixed(1)}% of the area is no-go.</p>
        <h4 style="margin-top:10px">Stop-to-stop: A* vs the real drive</h4>
        <table class="legs val"><tr><th>Sols</th><th>Curiosity</th><th>A*</th><th>Mean gap</th><th>Straight-line gap</th></tr>
          ${this.segs.map((sg, i) => { const c = get(i); return c ? `<tr data-i="${i}" class="${i === pick ? "on" : ""}"><td>${sg.from.sol}&rarr;${sg.to.sol}</td><td>${fmtDist(c.curiosityM)}</td><td>${fmtDist(c.astarM)}</td><td>${c.meanDevM.toFixed(0)} m</td><td>${c.straightDevM.toFixed(0)} m</td></tr>` : ""; }).join("")}
        </table>
        <p class="note">Mean over ${all.length} segments: A* is ${mean((c) => c.meanDevM).toFixed(0)} m from Curiosity's line (a straight line: ${mean((c) => c.straightDevM).toFixed(0)} m).
          Honest read: on these short, mostly benign hops a straight line is about as close; where the rover drove much farther than A* (e.g. sols 4151&rarr;4342: ${fmtDist(this.segs.findIndex((x) => x.from.sol === 4151) >= 0 ? get(this.segs.findIndex((x) => x.from.sol === 4151))?.curiosityM ?? 0 : 0)}) it was doing science along the way, not avoiding hazards.
          The strong signal is the hazard map: the rover stayed off our no-go cells ${h.avoidance.toFixed(0)}&times; more than chance.</p>
        <p class="src">Curiosity profile: slope ${CURIOSITY.maxSlopeDeg.value}&deg; ${sourceTag(CURIOSITY.maxSlopeDeg)}, relief ${CURIOSITY.maxRoughM.value} m ${sourceTag(CURIOSITY.maxRoughM)}. Drives: NASA/JPL-Caltech MSL traverse (MMGIS), cut between Curiosity's dated stops. Click a row to see both lines.</p>
      </div>`);
    this.el.querySelectorAll<HTMLTableRowElement>(".val tr[data-i]").forEach((tr) => (tr.onclick = () => this.validate(+tr.dataset.i!)));
  }
}
