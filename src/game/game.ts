// Game orchestrator: renderer + post-processing, states (title -> briefing -> deploy -> EVA -> debrief),
// camera rig, mission logic (objectives, surveys, live A* navigation, point of no return), and the frame loop.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { EVA, SUIT, WALKING } from "../core/config";
import { blockReason } from "../core/cost";
import { type Grid, lonLatToXY, xyToIdx, xyToLonLat } from "../core/grid";
import { routeThrough, type Route, type Stop } from "../core/route";
import { dateAtLTST, fmtClock, marsTime, sunPosition } from "../core/sun";
import { metabolicFactor, newSuit, returnCheck, tickSuit, type ReturnCheck, type SuitState } from "../core/suit";
import { MissionMap, type LL } from "../planner/missionMap";
import { airTempAt, remsAnalogue, spaceWeather, type Donki, type Rems, type RemsSol } from "../shared/conditions";
import type { StopInfo } from "../shared/data";
import { fmtDist } from "../shared/format";
import { store } from "../shared/store";
import { Astronaut, visorMat } from "./astronaut";
import { SuitAudio } from "./audio";
import { AmbientDust, DustPuffs, Footprints, Rocks } from "./effects";
import { Hud, type Objective } from "./hud";
import { makeBeacon, RouteRibbon, ScanMarker, type Beacon, type P2 } from "./markers";
import { Player } from "./player";
import { Screens } from "./screens";
import { MarsSky } from "./sky";
import type { Terrain } from "./terrain";

