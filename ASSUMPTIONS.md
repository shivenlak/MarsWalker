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

## Suit, point of no return, walk sim (game)

| Parameter | Value | Status | Reasoning |
|---|---|---|---|
| Suit consumables capacity | 8.5 nominal hours | **assumed** | Sized like an EMU/xEMU PLSS (~8 h EVA + 30 min reserve). O₂, water and battery share one budget so the HUD shows one bar |
| Reserve on return | 30 min | **assumed** | EMU practice: never plan to arrive with an empty PLSS |
| Consumption vs activity | rest 0.7×, flat walk 1.0×, +4× per unit uphill grade (cap 2.2×), downhill 0.9× | **assumed** | Shape follows Earth walking metabolic studies (e.g. Pandolf 1977). Magnitudes are not Mars-validated |
| Point of no return | remaining − (A* walk home × climb factor) − reserve | design | Recomputed every 2 s with a fresh A* from the walker's position to base. Amber under 30 min of margin, red when negative |
| Radiation dose | 0.64 mSv/sol | sourced | Hassler et al. 2014 (RAD). Quiet-sun average; SEP events not modelled |
| Physical climb limit (sim) | 30° at 2 m scale | **assumed** | What the walker can physically step up in the sim. The *router* stays at 25° p90 (stricter), so planned routes never hit it |
| Lope speed (Shift) | 1.5× walking | **assumed** | Apollo crews used a loping gait in low gravity |
| Hop | 1.7 m/s take-off under 3.72 m/s² | sourced g / cosmetic speed | ~0.4 m apex, ~0.9 s airtime |
| Air temperature curve | cosine from REMS daily min (sunrise) to max (14:00) | **assumed** | The REMS feed gives only daily extremes |
| Weather analogue | REMS sol with the same Ls, latest Mars year | design | No live forecast exists; same-season data is the best offline proxy |
| Projection scale | equirectangular clon0 → E–W distances 0.35% long at −4.8° | known | Matches the USGS DTM. Negligible for planning |
| Survey tasks | 10 + 20 min = 30 min dwell | same as plan | Image the outcrop, then collect a sample |
| Time warp | ×1 to ×60 | design | Sim clock, sun, consumables and dose all scale together |

## Not yet modelled

SEP/flare dose spikes, CRISM mineral layer, rover-assisted / heavy-load crew profiles, dust-storm opacity effects on lighting.
