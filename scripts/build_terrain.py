"""DTM -> route grid + map overlays.

Reads only the AOI window of the 1 m USGS Gale DEM mosaic over HTTP (range
requests, ~a few hundred MB instead of 3.9 GB), then writes:
  data/processed/terrain/grid.bin   Float32 [elev | slope_p90 | rough], row 0 = north
  data/processed/terrain/grid.json  grid metadata (size, origin, cell size, layers)
  data/processed/overlays/hillshade.png   tinted hillshade, 2 m/px
  data/processed/overlays/slope.png       slope colour ramp, 2 m/px
"""
import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window

from common import (AOI, CELL_M, DEM_URL, OUT, RAW, aoi_xy_snapped, write_json,
                    xy_to_lonlat)

CACHE = RAW / "dem_aoi_1m.npy"


def read_dem():
    """Return (dem_1m, origin_x, origin_y). Cached in data/raw after first run."""
    x0, y0, x1, y1 = aoi_xy_snapped()
    with rasterio.open(DEM_URL) as ds:
        t = ds.transform
        col0 = int(round((x0 - t.c) / t.a))
        row0 = int(round((t.f - y1) / -t.e))
        ncol = int(round((x1 - x0) / t.a))
        nrow = int(round((y1 - y0) / -t.e))
        # make the window a whole number of grid cells
        ncol -= ncol % CELL_M
        nrow -= nrow % CELL_M
        ox, oy = t.c + col0 * t.a, t.f + row0 * t.e
        if CACHE.exists():
            dem = np.load(CACHE)
        else:
            print(f"  reading DEM window {ncol}x{nrow} px over HTTP (one-off)...")
            dem = ds.read(1, window=Window(col0, row0, ncol, nrow)).astype(np.float32)
            np.save(CACHE, dem)
        dem[dem <= -30000] = np.nan  # nodata = -32767
    return dem, ox, oy


