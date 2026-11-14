// Entry: load shared data once, build both modes, wire the Planner/HUD toggle.

import "./style.css";
import { loadGrid } from "./core/grid";
import { initHud, onHideHud, onShowHud } from "./hud/hud";
import { initPlanner, onShowPlanner } from "./planner/planner";
import { loadStops } from "./shared/data";
import { store } from "./shared/store";

async function main() {
  const [grid, stops] = await Promise.all([loadGrid(), loadStops()]);
  store.grid = grid;
  store.stops = stops;

  const planner = document.getElementById("planner")!;
  const hud = document.getElementById("hud")!;
  await initPlanner(planner);
  initHud(hud);

  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-mode]");
  const show = (mode: string) => {
    planner.hidden = mode !== "planner";
    hud.hidden = mode !== "hud";
    buttons.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    if (mode === "planner") { onHideHud(); onShowPlanner(); } else onShowHud();
  };
  buttons.forEach((b) => (b.onclick = () => show(b.dataset.mode!)));
  show("planner");
}

main().catch((e) => {
  document.body.innerHTML = `<pre class="fatal">${e}</pre>`;
  console.error(e);
});
