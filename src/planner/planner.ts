// Mode A - Planner: top-down map, layer stack, science stop pins, A* route, EVA budget.

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { EVA, WALKING } from "../core/config";
import { planRoute, type Route } from "../core/route";
import type { Overlays, StopInfo } from "../shared/data";
import { loadOverlays, loadTraverse } from "../shared/data";
import { fmtDist, fmtDur, sourceTag } from "../shared/format";
import { setRoute, store, subscribe } from "../shared/store";

let map: L.Map;
let routeLayer: L.LayerGroup;
let simMarker: L.CircleMarker;
const included = new Set<string>(); // science stop ids included in the EVA

export async function initPlanner(root: HTMLElement) {
  root.innerHTML = `
    <aside class="sidebar">
      <section><h2>Layers</h2><div id="layers"></div></section>
      <section><h2>EVA stops</h2><div id="stoplist"></div>
        <p class="note">Crew: ${WALKING.name}. Max slope ${WALKING.maxSlopeDeg.value}&deg; ${sourceTag(WALKING.maxSlopeDeg)},
        max roughness ${WALKING.maxRoughM.value} m ${sourceTag(WALKING.maxRoughM)}.</p>
      </section>
      <section><h2>EVA budget</h2><div id="budget"></div></section>
    </aside>
    <div id="map"></div>`;

  const ov = await loadOverlays();
  const b = ov.bounds;
  map = L.map("map", { zoomControl: true, minZoom: 13, maxZoom: 19, attributionControl: true })
    .fitBounds([[b.south, b.west], [b.north, b.east]]);

  // Base: HiRISE colour mosaic (cached tiles, standard XYZ order)
  L.tileLayer("tiles/hirise/{z}/{x}/{y}.jpg", {
    minZoom: 13, maxZoom: 19, maxNativeZoom: 17,
    attribution: "HiRISE: NASA/JPL-Caltech/UArizona via NASA MMGIS",
  }).addTo(map);

  const layers = await buildLayers(ov);
  renderLayerPanel(layers);
  renderStopList();
  routeLayer = L.layerGroup().addTo(map);
  simMarker = L.circleMarker([0, 0], { radius: 7, color: "#fff", weight: 2, fillColor: "#00e5ff", fillOpacity: 1 });

  subscribe(drawSim);
  replan();
}

interface LayerDef { name: string; layer: L.Layer; on: boolean; opacity: number; source: string; legend?: string }

async function buildLayers(ov: Overlays): Promise<LayerDef[]> {
  const bb = (b: Overlays["bounds"]): L.LatLngBoundsExpression => [[b.south, b.west], [b.north, b.east]];
  const traverse = L.geoJSON(await loadTraverse(), {
    style: { color: "#ff9d00", weight: 2, dashArray: "4 4", opacity: 0.9 },
  });
  const pins = L.layerGroup(store.stops.map(stopMarker));
  return [
    { name: "Elevation (hillshade)", layer: L.imageOverlay(ov.hillshade.file, bb(ov.bounds)), on: false, opacity: 0.6,
      source: ov.hillshade.source, legend: `${ov.hillshade.elevMin.toFixed(0)} m (blue) to ${ov.hillshade.elevMax.toFixed(0)} m (tan)` },
    { name: "Slope", layer: L.imageOverlay(ov.slope.file, bb(ov.bounds)), on: false, opacity: 0.55,
      source: ov.slope.source, legend: "green <10&deg;, yellow 10-20&deg;, red 20-30&deg;, dark >30&deg;" },
    { name: "Thermal (THEMIS day IR)", layer: L.imageOverlay(ov.themis.file, bb(ov.themis.bounds)), on: false, opacity: 0.5,
      source: ov.themis.source, legend: "blue = cooler by day, orange = warmer (relative, ~81 m/px)" },
    { name: "Curiosity traverse", layer: traverse, on: true, opacity: 1, source: "NASA/JPL-Caltech MSL traverse (MMGIS)" },
    { name: "Science stops", layer: pins, on: true, opacity: 1, source: "Positions from MSL waypoints at the cited sol" },
  ];
}

function renderLayerPanel(defs: LayerDef[]) {
  const el = document.getElementById("layers")!;
  el.innerHTML = "";
  for (const d of defs) {
    const row = document.createElement("div");
    row.className = "layer-row";
    const hasOpacity = "setOpacity" in d.layer;
    row.innerHTML = `
      <label><input type="checkbox" ${d.on ? "checked" : ""}> ${d.name}</label>
      ${hasOpacity ? `<input type="range" min="0" max="1" step="0.05" value="${d.opacity}">` : ""}
      <div class="src">${d.legend ? d.legend + "<br>" : ""}${d.source}</div>`;
    const cb = row.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    const sl = row.querySelector<HTMLInputElement>("input[type=range]");
    const apply = () => {
      if (cb.checked) d.layer.addTo(map); else d.layer.remove();
      if (sl) (d.layer as L.ImageOverlay).setOpacity(+sl.value);
    };
    cb.onchange = apply;
    if (sl) sl.oninput = apply;
    apply();
    el.appendChild(row);
  }
}

