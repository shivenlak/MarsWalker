// Menus: game settings (persisted per browser), options panel, pause menu, journal (discoveries + sample
// bag, with Curiosity's real photos), and the habitat airlock menu.

import type { Sample } from "../core/survival";

export interface Settings {
  travel: "foot" | "buggy";
  hazards: "realistic" | "forgiving" | "off";
  graphics: "high" | "medium" | "low";
  sound: boolean;
  startHour: number;
}

// phones/tablets start on medium graphics (coarse pointer = touch screen)
const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
const DEFAULTS: Settings = { travel: "foot", hazards: "realistic", graphics: touch ? "medium" : "high", sound: true, startHour: 9 };

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem("marswalk.settings") ?? "{}");
    return { ...DEFAULTS, ...s };
  } catch { return { ...DEFAULTS }; }
}
function saveSettings(s: Settings) {
  try { localStorage.setItem("marswalk.settings", JSON.stringify(s)); } catch { /* private mode */ }
}

export interface JournalEntry { id: string; title: string; text: string; img?: string; caption?: string; found: boolean; kind: string }

export class Menus {
  readonly el: HTMLDivElement;
  settings = loadSettings();
  onSettings: ((s: Settings) => void) | null = null;
  private q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "menus";
    this.el.innerHTML = `
      <div class="mn options"><div class="mn-card"><h2>OPTIONS</h2><div class="opt-body"></div><button class="btn mn-close">DONE</button></div></div>
      <div class="mn pause"><div class="mn-card"><h2>PAUSED</h2>
        <button class="btn" data-a="resume">RESUME</button><button class="btn" data-a="journal">JOURNAL</button>
        <button class="btn" data-a="map">MISSION MAP</button><button class="btn" data-a="options">OPTIONS</button>
        <button class="btn" data-a="quit">ABANDON EVA</button></div></div>
      <div class="mn journal"><div class="mn-card wide"><h2>JOURNAL <button class="sv-x jr-x">&times;</button></h2>
        <div class="jr-tabs"><button data-t="sites" class="on">SITES</button><button data-t="finds">CURIOSITY'S PATH</button><button data-t="bag">SAMPLE BAG</button></div>
        <div class="jr-body"></div></div></div>
      <div class="mn hab"><div class="mn-card"><h2>HABITAT AIRLOCK</h2><p class="note hab-status"></p><div class="hab-acts"></div>
        <button class="btn mn-close">LEAVE</button></div></div>`;
    root.appendChild(this.el);
    this.el.querySelectorAll<HTMLButtonElement>(".mn-close").forEach((b) => (b.onclick = () => this.close()));
    this.q<HTMLButtonElement>(".jr-x").onclick = () => this.close();
  }

  get open() { return !!this.el.querySelector(".mn.on"); }
  close() { this.el.querySelectorAll(".mn").forEach((m) => m.classList.remove("on")); this.onClose?.(); }
  onClose: (() => void) | null = null;
  private show(name: string) { this.el.querySelectorAll(".mn").forEach((m) => m.classList.toggle("on", m.classList.contains(name))); }

  // ---------- options ----------
  options() {
    this.show("options");
    const s = this.settings;
    const row = (label: string, key: keyof Settings, opts: [string | number | boolean, string][], help = "") => `
      <div class="opt-row"><label>${label}</label><div class="seg" data-k="${key}">
        ${opts.map(([v, t]) => `<button data-v="${v}" class="${String(s[key]) === String(v) ? "on" : ""}">${t}</button>`).join("")}
      </div>${help ? `<p class="src">${help}</p>` : ""}</div>`;
    this.q(".opt-body").innerHTML =
      row("Start the EVA", "travel", [["foot", "On foot"], ["buggy", "In the buggy"]], "The buggy is always parked at base; E to board or leave it.") +
      row("Hazards", "hazards", [["realistic", "Realistic"], ["forgiving", "Forgiving"], ["off", "Off"]],
        "Realistic: cold nights drain the suit heater, falls hurt, solar storms, dust devils, O2 can run out. Forgiving halves damage and drain.") +
      row("Start time (local solar)", "startHour", [[7, "07:00"], [9, "09:00"], [12, "12:00"], [15, "15:00"], [17, "17:00"]], "Start late to race the sunset.") +
      row("Graphics", "graphics", [["high", "High"], ["medium", "Medium"], ["low", "Low"]]) +
      row("Sound", "sound", [[true, "On"], [false, "Off"]]);
    this.el.querySelectorAll<HTMLElement>(".opt-body .seg").forEach((seg) => {
      seg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => {
        const k = seg.dataset.k as keyof Settings;
        const raw = b.dataset.v!;
        const v = raw === "true" ? true : raw === "false" ? false : isNaN(+raw) ? raw : +raw;
        (this.settings as unknown as Record<string, unknown>)[k] = v;
        saveSettings(this.settings);
        this.onSettings?.(this.settings);
        this.options();
      }));
    });
  }

  // ---------- pause ----------
  pause(handlers: { resume: () => void; journal: () => void; map: () => void; quit: () => void }) {
    this.show("pause");
    this.el.querySelectorAll<HTMLButtonElement>(".pause [data-a]").forEach((b) => (b.onclick = () => {
      const a = b.dataset.a!;
      if (a === "options") this.options();
      else (handlers as Record<string, () => void>)[a]();
    }));
  }

  // ---------- journal ----------
  journal(sites: JournalEntry[], finds: JournalEntry[], bag: Sample[], deposited: Sample[]) {
    this.show("journal");
    const card = (e: JournalEntry) => e.found
      ? `<div class="jr-card"><img src="${e.img}" loading="lazy"><div><h4>${e.title}</h4><p>${e.text}</p><p class="src">${e.caption ?? ""}</p></div></div>`
      : `<div class="jr-card locked"><div class="jr-q">?</div><div><h4>${e.title}</h4><p class="note">Not yet visited. ${e.kind === "landmark" ? "Follow Curiosity's wheel tracks to find it." : "Marked on the mission map."}</p></div></div>`;
    const render = (t: string) => {
      this.el.querySelectorAll<HTMLButtonElement>(".jr-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
      const body = this.q(".jr-body");
      if (t === "sites") body.innerHTML = sites.map(card).join("");
      else if (t === "finds") body.innerHTML = `<p class="note">${finds.filter((f) => f.found).length} / ${finds.length} of Curiosity's stopping points found. Each photo was taken by Curiosity's Navcam right there.</p>` + finds.map(card).join("");
      else {
        const kg = (a: Sample[]) => a.reduce((x, s) => x + s.massKg, 0).toFixed(2);
        const li = (s: Sample) => `<li><b>${s.name}</b> <span class="src">${s.massKg} kg · ${s.site}</span><br><span class="note">${s.about}</span></li>`;
        body.innerHTML = `<h4>Carrying (${kg(bag)} kg)</h4><ul class="bag">${bag.map(li).join("") || "<li class='note'>Empty</li>"}</ul>
          <h4>Delivered to the habitat (${kg(deposited)} kg)</h4><ul class="bag">${deposited.map(li).join("") || "<li class='note'>None yet</li>"}</ul>`;
      }
    };
    this.el.querySelectorAll<HTMLButtonElement>(".jr-tabs button").forEach((b) => (b.onclick = () => render(b.dataset.t!)));
    render("sites");
  }

  // ---------- habitat ----------
  habitat(status: string, acts: { label: string; note: string; run: () => void; disabled?: boolean }[]) {
    this.show("hab");
    this.q(".hab-status").innerHTML = status;
    this.q(".hab-acts").innerHTML = acts.map((a, i) => `<button class="task" data-i="${i}" ${a.disabled ? "disabled" : ""}><span>${a.label}</span><small>${a.note}</small></button>`).join("");
    this.el.querySelectorAll<HTMLButtonElement>(".hab-acts .task").forEach((b) => (b.onclick = () => acts[+b.dataset.i!].run()));
  }
}
