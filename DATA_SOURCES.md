# DATA_SOURCES.md — Marswalk (Gale Crater / lower Mount Sharp)

Every source below was **checked live on 2026-11-14** with an HTTP request and a look at the response (status, size, header or content). "Status" is what we saw that day. The app never calls these at runtime: `scripts/` downloads everything once and writes it to `data/processed/`.

## Area of interest (AOI)

- **lon 137.374 – 137.414 °E, lat −4.830 – −4.774 °** (≈ 2.4 km E–W × 3.3 km N–S)
- Covers the Gediz Vallis channel segment (Curiosity sols ~4100–4340), the boxwork region (sols ~4600–4900) and the start of "Valle Grande" (sol 5000+).
- Route grid: 10 m/cell (~240 × 330 ≈ 80k cells), built from the 1 m DTM. 5 m is the fallback if 10 m hides hazards.

## Sources

### (a) Optical base: HiRISE color mosaic tiles (NASA MMGIS)
- URL template: `https://mars.nasa.gov/mmgis-maps/MSL/Layers/MSL_Gale_HiRISE-LRGB_78quads/{z}/{x}/{y}.png`
- Found in the config of NASA's "Curiosity's Location" map: `https://mars.nasa.gov/maps/location/api/configure/get?mission=MSL`
- Format: PNG XYZ tiles in **TMS order (y flipped: `y_tms = 2^z − 1 − y_xyz`)**, ~120 KB each. Tested z14 and z16 at the AOI (HTTP 200). Off-coverage tiles return 403.
- Alternate layer in the same config: CTX 6 m ortho mosaic, `.../MSL_CTX_ortho_mosaic_6m/{z}/{x}/{y}.png`
- Credit: NASA/JPL-Caltech/University of Arizona (HiRISE); NASA/JPL/MSSS (CTX); NASA AMMOS MMGIS.
- Difficulty: easy. Cache about 1–2k tiles for the AOI.

### (a′) Optical, high-res fallback: USGS MSL Gale Orthophoto Mosaic 25 cm v3
- `https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_Orthophoto_Mosaic_25cm_v3.tif`
- GeoTIFF, 24.4 GB (HTTP 200). Usable only through windowed range reads. Not planned for MVP.
- Credit: USGS Astrogeology Science Center; Calef & Parker (2016), MSL Gale Merged Orthophoto Mosaic.

### (b) Topography: USGS MSL Gale DEM Mosaic 1 m v3
- `https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif`
  - 302 redirect to `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif`
- Verified by parsing the TIFF header with range reads:
  - 3,868,256,546 bytes; `Accept-Ranges: bytes`; Last-Modified 2022-11-09
  - 32980 × 57440 px, Float32, LZW, **1-row strips**, 1.0 m pixels
  - CRS: Equirectangular, clon 0, Mars 2000 sphere R = 3,396,190 m
  - Upper-left x = 8,127,993.99 m, y = −244,781.58 m; nodata −32767
  - Stats: min −4625.9 m, max −322.6 m
- Extent ≈ lon 137.12–137.68 °E, lat −4.13 to −5.10 °, so the AOI is fully covered.
- Curiosity's waypoint `easting/northing` use the same projection; for example, sol 5073 is at x = 8,143,684.7, y = −286,061.1, inside the raster.
- Plan: read only the AOI rows (~3.3k rows, estimated 200–300 MB transfer) with rasterio over `/vsicurl/`. The full 3.9 GB file is never downloaded.
- Credit: USGS Astrogeology; Calef & Parker (2016), MSL Gale Merged DEM (from HiRISE stereo DTMs).
- Difficulty: medium (GDAL is not installed locally; plan is `pip install rasterio`).

### (c1) Spectral: CRISM MTRDR (map-projected targeted reduced data)
- Discovery: PDS ODE REST API
  - `https://oderest.rsl.wustl.edu/live2/?query=product&results=fp&output=JSON&target=mars&ihid=MRO&iid=CRISM&pt=MTRDR&westlon=137.37&eastlon=137.42&minlat=-4.83&maxlat=-4.77`
