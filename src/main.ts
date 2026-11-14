// Entry: load the real terrain + mission data, build the 3D world, then hand over to the game.

import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import "./style.css";
import { loadGrid, lonLatToXY } from "./core/grid";
import { Game } from "./game/game";
import { Terrain } from "./game/terrain";
import { loadConditions } from "./shared/conditions";
import { loadLandmarks, loadStops, loadTraverse } from "./shared/data";
import { store } from "./shared/store";

async function main() {
  const root = document.getElementById("app")!;
  const [grid, stops, terrain, cond, trav, landmarks] = await Promise.all([
    loadGrid(), loadStops(), Terrain.load(), loadConditions(), loadTraverse(), loadLandmarks()]);
  store.grid = grid;
  store.stops = stops;
  // Curiosity's traverse in world coordinates (for its wheel tracks)
  const traverse = trav.features.map((f) => (f.geometry as GeoJSON.LineString).coordinates
    .map(([lon, lat]) => terrain.toWorld(lonLatToXY({ lon, lat }))));
  const game = new Game(root, terrain, grid, cond.rems, cond.donki, { traverse, landmarks });
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
