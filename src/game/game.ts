// Game orchestrator. States: title -> (briefing) -> deploy -> play -> debrief.
// Modes: Mission (plan stops, collect samples, return them to the habitat) and Free Explore.
// Travel: on foot or in the buggy. Survival: suit consumables + heater load in the cold, falls,
// oxygen-out, solar particle events, dust devils, night. Live A* for walking or driving (park & walk).

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { DUST, EVA, RADIATION, ROVER, SUIT, SURVIVAL, WALKING, withSlopeLimit, type TerrainProfile } from "../core/config";
import { blockReason } from "../core/cost";
import { type Grid, lonLatToXY, xyToIdx, xyToLonLat } from "../core/grid";
import { nearestReachable, routeThrough, type Route, type Stop } from "../core/route";
import { commLink, CONJUNCTION_DEG } from "../core/space";
import { dateAtLTST, fmtClock, MARS_HOUR_S, marsTime, sunPosition } from "../core/sun";
import { metabolicFactor, newSuit, returnCheck, tickSuit, type ReturnCheck, type SuitState } from "../core/suit";
import { canCarry, damage, heaterLoad, impactDamage, newVitals, SAMPLE_LIMIT_KG, tickVitals, type Sample, type Vitals } from "../core/survival";
import { MissionMap, type LL } from "../planner/missionMap";
import { airTempAt, remsAnalogue, spaceWeather, type Donki, type Rems, type RemsSol } from "../shared/conditions";
import type { Landmark, StopInfo } from "../shared/data";
import { fmtDist, fmtDur } from "../shared/format";
import { store } from "../shared/store";
import { Astronaut, visorMat } from "./astronaut";
import { SuitAudio } from "./audio";
import { Buddy } from "./buddy";
import { Director, type DemoStep } from "./demo";
import { Buggy } from "./buggy";
import { AmbientDust, DustPuffs, Footprints, Rocks, wheelTrackTexture } from "./effects";
import { Helmet } from "./helmet";
import { Hud, type Objective } from "./hud";
import { makeBeacon, RouteRibbon, ScanMarker, type Beacon, type P2 } from "./markers";
import { Menus, type JournalEntry, type Settings } from "./menus";
import { PhotoMode } from "./photo";
import { TouchControls } from "./touch";
import { XRMode } from "./xr";
import { Player } from "./player";
import { DustDevils, Habitat, LooseRocks, makeCuriosity, makeTracks, Shelter, Specimens } from "./props";
import { Screens } from "./screens";
import { MarsSky } from "./sky";
import type { Terrain } from "./terrain";

type State = "title" | "briefing" | "deploy" | "play" | "debrief";
type Mode = "mission" | "explore";
type AlertLevel = "info" | "caution" | "danger";
type NavRoute = Route & { label?: string };
const WARPS = [1, 2, 5, 10, 30, 60];
const SURVEY_TASKS = [
  { label: "Image the outcrop (Mastcam-style panorama)", min: EVA.stopDwellMin.value / 3 },
  { label: "Drill & bag the site sample", min: (EVA.stopDwellMin.value * 2) / 3 },
];
const OVERLAYS = ["off", "slope", "go/no-go (A*)", "elevation", "thermal (THEMIS)", "minerals (CRISM)"] as const;