- Products intersecting the AOI: FRT000058A3, **FRT0000B6F1**, HRL0000BABA, FRT0001BBA1, FRT0001CA91, FRT00021C92 (all `_07_IF16xJ_MTR3`)
- Browse products per observation (PNG ~0.3–0.8 MB, plus ENVI IMG/HDR/LBL ~1.6 MB) include:
  - `BRHYDJ`: hydrated minerals (sulfates)
  - `BRPHYJ`: phyllosilicates
  - `BRFALJ`, `BRFEMJ`, `BRCARJ`: false color, iron minerals, carbonates
- Example: `https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/browse/2008/2008_191/frt0000b6f1/frt0000b6f1_07_brhydj_mtr3.png`
- Resolution ~18 m/px. Georeference from the LBL/HDR map projection.
- **To verify in Phase 1:** exact footprint overlap with the route corridor.
- Credit: NASA/JPL-Caltech/JHUAPL (CRISM), PDS Geosciences Node, Washington University in St. Louis.

### (c2) Thermal: THEMIS Day IR controlled mosaic 100 m (Mars Trek)
- Capabilities: `https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018/1.0.0/WMTSCapabilities.xml` (200)
- Tiles: `https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018/1.0.0/default/default028mm/{z}/{row}/{col}.png` (200, equirectangular WMTS)
- **Coarse:** ~25 × 33 px over the AOI. Used as a soft overlay and a low-weight terrain-type cost term.
- Credit: NASA/JPL-Caltech/Arizona State University (THEMIS); NASA Solar System Treks.

### (d1) Rover ground truth: Curiosity traverse and waypoints (NASA MMGIS)
- `https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json`: GeoJSON, 1.36 MB
- `https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json`: GeoJSON, 665 KB
  - 1389 points, sol 3 → sol 5073
  - Fields: site/drive, sol, lon, lat, elev_geoid, easting/northing, roll/pitch/yaw/tilt, dist_total_m
- Credit: NASA/JPL-Caltech, MSL localization team.

### (d2) Rover POV images: MSL raw images API
- `https://mars.nasa.gov/api/v1/raw_image_items/?order=sol%20desc&per_page=50&page=0&condition_1=msl:mission&condition_2=<SOL>:sol:gte&condition_3=<SOL>:sol:lte`
- JSON with `https_url` JPGs (Mastcam, Navcam, …). Tested sol 4620: 410 images.
- Raw, unprocessed images. Download a curated handful per stop.
- Credit: NASA/JPL-Caltech/MSSS (Mastcam); NASA/JPL-Caltech (Navcam).

### (e1) Atmosphere: REMS weather feed
- `https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json`: JSON, 1.7 MB
- 4745 sols, latest sol 4995 (2026-08-25)
- Per sol: min/max air temp, min/max ground temp, pressure, atmo_opacity, sunrise/sunset, UV index
- Wind and humidity are mostly `--` (missing).
- Credit: NASA/JPL-Caltech/CAB (Centro de Astrobiología), REMS team.