function stopMarker(s: StopInfo): L.Marker {
  const n = store.stops.indexOf(s);
  const icon = L.divIcon({
    className: `pin pin-${s.kind}`,
    html: s.kind === "base" ? "&#8962;" : String(n),
    iconSize: [26, 26],
  });
  const imgs = s.images.slice(0, 3)
    .map((i) => `<a href="${i.file}" target="_blank"><img src="${i.file}" title="${i.instrument} sol ${i.sol}"></a>`).join("");
  return L.marker([s.lat, s.lon], { icon }).bindPopup(`
    <div class="card">
      <h3>${s.name}</h3>
      <p><b>What:</b> ${s.what}</p>
      <p><b>Why it matters:</b> ${s.why}</p>
      <p><b>Look for:</b> ${s.lookFor}</p>
      <p class="src"><b>Evidence:</b> ${s.evidence}<br>Position: ${s.waypoint}, elev ${s.elev.toFixed(0)} m</p>
      <div class="thumbs">${imgs}</div>
      <p class="src">Raw Navcam frames from Curiosity at this stop. ${s.images[0]?.credit ?? ""}</p>
    </div>`, { maxWidth: 360 });
}

function renderStopList() {
  const el = document.getElementById("stoplist")!;
  const science = store.stops.filter((s) => s.kind === "science");
  science.forEach((s) => included.add(s.id));
  el.innerHTML = science.map((s) => `
    <label class="stop-row"><input type="checkbox" data-id="${s.id}" checked>
      <span class="pin-inline">${store.stops.indexOf(s)}</span> ${s.name}</label>`).join("");
  el.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
    cb.onchange = () => { cb.checked ? included.add(cb.dataset.id!) : included.delete(cb.dataset.id!); replan(); };
  });
}

function replan() {
  const base = store.stops.find((s) => s.kind === "base")!;
  const targets = store.stops.filter((s) => s.kind === "science" && included.has(s.id));
  const r = targets.length ? planRoute(store.grid!, base, targets, WALKING) : null;
  setRoute(r);
  drawRoute(r);
  renderBudget(r);
}

function drawRoute(r: Route | null) {
  routeLayer.clearLayers();
  if (!r) return;
  const ll = r.points.map((p) => [p.lat, p.lon] as [number, number]);
  L.polyline(ll, { color: "#000", weight: 7, opacity: 0.5 }).addTo(routeLayer);
  L.polyline(ll, { color: "#00e5ff", weight: 3.5 }).addTo(routeLayer);
}

function renderBudget(r: Route | null) {
  const el = document.getElementById("budget")!;
  if (!r) { el.innerHTML = `<p class="note">Select at least one stop.</p>`; return; }
  const name = (id: string) => store.stops.find((s) => s.id === id)?.name.split(" - ")[0] ?? id;
  const t = r.totals;
  const over = t.evaS > EVA.maxDurationH.value * 3600;
  el.innerHTML = `
    <div class="kpis">
      <div><span>${fmtDist(t.distM)}</span>distance (3D)</div>
      <div><span>+${t.climbM.toFixed(0)} / -${t.descentM.toFixed(0)} m</span>climb / descent</div>
      <div><span>${fmtDur(t.walkS)}</span>walking</div>
      <div class="${over ? "bad" : ""}"><span>${fmtDur(t.evaS)}</span>total EVA</div>
    </div>
    <table class="legs"><tr><th>Leg</th><th>Dist</th><th>Climb</th><th>Time</th></tr>
      ${r.legs.map((l) => `<tr><td>${name(l.fromId)} &rarr; ${name(l.toId)}</td><td>${fmtDist(l.distM)}</td>
        <td>+${l.climbM.toFixed(0)} m</td><td>${fmtDur(l.walkS)}</td></tr>`).join("")}
    </table>
    <p class="note">Walking pace ${WALKING.flatSpeedKmh.value} km/h on flat, slowed on grades (Tobler shape) ${sourceTag(WALKING.flatSpeedKmh)}.
      Includes ${EVA.stopDwellMin.value} min per stop ${sourceTag(EVA.stopDwellMin)}. EVA limit ${EVA.maxDurationH.value} h ${sourceTag(EVA.maxDurationH)}.</p>
    ${r.warnings.map((w) => `<p class="warn">&#9888; ${w}</p>`).join("")}
    <p class="src">A* over ${store.grid!.cols}&times;${store.grid!.rows} cells (${store.grid!.cellSize} m) in ${r.computeMs.toFixed(0)} ms.</p>`;
}

function drawSim() {
  const p = store.sim.pos;
  if (!map || !p || store.sim.evaS === 0) { simMarker?.remove(); return; }
  simMarker.setLatLng([p.lat, p.lon]).addTo(map);
}

export function onShowPlanner() {
  map?.invalidateSize();
}
