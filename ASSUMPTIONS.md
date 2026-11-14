# ASSUMPTIONS.md

Every number in the UI is either **sourced** (green tag) or **assumed** (amber tag, hover for the reason).
All values live in one place: `src/core/config.ts`. Change them there.

## Terrain / router (profile: walking, 2 crew, standard tool load)

| Parameter | Value | Status | Reasoning |
|---|---|---|---|
| Grid cell size | 10 m | design choice | The 2.4 × 3.3 km AOI becomes 238 × 333 = 79k cells, and full-EVA A* takes ~20 ms in the browser. Slope/roughness are computed at 1–2 m *inside* each cell (p90 / RMS), so fine hazards still show up in the coarse grid |
| Cell slope metric | 90th percentile of 2 m slopes | design choice | Conservative: a cell is only as walkable as its steep parts. HiRISE DTMs have ~1 m posts but ~3 m effective resolution, so 1 m slopes are noisy |
| Max walkable slope | 25° | **assumed** | Suited-walking limit. Apollo crews walked on slopes of ~20–25° with difficulty |
| Max roughness | 0.5 m RMS about the cell's best-fit plane | **assumed** | About knee-height relief inside 10 m: boulders, scarps, ridge crests |
| Slope cost weight | ×(1 + 3·(s/25°)²) | **assumed** | Strongly prefers gentle ground without forbidding moderate slopes |
| Roughness cost weight | ×(1 + 2·(r/0.5 m)) | **assumed** | |
| Uphill penalty | +8 m-equivalent per metre climbed | sourced (Earth) / assumed (Mars) | Naismith's rule: 1 h per 600 m ascent at 5 km/h → 1 m up ≈ 8.3 m flat |
| Edge distance | 3D: √(d² + Δz²) | — | |
| Heuristic | straight-line 2D distance | — | Admissible: every edge costs ≥ its 2D length |
| No-data cells | impassable | — | AOI currently has 0% no-data |

Cell-level climb totals include some DTM noise (each 10 m step contributes its own Δz), so "+195 m" is an upper-bound-ish figure.

## Walking time

| Parameter | Value | Status | Reasoning |
|---|---|---|---|
| Flat speed | 3.0 km/h | **assumed** | Below Earth's ~5 km/h for suit mobility. Apollo lunar walking traverses were typically ~2–3 km/h |
| Grade effect | Tobler's hiking function shape, exp(−3.5·\|g + 0.05\|), normalised to flat | sourced shape (Tobler 1993) | Fastest on a slight downhill, slower both ways |
| Dwell per science stop | 30 min | **assumed** | Imaging + sampling |
| EVA limit | 8 h | **assumed** | NASA xEMU design target ~8 h. Total turns red when exceeded |

## Data interpretation

- **THEMIS Day IR** is shown as *relative* daytime brightness (8-bit mosaic DN), not calibrated temperature or thermal inertia. At ~81 m/px it is ~30 × 42 px over the AOI. It is a context layer and is **not yet in the route cost**.
- **Stop positions** are Curiosity drive end-points at the cited sol, not the exact drill/target spot (typically within a few metres to tens of metres).
- **Boxwork entrance stop** sits on a ridge whose 10 m cell exceeds the slope limit, so the router snaps it to the nearest passable cell and shows a warning. This is consistent with the rover's 11 m climb to reach it.
- **POV images** are raw (uncalibrated) Navcam frames, auto-picked by camera pointing (near-horizontal, not looking back at the deck).

## Not yet modelled (Phase 2)

Point of no return, suit consumables, radiation dose (constant is already in `config.ts`: 0.64 mSv/day, sourced), space weather, REMS temperature/daylight window, rover-assisted / heavy-load profiles.