def block(a, k):
    """Reshape (H, W) into (H/k, W/k, k*k) blocks."""
    h, w = a.shape
    return a.reshape(h // k, k, w // k, k).swapaxes(1, 2).reshape(h // k, w // k, k * k)


def slope_deg(dem, spacing):
    gy, gx = np.gradient(dem, spacing)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def plane_rms(dem, k):
    """Per k x k block: RMS residual after removing a best-fit plane (m).
    High values = rocks, ridges, scarps that a mean slope would hide."""
    yy, xx = np.mgrid[0:k, 0:k]
    A = np.stack([xx.ravel(), yy.ravel(), np.ones(k * k)], axis=1)  # (k*k, 3)
    P = A @ np.linalg.pinv(A)  # projection onto plane space
    b = block(dem.astype(np.float64), k)  # (H, W, k*k)
    resid = b - b @ P.T
    return np.sqrt(np.mean(resid ** 2, axis=2))


def to_png(rgba, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba).quantize(colors=96, method=Image.FASTOCTREE).save(path, optimize=True)
    print(f"  wrote {path.relative_to(OUT.parent.parent)} {rgba.shape[1]}x{rgba.shape[0]}")


def hillshade_png(dem2, path):
    gy, gx = np.gradient(dem2, 2.0)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(315), np.radians(45)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    hs = np.clip(hs, 0, 1)
    # hypsometric tint: low = blue-ish, high = warm
    lo, hi = np.nanpercentile(dem2, 1), np.nanpercentile(dem2, 99)
    t = np.clip((dem2 - lo) / (hi - lo), 0, 1)
    low, high = np.array([60, 90, 160]), np.array([240, 200, 120])
    tint = low[None, None] * (1 - t[..., None]) + high[None, None] * t[..., None]
    rgb = tint * (0.35 + 0.65 * hs[..., None])
    rgba = np.zeros(dem2.shape + (4,), np.uint8)
    rgba[..., :3] = np.nan_to_num(rgb).astype(np.uint8)
    rgba[..., 3] = np.where(np.isnan(dem2), 0, 255)
    to_png(rgba, path)
    return float(lo), float(hi)


def slope_png(s, path):
    # 0-10 deg green, 10-20 yellow, 20-30 red, >30 dark red
    stops = np.array([0, 10, 20, 30, 45])
    cols = np.array([[40, 170, 60], [230, 220, 40], [230, 60, 30], [120, 0, 0], [60, 0, 0]])
    rgb = np.stack([np.interp(s, stops, cols[:, i]) for i in range(3)], axis=-1)
    rgba = np.zeros(s.shape + (4,), np.uint8)
    rgba[..., :3] = np.nan_to_num(rgb).astype(np.uint8)
    rgba[..., 3] = np.where(np.isnan(s), 0, 255)
    to_png(rgba, path)


def main():
    print("build_terrain: DEM -> grid + overlays")
    dem, ox, oy = read_dem()
    h, w = dem.shape
    print(f"  DEM window {w}x{h} m, nodata {np.isnan(dem).mean() * 100:.2f}%,"
          f" elev {np.nanmin(dem):.0f}..{np.nanmax(dem):.0f} m")

    dem2 = np.nanmean(block(dem, 2), axis=2)        # 2 m DEM (HiRISE DTMs ~1 m post, ~3 m effective)
    s2 = slope_deg(dem2, 2.0)                       # slope at 2 m
    k = CELL_M // 2
    elev = np.nanmean(block(dem, CELL_M), axis=2)   # cell mean elevation
    slope_p90 = np.nanpercentile(block(s2, k), 90, axis=2)
    rough = plane_rms(np.nan_to_num(dem, nan=0.0), CELL_M)
    # any nodata inside a cell -> unknown terrain -> NaN (router treats as impassable)
    bad = np.isnan(block(dem, CELL_M)).any(axis=2)
    for a in (elev, slope_p90, rough):
        a[bad] = np.nan

    rows, cols = elev.shape
    tdir = OUT / "terrain"
    tdir.mkdir(parents=True, exist_ok=True)
    np.concatenate([elev.ravel(), slope_p90.ravel(), rough.ravel()]).astype("<f4").tofile(tdir / "grid.bin")
    print(f"  wrote data/processed/terrain/grid.bin ({cols}x{rows} cells)")

    west, north = xy_to_lonlat(ox, oy)
    east, south = xy_to_lonlat(ox + w, oy - h)
    bounds = {"west": west, "east": east, "south": south, "north": north}

    lo, hi = hillshade_png(dem2, OUT / "overlays" / "hillshade.png")
    slope_png(s2, OUT / "overlays" / "slope.png")

    write_json(tdir / "grid.json", {
        "cols": cols, "rows": rows, "cellSize": CELL_M,
        "originX": ox, "originY": oy,  # projected metres, top-left corner of cell (0,0)
        "projection": "Equirectangular clon0, Mars 2000 sphere R=3396190 (x=R*lon, y=R*lat)",
        "bounds": bounds,
        "layers": ["elev_m", "slope_p90_deg", "rough_rms_m"],
        "notes": {
            "elev_m": "mean of 1 m DEM posts in the cell (m, areoid)",
            "slope_p90_deg": "90th percentile of 2 m-scale slopes in the cell",
            "rough_rms_m": "RMS residual of 1 m posts about best-fit plane in the cell",
        },
        "stats": {
            "elevMin": float(np.nanmin(elev)), "elevMax": float(np.nanmax(elev)),
            "nodataPct": float(np.isnan(elev).mean() * 100),
            "slopeP90Median": float(np.nanmedian(slope_p90)),
            "roughMedian": float(np.nanmedian(rough)),
        },
        "source": "USGS Astrogeology, MSL Gale DEM Mosaic 1m v3 (Calef & Parker 2016)",
    })
    write_json(OUT / "overlays" / "overlays.json", {
        "bounds": bounds,
        "hillshade": {"file": "overlays/hillshade.png", "elevMin": lo, "elevMax": hi,
                      "source": "Derived from USGS MSL Gale DEM Mosaic 1m v3"},
        "slope": {"file": "overlays/slope.png", "rampDeg": [0, 10, 20, 30],
                  "source": "Derived from USGS MSL Gale DEM Mosaic 1m v3 (2 m slope)"},
    })
    print("  AOI requested:", AOI)


if __name__ == "__main__":
    main()
