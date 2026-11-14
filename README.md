# Marswalk

An EVA planner + helmet HUD for a single Marswalk on lower Mount Sharp, Gale Crater. Built on real NASA data:
HiRISE imagery, a 1 m HiRISE DTM, THEMIS thermal, and Curiosity's traverse and Navcam images.

**Story:** *Water on Mount Sharp, twice.* Walk from base to the Gediz Vallis channel (flood debris, the first pure sulfur found on Mars), then to the boxwork ridges (ancient groundwater in fractures), and get back with margin.

## Run it

```bash
npm install
npm run dev          # open http://localhost:5173 (also reachable from a tablet on the same Wi-Fi)
```

The preprocessed data in `data/processed/` (~17 MB) is committed, so the app runs **offline** with no API calls.

```bash
npm test             # A* unit tests + real-terrain smoke test
```

### Rebuild the data (optional, needs internet, ~2 min)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/build_all.py
```

This reads only the AOI window of the 3.9 GB USGS DTM via HTTP range requests (~a few hundred MB), caches HiRISE tiles z13–17, stitches THEMIS, and pulls Curiosity's traverse and POV images. See `DATA_SOURCES.md`.

## What's in the MVP (Phase 1)

- **Planner**
  - HiRISE base map, plus toggle + opacity for hillshade/elevation, slope and THEMIS thermal
  - Curiosity traverse
  - Science-stop pins with info cards and Curiosity Navcam images
  - Include/exclude stops to re-plan the A* route live
  - EVA budget: distance, climb/descent, walking time, total EVA, per-leg table
- **HUD:**
  - Visor view over a Curiosity image of the next stop
  - Compass tape with the bearing to the next stop
  - Route distance remaining, slope-ahead light
  - Simulate walk (×60/×120/×300). The position also shows on the planner map

## Repo layout

```
scripts/          offline data pipeline (Python): build_terrain, fetch_basemap, fetch_rover, build_all
data/raw/         gitignored cache (DTM window)
data/processed/   web-ready files, served at the site root by Vite
src/core/         no UI: config (all numbers + sources), grid, astar, cost, route, nav  (+ tests)
src/planner/      Mode A UI (Leaflet)
src/hud/          Mode B UI (canvas compass + DOM panels)
src/shared/       data loading, shared store, formatting
```

## How the route is computed

1. **Grid:** 10 m cells (238 × 333) from the 1 m DTM. Each cell stores mean elevation, p90 slope (from a 2 m DEM) and roughness (RMS residual about a best-fit plane).
2. **Blocked cells:** slope > 25°, roughness > 0.5 m, or no data.
3. **Edge cost:** 3D distance × slope multiplier × roughness multiplier, + 8 m per metre climbed.
4. **A*:** 8-connected, straight-line heuristic (admissible). Chained base → stops → base.
5. **Time:** Tobler-shaped speed vs. grade per step, plus 30 min per stop.

Every weight is in `src/core/config.ts`. The reasoning is in `ASSUMPTIONS.md`.

## Docs

- `DATA_SOURCES.md`: every dataset, URL, format, and credit
- `ASSUMPTIONS.md`: every assumed number and why
