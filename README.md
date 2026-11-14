# Marswalk

**Walk a real EVA on Mount Sharp, Gale Crater, like a video game, on real NASA terrain.**

Plan a suited EVA with A* on the HiRISE 1 m terrain model, then walk it in 3D. The world under your boots is the
real ground Curiosity drove over: the USGS 1 m HiRISE DTM with HiRISE colour draped on it, and Mount Sharp and the
crater rim on the horizon from the HRSC-MOLA global DEM. Survey real science stops with Curiosity's own Navcam
images, and watch your suit consumables and point of no return as you go.

**Story:** *Water on Mount Sharp, twice.* Walk from base to the Gediz Vallis channel (flood debris, the first pure
sulfur found on Mars), then to the boxwork ridges (ancient groundwater in fractures), and get back with margin.

## Run it

```bash
npm install
npm run dev          # open http://localhost:5173
```

All data (~39 MB) is preprocessed and committed in `data/processed/`, so the game runs **offline** with no API calls.

```bash
npm test             # 20 tests: A* (incl. the 10x10 wall), walking + buggy routes and park-and-walk on real terrain,
                     # suit/PNR, survival model, Mars clock vs REMS
npm run build        # type-check + production build into dist/
```

## How to play

**Modes** (title screen):
- **Mission**: plan the stops (walking or buggy). Drill and bag a core at each site, find 3 field specimens with the spectrometer, and deliver everything to the habitat lab. Scored.
- **Free Explore**: roam the whole 2.4 × 3.3 km survey area. Find the 8 science sites, Curiosity itself (parked at its real sol 5073 position) and 16 of its past stopping points (each unlocks the Navcam photo it took there), and collect specimens.
- **Options**: start on foot or in the buggy; hazards Realistic / Forgiving / Off; start time (race the sunset); graphics; sound.

| Key | On foot | In the buggy |
|---|---|---|
| **W A S D** | walk (Tobler slope speed) | throttle / steer (LRV: 13 km/h max) |
| **Shift / Space** | lope / hop (Mars gravity) | – / brake |
| **E** | survey site · collect specimen · drive the buggy · enter the habitat or shelter | get out |
| **F** | autopilot along the A* route | autopilot (park-and-walk when the buggy can't reach) |
| **V** | first-person helmet view (visor, frost, dust, breath fog) | seat view |
| **Q** | spectrometer: specimens glow; the beep speeds up as you close in | |
| **T** | data layer on the terrain: slope / A* go-no-go / elevation / THEMIS thermal | |
| **G** | pick up / throw a rock (ballistic in 0.38 g) | |
| **B** | pitch the emergency shelter (one per EVA) | |
| **L / Z / X** | helmet lamps / gold sun visor / wipe visor | |
| **M / J / Esc** | mission map / journal / pause menu | |
| **[ ]** · **H** · **Click** | time warp · A* path home · terrain scan (**N** = navigate there) | |

**Survival:** the suit's O₂/water/power drain faster when you work hard, carry samples, or run the heater. Gale nights fall to about −73 °C (REMS). Falls above ~2 m hurt. A solar particle event can arrive with a 20-minute warning. Dust devils coat your visor. The buggy can roll over on side slopes. The habitat recharges you; the shelter gets you through a night.

## What's real, what's modelled

| Real data | Modelled (sourced) | Assumed (amber tag in the UI, see `ASSUMPTIONS.md`) |
|---|---|---|
| 1 m HiRISE DTM terrain, HiRISE colour, HRSC-MOLA Mount Sharp, Viking colour backdrop | Sun position and sol for today's date (Mars24, checked against REMS) | 25° slope / 0.5 m roughness limits, 3 km/h pace |
| Curiosity traverse, stop positions, Navcam images | Walking speed vs grade (Tobler), uphill penalty (Naismith) | Suit capacity 8.5 h, metabolic factors |
| REMS weather (same-season analogue), RAD dose 0.64 mSv/sol | Planet curvature, Mars gravity | Diurnal temperature shape, lope speed, physical climb limit |

Rocks are scattered procedurally with density driven by the DTM roughness grid. Footprints, dust and wind are cosmetic.

## How the route is computed

1. **Grid:** 10 m cells (238 × 333) from the 1 m DTM. Each cell stores mean elevation, p90 slope (from a 2 m DEM) and roughness (RMS about a best-fit plane).
2. **Blocked cells:** slope > 25°, roughness > 0.5 m, or no data.
3. **Edge cost:** 3D distance × slope multiplier × roughness multiplier, + 8 m per metre climbed.
4. **A*:** 8-connected, straight-line heuristic (admissible). Plan = base → stops → base (~20–50 ms).
5. **Live:** in the game, A* re-plans from your position whenever you leave the route by more than 15 m. The path home (point of no return) is recomputed every 2 s.

## Repo layout

```
scripts/          offline data pipeline (Python): build_terrain, build_world, fetch_basemap, fetch_rover, fetch_conditions
data/processed/   web-ready data served at the site root (terrain grid, 3D world chunks, tiles, POV images, conditions)
src/core/         pure logic, no UI: config (every number + source), grid, astar, cost, route, nav, sun, suit (+ tests)
src/game/         Three.js game: terrain, sky, astronaut (IK), player, buggy, props (habitat, Curiosity, shelter,
                  rocks, specimens, dust devils, tracks), helmet, effects, markers, hud, menus, screens, audio, game loop
src/planner/      mission map (Leaflet): briefing, stop selection, budget, leg profiles, terrain readout
src/shared/       data loading, conditions (REMS/DONKI), store, formatting
```

### Rebuild the data (optional, needs internet, a few minutes)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/build_all.py
NASA_API_KEY=<your free key> .venv/bin/python scripts/fetch_conditions.py   # DEMO_KEY is heavily rate-limited
```

## Docs

- `DATA_SOURCES.md`: every dataset, URL, format, how it was verified, and credits
- `ASSUMPTIONS.md`: every assumed number and why

Credits: NASA/JPL-Caltech/UArizona (HiRISE), USGS Astrogeology (MSL Gale DEM, Calef & Parker 2016; HRSC-MOLA blend,
Fergason et al. 2018), ESA/DLR/FU Berlin (HRSC), NASA/JPL-Caltech/MSSS (Curiosity images), CAB (CSIC-INTA) (REMS),
ASU (THEMIS), NASA Mars Trek (Viking MDIM 2.1), NASA CCMC (DONKI), Hassler et al. 2014 (RAD).