export interface World { traverse: P2[][]; landmarks: Landmark[] }

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private css: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.05, 250000);
  private sky: MarsSky;
  private astro = new Astronaut();
  private player: Player;
  private buggy: Buggy;
  private buddy: Buddy;
  private hab: Habitat;
  private shelter = new Shelter();
  private hud: Hud;
  private helmet: Helmet;
  private photo: PhotoMode;
  private director: Director;
  private touch: TouchControls;
  private xr: XRMode;
  private demoSaved: Settings | null = null;
  private captureNext = false;
  private screens: Screens;
  private menus: Menus;
  private map: MissionMap;
  private audio = new SuitAudio();
  private footprints: Footprints;
  private wheelTracks: Footprints;
  private puffs: DustPuffs;
  private dust = new AmbientDust();
  private rocks: Rocks;
  private loose: LooseRocks;
  private specimens: Specimens;
  private devils: DustDevils;
  private navRibbon: RouteRibbon;
  private homeRibbon: RouteRibbon;
  private planRibbon: RouteRibbon;
  private scan = new ScanMarker();
  private beacons: Beacon[] = [];
  private landmarkPosts: { lm: Landmark; g: THREE.Group; x: number; z: number }[] = [];
  private beaconTime = { value: 0 };
  private clock = new THREE.Clock();
  private overlayTex: Record<string, { tex: THREE.Texture; rect: { x0: number; z0: number; w: number; h: number } }> = {};

  private state: State = "title";
  private mode: Mode = "mission";
  private keys = new Set<string>();
  private camYaw = 0; private camPitch = 0.16; private camDist = 5.5;
  private camMode: "third" | "first" = "third";
  private lastDrag = -10;
  private warpIdx = 2;
  private driveAlong = 0;
  private driveVer = -1;
  private time = 0;
  private titleT = 0;
  private settings: Settings;

  // EVA state
  private driving = false;
  private startDate = new Date();
  private evaS = 0;
  private suit: SuitState = newSuit();
  private vitals: Vitals = newVitals();
  private ret: ReturnCheck | null = null;
  private surveyed = new Set<string>();
  private discovered = new Set<string>();
  private bag: Sample[] = [];
  private deposited: Sample[] = [];
  private navTarget: { kind: "stop"; id: string } | { kind: "point"; x: number; z: number; label: string } | null = null;
  private navRoute: NavRoute | null = null;
  private navCheckT = 0; private homeT = 0; private scanBeepT = 0;
  private showHome = false;
  private homePts: P2[] = [];
  private trail: P2[] = [];
  private survey: { stop: StopInfo; tasks: { label: string; min: number; done: boolean; running: boolean; progress: number }[] } | null = null;
  private sheltered: "" | "hab" | "shelter" = "";
  private analogue: RemsSol;
  private deployT = 0;
  private deployFrom = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private wind = new THREE.Vector3(0.8, 0, 0.3);
  private scanEl: HTMLDivElement;
  private scanner = false;
  private overlayIdx = 0;
  private visorDust = 0; private frost = 0;
  private goldVisor = false;
  private lampsAuto = true; private lampsOn = false;
  private held: ReturnType<LooseRocks["nearest"]> = null;
  private sep: { phase: "none" | "warning" | "active" | "over"; t: number; doseMSv: number } = { phase: "none", t: 0, doseMSv: 0 };
  private devilNear = Infinity;
  private sunsetWarned = false;
  private tempC = -50;
  private sunElev = 30;
  private ltst = 9;
  private paused = false;
  // comms with Earth: every report waits for the real one-way light time, replies take the round trip
  private storm: { phase: "none" | "warning" | "active" | "over"; t: number; peak: number; dur: number } = { phase: "none", t: 0, peak: 0, dur: 0 };
  private tau = DUST.clearTau.value;
  private comms: { reply: string; sentS: number; arriveS: number; delivered: boolean }[] = [];

  constructor(private root: HTMLElement, private terrain: Terrain, private grid: Grid, private rems: Rems, private donki: Donki | null, private world: World) {
    const r = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.css = new CSS2DRenderer();
    this.css.domElement.className = "labels";
    root.appendChild(this.css.domElement);

    this.sky = new MarsSky(r);
    this.scene.add(this.sky.mesh, this.sky.sun, this.sky.sun.target, this.sky.hemi);
    this.scene.fog = this.sky.fog;
    this.scene.add(terrain.group, this.astro.root, this.camera);
    this.player = new Player(terrain, this.astro);
    this.astro.ground = (x, z) => terrain.heightAt(x, z);
    this.buggy = new Buggy(terrain);
    this.scene.add(this.buggy.root);
    this.buddy = new Buddy(terrain, grid);
    this.scene.add(this.buddy.astro.root);
    this.buddy.astro.onStep = (f) => { if (this.state === "play") { this.footprints.add(f.x, f.z, this.buddy.heading); this.puffs.burst(f, 4, 0.6); } };
    this.buddy.onSay = (m) => this.hud.toast(m, 3500);
    this.buddy.onTake = (sp) => { this.specimens.take(sp); this.updateObjectives(); };
    this.buddy.onHandover = (sp) => {
      const site = sp.site === "plain" || sp.site === "crism" ? (sp.site === "crism" ? "CRISM target" : "open plains") : store.stops.find((q) => q.id === sp.site)?.name.split(" - ")[0] ?? sp.site;
      const smp: Sample = { id: sp.id, name: sp.name, site, massKg: sp.massKg, about: sp.about };
      if (!canCarry(this.bag, smp)) { this.hud.toast("EV2: your bag is full, I'll hang on to this one until we're at the habitat"); return false; }
      this.bag.push(smp); this.updateObjectives();
      this.hud.toast(`<b>EV2 HANDOVER</b> · ${smp.name} (${smp.massKg} kg) into your bag`, 3500); this.audio.beep(1050);
      return true;
    };
    this.footprints = new Footprints(terrain);
    this.wheelTracks = new Footprints(terrain, 0.26, 0.6, wheelTrackTexture());
    this.puffs = new DustPuffs(terrain);
    this.rocks = new Rocks(terrain, grid);
    this.devils = new DustDevils(terrain);
    this.scene.add(this.footprints.mesh, this.wheelTracks.mesh, this.puffs.points, this.dust.points, this.rocks.group, this.scan.group, this.shelter.group, this.devils.group);
    this.planRibbon = new RouteRibbon(terrain, 0xff9d00, 0.5, 0.35);
    this.navRibbon = new RouteRibbon(terrain, 0x00e5ff, 0.8, 1);
    this.homeRibbon = new RouteRibbon(terrain, 0xff5a3c, 0.5, 0.8);
    this.scene.add(this.planRibbon.mesh, this.navRibbon.mesh, this.homeRibbon.mesh);

    // base layout: habitat beside the base waypoint
    const bw = terrain.toWorld(lonLatToXY(this.baseStop()));
    this.hab = new Habitat(terrain, bw.x - 16, bw.z + 10, Math.PI * 0.35);
    this.scene.add(this.hab.group);
    this.player.collide = (p) => this.hab.collide(p);

    // Curiosity at its latest position, facing along its last drive
    const cur = store.stops.find((s) => s.id === "curiosity");
    const line = world.traverse.flat();
    if (cur && line.length) {
      const cw = terrain.toWorld(lonLatToXY(cur));
      let bi = 0;
      line.forEach((p, i) => { if (Math.hypot(p.x - cw.x, p.z - cw.z) < Math.hypot(line[bi].x - cw.x, line[bi].z - cw.z)) bi = i; });
      const prev = line[Math.max(0, bi - 3)];
      const head = Math.atan2(cw.x - prev.x, -(cw.z - prev.z));
      this.scene.add(makeCuriosity(terrain, cw.x + 3, cw.z, isFinite(head) ? head : 0));
    }
    this.scene.add(makeTracks(terrain, world.traverse));

    // landmarks (Curiosity's past stopping points) as small gold posts
    const postMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, toneMapped: false });
    for (const lm of world.landmarks) {
      const w = terrain.toWorld(lonLatToXY(lm));
      const g = new THREE.Group();
      g.position.set(w.x, terrain.heightAt(w.x, w.z), w.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), postMat);
      pole.position.y = 1.1;
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), postMat);
      gem.position.y = 2.6;
      g.add(pole, gem);
      this.scene.add(g);
      this.landmarkPosts.push({ lm, g, x: w.x, z: w.z });
    }

    // throwable rocks near base and the first sites; collectible specimens around the science sites
    const sciW = store.stops.filter((s) => s.kind === "science").map((s) => ({ id: s.id, ...terrain.toWorld(lonLatToXY(s)) }));
    this.loose = new LooseRocks(terrain, [{ x: bw.x + 6, z: bw.z - 6 }, ...sciW.slice(0, 3)]);
    this.loose.onImpact = (p, v) => { this.puffs.burst(p, Math.min(30, Math.round(v * 5)), Math.min(2, v / 3)); this.audio.step(); };
    const hot = (store.crism?.hotspots(8) ?? []).map((h) => ({
      ...terrain.toWorld(lonLatToXY(h)),
      about: `CRISM (orbit) flagged this spot: ${h.r.label}, band depths SINDEX2 ${h.r.sindex2.toFixed(4)}, BD2100 ${h.r.bd2100.toFixed(4)}, BD1900 ${h.r.bd1900.toFixed(4)}. Bring it back so the lab can confirm.`,
    }));
    this.specimens = new Specimens(terrain, grid, sciW, hot);
    this.scene.add(this.loose.group, this.specimens.group);

    this.hud = new Hud(root, terrain.meta.overview.file, terrain.meta.width, terrain.meta.depth);
    this.hud.visible = false;
    this.hud.onExpand = () => this.openMap();
    this.helmet = new Helmet(root);
    this.photo = new PhotoMode(root);
    this.photo.onCapture = () => { this.captureNext = true; };
    this.photo.onExit = () => this.togglePhoto(false);
    this.touch = new TouchControls(root, (k) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: k })), 60);
    });
    this.xr = new XRMode(r, this.camera, this.scene, root);
    this.xr.onTrigger = () => {
      if (this.state !== "play") return;
      this.player.autopilot = !this.player.autopilot;
      if (this.player.autopilot && !this.navRoute) this.replanNav("route");
    };
    this.director = new Director(root);
    this.director.onEnd = () => this.endDemo();
    this.scanEl = document.createElement("div");
    this.scanEl.className = "g-scan";
    root.appendChild(this.scanEl);
    this.map = new MissionMap(root);
    this.screens = new Screens(root);
    this.menus = new Menus(root);
    this.settings = this.menus.settings;
    this.menus.onSettings = (s) => this.applySettings(s);
    this.menus.onClose = () => { this.paused = false; this.sheltered = ""; };

    this.astro.onStep = (f) => {
      if (this.state !== "play" || this.driving) return;
      this.footprints.add(f.x, f.z, this.player.heading);
      this.puffs.burst(f, 6, 0.8);
      this.audio.step();
    };
    this.player.onLand = (impact) => {
      this.puffs.burst(this.player.pos, 22, 1.4);
      this.audio.step();
      const dmg = impactDamage(impact) * this.hazardScale();
      if (dmg > 0) {
        this.vitals = damage(this.vitals, dmg, "Fatal fall");
        this.hud.toast(`<b>HARD LANDING</b> · ${impact.toFixed(1)} m/s impact · −${dmg.toFixed(0)} health`, 3000);
        this.audio.beep(220, 0.3);
      }
    };
    this.buggy.onWheel = (p, v) => { this.puffs.burst(p, 3, 0.4 + v / 6); this.wheelTracks.add(p.x, p.z, this.buggy.heading); };
    this.buggy.onLand = (impact) => {
      this.puffs.burst(this.buggy.pos, 30, 1.6);
      const dmg = Math.max(0, impact - 5) * 8 * this.hazardScale();
      if (dmg > 0) { this.vitals = damage(this.vitals, dmg, "Buggy crash"); this.hud.toast(`<b>HARD LANDING</b> · −${dmg.toFixed(0)} health`); }
    };
    this.buggy.onRoll = () => {
      const dmg = 35 * this.hazardScale();
      this.vitals = damage(this.vitals, dmg, "Buggy rollover");
      this.hud.toast(`<b>ROLLOVER!</b> The buggy tipped on a steep side slope · −${dmg.toFixed(0)} health · E near it to right it`, 5000);
      this.exitBuggy();
    };

    this.analogue = remsAnalogue(rems, marsTime(new Date()).ls);
    this.bindInput();
    window.addEventListener("resize", () => this.resize());
    this.applySettings(this.settings);
  }

  get loadingScreens() { return this.screens; }

  async init() {
    await this.map.init();
    this.map.onPlanChange = () => this.onPlanChanged();
    this.map.onBegin = () => this.deploy("mission");
    this.map.onClose = () => this.closeMap();
    this.map.onNavigate = (p, label) => this.navigateTo(p, label);
    this.map.onCapability = () => { if (this.state === "play") { this.navCheckT = 0; this.replanNav(`re-planned for a ${store.crewSlopeDeg}° crew limit`); } };
    this.map.onTravel = (t, h) => {
      this.settings.travel = t === "buggy" ? "buggy" : "foot";
      this.settings.startHour = h;
      this.hud.toast(`Scenario applied: ${t === "buggy" ? "buggy" : "on foot"}, start ${String(h).padStart(2, "0")}:00`, 2500);
    };
    this.screens.onPlan = () => { this.audio.start(); this.state = "briefing"; this.screens.hideAll(); this.map.show("briefing", this.briefingInfo()); };
    this.screens.onQuick = () => { this.audio.start(); this.deploy("mission"); };
    this.screens.onFree = () => { this.audio.start(); this.deploy("explore"); };
    this.screens.onOptions = () => this.menus.options();
    this.screens.onDemo = () => this.startDemo();
    this.buildOverlays();
    const n = (s: StopInfo) => (s.kind === "base" ? "&#8962;" : s.kind === "rover" ? "C" : String(store.stops.indexOf(s)));
    for (const s of store.stops) {
      const w = this.terrain.toWorld(lonLatToXY(s));
      const b = makeBeacon(this.terrain, s.id, s.name.split(" - ")[0], w.x, w.z, n(s), this.beaconTime);
      b.setState(s.kind === "base" ? "base" : "pending");
      this.beacons.push(b);
      this.scene.add(b.group);
    }
    this.onPlanChanged();
    this.resetEva();
    this.toTitle();
    this.renderer.setAnimationLoop(() => this.frame());
    if (new URLSearchParams(location.search).has("demo")) setTimeout(() => this.startDemo(), 1500);
  }

  // ---------- settings ----------
  private applySettings(s: Settings) {
    this.settings = s;
    const pr = s.graphics === "high" ? Math.min(window.devicePixelRatio, 1.5) : s.graphics === "medium" ? 1 : 0.75;
    this.renderer.setPixelRatio(pr);
    this.renderer.shadowMap.enabled = s.graphics !== "low";
    this.sky.sun.castShadow = s.graphics !== "low";
    this.sky.sun.shadow.mapSize.setScalar(s.graphics === "high" ? 2048 : 1024);
    this.sky.sun.shadow.map?.dispose();
    this.sky.sun.shadow.map = null;
    this.bloom.enabled = s.graphics !== "low";
    this.audio.muted = !s.sound;
    this.map.startHour = s.startHour;
    this.resize();
  }
  private hazardScale() { return this.settings.hazards === "realistic" ? 1 : this.settings.hazards === "forgiving" ? 0.5 : 0; }

  // ---------- data layers draped on the terrain ----------
  private buildOverlays() {
    const W = this.terrain.meta.width, D = this.terrain.meta.depth;
    const load = (f: string) => { const t = new THREE.TextureLoader().load(f); t.colorSpace = THREE.SRGBColorSpace; return t; };
    this.overlayTex["slope"] = { tex: load("overlays/slope.png"), rect: { x0: 0, z0: 0, w: W, h: D } };
    this.overlayTex["elevation"] = { tex: load("overlays/hillshade.png"), rect: { x0: 0, z0: 0, w: W, h: D } };
    const cr = store.crism;
    if (cr) {
      const nw = this.terrain.toWorld(lonLatToXY({ lon: cr.meta.bounds.west, lat: cr.meta.bounds.north }));
      const se = this.terrain.toWorld(lonLatToXY({ lon: cr.meta.bounds.east, lat: cr.meta.bounds.south }));
      const t = new THREE.CanvasTexture(cr.stretched());
      t.colorSpace = THREE.SRGBColorSpace; t.flipY = true;
      this.overlayTex["minerals (CRISM)"] = { tex: t, rect: { x0: nw.x, z0: nw.z, w: se.x - nw.x, h: se.z - nw.z } };
    }
    fetch("overlays/themis.json").then((r) => r.json()).then((t) => {
      const nw = this.terrain.toWorld(lonLatToXY({ lon: t.bounds.west, lat: t.bounds.north }));
      const se = this.terrain.toWorld(lonLatToXY({ lon: t.bounds.east, lat: t.bounds.south }));
      this.overlayTex["thermal (THEMIS)"] = { tex: load(t.file), rect: { x0: nw.x, z0: nw.z, w: se.x - nw.x, h: se.z - nw.z } };
    });
  }
  /** Go/no-go map for the current travel profile, straight from the A* passability test. */
  private goNoGo(p: TerrainProfile) {
    const g = this.grid;
    const data = new Uint8Array(g.cols * g.rows * 4);
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c, k = ((g.rows - 1 - r) * g.cols + c) * 4; // DataTexture row 0 is sampled at v = 0 (south)
      const bad = blockReason(g, i, p);
      const s = Math.min(1, g.slope[i] / p.maxSlopeDeg.value);
      data[k] = bad ? 230 : Math.round(60 + 160 * s); data[k + 1] = bad ? 40 : Math.round(200 - 60 * s); data[k + 2] = bad ? 40 : 70;
      data[k + 3] = bad ? 230 : 120;
    }
    const t = new THREE.DataTexture(data, g.cols, g.rows);
    t.needsUpdate = true; t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
    return { tex: t as THREE.Texture, rect: { x0: 0, z0: 0, w: this.terrain.meta.width, h: this.terrain.meta.depth } };
  }
  private setOverlay(i: number) {
    this.overlayIdx = i;
    const name = OVERLAYS[i];
    if (name === "off") { this.terrain.setOverlay(null); return; }
    const o = name.startsWith("go/no-go") ? this.goNoGo(this.profile) : this.overlayTex[name];
    if (o) this.terrain.setOverlay(o.tex, o.rect, name === "elevation" ? 0.6 : 0.65);
  }

  // ---------- states ----------
  private toTitle() {
    this.state = "title";
    this.hud.visible = false;
    this.helmet.visible = false;
    this.map.hide();
    this.menus.close();
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
      comm: commLink(new Date()),
    };
  }

  private get profile(): TerrainProfile { return this.driving ? ROVER : withSlopeLimit(WALKING, store.crewSlopeDeg); }
  private baseStop() { return store.stops.find((s) => s.kind === "base")!; }

  private resetEva() {
    const w = this.terrain.toWorld(lonLatToXY(this.baseStop()));
    const first = store.route?.stops[1];
    const fw = first ? this.terrain.toWorld(lonLatToXY(first)) : { x: w.x, z: w.z - 1 };
    const head = Math.atan2(fw.x - w.x, -(fw.z - w.z));
    this.player.place(w.x, w.z, head);
    Object.assign(this.player, { odometer: 0, climbed: 0, autopilot: false, airborne: false, vy: 0, kneel: 0 });
    this.buggy.place(w.x + Math.cos(head) * 7, w.z + Math.sin(head) * 7, head);
    this.buggy.battery = 1; this.buggy.odometer = 0;
    this.buddy.place(w.x - Math.sin(head) * 3.5 - Math.cos(head) * 2, w.z + Math.cos(head) * 3.5 - Math.sin(head) * 2, head);
    this.driving = false;
    this.astro.setVisible(true);
    this.camYaw = head;
    this.suit = newSuit();
    this.vitals = newVitals();
    this.evaS = 0;
    this.surveyed.clear(); this.discovered.clear(); this.bag = []; this.deposited = [];
    this.specimens.list.forEach((s) => { s.taken = false; s.mesh.visible = true; });
    this.trail = [];
    this.navTarget = null; this.navRoute = null; this.navRibbon.set([]);
    this.survey = null; this.sheltered = "";
    this.scan.hide(); this.scanEl.classList.remove("on");
    this.shelter.deployed = false; this.shelter.group.visible = false;
    this.sep = { phase: "none", t: 0, doseMSv: 0 };
    this.comms = [];
    this.storm = { phase: "none", t: 0, peak: 0, dur: 0 }; this.tau = DUST.clearTau.value;
    this.visorDust = 0; this.frost = 0; this.sunsetWarned = false; this.held = null;
    this.updateObjectives();
  }

  private deploy(mode: Mode) {
    this.mode = mode;
    this.map.hide();
    this.screens.hideAll();
    this.menus.close();
    this.resetEva();
    this.planRibbon.visible = mode === "mission";
    this.startDate = dateAtLTST(new Date(), this.settings.startHour);
    if (this.settings.travel === "buggy") this.enterBuggy(true);
    this.state = "deploy";
    this.deployT = 0;
    this.deployFrom.pos.copy(this.camera.position);
    this.deployFrom.quat.copy(this.camera.quaternion);
  }

  private touchdown() {
    this.state = "play";
    this.hud.visible = true;
    this.hud.toast(this.mode === "mission"
      ? `<b>MISSION START</b> · Sol ${marsTime(this.startDate).sol} · ${fmtClock(this.settings.startHour)} · sample the planned sites, bring everything home`
      : `<b>FREE EXPLORE</b> · follow Curiosity's tracks, find its stops, collect specimens`, 5000);
    this.audio.beep(660); setTimeout(() => this.audio.beep(990), 160);
  }

  private score() {
    return this.deposited.reduce((a, s) => a + (s.id.startsWith("sp") ? 25 : 100), 0) + this.discovered.size * 10;
  }

  private endEva(success: boolean, reason: string) {
    this.state = "debrief";
    this.player.autopilot = false;
    this.hud.visible = false; this.helmet.visible = false;
    this.menus.close(); this.map.hide(); this.screens.hideAll();
    this.audio.motor(0);
    const r = store.route;
    const sci = this.planSites();
    this.screens.debrief({
      success, reason,
      stopsDone: sci.filter((s) => this.surveyed.has(s.id)).length, stopsTotal: sci.length,
      distM: this.player.odometer + this.buggy.odometer, planDistM: r?.totals.distM ?? 0,
      evaS: this.evaS, planEvaS: r?.totals.evaS ?? 0, climbM: this.player.climbed,
      doseMSv: this.suit.doseMSv, remainingPct: (this.suit.remainingH / SUIT.capacityH.value) * 100,
      extra: [
        ["Samples delivered", `${this.deposited.length} (${this.deposited.reduce((a, s) => a + s.massKg, 0).toFixed(1)} kg)`, "site cores 100 pts, field specimens 25"],
        ["Discoveries", `${this.discovered.size}`, "sites + Curiosity's stops, 10 pts each"],
        ["Health", `${this.vitals.health.toFixed(0)}%`, this.vitals.cause ?? ""],
        ["Driven / walked", `${fmtDist(this.buggy.odometer)} / ${fmtDist(this.player.odometer)}`, ""],
      ],
      score: this.score(),
    }, () => this.toTitle());
  }

  private openMap() {
    if (this.state !== "play") return;
    this.map.setProfile(this.profile);
    this.map.show("map");
    this.pushLiveToMap();
  }
  private closeMap() { this.map.hide(); }

  private pauseMenu() {
    this.paused = true;
    this.menus.pause({
      resume: () => this.menus.close(),
      journal: () => this.journal(),
      map: () => { this.menus.close(); this.openMap(); },
      quit: () => this.endEva(false, "EVA abandoned."),
    });
  }

  private journal() {
    this.paused = true;
    const sites: JournalEntry[] = store.stops.filter((s) => s.kind !== "base").map((s) => ({
      id: s.id, kind: s.kind, title: s.name, found: this.discovered.has(s.id) || this.surveyed.has(s.id),
      text: `${s.what} <i>${s.why}</i>`, img: s.images[0]?.file, caption: `${s.images[0]?.instrument ?? ""}, sol ${s.images[0]?.sol ?? ""}. ${s.evidence}`,
    }));
    const finds: JournalEntry[] = this.world.landmarks.map((l) => ({
      id: l.id, kind: "landmark", title: l.name, found: this.discovered.has(l.id),
      text: `Curiosity parked here at the end of its sol ${l.sol} drive (${l.waypoint})${l.odometerKm ? `, ${l.odometerKm} km into its mission` : ""}.`,
      img: l.images[0]?.file, caption: `${l.images[0]?.instrument}, sol ${l.images[0]?.sol}. ${l.images[0]?.credit ?? ""}`,
    }));
    this.menus.journal(sites, finds, this.bag, this.deposited);
  }

  // ---------- mission ----------
  private onPlanChanged() {
    const r = store.route;
    this.planRibbon.set(r ? r.points.map((p) => this.terrain.toWorld(p)) : []);
    this.updateObjectives();
    if (this.state === "play" && this.navTarget?.kind === "stop") this.navTarget = null;
  }

  private planSites(): StopInfo[] {
    const ids = new Set((store.route?.stops ?? []).map((s) => s.id.replace(/_park$/, "")));
    return store.stops.filter((s) => s.kind === "science" && ids.has(s.id));
  }

  private objectives(): Objective[] {
    if (this.mode === "explore") {
      const sci = store.stops.filter((s) => s.kind !== "base");
      const found = sci.filter((s) => this.discovered.has(s.id)).length;
      const lm = this.world.landmarks.filter((l) => this.discovered.has(l.id)).length;
      return [
        { id: "x1", label: `Science sites found ${found} / ${sci.length}`, done: found === sci.length, active: found < sci.length },
        { id: "x2", label: `Curiosity's stops found ${lm} / ${this.world.landmarks.length}`, done: lm === this.world.landmarks.length, active: false },
        { id: "x3", label: `Specimens bagged ${this.bag.length + this.deposited.length}`, done: false, active: false },
        { id: "x4", label: "Be back at the habitat before dark", done: false, active: false },
      ];
    }
    const list: Objective[] = this.planSites().map((s) => ({ id: s.id, label: `Drill & bag: ${s.name.split(" - ")[0]}`, done: this.surveyed.has(s.id), active: false }));
    const spec = this.bag.concat(this.deposited).filter((s) => s.id.startsWith("sp")).length;
    list.push({ id: "spec", label: `Field specimens ${Math.min(spec, 3)} / 3 (spectrometer: Q)`, done: spec >= 3, active: false });
    list.push({ id: "base", label: "Deliver the samples to the habitat", done: false, active: false });
    const a = list.find((o) => !o.done);
    if (a) a.active = true;
    return list;
  }

  private updateObjectives() {
    const sites = new Set(this.planSites().map((s) => s.id));
    const active = this.objectives().find((o) => o.active)?.id;
    for (const b of this.beacons) {
      if (b.id === "base") { b.setState("base"); continue; }
      const s = store.stops.find((q) => q.id === b.id);
      b.group.visible = this.mode === "explore" || sites.has(b.id) || s?.kind === "rover";
      b.setState(this.surveyed.has(b.id) ? "done" : active === b.id ? "next" : "pending");
    }
  }

  private currentTarget(): { name: string; x: number; z: number; id: string | null } | null {
    if (this.navTarget?.kind === "point") return { name: this.navTarget.label, x: this.navTarget.x, z: this.navTarget.z, id: null };
    let id = this.navTarget?.kind === "stop" ? this.navTarget.id : this.mode === "mission" ? this.objectives().find((o) => o.active)?.id : undefined;
    if (id === "spec") {
      const n = this.specimens.nearest(this.player.x, this.player.z);
      if (n && this.scanner && n.d < 250) return { name: n.s.name, x: n.s.x, z: n.s.z, id: null };
      id = undefined;
    }
    if (id === "base") return { name: "Habitat airlock", x: this.hab.door.x, z: this.hab.door.z, id: "base" };
    const s = store.stops.find((q) => q.id === id);
    if (!s) return null;
    const w = this.terrain.toWorld(lonLatToXY(s));
    return { name: s.name.split(" - ")[0], x: w.x, z: w.z, id: s.id };
  }

  private here(): Stop {
    return { id: "here", name: "You", ...xyToLonLat(this.terrain.toProj(this.player.x, this.player.z)) };
  }

  /** A* from the player to the target with the current travel profile; the buggy falls back to park-and-walk. */
  private replanNav(reason: string) {
    const t = this.currentTarget();
    if (!t) { this.navRoute = null; this.navRibbon.set([]); return; }
    const goal: Stop = { id: t.id ?? "pt", name: t.name, ...this.terrain.lonLat(t.x, t.z) };
    let r: NavRoute = routeThrough(this.grid, [this.here(), goal], this.profile);
    let label = t.name, endX = t.x, endZ = t.z;
    if (!r.legs.length && this.driving) {
      const park = nearestReachable(this.grid, this.here(), goal, ROVER);
      if (park && park.gapM > 5) {
        r = routeThrough(this.grid, [this.here(), park.stop], ROVER);
        const pw = this.terrain.toWorld(lonLatToXY(park.stop));
        endX = pw.x; endZ = pw.z; label = `${t.name} (park ${park.gapM.toFixed(0)} m short)`;
        this.hud.toast(`The buggy can't reach ${t.name}: A* parks you ${park.gapM.toFixed(0)} m away, walk the rest`, 4500);
      }
    }
    if (!r.legs.length) {
      this.navRoute = null; this.navRibbon.set([]);
      this.hud.toast(`No safe ${this.driving ? "driving" : "walking"} path to ${t.name} from here`, 3000);
      return;
    }
    r.label = label;
    this.navRoute = r;
    const pts = r.points.map((p) => this.terrain.toWorld(p));
    pts.unshift({ x: this.player.x, z: this.player.z });
    pts.push({ x: endX, z: endZ });
    // the 10 m A* grid doesn't know about the habitat: bend the route around its hull (1 m clearance)
    const clear = (q: P2) => { const c = { ...q }; this.hab.collide(c, 1.0); return c; };
    this.navRibbon.set(pts.map((q, i) => (i === pts.length - 1 && t.id === "base" ? q : clear(q))));
    if (reason) this.hud.toast(`A* ${reason}: ${fmtDist(r.totals.distM)} to ${label} <small>(${r.computeMs.toFixed(0)} ms, ${this.driving ? "buggy" : "walking"})</small>`, 2500);
  }

  private navigateTo(p: LL, label: string) {
    const w = this.terrain.toWorld(lonLatToXY(p));
    const stop = store.stops.find((s) => Math.abs(s.lon - p.lon) < 1e-7 && Math.abs(s.lat - p.lat) < 1e-7);
    this.navTarget = stop ? { kind: "stop", id: stop.id } : { kind: "point", x: w.x, z: w.z, label };
    this.closeMap();
    this.replanNav("route");
  }

  private updateHome() {
    const r = routeThrough(this.grid, [this.here(), this.baseStop()], withSlopeLimit(WALKING, store.crewSlopeDeg));
    this.ret = r.legs.length ? returnCheck(this.suit, r.totals.walkS, r.totals.distM, r.totals.climbM) : null;
    this.homePts = r.points.map((p) => this.terrain.toWorld(p));
    const show = this.showHome || (this.ret && this.ret.status !== "ok");
    this.homeRibbon.set(show ? this.homePts : []);
  }

  // ---------- survey ----------
  private tickSurvey(dt: number) {
    const sv = this.survey;
    if (!sv) return;
    const t = sv.tasks.find((k) => k.running);
    if (t) {
      const dp = dt / 3.5;
      t.progress = Math.min(1, t.progress + dp);
      this.advanceClock(dp * t.min * 60, false);
      if (t.progress >= 1) {
        t.running = false; t.done = true; this.audio.beep(990);
        if (t.label.startsWith("Drill") && sv.stop.sample) {
          const sample: Sample = { id: `core_${sv.stop.id}`, name: sv.stop.sample.name, site: sv.stop.name.split(" - ")[0], massKg: 1.2, about: sv.stop.sample.about };
          if (canCarry(this.bag, sample)) { this.bag.push(sample); this.hud.toast(`<b>SAMPLE BAGGED</b> · ${sample.name} (${sample.massKg} kg)`); }
          else this.hud.toast(`Sample bag full (${SAMPLE_LIMIT_KG.value} kg): deliver to the habitat first`, 4000);
        }
      }
      if (sv.tasks.every((k) => k.done) && !this.surveyed.has(sv.stop.id)) {
        this.surveyed.add(sv.stop.id); this.discovered.add(sv.stop.id);
        this.report(`Survey report from ${sv.stop.name.split(" - ")[0]}`, `Science team: great data from ${sv.stop.name.split(" - ")[0]}. Your images match what Curiosity saw there. Proceed with the plan.`);
        this.updateObjectives();
        this.navTarget = null;
        this.replanNav("next objective");
      }
    }
    this.screens.survey(sv.stop, String(store.stops.indexOf(sv.stop)), sv.tasks, (i) => { sv.tasks[i].running = true; this.audio.beep(740); }, () => this.leaveSurvey());
  }
  private leaveSurvey() { this.survey = null; this.player.kneel = 0; this.screens.hideAll(); }

  // ---------- vehicle ----------
  private enterBuggy(silent = false) {
    if (this.buggy.flipped) return;
    this.driving = true;
    this.player.autopilot = false;
    if (!silent) { this.hud.toast("<b>BUGGY</b> · W/S drive, A/D steer, Space brake, F autopilot, E get out"); this.audio.beep(520); }
    this.navCheckT = 0;
    if (this.overlayIdx) this.setOverlay(this.overlayIdx);
  }
  private exitBuggy() {
    if (!this.driving) return;
    this.driving = false;
    const h = this.buggy.heading;
    let x = this.buggy.x - Math.cos(h) * 2.8, z = this.buggy.z - Math.sin(h) * 2.8; // step out on the driver's side
    if (!this.terrain.inside(x, z, 6)) { x = this.buggy.x; z = this.buggy.z; }
    this.player.place(x, z, h);
    this.camYaw = h;
    this.navCheckT = 0;
    this.audio.motor(0);
    if (this.overlayIdx) this.setOverlay(this.overlayIdx);
  }

  // ---------- interaction (E) ----------
  private interact() {
    if (this.state !== "play" || this.survey) return;
    const p = this.player;
    if (this.driving) { if (Math.abs(this.buggy.speed) < 0.5) this.exitBuggy(); else this.hud.toast("Stop the buggy first (Space)"); return; }
    if (Math.hypot(this.buggy.x - p.x, this.buggy.z - p.z) < 3.5) {
      if (this.buggy.flipped) {
        this.advanceClock(15 * 60, false);
        this.buggy.place(this.buggy.x, this.buggy.z, this.buggy.heading);
        this.hud.toast("Buggy back on its wheels (15 min of hard work)");
      } else this.enterBuggy();
      return;
    }
    if (Math.hypot(this.hab.door.x - p.x, this.hab.door.z - p.z) < 4.5) { this.habMenu(); return; }
    if (this.shelter.deployed && Math.hypot(this.shelter.group.position.x - p.x, this.shelter.group.position.z - p.z) < 3.5) { this.shelterMenu(); return; }
    const near = this.nearStop();
    if (near && near.kind === "science" && !this.surveyed.has(near.id)) {
      p.autopilot = false; p.kneel = 1;
      this.survey = { stop: near, tasks: SURVEY_TASKS.map((t) => ({ ...t, done: false, running: false, progress: 0 })) };
      return;
    }
    const sp = this.specimens.nearest(p.x, p.z);
    if (sp && sp.d < 2.8) {
      const site = sp.s.site === "plain" ? "open plains" : store.stops.find((q) => q.id === sp.s.site)?.name.split(" - ")[0] ?? sp.s.site;
      const s: Sample = { id: sp.s.id, name: sp.s.name, site, massKg: sp.s.massKg, about: sp.s.about };
      if (!canCarry(this.bag, s)) { this.hud.toast(`Bag full (${SAMPLE_LIMIT_KG.value} kg): deliver samples to the habitat`); return; }
      this.specimens.take(sp.s);
      this.bag.push(s);
      p.kneel = 1; setTimeout(() => (p.kneel = 0), 900);
      this.advanceClock(5 * 60, false);
      this.hud.toast(`<b>SPECIMEN</b> · ${s.name} (${s.massKg} kg) · ${s.about}`, 5000);
      this.audio.beep(1100);
      this.updateObjectives();
      if (this.navTarget?.kind === "point" || this.objectives().find((o) => o.active)?.id === "spec") this.replanNav("");
    }
  }

  private habMenu() {
    this.paused = true;
    this.sheltered = "hab";
    const full = this.suit.remainingH >= SUIT.capacityH.value - 0.01;
    const night = this.sunElev < 0;
    this.menus.habitat(
      `Inside the airlock. Suit ${(this.suit.remainingH / SUIT.capacityH.value * 100).toFixed(0)}%, health ${this.vitals.health.toFixed(0)}%, carrying ${this.bag.length} sample(s). Outside ${this.tempC.toFixed(0)} °C, ${fmtClock(this.ltst)} LTST.`,
      [
        { label: "Recharge suit (O₂, water, battery)", note: "30 min", disabled: full, run: () => {
          this.advanceClock(30 * 60, true);
          this.suit = { ...this.suit, remainingH: SUIT.capacityH.value };
          this.vitals = { ...this.vitals, health: Math.min(100, this.vitals.health + 20) };
          if (Math.hypot(this.buggy.x - this.hab.center.x, this.buggy.z - this.hab.center.z) < 30) this.buggy.battery = 1;
          this.habMenu();
        } },
        { label: `Deliver ${this.bag.length + (this.buddy.carrying ? 1 : 0)} sample(s) to the lab`, note: "5 min", disabled: !this.bag.length && !this.buddy.carrying, run: () => {
          this.deposited.push(...this.bag); this.bag = [];
          const bc = this.buddy.carrying;
          if (bc) { this.deposited.push({ id: bc.id, name: bc.name, site: bc.site, massKg: bc.massKg, about: bc.about }); this.buddy.carrying = null; }
          this.advanceClock(5 * 60, true);
          this.hud.toast(`<b>SAMPLES DELIVERED</b> · science score ${this.score()}`);
          this.report("Sample manifest", "Curation team: manifest received. Keep the cores sealed and cold for the return vehicle.");
          this.updateObjectives();
          this.habMenu();
        } },
        { label: night ? "Sleep until sunrise" : "Rest 2 hours", note: night ? "skip the night" : "recover health", run: () => { this.sleep(night ? "dawn" : 2 * 3600, true); this.habMenu(); } },
        { label: "End EVA (debrief)", note: "", run: () => this.finishAtBase() },
      ]);
  }

  private shelterMenu() {
    this.paused = true;
    this.sheltered = "shelter";
    const night = this.sunElev < 0;
    this.menus.habitat(`Inside the emergency shelter: its own O₂ and heat for ${SURVIVAL.shelterHours.value} h <span class="tag assumed" title="${SURVIVAL.shelterHours.source}">assumed</span>, partial radiation shielding. Outside ${this.tempC.toFixed(0)} °C.`, [
      { label: night ? "Sleep until sunrise" : "Wait 1 hour", note: "suit not used", run: () => { this.sleep(night ? "dawn" : 3600, false); this.shelterMenu(); } },
    ]);
  }

  /** Skip time while sheltered: the suit is not drawn down; in the habitat it is refilled. */
  private sleep(what: "dawn" | number, inHab: boolean) {
    let dt: number;
    if (what === "dawn") {
      const now = new Date(this.startDate.getTime() + this.evaS * 1000);
      let t = dateAtLTST(now, 7.0);
      if (t.getTime() <= now.getTime()) t = dateAtLTST(new Date(now.getTime() + MARS_HOUR_S * 1000 * 12), 7.0);
      dt = (t.getTime() - now.getTime()) / 1000;
    } else dt = what;
    this.advanceClock(dt, true);
    if (inHab) this.suit = { ...this.suit, remainingH: SUIT.capacityH.value };
    this.vitals = { ...this.vitals, health: Math.min(100, this.vitals.health + dt / 360) };
    this.sunsetWarned = false;
    this.hud.toast(`Rested ${fmtDur(dt)} · now ${fmtClock(marsTime(new Date(this.startDate.getTime() + this.evaS * 1000)).ltst)} LTST`);
  }

  private finishAtBase() {
    const sites = this.planSites();
    const ok = this.mode === "explore" ||
      (sites.every((s) => this.deposited.some((d) => d.id === `core_${s.id}`)) && this.deposited.filter((d) => d.id.startsWith("sp")).length >= 3);
    this.endEva(ok, ok
      ? (this.mode === "mission" ? "Mission accomplished: every planned site sampled and the samples are safely in the habitat lab." : "Back at base after free exploration.")
      : "Ended at base with mission objectives incomplete.");
  }

  /** Move the sim clock while inactive (surveys, resting): consumables at rest rate unless sheltered. */
  private advanceClock(dtS: number, sheltered: boolean) {
    this.evaS += dtS;
    if (!sheltered) this.suit = tickSuit(this.suit, dtS, metabolicFactor(false, 0) + heaterLoad(this.tempC) * this.hazardScale());
    else this.suit = { ...this.suit, elapsedS: this.suit.elapsedS + dtS, doseMSv: this.suit.doseMSv + (RADIATION.surfaceDoseMSvPerDay.value * dtS) / 86400 * 0.5 };
  }

  private nearStop(): StopInfo | null {
    for (const s of store.stops) {
      if (s.kind === "base") continue;
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
        for (let k = 0; k < 20; k++) { const mm = (lo + hi) / 2; if (o.y + d.y * mm < this.terrain.heightAt(o.x + d.x * mm, o.z + d.z * mm)) hi = mm; else lo = mm; }
        hit = hi; break;
      }
      prev = t;
    }
    if (hit < 0) return;
    const x = o.x + d.x * hit, z = o.z + d.z * hit, y = this.terrain.heightAt(x, z);
    this.scan.show(x, y, z);
    this.audio.beep(1200, 0.06);
    const gi = xyToIdx(this.grid, this.terrain.toProj(x, z));
    const why = gi >= 0 ? blockReason(this.grid, gi, this.profile) : "outside DTM";
    const dist = Math.hypot(x - this.player.x, z - this.player.z);
    const brg = (Math.atan2(x - this.player.x, -(z - this.player.z)) * 180 / Math.PI + 360) % 360;
    this.scanEl.innerHTML = `
      <div class="g-title">TERRAIN SCAN <button class="sx">&times;</button></div>
      <div class="kpis small">
        <div><span>${(y + this.terrain.meta.yRef).toFixed(1)} m</span>elevation</div>
        <div><span>${this.terrain.slopeDeg(x, z).toFixed(0)}° / ${gi >= 0 ? this.grid.slope[gi].toFixed(0) : "-"}°</span>slope here / cell p90</div>
        <div><span>${gi >= 0 ? this.grid.rough[gi].toFixed(2) : "-"} m</span>roughness</div>
        <div><span>${fmtDist(dist)} · ${brg.toFixed(0)}°</span>range · bearing</div>
      </div>
      ${this.crismLine(x, z)}
      <p class="${why ? "warn" : "ok-text"}">${why ? `NO-GO (${this.driving ? "buggy" : "walking"}): ${why}` : `Go for ${this.driving ? "the buggy" : "walking"}`}</p>
      <button class="btn small go" ${why ? "disabled" : ""}>Navigate here (A*) <kbd>N</kbd></button>`;
    this.scanEl.classList.add("on");
    this.scanEl.querySelector<HTMLButtonElement>(".sx")!.onclick = () => { this.scanEl.classList.remove("on"); this.scan.hide(); };
    const go = () => { this.navTarget = { kind: "point", x, z, label: "Scan waypoint" }; this.replanNav("route"); this.scanEl.classList.remove("on"); };
    this.scanEl.querySelector<HTMLButtonElement>(".go")!.onclick = go;
    (this.scanEl as HTMLDivElement & { go?: () => void }).go = why ? undefined : go;
  }

  /** R: send EV2 to fetch the nearest specimen (it plans its own A* route there and back). */
  private sendBuddy() {
    if (this.driving) { this.hud.toast("EV2 is riding with you · get out first"); return; }
    if (this.buddy.mode !== "follow") { this.hud.toast(this.buddy.status || "EV2 is busy"); return; }
    const free = this.specimens.list.filter((s) => !s.taken && Math.hypot(s.x - this.player.x, s.z - this.player.z) < (this.scanner ? 300 : 120));
    free.sort((a, b) => Math.hypot(a.x - this.player.x, a.z - this.player.z) - Math.hypot(b.x - this.player.x, b.z - this.player.z));
    const t = free.find((s) => this.buddy.send(s));
    this.hud.toast(t ? `<b>EV2</b> · on my way to the ${t.name}, ${fmtDist(Math.hypot(t.x - this.player.x, t.z - this.player.z))} out (A* route)` : `EV2: no specimen in range${this.scanner ? "" : " · switch on the spectrometer (Q) to search wider"}`, 3500);
  }

  private togglePhoto(on: boolean, hour?: number) {
    if (on) {
      this.photo.open({ x: this.player.x, z: this.player.z, yaw: this.camYaw, hour: hour ?? Math.round(this.ltst * 4) / 4 });
      this.hud.visible = false;
      this.astro.setFirstPerson(false);
    } else {
      this.photo.close();
      this.hud.visible = this.state === "play";
      this.astro.setFirstPerson(this.camMode === "first");
    }
  }

  /** Send a report to Earth; the reply arrives after the real round-trip light time (sim clock). */
  private report(what: string, reply: string) {
    const link = commLink(new Date(this.startDate.getTime() + this.evaS * 1000));
    if (link.sunAngleDeg < CONJUNCTION_DEG.value) { this.hud.toast(`<b>NO LINK</b> · Mars is ${link.sunAngleDeg.toFixed(1)}° from the Sun (solar conjunction). The crew is on its own.`, 4000); return; }
    const rt = 2 * link.oneWayS + 120; // + ~2 min for the team to answer
    this.comms.push({ reply, sentS: this.evaS, arriveS: this.evaS + rt, delivered: false });
    this.hud.toast(`<b>UPLINK</b> · ${what} sent to Earth · arrives in ${fmtDur(link.oneWayS)}, reply in ~${fmtDur(rt)} <small>(${(link.distKm / 1e6).toFixed(0)} million km)</small>`, 4000);
  }
  private tickComms() {
    for (const c of this.comms) if (!c.delivered && this.evaS >= c.arriveS) {
      c.delivered = true;
      this.hud.toast(`<b>EARTH</b> <small>(sent ${fmtDur(this.evaS - c.sentS)} ago)</small> · ${c.reply}`, 7000);
      this.audio.beep(700); setTimeout(() => this.audio.beep(900), 120);
    }
  }

  // ---------- guided demo ----------
  private worldOf(id: string) { const st = store.stops.find((q) => q.id === id)!; return { st, ...this.terrain.toWorld(lonLatToXY(st)) }; }
  /** Put the walker (and EV2) at a spot, facing a point. */
  private teleport(x: number, z: number, faceX: number, faceZ: number) {
    const h = Math.atan2(faceX - x, -(faceZ - z));
    if (this.driving) this.exitBuggy();
    this.player.place(x, z, h);
    this.player.autopilot = false;
    this.buddy.place(x - Math.sin(h) * 3.5 - Math.cos(h) * 2, z + Math.cos(h) * 3.5 - Math.sin(h) * 2, h);
    this.camYaw = h; this.navCheckT = 0; this.trail.push({ x, z });
  }
  /** Jump the EVA clock forward to a local solar hour (demo only). */
  private setHour(hour: number) {
    const now = new Date(this.startDate.getTime() + this.evaS * 1000);
    let t = dateAtLTST(now, hour);
    if (t.getTime() < now.getTime()) t = dateAtLTST(new Date(now.getTime() + MARS_HOUR_S * 1000 * 12), hour);
    this.evaS += (t.getTime() - now.getTime()) / 1000;
    this.sunsetWarned = true;
  }

  private startDemo() {
    if (this.director.active) return;
    this.demoSaved = { ...this.settings };
    this.settings = { ...this.settings, travel: "foot", hazards: "off", startHour: 9 };
    this.audio.start();
    const gz = this.worldOf("gediz"), cu = this.worldOf("curiosity");
    const steps: DemoStep[] = [
      { dur: 6, cap: "MARSWALK", sub: "A walkable EVA planner on real NASA terrain · Gale crater, lower Mount Sharp", run: () => this.toTitle() },
      { dur: 7, cap: "Plan the EVA with A*", sub: "Slope + roughness on 80,000 cells from the USGS 1 m HiRISE terrain model · today's sol, REMS weather, Earth light-time",
        run: () => { this.screens.hideAll(); this.state = "briefing"; this.map.setProfile(WALKING); this.map.show("briefing", this.briefingInfo()); } },
      { dur: 6, cap: "Walk or drive: A* re-plans for each vehicle", sub: "The buggy can't climb onto the boxwork ridge, so A* parks it and you walk the last stretch",
        run: () => this.map.setProfile(ROVER) },
      { dur: 8, cap: "Validated against Curiosity", sub: "On 9.8 km of Curiosity's real drives, the rover stayed off our no-go terrain 15&times; more than chance",
        run: () => { this.map.setProfile(WALKING); this.map.validate(); } },
      { dur: 6, cap: "What-if scenarios in milliseconds", sub: "Every stop order &times; on foot / buggy &times; start time, ranked by time, daylight and suit margin",
        run: () => this.map.scenarios() },
      { dur: 6.5, cap: "Touchdown on lower Mount Sharp", sub: "HiRISE colour on the 1 m DTM · Mount Sharp and the crater rim from HRSC-MOLA, with planet curvature",
        run: () => this.deploy("mission") },
      { dur: 7, cap: "Every footstep on the real slope", sub: "Mars gravity 3.72 m/s² · walking pace from a Tobler-style model on the local grade",
        run: () => { this.warpIdx = 0; this.replanNav(""); this.player.autopilot = true; } },
      { dur: 6, cap: "Go / no-go map draped on the ground", sub: "Red = steeper than 25° or rougher than 0.5 m: the cells A* will never cross",
        run: () => this.setOverlay(OVERLAYS.indexOf("go/no-go (A*)")), tick: (t) => { if (t > 5.8) this.setOverlay(0); } },
      { dur: 8, cap: "Autopilot rides the A* route, even at &times;30 time warp", sub: "Suit consumables, dose and return margin tick in simulated time",
        run: () => { this.warpIdx = 4; this.player.autopilot = true; } },
      { dur: 8, cap: "Survey a real Curiosity site: Gediz Vallis", sub: "These are Curiosity's own Navcam images from this exact spot (NASA/JPL-Caltech)",
        run: () => { this.warpIdx = 2; this.teleport(gz.x - 9, gz.z + 7, gz.x, gz.z); this.interact(); },
        tick: (t) => { if (t > 2 && this.survey && !this.survey.tasks.some((k) => k.running || k.done)) this.survey.tasks[1].running = true; if (t > 7.8) this.leaveSurvey(); } },
      { dur: 7, cap: "Orbital mineral map: MRO CRISM", sub: "Hydrated-sulfate signatures (CRISM FRT000058A3) · the spectrometer's specimen targets come from it",
        run: () => { this.setOverlay(OVERLAYS.indexOf("minerals (CRISM)")); this.scanner = true; this.camDist = 30; this.camPitch = 0.7; },
        tick: (t) => { if (t > 6.8) { this.setOverlay(0); this.camDist = 5.5; this.camPitch = 0.16; } } },
      { dur: 8, cap: "EV2: no one walks alone", sub: "Your buddy plans its own A* route to a specimen, collects it and brings it back",
        run: () => { this.warpIdx = 3; this.sendBuddy(); this.camDist = 12; } },
      { dur: 6, cap: "Inside the helmet", sub: "Gold visor, frost, dust and breath fog; the HUD projected on the visor",
        run: () => { this.camDist = 5.5; this.camMode = "first"; this.hud.setMode("first"); this.astro.setFirstPerson(true); this.camPitch = 0.35; },
        tick: (t) => { this.camYaw += 0.15 * (t < 3 ? 1 : -1) * 0.016; if (t > 5.8) { this.camMode = "third"; this.hud.setMode("third"); this.astro.setFirstPerson(false); this.camPitch = 0.16; } } },
      { dur: 9, cap: "Take the buggy", sub: "Apollo-LRV-class physics: slip, jumps, rollover · the A* autopilot slows for bends",
        run: () => {
          const h = this.player.heading;
          this.buggy.place(this.player.x + Math.cos(h) * 3, this.player.z + Math.sin(h) * 3, h);
          this.enterBuggy(true);
          this.navTarget = { kind: "stop", id: "curiosity" }; this.replanNav("");
          this.player.autopilot = true; this.warpIdx = 4;
        } },
      { dur: 8, cap: "Meet Curiosity at its real position (sol 5073)", sub: "Reports to Earth wait for the real light-time: about 11 minutes each way today",
        run: () => {
          // stand on the lowest ground ~10 m from the rover so nothing blocks the view of it
          const rx = cu.x + 3, rz = cu.z;
          let best = { x: rx - 7, z: rz + 7, h: Infinity };
          for (let a = 0; a < 16; a++) {
            const x = rx + Math.cos((a / 16) * Math.PI * 2) * 10, z = rz + Math.sin((a / 16) * Math.PI * 2) * 10;
            const h = this.terrain.heightAt(x, z);
            if (this.terrain.inside(x, z, 8) && h < best.h) best = { x, z, h };
          }
          this.teleport(best.x, best.z, rx, rz); this.warpIdx = 5; this.camDist = 9; this.report("Photo of Curiosity", "JPL rover team: we see you in Curiosity's hazcams! First human visitor. Please don't touch the wheels."); } },
      { dur: 9, cap: "A regional dust storm rolls in", sub: "Beer–Lambert sunlight, visibility down to a few hundred metres: trust the A* route home",
        run: () => { this.warpIdx = 4; this.storm = { phase: "active", t: 2400, peak: DUST.stormPeakTau.value, dur: 3 * 3600 }; this.camDist = 7; } },
      { dur: 8, cap: "Night falls", sub: "",
        run: () => {
          this.storm = { phase: "over", t: 0, peak: 0, dur: 0 }; this.tau = DUST.clearTau.value; this.warpIdx = 2; this.setHour(21);
          const cap = this.director.el.querySelector(".dm-s");
          if (cap) cap.innerHTML = `${airTempAt(this.analogue, 21).toFixed(0)} °C now, ${this.analogue.minAirC ?? "?"} °C by dawn (Curiosity's REMS, same season) · the suit heater drains consumables; helmet lamps on`;
        } },
      { dur: 7, cap: "Photo mode", sub: "Free camera and any time of day, for your own Mars postcards",
        run: () => { this.setHour(16.6); this.togglePhoto(true, 16.6); this.photo.state.dist = 14; this.photo.state.pitch = 0.18; },
        tick: (_t, dt) => { this.photo.state.yaw += dt * 0.25; } },
      { dur: 6, cap: "MARSWALK · NASA Space Apps 2026", sub: "Real data · A* planning validated against Curiosity · press any key to play",
        run: () => { this.togglePhoto(false); this.toTitle(); } },
    ];
    this.director.start(steps);
  }

  private endDemo() {
    if (this.photo.state.on) this.togglePhoto(false);
    if (this.demoSaved) { this.settings = this.demoSaved; this.demoSaved = null; }
    this.storm = { phase: "none", t: 0, peak: 0, dur: 0 }; this.tau = DUST.clearTau.value;
    this.scanner = false; this.setOverlay(0); this.warpIdx = 2; this.camDist = 5.5; this.camPitch = 0.16;
    if (this.camMode === "first") { this.camMode = "third"; this.hud.setMode("third"); this.astro.setFirstPerson(false); }
    this.toTitle();
  }

  /** CRISM orbital reading at a world point, for scan readouts. */
  private crismLine(x: number, z: number) {
    const r = store.crism?.at(this.terrain.lonLat(x, z).lon, this.terrain.lonLat(x, z).lat);
    if (!r) return "";
    return `<p class="src"><b>CRISM from orbit (18 m):</b> ${r.label} · ${r.strength} <span class="tag sourced" title="${store.crism!.meta.source}">CRISM</span></p>`;
  }

  // ---------- input ----------
  private bindInput() {
    const el = this.renderer.domElement;
    let down: { moved: number } | null = null;
    window.addEventListener("pointerdown", (e) => { if (this.director.active && e.isTrusted) this.director.stop(); }, { capture: true });
    el.addEventListener("pointerdown", (e) => { down = { moved: 0 }; el.setPointerCapture(e.pointerId); this.audio.start(); });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      down.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (down.moved > 4 && this.photo.state.on) {
        const ps = this.photo.state;
        ps.yaw += e.movementX * 0.005;
        ps.pitch = Math.min(1.45, Math.max(-0.35, ps.pitch + e.movementY * 0.004));
        return;
      }
      if (down.moved > 4 && this.state === "play") {
        this.camYaw += e.movementX * 0.005;
        this.camPitch = Math.min(1.3, Math.max(this.camMode === "first" ? -1.0 : -0.25, this.camPitch + e.movementY * 0.004));
        this.lastDrag = this.time;
      }
    });
    el.addEventListener("pointerup", (e) => { if (down && down.moved <= 4 && this.state === "play" && !this.photo.state.on) this.scanAt(e.clientX, e.clientY); down = null; });
    el.addEventListener("wheel", (e) => {
      if (this.photo.state.on) { this.photo.state.dist = Math.min(600, Math.max(1.5, this.photo.state.dist * (1 + Math.sign(e.deltaY) * 0.1))); return; }
      if (this.state !== "play" || this.camMode === "first") return;
      this.camDist = Math.min(45, Math.max(2.5, this.camDist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: true });

    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      const k = e.key.toLowerCase();
      if (this.director.active) { if (e.isTrusted) this.director.stop(); return; }
      this.keys.add(k);
      if (k === " ") e.preventDefault();
      if (this.state !== "play") { if (k === "escape") this.menus.close(); return; }
      if (this.photo.state.on) {
        if (k === "c" || k === "escape") this.togglePhoto(false);
        if (k === " ") this.captureNext = true;
        return;
      }
      if (k === "c" && !this.menus.open && !this.map.open) { this.togglePhoto(true); return; }
      if (k === "escape") {
        if (this.menus.open) this.menus.close();
        else if (this.map.open) this.closeMap();
        else if (this.survey) this.leaveSurvey();
        else if (this.scanEl.classList.contains("on")) { this.scanEl.classList.remove("on"); this.scan.hide(); }
        else this.pauseMenu();
        return;
      }
      if (this.menus.open) return;
      if (k === "m") { if (this.map.open) this.closeMap(); else this.openMap(); }
      if (this.map.open) return;
      if (k === "j") this.journal();
      if (k === "e") this.interact();
      if (k === "f") {
        this.player.autopilot = !this.player.autopilot;
        if (this.player.autopilot && !this.navRoute) this.replanNav("route");
        this.hud.toast(this.player.autopilot ? `<b>AUTOPILOT ON</b> · following the A* route (${this.driving ? "buggy" : "walking"})` : "Autopilot off");
      }
      if (k === "v") {
        this.camMode = this.camMode === "third" ? "first" : "third";
        this.hud.setMode(this.camMode);
        this.astro.setFirstPerson(this.camMode === "first");
      }
      if (k === "[" || k === "]") {
        this.warpIdx = Math.min(WARPS.length - 1, Math.max(0, this.warpIdx + (k === "]" ? 1 : -1)));
        this.hud.toast(`Time warp ×${WARPS[this.warpIdx]}`, 1200);
      }
      if (k === "h") { this.showHome = !this.showHome; this.updateHome(); this.hud.toast(this.showHome ? "Path home shown (A* to base)" : "Path home hidden", 1500); }
      if (k === "n") (this.scanEl as HTMLDivElement & { go?: () => void }).go?.();
      if (k === "t") { this.setOverlay((this.overlayIdx + 1) % OVERLAYS.length); this.hud.toast(`Data layer: <b>${OVERLAYS[this.overlayIdx]}</b>`, 1500); }
      if (k === "q") { this.scanner = !this.scanner; this.hud.toast(this.scanner ? "<b>SPECTROMETER ON</b> · specimens glow; beeps speed up as you get close" : "Spectrometer off", 2500); }
      if (k === "l") { this.lampsAuto = false; this.lampsOn = !this.lampsOn; }
      if (k === "z") { this.goldVisor = !this.goldVisor; this.hud.toast(this.goldVisor ? "Gold sun visor down" : "Sun visor up", 1200); }
      if (k === "x") { this.visorDust = 0; this.frost *= 0.3; this.hud.toast("Visor wiped", 1000); }
      if (k === "b") this.deployShelter();
      if (k === "r") this.sendBuddy();
      if (k === "g") this.grabThrow();
      if (k === "p") this.audio.muted = !this.audio.muted;
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private deployShelter() {
    if (this.driving) return;
    if (this.shelter.deployed) { this.hud.toast("Only one emergency shelter kit per EVA"); return; }
    const p = this.player, h = p.heading;
    const x = p.x + Math.sin(h) * 4, z = p.z - Math.cos(h) * 4;
    if (this.terrain.slopeDeg(x, z) > 15) { this.hud.toast("Too steep to pitch the shelter here (needs < 15°)"); return; }
    const y = this.terrain.heightAt(x, z);
    this.shelter.deploy(x, y, z, h);
    this.advanceClock(10 * 60, false);
    this.puffs.burst(new THREE.Vector3(x, y, z), 30, 1.2);
    this.hud.toast("<b>SHELTER DEPLOYED</b> · E to go inside: sleep through the night, hide from solar storms", 4500);
  }

  private grabThrow() {
    if (this.driving) return;
    const hand = this.handPos();
    if (this.held) {
      const dir = new THREE.Vector3(Math.sin(this.camYaw), 0.55, -Math.cos(this.camYaw));
      this.loose.throw(this.held, hand, dir, 9);
      this.held = null;
      this.hud.toast("Thrown · Mars gravity is 38% of Earth's, so it flies ~2.6× farther", 2500);
    } else {
      const b = this.loose.nearest(this.player.pos, 2.4);
      if (b) { b.held = true; b.rest = false; this.held = b; this.hud.toast("Rock in hand · G to throw", 1500); }
      else this.hud.toast("No loose rock within reach (there are some near base)", 1500);
    }
  }
  private handPos() {
    const p = this.player, h = p.heading;
    return new THREE.Vector3(p.x + Math.cos(h) * 0.35 + Math.sin(h) * 0.3, p.y + 1.1, p.z + Math.sin(h) * 0.35 - Math.cos(h) * 0.3);
  }

  private resize() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.css.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- frame ----------
  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    this.director.update(dt);
    this.beaconTime.value = this.time;
    const playing = this.state === "play";
    const halted = this.paused || this.map.open || this.menus.open || this.photo.state.on;
    const dtSim = playing && !halted && !this.survey ? dt * WARPS[this.warpIdx] : 0;

    // sun + temperature from the Mars clock and the REMS analogue
    const evaDate = new Date(this.startDate.getTime() + this.evaS * 1000);
    const date = this.photo.state.hour != null ? dateAtLTST(evaDate, this.photo.state.hour) : evaDate;
    const idle = this.state === "title" || this.state === "briefing" || this.state === "debrief";
    const mt = marsTime(idle ? dateAtLTST(new Date(), 16.2 + Math.sin(this.time * 0.02) * 0.4) : date);
    const sp = sunPosition(mt.ltst, mt.decl);
    this.sunElev = sp.elevDeg; this.ltst = mt.ltst;
    this.tempC = airTempAt(this.analogue, mt.ltst);
    // dust shades the day and blankets the night: the diurnal swing shrinks with optical depth (ASSUMED shape)
    const storm = idle ? 0 : Math.min(1, Math.max(0, (this.tau - DUST.clearTau.value) / 4));
    if (storm > 0) { const mid = ((this.analogue.minAirC ?? -70) + (this.analogue.maxAirC ?? -10)) / 2; this.tempC = this.tempC + (mid - this.tempC) * 0.5 * storm; }
    this.sky.tau = idle ? DUST.clearTau.value : this.tau;
    this.sky.setSun(sp.elevDeg, sp.azDeg);
    visorMat.envMap = this.sky.envMap();
    const night = sp.elevDeg < 2;
    if (this.lampsAuto) this.lampsOn = night;
    this.astro.setLamps(this.lampsOn && playing);
    this.buggy.setLights(this.driving && (night || this.lampsOn));
    this.hab.setLights(night);

    if (playing || this.state === "deploy") {
      const k = this.keys;
      const fwd = (k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0) + this.touch.stick.fwd + this.xr.stick.fwd;
      const right = (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("a") || k.has("arrowleft") ? 1 : 0) + this.touch.stick.right + this.xr.stick.right;
      if (fwd || right) this.player.autopilot = false;
      const frozen = !playing || halted || !!this.survey;
      if (this.driving) {
        let input = { throttle: frozen ? 0 : fwd, steer: frozen ? 0 : right, brake: k.has(" ") || frozen };
        const auto = this.player.autopilot && this.navRibbon.length() > 0 && !frozen;
        // fixed sim-time substeps: at x30/x60 warp one frame would move the buggy several metres before
        // it could steer, overshooting the A* line and snaking. 50 ms steps keep it identical to x1.
        const n = Math.min(240, Math.max(1, Math.ceil(dtSim / 0.05)));
        const dr = (halted ? 0 : dt) / n;
        for (let i = 0; i < n; i++) this.buggy.update(dtSim / n, dr, auto ? this.autoDrive() : input);
        if (!auto) this.driveVer = -1;
        const seatPos = new THREE.Vector3(), q = new THREE.Quaternion();
        this.buggy.seatPose(seatPos, q);
        this.astro.root.position.copy(seatPos);
        this.astro.root.quaternion.copy(q);
        this.astro.animate(0, dt, false, 0, 0, 1);
        const p = this.player;
        p.x = this.buggy.x; p.z = this.buggy.z; p.y = this.buggy.y;
        p.heading = this.buggy.heading; p.speed = Math.abs(this.buggy.speed);
        p.moving = Math.abs(this.buggy.speed) > 0.1; p.grade = 0;
        this.loose.push(this.buggy.pos, new THREE.Vector3(Math.sin(p.heading) * this.buggy.speed, 0, -Math.cos(p.heading) * this.buggy.speed), 1.8);
        this.audio.motor(Math.min(1, Math.abs(this.buggy.speed) / 3.6));
      } else {
        this.astro.root.quaternion.identity();
        this.player.update(dtSim, halted ? 0 : dt, { fwd, right, run: k.has("shift"), hop: k.has(" ") }, this.camYaw, this.player.autopilot ? this.navRibbon : null, frozen);
        const p = this.player;
        this.loose.push(p.pos, new THREE.Vector3(Math.sin(p.heading) * p.speed, 0, -Math.cos(p.heading) * p.speed), 0.45);
        this.buggy.update(0, halted ? 0 : dt, { throttle: 0, steer: 0, brake: true });
      }
      this.buddy.update(halted ? 0 : dtSim, halted ? 0 : dt, { x: this.player.x, z: this.player.z, heading: this.player.heading }, this.driving, this.buggy);
      this.buddy.astro.setLamps(this.lampsOn && playing);
      if (playing) this.tickPlay(dt, dtSim, mt.ltst, mt.sol, mt.ls, sp.elevDeg);
    }
    this.updateCamera(dt);
    this.terrain.detailUniforms.uCamPos.value.copy(this.camera.position);
    this.sky.follow(this.state === "play" || this.state === "deploy" ? this.player.pos : this.camera.position);
    this.sky.mesh.position.copy(this.camera.position);
    this.rocks.update(this.player.x, this.player.z);
    this.puffs.update(dt, this.wind);
    this.dust.update(dt, this.camera.position, this.wind);
    this.loose.update(halted ? 0 : dt, this.held ? this.handPos() : null);
    this.specimens.update(dt, this.player.x, this.player.z, this.scanner);
    this.shelter.update(dt);
    this.scan.update(dt);
    this.navRibbon.update(this.time); this.planRibbon.update(this.time); this.homeRibbon.update(this.time);
    for (const b of this.beacons) (b.group.userData.tick as (() => void) | undefined)?.();
    for (const l of this.landmarkPosts) l.g.children[1].rotation.y += dt;
    this.audio.update(dt, Math.min(1, this.player.speed / 1.2 + Math.max(0, this.player.grade) * 2), 0.3 + (this.devilNear < 40 ? 0.7 : 0));
    this.helmet.visible = playing && this.camMode === "first" && !this.photo.state.on;
    this.xr.button.classList.toggle("in-play", playing);
    this.touch.visible = playing && !this.photo.state.on && !this.director.active && !this.map.open && !this.menus.open;
    if (playing && this.camMode === "first" && !this.photo.state.on) this.helmet.update(dt, {
      frost: this.frost, dust: this.visorDust, gold: this.goldVisor, health: this.vitals.health,
      exertion: Math.min(1, this.player.speed / 1.2), cold: this.tempC < -30,
    });

    if (this.xr.presenting) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
    if (this.captureNext) { this.captureNext = false; this.photo.save(this.renderer.domElement); }
    this.css.domElement.style.display = (playing || this.state === "deploy") && !this.photo.state.on ? "" : "none";
    this.css.render(this.scene, this.camera);
  }

  /** Buggy autopilot: steer toward a look-ahead point on the A* ribbon, slow for turns. */
  private autoDrive() {
    const b = this.buggy, rb = this.navRibbon;
    // track progress along the ribbon so a route that doubles back can't snap us onto the other leg
    const fresh = this.driveVer !== rb.version;
    const pr = rb.project(b.x, b.z, fresh ? undefined : this.driveAlong);
    this.driveVer = rb.version; this.driveAlong = Math.max(pr.along, fresh ? 0 : this.driveAlong);
    const tgt = rb.pointAt(this.driveAlong + 8);
    let d = Math.atan2(tgt.x - b.x, -(tgt.z - b.z)) - b.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const remain = rb.length() - this.driveAlong;
    // look ahead for bends: the sharper the turn in the next 6-24 m, the slower we go into it
    const t0 = rb.tangentAt(this.driveAlong + 4), t1 = rb.tangentAt(this.driveAlong + 18);
    const bend = Math.acos(THREE.MathUtils.clamp(t0.x * t1.x + t0.z * t1.z, -1, 1));
    const target = THREE.MathUtils.clamp(3.6 * (1 - bend / 1.6), 1.0, 3.6) * (remain < 15 ? Math.max(0.3, remain / 15) : 1);
    const v = Math.abs(b.speed);
    const throttle = remain < 3 ? 0 : v < target ? (Math.abs(d) > 0.6 ? 0.35 : 0.8) : 0;
    return { throttle, steer: THREE.MathUtils.clamp(d * 2, -1, 1), brake: remain < 3 || v > target + 0.4 };
  }

  private tickPlay(dt: number, dtSim: number, ltst: number, sol: number, ls: number, sunElev: number) {
    const p = this.player;
    const hz = this.hazardScale();
    const inShelter = !!this.sheltered && this.menus.open;
    // consumables: metabolic rate (seated in the buggy = resting) + bag weight + heater load in the cold
    const moving = !this.driving && p.moving && p.speed > 0.05;
    const bagKg = this.bag.reduce((a, s) => a + s.massKg, 0);
    const met = (this.driving ? metabolicFactor(false, 0) : metabolicFactor(moving, p.grade)) + bagKg / 30;
    const heater = heaterLoad(this.tempC) * hz;
    this.suit = tickSuit(this.suit, dtSim, met + heater);
    if (hz === 0) this.suit = { ...this.suit, remainingH: Math.max(this.suit.remainingH, 0.5) };
    this.tickSep(dtSim);
    this.tickStorm(dtSim, ls);
    this.vitals = tickVitals(this.vitals, dtSim * hz, this.suit.remainingH <= 0, inShelter);
    if (this.vitals.cause) { this.endEva(false, `${this.vitals.cause}.`); return; }
    this.tickComms();
    this.tickSurvey(dt);

    // dust devils (convective hours) + visor frost on cold nights
    const devActive = ltst > 10 && ltst < 16.5 && this.settings.hazards !== "off";
    this.devilNear = this.devils.update(dt, dtSim, p.x, p.z, devActive);
    if (this.devilNear < 15) {
      this.visorDust = Math.min(1, this.visorDust + dt * 0.35);
      if (!this.driving) { p.x += (Math.random() - 0.5) * 0.08; p.z += (Math.random() - 0.5) * 0.08; }
    }
    this.frost = THREE.MathUtils.clamp(this.frost + dt * (this.tempC < -65 && sunElev < 0 ? 0.02 : -0.05), 0, 0.8);

    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 3) this.trail.push({ x: p.x, z: p.z });

    // discoveries: come within ~20 m of a site, of Curiosity, or of one of Curiosity's stops
    for (const s of store.stops) {
      if (s.kind === "base" || this.discovered.has(s.id)) continue;
      const w = this.terrain.toWorld(lonLatToXY(s));
      if (Math.hypot(w.x - p.x, w.z - p.z) < 20) {
        this.discovered.add(s.id);
        this.hud.toast(`<b>DISCOVERED</b> · ${s.name}${s.kind === "rover" ? " · say hi to Curiosity!" : ""} <small>(J for journal)</small>`, 5000);
        if (s.kind === "rover") setTimeout(() => this.report("Photo of Curiosity", "JPL rover team: we see you in Curiosity's hazcams! First human visitor. Please don't touch the wheels."), 2500);
        this.audio.beep(880); setTimeout(() => this.audio.beep(1320), 140);
      }
    }
    for (const l of this.landmarkPosts) {
      const d = Math.hypot(l.x - p.x, l.z - p.z);
      if (!this.discovered.has(l.lm.id) && d < 18) {
        this.discovered.add(l.lm.id);
        this.hud.toast(`<b>CURIOSITY WAS HERE</b> · end of its sol ${l.lm.sol} drive · its Navcam photo is in your journal (J)`, 5000);
        this.audio.beep(990);
      }
      l.g.visible = !this.discovered.has(l.lm.id) || d < 60;
    }

    if (this.scanner) {
      const n = this.specimens.nearest(p.x, p.z);
      if (n && n.d < 120) {
        this.scanBeepT -= dt;
        if (this.scanBeepT <= 0) { this.scanBeepT = Math.max(0.12, n.d / 60); this.audio.beep(600 + 900 * (1 - n.d / 120), 0.04); }
      }
    }

    // navigation: re-plan on target change or when off the ribbon
    const tgt = this.currentTarget();
    this.navCheckT -= dt;
    if (tgt && this.navCheckT <= 0) {
      this.navCheckT = 1;
      const end = this.navRibbon.pts[this.navRibbon.pts.length - 1];
      const parked = this.navRoute?.label?.includes("park");
      const stale = !end || (Math.hypot(end.x - tgt.x, end.z - tgt.z) > 2 && !parked);
      const off = this.navRibbon.length() > 0 && this.navRibbon.project(p.x, p.z).dist > (this.driving ? 25 : 15);
      if (stale) this.replanNav(this.navRibbon.length() ? "new target" : "");
      else if (off) this.replanNav("re-planned (off route)");
    } else if (!tgt && this.navRibbon.length()) { this.navRibbon.set([]); this.navRoute = null; }
    const pr = this.navRibbon.length() ? this.navRibbon.project(p.x, p.z) : null;
    if (pr) this.navRibbon.setDone(pr.along);
    const remain = pr ? Math.max(0, this.navRibbon.length() - pr.along) : null;
    if (this.navTarget?.kind === "point" && remain != null && remain < 3) { this.navTarget = null; this.hud.toast("Waypoint reached"); this.replanNav(""); }
    if (p.autopilot && remain != null && remain < (this.driving ? 3 : 2)) { p.autopilot = false; this.hud.toast("Arrived · autopilot off"); }

    this.homeT -= dt;
    if (this.homeT <= 0) { this.homeT = 2; this.updateHome(); }

    if (!this.sunsetWarned && sunElev < 12 && ltst > 12) {
      this.sunsetWarned = true;
      this.hud.toast(`<b>SUNSET SOON</b> · ${this.tempC.toFixed(0)} °C and falling to ${this.analogue.minAirC} °C tonight (REMS analogue). Head for the habitat or pitch the shelter (B)`, 7000);
      this.audio.beep(440, 0.25);
    }

    // interaction prompt
    const near = this.nearStop();
    const sp = this.specimens.nearest(p.x, p.z);
    let prompt = "";
    if (this.survey) prompt = "";
    else if (this.driving) prompt = Math.abs(this.buggy.speed) < 0.5 ? "<kbd>E</kbd> Get out" : "";
    else if (Math.hypot(this.buggy.x - p.x, this.buggy.z - p.z) < 3.5) prompt = this.buggy.flipped ? "<kbd>E</kbd> Right the buggy (15 min)" : "<kbd>E</kbd> Drive the buggy";
    else if (Math.hypot(this.hab.door.x - p.x, this.hab.door.z - p.z) < 4.5) prompt = "<kbd>E</kbd> Enter the habitat airlock";
    else if (this.shelter.deployed && Math.hypot(this.shelter.group.position.x - p.x, this.shelter.group.position.z - p.z) < 3.5) prompt = "<kbd>E</kbd> Enter the shelter";
    else if (near?.kind === "science" && !this.surveyed.has(near.id)) prompt = `<kbd>E</kbd> Survey ${near.name.split(" - ")[0]}`;
    else if (sp && sp.d < 2.8) prompt = `<kbd>E</kbd> Collect ${sp.s.name}`;
    else if (!this.held && this.loose.nearest(p.pos, 2.4)) prompt = "<kbd>G</kbd> Pick up rock";
    this.hud.prompt(prompt);

    const gi = xyToIdx(this.grid, this.terrain.toProj(p.x, p.z));
    const cellBlocked = gi >= 0 ? blockReason(this.grid, gi, this.profile) : null;
    this.hud.warn(
      this.vitals.health < 25 ? "CRITICAL INJURY · GET TO THE HABITAT" :
      this.suit.remainingH <= 0 ? "O₂ EXHAUSTED · SUFFOCATING" :
      this.driving && this.buggy.slipping ? "WHEELS SLIPPING · TOO STEEP FOR THE BUGGY" :
      this.driving && Math.abs(this.buggy.roll) * 57.3 > 30 ? `ROLLOVER RISK · ${Math.abs(this.buggy.roll * 57.3).toFixed(0)}° side slope` :
      !this.driving && p.blocked === "steep" ? "TOO STEEP TO CLIMB · find another line" :
      p.blocked === "boundary" ? "EDGE OF SURVEY AREA (DTM coverage)" :
      this.ret?.status === "critical" ? "PAST POINT OF NO RETURN · RETURN TO BASE NOW" :
      this.ret?.status === "turn-back" ? "TURN BACK SOON · return margin under 30 min" :
      cellBlocked ? `OFF-LIMITS FOR ${this.driving ? "BUGGY" : "WALKING"} · ${cellBlocked}` : "");

    const alerts: { text: string; level: AlertLevel }[] = [];
    if (sunElev < 0) alerts.push({ text: `NIGHT · ${this.tempC.toFixed(0)} °C`, level: "caution" });
    if (heater > 0.05) alerts.push({ text: `SUIT HEATER +${(heater * 100).toFixed(0)}% load`, level: heater > 0.4 ? "danger" : "caution" });
    if (this.sep.phase === "warning") alerts.push({ text: `SOLAR STORM IN ${fmtDur(this.sep.t)} · TAKE SHELTER`, level: "danger" });
    if (this.sep.phase === "active") alerts.push({ text: `SOLAR PARTICLE EVENT · dose ×${SURVIVAL.sepDoseMultiplier.value}`, level: "danger" });
    if (this.storm.phase === "warning") alerts.push({ text: `DUST STORM IN ${fmtDur(this.storm.t)}`, level: "danger" });
    if (this.storm.phase === "active") alerts.push({ text: `DUST STORM · τ ${this.tau.toFixed(1)} · visibility ~${Math.round(1 / this.sky.fog.density * 1.5 / 10) * 10 > 5000 ? ">5 km" : Math.round(1 / this.sky.fog.density * 1.5 / 10) * 10 + " m"}`, level: this.tau > 2.5 ? "danger" : "caution" });
    if (this.devilNear < 60) alerts.push({ text: `DUST DEVIL ${this.devilNear.toFixed(0)} m`, level: this.devilNear < 15 ? "danger" : "caution" });
    if (this.visorDust > 0.4 && this.camMode === "first") alerts.push({ text: "VISOR DUSTY · X to wipe", level: "info" });
    if (this.scanner) alerts.push({ text: "SPECTROMETER ON", level: "info" });
    if (this.buddy.status) alerts.push({ text: this.buddy.status, level: "info" });
    const pend = this.comms.filter((c) => !c.delivered);
    if (pend.length) alerts.push({ text: `EARTH REPLY IN ${fmtDur(Math.max(0, Math.min(...pend.map((c) => c.arriveS)) - this.evaS))}`, level: "info" });
    const brg = (x: number, z: number) => (Math.atan2(x - p.x, -(z - p.z)) * 180 / Math.PI + 360) % 360;
    const markers: { bearing: number; label: string; kind: "next" | "stop" | "base" | "nav"; dist: number }[] = [];
    const planned = new Set(this.planSites().map((s) => s.id));
    const shown = this.mode === "explore" ? store.stops : store.stops.filter((s) => s.kind === "base" || planned.has(s.id));
    for (const s of shown) {
      if (s.kind !== "base" && this.surveyed.has(s.id)) continue;
      const w = this.terrain.toWorld(lonLatToXY(s));
      markers.push({ bearing: brg(w.x, w.z), label: s.name.split(" - ")[0], kind: tgt?.id === s.id ? "next" : s.kind === "base" ? "base" : "stop", dist: 0 });
    }
    if (tgt && !tgt.id) markers.push({ bearing: brg(tgt.x, tgt.z), label: tgt.name, kind: "nav", dist: 0 });
    const walkS = this.navRoute && remain != null ? this.navRoute.totals.walkS * (remain / Math.max(this.navRibbon.length(), 1)) : null;
    const ovName = OVERLAYS[this.overlayIdx];
    this.hud.update({
      headingDeg: ((this.camYaw * 180) / Math.PI % 360 + 360) % 360,
      markers, objectives: this.objectives(),
      ltst: fmtClock(ltst), sol, ls, evaS: this.evaS, suit: this.suit, ret: this.ret, tempC: this.tempC,
      speed: p.speed, grade: p.grade, slopeDeg: this.terrain.slopeDeg(p.x, p.z), elev: p.y + this.terrain.meta.yRef,
      warp: WARPS[this.warpIdx], navDist: tgt ? remain : null, navTime: walkS, navName: this.navRoute?.label ?? tgt?.name ?? "",
      autopilot: p.autopilot, mode: this.camMode, odometer: p.odometer,
      health: this.vitals.health, bagKg, bagN: this.bag.length, bagMax: SAMPLE_LIMIT_KG.value,
      alerts,
      vehicle: this.driving ? { speedKmh: Math.abs(this.buggy.speed) * 3.6, battery: this.buggy.battery, pitch: this.buggy.pitch * 57.3, roll: this.buggy.roll * 57.3, slipping: this.buggy.slipping } : null,
      overlay: ovName === "off" ? "" : `<b>DATA LAYER</b> ${ovName}${ovName.startsWith("go") ? ` · ${this.driving ? "buggy" : "walking"} limits` : ""} <small>(T)</small>`,
      modeLabel: this.mode === "mission" ? "MISSION" : "EXPLORE",
    });
    type PoiKind = "landmark" | "landmark-found" | "buggy" | "hab" | "shelter" | "specimen";
    const pois: { x: number; z: number; kind: PoiKind }[] = [
      ...this.landmarkPosts.map((l) => ({ x: l.x, z: l.z, kind: (this.discovered.has(l.lm.id) ? "landmark-found" : "landmark") as PoiKind })),
      { x: this.hab.center.x, z: this.hab.center.z, kind: "hab" },
    ];
    if (!this.driving) pois.push({ x: this.buggy.x, z: this.buggy.z, kind: "buggy" });
    if (this.shelter.deployed) pois.push({ x: this.shelter.group.position.x, z: this.shelter.group.position.z, kind: "shelter" });
    if (this.scanner) for (const s of this.specimens.list) if (!s.taken && Math.hypot(s.x - p.x, s.z - p.z) < 250) pois.push({ x: s.x, z: s.z, kind: "specimen" });
    this.hud.drawMinimap({
      x: p.x, z: p.z, heading: p.heading, camYaw: this.camYaw,
      plan: this.mode === "mission" && store.route ? store.route.points.map((q) => this.terrain.toWorld(q)) : [],
      nav: this.navRibbon.pts, home: this.showHome || (this.ret && this.ret.status !== "ok") ? this.homePts : [],
      trail: this.trail,
      stops: shown.map((s) => {
        const w = this.terrain.toWorld(lonLatToXY(s));
        return { x: w.x, z: w.z, label: s.kind === "base" ? "⌂" : s.kind === "rover" ? "C" : String(store.stops.indexOf(s)), state: s.kind === "base" ? "base" : this.surveyed.has(s.id) ? "done" : "pending" };
      }),
      scan: this.scan.group.visible ? { x: this.scan.group.position.x, z: this.scan.group.position.z } : null,
      pois,
    });
    for (const b of this.beacons) {
      const el = b.label.querySelector(".bd");
      if (el) el.textContent = fmtDist(Math.hypot(b.group.position.x - p.x, b.group.position.z - p.z));
    }
    if (this.map.open) this.pushLiveToMap();
  }

  /**
   * Regional dust storm: more likely in dust season (Ls 180-330). Warned ~30 min ahead (orbital weather
   * imagery), optical depth ramps up over 40 min, holds, then clears. Light falls with Beer-Lambert,
   * visibility drops to a few hundred metres, and the crew has to trust the A* route and the minimap.
   */
  private tickStorm(dtSim: number, ls: number) {
    const st = this.storm;
    if (dtSim <= 0) return;
    if (this.settings.hazards !== "off" && st.phase === "none" && this.evaS > 1800) {
      const [a, b] = DUST.seasonLs.value;
      const perSol = DUST.perSolChance.value * (ls >= a && ls <= b ? 1 : 0.15);
      if (Math.random() < (dtSim / 88775) * perSol * 3) { // x3: compressed into the daylight hours of an EVA
        st.phase = "warning"; st.t = 30 * 60; st.peak = DUST.stormPeakTau.value * (0.7 + Math.random() * 0.5); st.dur = (2 + Math.random() * 2) * 3600;
        this.hud.toast(`<b>DUST STORM WARNING</b> · orbital imagery shows a regional storm front reaching Gale in ~30 min. Visibility will collapse: plan your route home now (H).`, 8000);
        this.audio.beep(360, 0.4);
        this.report("Storm acknowledgement", "Weather team: MARCI shows the storm front over Gale. Hold position or return on the planned route; we can't help faster than light.");
      }
    } else if (st.phase === "warning") {
      st.t -= dtSim;
      if (st.t <= 0) { st.phase = "active"; st.t = 0; this.hud.toast("<b>DUST STORM</b> · the sky is closing in. Follow the cyan A* route; the minimap still knows the way.", 6000); }
    } else if (st.phase === "active") {
      st.t += dtSim;
      const ramp = Math.min(1, st.t / 2400), fade = Math.min(1, Math.max(0, (st.dur - st.t) / 2400));
      this.tau = DUST.clearTau.value + (st.peak - DUST.clearTau.value) * Math.min(ramp, fade);
      this.visorDust = Math.min(1, this.visorDust + dtSim * 0.0004 * (this.tau / st.peak));
      if (st.t >= st.dur) { st.phase = "over"; this.tau = DUST.clearTau.value; this.hud.toast("Dust storm has passed · skies clearing"); }
    }
  }

  /** Solar particle event: random, warned in advance; dose rate multiplied unless sheltered. Illustrative. */
  private tickSep(dtSim: number) {
    if (this.settings.hazards === "off" || dtSim <= 0) return;
    const s = this.sep;
    if (s.phase === "none" && this.evaS > 3600 && Math.random() < (dtSim / 3600) * 0.2) {
      s.phase = "warning"; s.t = 20 * 60;
      this.hud.toast("<b>SPACE WEATHER ALERT</b> · solar particle event arriving in ~20 min. Get into the habitat or a shelter", 8000);
      this.audio.beep(330, 0.5);
    } else if (s.phase === "warning") {
      s.t -= dtSim;
      if (s.t <= 0) { s.phase = "active"; s.t = 2 * 3600; }
    } else if (s.phase === "active") {
      s.t -= dtSim;
      const shield = this.sheltered === "hab" ? 0 : this.sheltered === "shelter" ? 0.3 : 1;
      const extra = (RADIATION.surfaceDoseMSvPerDay.value * (SURVIVAL.sepDoseMultiplier.value - 1) * shield * dtSim) / 86400;
      this.suit = { ...this.suit, doseMSv: this.suit.doseMSv + extra };
      s.doseMSv += extra;
      if (s.t <= 0) { s.phase = "over"; this.hud.toast("Solar particle event over"); }
    }
  }

  private pushLiveToMap() {
    const ll = (q: P2) => this.terrain.lonLat(q.x, q.z);
    this.map.setLive({ ...ll({ x: this.player.x, z: this.player.z }), headingDeg: this.player.heading * 180 / Math.PI },
      this.trail.map(ll), this.navRibbon.pts.filter((_, i) => i % 3 === 0).map(ll), this.homePts.map(ll), ll({ x: this.buggy.x, z: this.buggy.z }));
    this.map.setLandmarks(this.landmarkPosts.map((l) => ({ ...l.lm, found: this.discovered.has(l.lm.id) })));
  }

  private updateCamera(dt: number) {
    const cam = this.camera;
    const p = this.player;
    if (this.xr.presenting) {
      // VR: first person from the astronaut's (or the driver's) feet; the headset supplies the head pose
      if (this.state === "play" || this.state === "deploy") {
        if (this.state === "deploy") this.touchdown();
        this.astro.setFirstPerson(true);
        const yaw = this.xr.update(p.x, (this.driving ? this.buggy.y + 0.3 : p.y) - (this.driving ? 0.6 : 0), p.z);
        this.camYaw = yaw;
      } else {
        const cx = this.terrain.meta.width / 2, cz = this.terrain.meta.depth / 2;
        this.xr.update(cx, this.terrain.heightAt(cx, cz) + 40, cz);
      }
      return;
    }
    if (this.state === "title" || this.state === "briefing" || this.state === "debrief") {
      this.titleT += dt;
      const cx = this.terrain.meta.width / 2, cz = this.terrain.meta.depth / 2;
      const summit = this.terrain.toWorld(lonLatToXY({ lon: 137.85, lat: -5.08 }));
      const toS = new THREE.Vector2(summit.x - cx, summit.z - cz).normalize();
      const a = Math.atan2(toS.y, toS.x) + Math.PI + Math.sin(this.titleT * 0.03) * 0.5;
      cam.position.set(cx + Math.cos(a) * 2600, this.terrain.heightAt(cx, cz) + 520, cz + Math.sin(a) * 2600);
      cam.lookAt(cx + toS.x * 6000, this.terrain.heightAt(cx, cz) + 900, cz + toS.y * 6000);
      return;
    }
    if (this.photo.state.on) {
      const ps = this.photo.state, k = this.keys;
      const mv = Math.max(4, ps.dist) * dt * 0.8;
      const fw = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0), rt = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
      ps.fx += (Math.sin(ps.yaw) * fw + Math.cos(ps.yaw) * rt) * mv;
      ps.fz += (-Math.cos(ps.yaw) * fw + Math.sin(ps.yaw) * rt) * mv;
      ps.fx = THREE.MathUtils.clamp(ps.fx, 0, this.terrain.meta.width); ps.fz = THREE.MathUtils.clamp(ps.fz, 0, this.terrain.meta.depth);
      const fy = this.terrain.heightAt(ps.fx, ps.fz) + 1.4;
      const c = Math.cos(ps.pitch);
      cam.position.set(ps.fx - Math.sin(ps.yaw) * c * ps.dist, fy + Math.sin(ps.pitch) * ps.dist, ps.fz + Math.cos(ps.yaw) * c * ps.dist);
      const g = this.terrain.inside(cam.position.x, cam.position.z) ? this.terrain.heightAt(cam.position.x, cam.position.z) + 0.4 : -Infinity;
      if (cam.position.y < g) cam.position.y = g;
      if (cam.fov !== ps.fov) { cam.fov = ps.fov; cam.updateProjectionMatrix(); }
      cam.lookAt(ps.fx, fy, ps.fz);
      return;
    }
    if (cam.fov !== 62) { cam.fov = 62; cam.updateProjectionMatrix(); }
    if ((p.autopilot || p.moving) && this.time - this.lastDrag > 2.5 && this.camMode === "third") {
      let d = p.heading - this.camYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw += d * Math.min(1, dt * (p.autopilot || this.driving ? 1.5 : 0.6));
    }
    let pos: THREE.Vector3;
    const look = new THREE.Vector3();
    if (this.camMode === "first") {
      pos = this.astro.eye(new THREE.Vector3());
      const pitch = this.camPitch - 0.16;
      look.set(pos.x + Math.sin(this.camYaw) * Math.cos(pitch), pos.y - Math.sin(pitch), pos.z - Math.cos(this.camYaw) * Math.cos(pitch));
    } else {
      const dist = this.driving ? Math.max(this.camDist, 8) : this.camDist;
      const target = new THREE.Vector3(p.x, p.y + (this.driving ? 1.8 : 1.55), p.z);
      const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch + (this.driving ? 0.08 : 0));
      pos = new THREE.Vector3(target.x - Math.sin(this.camYaw) * cp * dist, target.y + sp * dist, target.z + Math.cos(this.camYaw) * cp * dist);
      const ground = this.terrain.heightAt(pos.x, pos.z) + 0.6;
      if (pos.y < ground) pos.y = ground;
      const q = { x: pos.x, z: pos.z };
      if (this.hab.collide(q, 0.3)) { pos.x = q.x; pos.z = q.z; }
      look.copy(target);
    }
    if (this.state === "deploy") {
      this.deployT += dt / 5.5;
      const t = Math.min(this.deployT, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0)));
      cam.position.lerpVectors(this.deployFrom.pos, pos, e).y += Math.sin(e * Math.PI) * 300 * (1 - e);
      cam.quaternion.slerpQuaternions(this.deployFrom.quat, q, e);
      if (t >= 1) this.touchdown();
      return;
    }
    cam.position.copy(pos);
    cam.lookAt(look);
  }
}
