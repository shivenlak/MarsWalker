// Entry: load the real terrain + mission data, build the 3D world, then hand over to the game.

import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import "./style.css";
import { loadGrid } from "./core/grid";
import { Game } from "./game/game";
import { Terrain } from "./game/terrain";
import { loadConditions } from "./shared/conditions";
import { loadStops } from "./shared/data";
import { store } from "./shared/store";

async function main() {
  const root = document.getElementById("app")!;
  const [grid, stops, terrain, cond] = await Promise.all([loadGrid(), loadStops(), Terrain.load(), loadConditions()]);
  store.grid = grid;
  store.stops = stops;
  const game = new Game(root, terrain, grid, cond.rems, cond.donki);
  if (import.meta.env.DEV) Object.assign(window, { game, terrain });
  const scr = game.loadingScreens;
  scr.progress(0.05, "Building terrain chunks (2 m DTM + HiRISE colour)…");
  await terrain.build(game.renderer, (f) => scr.progress(0.05 + f * 0.85, f < 1 ? "Draping HiRISE imagery on the 1 m DTM…" : "Raising Mount Sharp (HRSC-MOLA)…"));
  scr.progress(0.95, "Planning the EVA with A*…");
  await game.init();
}

main().catch((e) => {
  document.body.innerHTML = `<pre class="fatal">${e?.stack ?? e}</pre>`;
  console.error(e);
});