type State = "title" | "briefing" | "deploy" | "play" | "debrief";
const WARPS = [1, 2, 5, 10, 30, 60];
const SURVEY_TASKS = [
  { label: "Image the outcrop (Mastcam-style panorama)", min: EVA.stopDwellMin.value / 3 },
  { label: "Collect & bag a sample", min: (EVA.stopDwellMin.value * 2) / 3 },
];

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private css: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.1, 250000);
  private sky: MarsSky;
  private astro = new Astronaut();
  private player: Player;
  private hud: Hud;
  private screens: Screens;
  private map: MissionMap;
  private audio = new SuitAudio();
  private footprints: Footprints;
  private puffs: DustPuffs;
  private dust = new AmbientDust();
  private rocks: Rocks;
  private navRibbon: RouteRibbon;
  private homeRibbon: RouteRibbon;
  private planRibbon: RouteRibbon;
  private scan = new ScanMarker();
  private beacons: Beacon[] = [];
  private beaconTime = { value: 0 };
  private clock = new THREE.Clock();

  private state: State = "title";
  private keys = new Set<string>();
  private camYaw = 0; private camPitch = 0.16; private camDist = 5.5;
  private camMode: "third" | "first" = "third";
  private lastDrag = -10;
  private warpIdx = 2;
  private time = 0;

  // mission
  private startDate = new Date();
  private evaS = 0;
  private suit: SuitState = newSuit();
  private ret: ReturnCheck | null = null;
  private done = new Set<string>();
  private navTarget: { kind: "stop"; id: string } | { kind: "point"; x: number; z: number; label: string } | null = null;
  private navRoute: Route | null = null;
  private navCheckT = 0; private homeT = 0;
  private showHome = false;
  private homePts: P2[] = [];
  private trail: P2[] = [];
  private survey: { stop: StopInfo; tasks: { label: string; min: number; done: boolean; running: boolean; progress: number }[] } | null = null;
  private analogue: RemsSol;
  private deployT = 0;
  private deployFrom = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private wind = new THREE.Vector3(0.8, 0, 0.3);
  private scanEl: HTMLDivElement;
  private titleT = 0;

  constructor(private root: HTMLElement, private terrain: Terrain, private grid: Grid, private rems: Rems, private donki: Donki | null) {
    const r = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.25;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    root.appendChild(r.domElement);
    r.domElement.className = "gl";

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.55, 0.9));
    this.composer.addPass(new OutputPass());

    this.css = new CSS2DRenderer();
    this.css.domElement.className = "labels";
    root.appendChild(this.css.domElement);

    this.sky = new MarsSky(r);
    this.scene.add(this.sky.mesh, this.sky.sun, this.sky.sun.target, this.sky.hemi);
    this.scene.fog = this.sky.fog;
    this.scene.add(terrain.group, this.astro.root);
    this.player = new Player(terrain, this.astro);
    this.footprints = new Footprints(terrain);
    this.puffs = new DustPuffs(terrain);
    this.rocks = new Rocks(terrain, grid);
    this.scene.add(this.footprints.mesh, this.puffs.points, this.dust.points, this.rocks.group, this.scan.group);
    this.planRibbon = new RouteRibbon(terrain, 0xff9d00, 0.5, 0.35);
    this.navRibbon = new RouteRibbon(terrain, 0x00e5ff, 0.8, 1);
    this.homeRibbon = new RouteRibbon(terrain, 0xff5a3c, 0.5, 0.8);
    this.scene.add(this.planRibbon.mesh, this.navRibbon.mesh, this.homeRibbon.mesh);

    this.hud = new Hud(root, terrain.meta.overview.file, terrain.meta.width, terrain.meta.depth);
    this.hud.visible = false;
    this.hud.onExpand = () => this.openMap();
    this.scanEl = document.createElement("div");
    this.scanEl.className = "g-scan";
    root.appendChild(this.scanEl);
    this.map = new MissionMap(root);
    this.screens = new Screens(root);

    this.astro.onStep = (f) => {
      if (this.state !== "play") return;
      this.footprints.add(f.x, f.z, this.player.heading);
      this.puffs.burst(f, 6, 0.8);
      this.audio.step();
    };
    this.player.onLand = () => { this.puffs.burst(this.player.pos, 22, 1.4); this.audio.step(); };

    this.analogue = remsAnalogue(rems, marsTime(new Date()).ls);
    this.bindInput();
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  get loadingScreens() { return this.screens; }

  async init() {
    await this.map.init();
    this.map.onPlanChange = () => this.onPlanChanged();
    this.map.onBegin = () => this.deploy();
    this.map.onClose = () => this.closeMap();
    this.map.onNavigate = (p, label) => this.navigateTo(p, label);
    this.screens.onPlan = () => { this.audio.start(); this.state = "briefing"; this.screens.hideAll(); this.map.show("briefing", this.briefingInfo()); };
    this.screens.onQuick = () => { this.audio.start(); this.deploy(); };
    // beacons
    const n = (s: StopInfo) => (s.kind === "base" ? "&#8962;" : String(store.stops.indexOf(s)));
    for (const s of store.stops) {
      const w = this.terrain.toWorld(lonLatToXY(s));
      const b = makeBeacon(this.terrain, s.id, s.name.split(" - ")[0], w.x, w.z, n(s), this.beaconTime);
      b.setState(s.kind === "base" ? "base" : "pending");
      this.beacons.push(b);
      this.scene.add(b.group);
    }
    this.onPlanChanged();
    this.resetMission();
    this.toTitle();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- states ----------
  private toTitle() {
    this.state = "title";
    this.hud.visible = false;
    this.map.hide();
    const m = marsTime(new Date());
    this.screens.title(`Today on Mars: <b>Sol ${m.sol}</b> at Gale · Ls ${m.ls.toFixed(0)}° · ${fmtClock(m.ltst)} local solar time`);
  }

  private briefingInfo() {
    const m = marsTime(new Date());
    const a = this.analogue;
    return {
      sol: m.sol, ls: m.ls,
      dateText: `EVA on ${new Date().toISOString().slice(0, 10)} (Earth)`,
      sunrise: a.sunrise, sunset: a.sunset,
      weather: `REMS analogue sol ${a.sol} (${a.date}, Ls ${a.ls}°, same season last Mars year): air ${a.minAirC}..${a.maxAirC} °C, ground ${a.minGroundC}..${a.maxGroundC} °C, ${a.pressurePa} Pa, ${a.opacity}, UV ${a.uv}.`,
      weatherSource: this.rems.source,
      spaceWx: spaceWeather(this.donki),
    };
  }

  private resetMission() {
    const base = store.stops.find((s) => s.kind === "base")!;
    const w = this.terrain.toWorld(lonLatToXY(base));
    const first = store.route?.stops[1];
    const fw = first ? this.terrain.toWorld(lonLatToXY(first)) : { x: w.x, z: w.z - 1 };
    this.player.place(w.x + (fw.x - w.x) / Math.max(Math.hypot(fw.x - w.x, fw.z - w.z), 1) * 12, w.z + (fw.z - w.z) / Math.max(Math.hypot(fw.x - w.x, fw.z - w.z), 1) * 12, Math.atan2(fw.x - w.x, -(fw.z - w.z)));
    this.player.odometer = 0; this.player.climbed = 0; this.player.autopilot = false;
    this.camYaw = this.player.heading;
    this.suit = newSuit();
    this.evaS = 0;
    this.done.clear();
    this.trail = [];
    this.navTarget = null;
    this.survey = null;
    this.scan.hide();
    this.scanEl.classList.remove("on");
    this.updateObjectives();
  }

  private deploy() {
    this.map.hide();
    this.screens.hideAll();
    this.resetMission();
    this.startDate = dateAtLTST(new Date(), this.map.startHour);
    this.state = "deploy";
    this.deployT = 0;
    this.deployFrom.pos.copy(this.camera.position);
    this.deployFrom.quat.copy(this.camera.quaternion);
  }

  private touchdown() {
    this.state = "play";
    this.hud.visible = true;
    this.hud.toast(`<b>EVA START</b> · Sol ${marsTime(this.startDate).sol} · ${fmtClock(this.map.startHour)} LTST · press <b>F</b> for autopilot`);
    this.audio.beep(660); setTimeout(() => this.audio.beep(990), 160);
  }

  private endEva(success: boolean, reason: string) {
    this.state = "debrief";
    this.player.autopilot = false;
    this.hud.visible = false;
    const r = store.route;
    const sci = (r?.stops ?? []).filter((s) => s.id !== "base");
    this.screens.debrief({
      success, reason,
      stopsDone: sci.filter((s) => this.done.has(s.id)).length, stopsTotal: sci.length,
      distM: this.player.odometer, planDistM: r?.totals.distM ?? 0,
      evaS: this.evaS, planEvaS: r?.totals.evaS ?? 0, climbM: this.player.climbed,
      doseMSv: this.suit.doseMSv, remainingPct: (this.suit.remainingH / SUIT.capacityH.value) * 100,
    }, () => this.toTitle());
  }

  private openMap() {
    if (this.state !== "play") return;
    this.map.show("map");
    this.pushLiveToMap();
  }
  private closeMap() { this.map.hide(); }

  // ---------- mission ----------
  private onPlanChanged() {
    const r = store.route;
    this.planRibbon.set(r ? r.points.map((p) => this.terrain.toWorld(p)) : []);
    this.updateObjectives();
    if (this.state === "play" && this.navTarget?.kind === "stop") this.navTarget = null;
  }

  private objectives(): Objective[] {
    const r = store.route;
    if (!r) return [];
    const sci = r.stops.filter((s) => s.id !== "base");
    const list: Objective[] = sci.map((s) => ({ id: s.id, label: `Survey ${s.name.split(" - ")[0]}`, done: this.done.has(s.id), active: false }));
    list.push({ id: "base", label: "Return to base", done: false, active: false });
    const a = list.find((o) => !o.done);
    if (a) a.active = true;
    return list;
  }

  private updateObjectives() {
    const objs = this.objectives();
    for (const b of this.beacons) {
      const inPlan = objs.some((o) => o.id === b.id);
      if (b.id === "base") { b.setState("base"); continue; }
      b.group.visible = inPlan;
      b.setState(this.done.has(b.id) ? "done" : objs.find((o) => o.active)?.id === b.id ? "next" : "pending");
    }
  }

  private currentTarget(): { name: string; x: number; z: number; id: string | null } | null {
    if (this.navTarget?.kind === "point") return { name: this.navTarget.label, x: this.navTarget.x, z: this.navTarget.z, id: null };
    const id = this.navTarget?.kind === "stop" ? this.navTarget.id : this.objectives().find((o) => o.active)?.id;
    const s = store.stops.find((q) => q.id === id);
    if (!s) return null;
    const w = this.terrain.toWorld(lonLatToXY(s));
    return { name: s.name.split(" - ")[0], x: w.x, z: w.z, id: s.id };
  }

  private here(): Stop {
    const p = this.terrain.toProj(this.player.x, this.player.z);
    return { id: "here", name: "You", ...xyToLonLat(p) };
  }

  /** A* from the player to the current target; called on target change or when off-route. */
  private replanNav(reason: string) {
    const t = this.currentTarget();
    if (!t) { this.navRoute = null; this.navRibbon.set([]); return; }
    const goal: Stop = { id: t.id ?? "pt", name: t.name, ...this.terrain.lonLat(t.x, t.z) };
    try {
      const r = routeThrough(this.grid, [this.here(), goal], WALKING);
      if (!r.points.length) throw new Error("no path");
      this.navRoute = r;
      const pts = r.points.map((p) => this.terrain.toWorld(p));
      pts.unshift({ x: this.player.x, z: this.player.z });
      pts.push({ x: t.x, z: t.z });
      this.navRibbon.set(pts);
      if (reason) this.hud.toast(`A* ${reason}: ${fmtDist(r.totals.distM)} to ${t.name} <small>(${r.computeMs.toFixed(0)} ms)</small>`, 2500);
    } catch {
      this.navRoute = null;
      this.navRibbon.set([]);
      this.hud.toast(`No safe walking path to ${t.name} from here`, 3000);
    }
  }

  private navigateTo(p: LL, label: string) {
    const w = this.terrain.toWorld(lonLatToXY(p));
    const stop = store.stops.find((s) => Math.abs(s.lon - p.lon) < 1e-7 && Math.abs(s.lat - p.lat) < 1e-7);
    this.navTarget = stop ? { kind: "stop", id: stop.id } : { kind: "point", x: w.x, z: w.z, label };
    this.closeMap();
    this.replanNav("route");
  }

  private updateHome() {
    const base = store.stops.find((s) => s.kind === "base")!;
    try {
      const r = routeThrough(this.grid, [this.here(), base], WALKING);
      this.ret = returnCheck(this.suit, r.totals.walkS, r.totals.distM, r.totals.climbM);
      this.homePts = r.points.map((p) => this.terrain.toWorld(p));
    } catch {
      this.ret = null;
      this.homePts = [];
    }
    const show = this.showHome || (this.ret && this.ret.status !== "ok");
    this.homeRibbon.set(show ? this.homePts : []);
  }

  private startTask(i: number) {
    const sv = this.survey;
    if (!sv) return;
    sv.tasks[i].running = true;
    this.audio.beep(740);
  }

  private tickSurvey(dt: number) {
    const sv = this.survey;
    if (!sv) return;
    const t = sv.tasks.find((k) => k.running);
    if (t) {
      const realS = 3.5; // each task plays out in ~3.5 s real time
      const dp = dt / realS;
      t.progress = Math.min(1, t.progress + dp);
      const simDt = dp * t.min * 60;
      this.evaS += simDt;
      this.suit = tickSuit(this.suit, simDt, metabolicFactor(false, 0));
      if (t.progress >= 1) { t.running = false; t.done = true; this.audio.beep(990); }
      if (sv.tasks.every((k) => k.done) && !this.done.has(sv.stop.id)) {
        this.done.add(sv.stop.id);
        this.updateObjectives();
        this.hud.toast(`<b>SITE SURVEYED</b> · ${sv.stop.name.split(" - ")[0]} · sample bagged`, 4000);
        this.navTarget = null;
        this.replanNav("next objective");
      }
    }
    const n = String(store.stops.indexOf(sv.stop));
    this.screens.survey(sv.stop, n, sv.tasks, (i) => this.startTask(i), () => this.leaveSurvey());
  }

  private leaveSurvey() {
    this.survey = null;
    this.player.kneel = 0;
    this.screens.hideAll();
  }

  private interact() {
    if (this.state !== "play" || this.survey) return;
    const near = this.nearStop();
    if (!near) return;
    if (near.kind === "base") {
      const sci = (store.route?.stops ?? []).filter((s) => s.id !== "base");
      if (this.evaS < 60 && this.player.odometer < 20) return;
      const all = sci.every((s) => this.done.has(s.id));
      this.endEva(all, all ? "All planned science stops surveyed and crew back at base with margin." :
        `Returned to base early: ${sci.filter((s) => this.done.has(s.id)).length} of ${sci.length} stops surveyed.`);
      return;
    }
    if (this.done.has(near.id)) return;
    this.player.autopilot = false;
    this.player.kneel = 1;
    this.survey = { stop: near, tasks: SURVEY_TASKS.map((t) => ({ ...t, done: false, running: false, progress: 0 })) };
  }

  private nearStop(): StopInfo | null {
    const inPlan = new Set((store.route?.stops ?? []).map((s) => s.id));
    for (const s of store.stops) {
      if (!inPlan.has(s.id)) continue;
      const w = this.terrain.toWorld(lonLatToXY(s));
      if (Math.hypot(w.x - this.player.x, w.z - this.player.z) < 14) return s;
    }
    return null;
  }

  // ---------- world scan (click) ----------
  private scanAt(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    let prev = 0, hit = -1;
    for (let t = 1; t < 4000; t += t < 50 ? 0.5 : t < 400 ? 2 : 8) {
      const x = o.x + d.x * t, z = o.z + d.z * t;
      if (!this.terrain.inside(x, z)) { if (t > 50) break; else continue; }
      if (o.y + d.y * t < this.terrain.heightAt(x, z)) {
        let lo = prev, hi = t;
        for (let k = 0; k < 20; k++) {
          const m = (lo + hi) / 2;
          if (o.y + d.y * m < this.terrain.heightAt(o.x + d.x * m, o.z + d.z * m)) hi = m; else lo = m;
        }
        hit = hi; break;
      }
      prev = t;
    }
    if (hit < 0) return;
    const x = o.x + d.x * hit, z = o.z + d.z * hit, y = this.terrain.heightAt(x, z);
    this.scan.show(x, y, z);
    this.audio.beep(1200, 0.06);
    const gi = xyToIdx(this.grid, this.terrain.toProj(x, z));
    const why = gi >= 0 ? blockReason(this.grid, gi, WALKING) : "outside DTM";
    const dist = Math.hypot(x - this.player.x, z - this.player.z);
    const brg = (Math.atan2(x - this.player.x, -(z - this.player.z)) * 180 / Math.PI + 360) % 360;
    const local = this.terrain.slopeDeg(x, z);
    this.scanEl.innerHTML = `
      <div class="g-title">TERRAIN SCAN <button class="sx">&times;</button></div>
      <div class="kpis small">
        <div><span>${(y + this.terrain.meta.yRef).toFixed(1)} m</span>elevation</div>
        <div><span>${local.toFixed(0)}° / ${gi >= 0 ? this.grid.slope[gi].toFixed(0) : "-"}°</span>slope here / cell p90</div>
        <div><span>${gi >= 0 ? this.grid.rough[gi].toFixed(2) : "-"} m</span>roughness</div>
        <div><span>${fmtDist(dist)} · ${brg.toFixed(0)}°</span>range · bearing</div>
      </div>
      <p class="${why ? "warn" : "ok-text"}">${why ? `NO-GO: ${why}` : "Walkable for this crew profile"}</p>
      <button class="btn small go" ${why ? "disabled" : ""}>Navigate here (A*) <kbd>N</kbd></button>`;
    this.scanEl.classList.add("on");
    this.scanEl.querySelector<HTMLButtonElement>(".sx")!.onclick = () => { this.scanEl.classList.remove("on"); this.scan.hide(); };
    const go = () => { this.navTarget = { kind: "point", x, z, label: "Scan waypoint" }; this.replanNav("route"); this.scanEl.classList.remove("on"); };
    this.scanEl.querySelector<HTMLButtonElement>(".go")!.onclick = go;
    (this.scanEl as HTMLDivElement & { go?: () => void }).go = why ? undefined : go;
  }

  // ---------- input ----------
  private bindInput() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; moved: number } | null = null;
    el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, moved: 0 }; el.setPointerCapture(e.pointerId); this.audio.start(); });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.movementX, dy = e.movementY;
      down.moved += Math.abs(dx) + Math.abs(dy);
      if (down.moved > 4 && this.state === "play") {
        this.camYaw += dx * 0.005;
        this.camPitch = Math.min(1.3, Math.max(this.camMode === "first" ? -0.9 : -0.25, this.camPitch + dy * 0.004));
        this.lastDrag = this.time;
      }
    });
    el.addEventListener("pointerup", (e) => {
      if (down && down.moved <= 4 && this.state === "play") this.scanAt(e.clientX, e.clientY);
      down = null;
    });
    el.addEventListener("wheel", (e) => {
      if (this.state !== "play" || this.camMode === "first") return;
      this.camDist = Math.min(40, Math.max(2.5, this.camDist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: true });

    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === " ") e.preventDefault();
      if (this.state !== "play") return;
      if (k === "m") { this.map.open ? this.closeMap() : this.openMap(); }
      if (k === "escape") { if (this.map.open) this.closeMap(); else if (this.survey) this.leaveSurvey(); else { this.scanEl.classList.remove("on"); this.scan.hide(); } }
      if (this.map.open) return;
      if (k === "e") this.interact();
      if (k === "f") {
        this.player.autopilot = !this.player.autopilot;
        if (this.player.autopilot && !this.navRoute) this.replanNav("route");
        this.hud.toast(this.player.autopilot ? "<b>AUTOPILOT ON</b> · following the A* route" : "Autopilot off");
      }
      if (k === "v") { this.camMode = this.camMode === "third" ? "first" : "third"; this.hud.setMode(this.camMode); this.astro.setVisible(this.camMode === "third"); }
      if (k === "[" || k === "]") {
        this.warpIdx = Math.min(WARPS.length - 1, Math.max(0, this.warpIdx + (k === "]" ? 1 : -1)));
        this.hud.toast(`Time warp ×${WARPS[this.warpIdx]}`, 1200);
      }
      if (k === "h") { this.showHome = !this.showHome; this.updateHome(); this.hud.toast(this.showHome ? "Path home shown (A* to base)" : "Path home hidden", 1500); }
      if (k === "n") (this.scanEl as HTMLDivElement & { go?: () => void }).go?.();
      if (k === "p") this.audio.muted = !this.audio.muted;
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private resize() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.css.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- frame ----------
  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    this.beaconTime.value = this.time;
    const playing = this.state === "play";
    const paused = this.map.open && playing;
    const warp = WARPS[this.warpIdx];
    const dtSim = playing && !paused && !this.survey ? dt * warp : 0;

    // sun from the Mars clock
    const date = new Date(this.startDate.getTime() + this.evaS * 1000);
    const mt = marsTime(this.state === "title" || this.state === "briefing" ? dateAtLTST(new Date(), 16.2 + Math.sin(this.time * 0.02) * 0.4) : date);
    const sp = sunPosition(mt.ltst, mt.decl);
    this.sky.setSun(sp.elevDeg, sp.azDeg);
    visorMat.envMap = this.sky.envMap();

    if (playing || this.state === "deploy") {
      const k = this.keys;
      const input = {
        fwd: (k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0),
        right: (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("a") || k.has("arrowleft") ? 1 : 0),
        run: k.has("shift"), hop: k.has(" "),
      };
      if (input.fwd || input.right) this.player.autopilot = false;
      const frozen = !playing || paused || !!this.survey;
      this.player.update(dtSim, paused ? 0 : dt, input, this.camYaw, this.player.autopilot ? this.navRibbon : null, frozen);
      if (playing) this.tickPlay(dt, dtSim, mt.ltst, mt.sol, mt.ls);
    }
    this.updateCamera(dt);
    this.terrain.detailUniforms.uCamPos.value.copy(this.camera.position);
    const focus = this.state === "play" || this.state === "deploy" ? this.player.pos : this.camera.position;
    this.sky.follow(focus);
    this.sky.mesh.position.copy(this.camera.position); // dome always centred on the viewer
    this.rocks.update(this.player.x, this.player.z);
    this.puffs.update(dt, this.wind);
    this.dust.update(dt, this.camera.position, this.wind);
    this.scan.update(dt);
    this.navRibbon.update(this.time);
    this.planRibbon.update(this.time);
    this.homeRibbon.update(this.time);
    for (const b of this.beacons) (b.group.userData.tick as (() => void) | undefined)?.();
    this.audio.update(dt, Math.min(1, this.player.speed / 1.2 + Math.max(0, this.player.grade) * 2), 0.3);

    this.composer.render();
    this.css.domElement.style.display = playing || this.state === "deploy" ? "" : "none";
    this.css.render(this.scene, this.camera);
  }

  private tickPlay(dt: number, dtSim: number, ltst: number, sol: number, ls: number) {
    const p = this.player;
    this.evaS += dtSim;
    this.suit = tickSuit(this.suit, dtSim, metabolicFactor(p.moving && p.speed > 0.05, p.grade));
    this.tickSurvey(dt);

    // trail
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 3) this.trail.push({ x: p.x, z: p.z });

    // navigation: (re)plan on target change or when > 15 m off the ribbon
    const tgt = this.currentTarget();
    this.navCheckT -= dt;
    if (tgt && this.navCheckT <= 0) {
      this.navCheckT = 1;
      const end = this.navRibbon.pts[this.navRibbon.pts.length - 1];
      const stale = !end || Math.hypot(end.x - tgt.x, end.z - tgt.z) > 2;
      const off = this.navRibbon.length() > 0 && this.navRibbon.project(p.x, p.z).dist > 15;
      if (stale) this.replanNav(this.navRibbon.length() ? "new target" : "");
      else if (off) this.replanNav("re-planned (off route)");
    }
    const pr = this.navRibbon.length() ? this.navRibbon.project(p.x, p.z) : null;
    if (pr) this.navRibbon.setDone(pr.along);
    const remain = pr ? Math.max(0, this.navRibbon.length() - pr.along) : null;
    if (this.navTarget?.kind === "point" && remain != null && remain < 3) {
      this.navTarget = null;
      this.hud.toast("Waypoint reached");
      this.replanNav("next objective");
    }
    if (p.autopilot && remain != null && remain < 2) { p.autopilot = false; this.hud.toast("Arrived · autopilot off"); }

    // point of no return (A* home every 2 s real time)
    this.homeT -= dt;
    if (this.homeT <= 0) { this.homeT = 2; this.updateHome(); }
    if (this.suit.remainingH <= 0) { this.endEva(false, "Suit consumables exhausted before reaching base."); return; }

    // prompts + warnings
    const near = this.nearStop();
    if (this.survey) this.hud.prompt("");
    else if (near?.kind === "base" && (this.evaS > 60 || p.odometer > 20)) this.hud.prompt(`<kbd>E</kbd> End EVA at base`);
    else if (near && near.kind === "science" && !this.done.has(near.id)) this.hud.prompt(`<kbd>E</kbd> Survey ${near.name.split(" - ")[0]}`);
    else this.hud.prompt("");
    const gi = xyToIdx(this.grid, this.terrain.toProj(p.x, p.z));
    const cellBlocked = gi >= 0 ? blockReason(this.grid, gi, WALKING) : null;
    this.hud.warn(
      p.blocked === "steep" ? "TOO STEEP TO CLIMB · find another line" :
      p.blocked === "boundary" ? "EDGE OF SURVEY AREA (DTM coverage)" :
      this.ret?.status === "critical" ? "PAST POINT OF NO RETURN · RETURN TO BASE NOW" :
      this.ret?.status === "turn-back" ? "TURN BACK SOON · return margin under 30 min" :
      cellBlocked ? `OFF-LIMITS TERRAIN · ${cellBlocked}` : "");

    // HUD
    const brg = (x: number, z: number) => (Math.atan2(x - p.x, -(z - p.z)) * 180 / Math.PI + 360) % 360;
    const markers = [];
    for (const s of store.route?.stops ?? []) {
      if (s.id !== "base" && this.done.has(s.id)) continue;
      const w = this.terrain.toWorld(lonLatToXY(s));
      const isNext = tgt?.id === s.id;
      markers.push({ bearing: brg(w.x, w.z), label: s.name.split(" - ")[0], kind: (isNext ? "next" : s.id === "base" ? "base" : "stop") as "next" | "base" | "stop", dist: 0 });
    }
    if (tgt && !tgt.id) markers.push({ bearing: brg(tgt.x, tgt.z), label: tgt.name, kind: "nav" as const, dist: 0 });
    const walkS = this.navRoute && remain != null ? this.navRoute.totals.walkS * (remain / Math.max(this.navRibbon.length(), 1)) : null;
    this.hud.update({
      headingDeg: ((this.camYaw * 180) / Math.PI % 360 + 360) % 360,
      markers, objectives: this.objectives(),
      ltst: fmtClock(ltst), sol, ls, evaS: this.evaS, suit: this.suit, ret: this.ret,
      tempC: airTempAt(this.analogue, ltst),
      speed: p.speed, grade: p.grade, slopeDeg: this.terrain.slopeDeg(p.x, p.z), elev: p.y + this.terrain.meta.yRef,
      warp: WARPS[this.warpIdx], navDist: remain, navTime: walkS, navName: tgt?.name ?? "",
      autopilot: p.autopilot, mode: this.camMode, odometer: p.odometer,
    });
    const planPts = store.route ? store.route.points.map((q) => this.terrain.toWorld(q)) : [];
    this.hud.drawMinimap({
      x: p.x, z: p.z, heading: p.heading, camYaw: this.camYaw,
      plan: planPts, nav: this.navRibbon.pts, home: this.showHome || (this.ret && this.ret.status !== "ok") ? this.homePts : [],
      trail: this.trail,
      stops: (store.route?.stops ?? []).filter((s, i, a) => a.findIndex((q) => q.id === s.id) === i).map((s) => {
        const w = this.terrain.toWorld(lonLatToXY(s));
        return { x: w.x, z: w.z, label: s.id === "base" ? "⌂" : String(store.stops.findIndex((q) => q.id === s.id)), state: s.id === "base" ? "base" : this.done.has(s.id) ? "done" : "pending" };
      }),
      scan: this.scan.group.visible ? { x: this.scan.group.position.x, z: this.scan.group.position.z } : null,
    });
    // beacon distance labels
    for (const b of this.beacons) {
      const d = Math.hypot(b.group.position.x - p.x, b.group.position.z - p.z);
      const el = b.label.querySelector(".bd");
      if (el) el.textContent = fmtDist(d);
    }
    if (this.map.open) this.pushLiveToMap();
  }

  private pushLiveToMap() {
    const ll = (q: P2) => this.terrain.lonLat(q.x, q.z);
    this.map.setLive({ ...ll({ x: this.player.x, z: this.player.z }), headingDeg: this.player.heading * 180 / Math.PI },
      this.trail.map(ll), this.navRibbon.pts.filter((_, i) => i % 3 === 0).map(ll), this.homePts.map(ll));
  }

  private updateCamera(dt: number) {
    const cam = this.camera;
    const p = this.player;
    if (this.state === "title" || this.state === "briefing" || this.state === "debrief") {
      // slow cinematic orbit: AOI in the foreground, Mount Sharp behind
      this.titleT += dt;
      const cx = this.terrain.meta.width / 2, cz = this.terrain.meta.depth / 2;
      const summit = this.terrain.toWorld(lonLatToXY({ lon: 137.85, lat: -5.08 }));
      const toS = new THREE.Vector2(summit.x - cx, summit.z - cz).normalize();
      const a = Math.atan2(toS.y, toS.x) + Math.PI + Math.sin(this.titleT * 0.03) * 0.5;
      const R = 2600;
      const x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
      cam.position.set(x, this.terrain.heightAt(cx, cz) + 520, z);
      cam.lookAt(cx + toS.x * 6000, this.terrain.heightAt(cx, cz) + 900, cz + toS.y * 6000);
      return;
    }
    // auto-align camera behind the player while walking (unless the user is steering the view)
    if ((p.autopilot || p.moving) && this.time - this.lastDrag > 2.5 && this.camMode === "third") {
      let d = p.heading - this.camYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw += d * Math.min(1, dt * (p.autopilot ? 1.2 : 0.6));
    }
    const target = new THREE.Vector3(p.x, p.y + 1.55, p.z);
    let pos: THREE.Vector3;
    const look = new THREE.Vector3();
    if (this.camMode === "first") {
      pos = this.astro.eye(new THREE.Vector3());
      pos.set(p.x, p.y + 1.72, p.z);
      const fx = Math.sin(this.camYaw) * Math.cos(this.camPitch - 0.28), fz = -Math.cos(this.camYaw) * Math.cos(this.camPitch - 0.28);
      look.set(pos.x + fx, pos.y - Math.sin(this.camPitch - 0.28), pos.z + fz);
    } else {
      const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
      pos = new THREE.Vector3(
        target.x - Math.sin(this.camYaw) * cp * this.camDist,
        target.y + sp * this.camDist,
        target.z + Math.cos(this.camYaw) * cp * this.camDist);
      const ground = this.terrain.heightAt(pos.x, pos.z) + 0.6;
      if (pos.y < ground) pos.y = ground;
      look.copy(target);
    }
    if (this.state === "deploy") {
      this.deployT += dt / 5.5;
      const t = Math.min(this.deployT, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const m = new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      // arc: rise up while travelling so we swoop down onto the astronaut
      const lift = Math.sin(e * Math.PI) * 300 * (1 - e);
      cam.position.lerpVectors(this.deployFrom.pos, pos, e).y += lift;
      cam.quaternion.slerpQuaternions(this.deployFrom.quat, q, e);
      if (t >= 1) this.touchdown();
      return;
    }
    cam.position.copy(pos);
    cam.lookAt(look);
  }
}