### (e2) Radiation: RAD surface dose rate (published)
- Hassler, D. M. et al. (2014). *Mars' Surface Radiation Environment Measured with the Mars Science Laboratory's Curiosity Rover.* Science 343(6169), 1244797. NTRS: https://ntrs.nasa.gov/citations/20180007641
- **Surface dose equivalent 0.64 ± 0.12 mSv/day** (tabulated in https://www.swsc-journal.org/articles/swsc/full_html/2016/01/swsc150074/T2.html). Absorbed dose ~0.21 mGy/day.
- Cruise rate for comparison: ~1.84 mSv/day.
- Use: EVA dose = rate × EVA duration. Any solar-event multiplier is **modeled** and goes in ASSUMPTIONS.md.

### (e3) Space weather: NASA DONKI
- `https://api.nasa.gov/DONKI/{CME|SEP|GST|IPS|notifications}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&api_key=DEMO_KEY`: all returned 200
- **`/DONKI/FLR` returned 404 on 2026-11-14.** `kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/...` timed out.
- Flare info comes from `notifications` if FLR stays down. The app ships a cached snapshot.
- These events are Earth/heliosphere-centric. Applying them to Mars is an assumption (to be documented).
- Credit: NASA CCMC / Moon to Mars Space Weather Analysis Office (DONKI).

## Science stops (candidates)

Positions are read from `MSL_waypoints.json` at the cited sols and will be snapped precisely in Phase 1.

| Stop | ≈ lon, lat | Evidence |
|---|---|---|
| Base / habitat | 137.3948, −4.7856 | Rover position ~sol 4439. Proven trafficable, between targets |
| Gediz Vallis channel, "Mammoth Lakes" | 137.409, −4.786 | Rover sols ~4200–4240. Pure sulfur found 2024-05-30; Mammoth Lakes drilled June 2024; PIA26363 360° pano (sol 4220). [NASA](https://www.nasa.gov/missions/mars-science-laboratory/nasas-curiosity-rover-discovers-a-surprise-in-a-martian-rock/), [PIA26363](https://www.jpl.nasa.gov/images/pia26363-curiosity-takes-a-360-degree-view-of-gediz-vallis-channel/) |
| Boxwork entrance ridge | 137.380, −4.803 | ~Sols 4602–4606, 11 m climb to first boxwork ([syndicated report](https://www.spacedaily.com/reports/Curiosity_Rovers_Boxwork_Campaign_Reaches_New_Heights_on_Mount_Sharp_999.html); sols to be cross-checked with the NASA blog) |
| Boxwork main exposure | 137.381, −4.808 | Sols ~4640–4800. [NASA/JPL](https://www.jpl.nasa.gov/news/nasas-curiosity-mars-rover-starts-unpacking-boxwork-formations/), [PIA26559](https://www.jpl.nasa.gov/images/pia26559-curiositys-first-360-degree-view-of-boxwork-patterns/), [blog sols 4804–4811](https://science.nasa.gov/blog/curiosity-blog-sols-4804-4811-kicking-off-the-final-phase-of-boxwork-exploration) |
| (optional) Valle Grande entry | 137.389, −4.826 | Sols 5000+ (latest traverse) |

## Phase 1 status (what the pipeline actually used, 2026-11-14)

| Layer | Used in app | Output |
|---|---|---|
| HiRISE tiles (a) | ✅ base map | 672 tiles z13–17 → `data/processed/tiles/hirise/` (JPEG, 10 MB) |
| DTM (b) | ✅ grid + hillshade + slope | 2380 × 3330 m window read via `/vsicurl/` in ~50 s; 0% nodata; elev −3946 to −3325 m → `terrain/grid.{json,bin}`, `overlays/{hillshade,slope}.png` |
| THEMIS (c2) | ✅ overlay | 30 × 42 px crop → `overlays/themis_dayir.png` |
| CRISM (c1) | ⏳ Phase 2 | — |
| Traverse/waypoints (d1) | ✅ | `rover/traverse.geojson`, `rover/waypoints.geojson` |
| Raw images (d2) | ✅ | 3 near-horizontal full-frame Navcam images per stop → `pov/<stop>/` |
| REMS / RAD / DONKI (e) | ⏳ Phase 2 (conditions panel) | RAD constant already in `src/core/config.ts` |

Stop positions as snapped by `scripts/fetch_rover.py`:

| Stop | Waypoint | lon, lat, elev |
|---|---|---|
| Base | site 112 drive 2616 (sol 4439) | 137.39480, −4.78563, −3724 m |
| Gediz Vallis / Mammoth Lakes | site 107 drive 2496 (sol 4210; rover parked sols 4200–4237) | 137.40886, −4.78572, −3688 m |
| Boxwork entrance ridge | site 117 drive 2538 (sol 4605) | 137.37956, −4.80443, −3631 m |
| Boxwork main exposure | site 120 drive 0 (sol 4709; parked to ~4789) | 137.38105, −4.80800, −3609 m |

## Game build: 3D world + conditions (feature/game, 2026-11-14)

All verified live on 2026-11-14 and built by `scripts/build_world.py` and `scripts/fetch_conditions.py`.

| Layer | Source | How it is used | Output |
|---|---|---|---|
| Walkable terrain | USGS MSL Gale DEM Mosaic 1 m v3 (b), same cached AOI window | 2 m block-mean heightmap (Uint16, ~1 cm steps) for the 3D mesh and for walking physics; 1 m world-space normal maps for lighting | `world/height.bin`, `world/chunks/n*.jpg` |
| Ground colour | HiRISE colour basemap tiles (a), z17 (~0.6 m/px) with z16 fill | Reprojected from Web-Mercator tiles to the DTM's equirectangular grid at 0.5 m/px, 35 chunks of 512 m. 0 gap pixels | `world/chunks/c*.jpg`, `world/overview.jpg` (minimap) |
| Mount Sharp / crater backdrop | **USGS/DLR/ESA HRSC-MOLA Blended DEM Global 200 m v2** (Fergason et al. 2018), `planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif` | Uncompressed int16, 106694 × 53347, 1-row strips; ±0.9° window (533 × 533 posts) read via `/vsicurl/` in ~1 s. Offset to the DTM by the median difference (−1.8 m). Sunk below the DTM near the AOI so it never pokes through. Planet curvature applied (d²/2R) | `world/backdrop.bin` |
| Backdrop colour | **Viking MDIM 2.1 colour mosaic** via NASA Mars Trek WMTS, `trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/...`. **Max level is 7** (~330 m/px; level 8 returns 404) | Per-channel mean/std matched to the HiRISE mosaic; HiRISE overview pasted inside the AOI | `world/backdrop.jpg` |
| Weather | REMS feed (e1) | Last 760 sols. The game picks the sol with the same Ls (season) in the latest Mars year as an analogue for the EVA date; daily min/max air temperature, pressure, sunrise/sunset, UV | `conditions/rems.json` |
| Space weather | DONKI (e3) | 30-day snapshot (CME/SEP/GST/notifications). **On 2026-11-14 `DEMO_KEY` returned HTTP 429 for every call**, so the cached file holds the errors and the app shows space weather as UNKNOWN (not assumed quiet). Rerun with `NASA_API_KEY=<free key>` to fill it | `conditions/donki.json` |
| Mars clock / sun | Mars24 algorithm (Allison & McEwen 2000; NASA GISS Mars24) | Ls, MSL sol, local true solar time, sun elevation/azimuth for any Earth date. **Validated against REMS**: sol number matches; Ls within 1.5° (REMS Ls is an integer); sunrise/sunset within 15 min (`src/core/sun.test.ts`) | `src/core/sun.ts` |

Mars gravity 3.71–3.72 m/s² is from the NASA Mars Fact Sheet.

Rocks are drawn procedurally: the density per 10 m cell follows the DTM roughness grid, but individual rocks are illustrative, not mapped boulders. Footprints, dust and wind are cosmetic.

## Open verification items
- [x] Boxwork entrance sols: the waypoint data shows the climb from −3645 m (sol 4591) to −3631 m (sols 4602–4605), consistent with the reported 11 m climb. Still worth a glance at the NASA blog for the exact narrative
- [ ] CRISM MTRDR footprint overlap with the route corridor (Phase 2)
- [ ] Location of the clay-to-sulfate transition. It is outside this AOI, so the default story was changed to "Gediz Vallis + boxwork"
- [ ] DONKI FLR endpoint status at build time
- [ ] DONKI snapshot: refill with a personal NASA API key (DEMO_KEY rate-limited on 2026-11-14)
