"""DTM + HiRISE + global DEM -> the walkable 3D world (Three.js).

Outputs (data/processed/world/):
  height.bin      Uint16 2 m heightmap of the AOI (row 0 = north), quantised over [hMin, hMax]
  chunks/c{i}_{j}.jpg   HiRISE colour per 512 m chunk, 0.5 m/px, reprojected to the DTM grid
  chunks/n{i}_{j}.jpg   world-space normals per chunk from the 1 m DTM (RGB = n*0.5+0.5, Y up)
  overview.jpg    whole-AOI HiRISE at 2 m/px (minimap)
  backdrop.bin    Int16 heights (m, +offset) of a ~110 km x 110 km window at ~200 m (Mount Sharp, crater rim)
  backdrop.jpg    Viking MDIM 2.1 colour for the backdrop, colour-matched to HiRISE
  world.json      metadata for all of the above

World coordinates used by the game: X = east (m) from the DTM window's NW corner,
Z = south (m) from it, Y = elevation (m, areoid) minus `yRef`.
"""
import io
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window

from build_terrain import block, read_dem
from common import OUT, R_MARS, RAW, get, write_json

WORLD = OUT / "world"
CHUNK_M = 512          # chunk edge (m)
COLOR_MPP = 0.5        # colour texture metres per pixel
TILES = OUT / "tiles" / "hirise"

BLEND_URL = ("/vsicurl/https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/"
             "Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif")
VIKING = ("https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/"
          "1.0.0/default/default028mm/{z}/{row}/{col}.jpg")
BACKDROP_HALF_DEG = 0.9


# ---------- HiRISE reprojection (Web-Mercator XYZ tiles -> DTM equirectangular grid) ----------

def merc_px(lon, lat, z):
    """Global pixel coords (256 px tiles) for lon/lat arrays at zoom z."""
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n
    return x, y


def load_mosaic(z, lon0, lon1, lat0, lat1):
    """Stitch cached XYZ tiles covering the lon/lat box. Returns (rgb float32, px0, py0)."""
    x0, y1 = merc_px(np.array(lon0), np.array(lat0), z)
    x1, y0 = merc_px(np.array(lon1), np.array(lat1), z)
    tx0, tx1, ty0, ty1 = int(x0 // 256), int(x1 // 256), int(y0 // 256), int(y1 // 256)
    mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, 3), np.uint8)
    have = np.zeros(mos.shape[:2], bool)
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            f = TILES / str(z) / str(tx) / f"{ty}.jpg"
            if f.exists():
                a = np.asarray(Image.open(f).convert("RGB"))
                sl = (slice((ty - ty0) * 256, (ty - ty0 + 1) * 256), slice((tx - tx0) * 256, (tx - tx0 + 1) * 256))
                mos[sl] = a
                have[sl] = a.sum(axis=2) > 0
    return mos, have, tx0 * 256, ty0 * 256


def bilinear(img, x, y):
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    a, b = img[y0, x0].astype(np.float32), img[y0, x0 + 1].astype(np.float32)
    c, d = img[y0 + 1, x0].astype(np.float32), img[y0 + 1, x0 + 1].astype(np.float32)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def sample_hirise(xs, ys, mosaics):
    """xs, ys = projected metres (2D arrays). Uses z17, fills gaps from z16."""
    lon, lat = np.degrees(xs / R_MARS), np.degrees(ys / R_MARS)
    out = None
    for z, (mos, have, px0, py0) in mosaics:
        px, py = merc_px(lon, lat, z)
        rgb = bilinear(mos, px - px0, py - py0)
        ok = have[np.clip((py - py0).astype(int), 0, have.shape[0] - 1),
                  np.clip((px - px0).astype(int), 0, have.shape[1] - 1)]
        if out is None:
            out, filled = rgb, ok
        else:
            out[~filled] = rgb[~filled]
            filled |= ok
    return np.clip(out, 0, 255).astype(np.uint8), filled


# ---------- normals ----------

def normals_rgb(dem, spacing):
    """World-space normal map, X = east, Y = up, Z = south (row direction)."""
    dz_drow, dz_dcol = np.gradient(dem, spacing)
    n = np.stack([-dz_dcol, np.ones_like(dem), -dz_drow], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return np.clip((n * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8)


# ---------- backdrop ----------

def read_backdrop(lon_c, lat_c):
    cache = RAW / "blend_backdrop.npy"
    with rasterio.open(BLEND_URL) as ds:
        t = ds.transform
        col0 = int((lon_c - BACKDROP_HALF_DEG - t.c) / t.a)
        row0 = int((t.f - (lat_c + BACKDROP_HALF_DEG)) / -t.e)
        n = int(2 * BACKDROP_HALF_DEG / t.a)
        lon0, lat0 = t.c + col0 * t.a, t.f + row0 * t.e  # NW corner of pixel (0,0)
        if cache.exists():
            a = np.load(cache)
        else:
            print(f"  reading HRSC-MOLA blend DEM window {n}x{n} px over HTTP (one-off)...")
            a = ds.read(1, window=Window(col0, row0, n, n)).astype(np.float32)
            np.save(cache, a)
    return a, lon0, lat0, t.a


def viking_colour(lon0, lat0, deg_px, n):
    """Stitch Viking MDIM2.1 colour (Mars Trek WMTS, level 7 = max, ~330 m/px)."""
    z = 7
    tdeg = 180 / 2 ** z           # tile size in degrees at this level (level 0 = 2x1 tiles of 180 deg)
    lon1, lat1 = lon0 + n * deg_px, lat0 - n * deg_px
    c0, c1 = int((lon0 + 180) // tdeg), int((lon1 + 180) // tdeg)
    r0, r1 = int((90 - lat0) // tdeg), int((90 - lat1) // tdeg)

    def fetch(rc):
        r, c = rc
        cache = RAW / "viking" / f"{z}_{r}_{c}.jpg"
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(get(VIKING.format(z=z, row=r, col=c)).content)
        return rc, np.asarray(Image.open(cache).convert("RGB"))

    mos = np.zeros(((r1 - r0 + 1) * 256, (c1 - c0 + 1) * 256, 3), np.uint8)
    with ThreadPoolExecutor(6) as ex:
        for (r, c), a in ex.map(fetch, [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]):
            mos[(r - r0) * 256:(r - r0 + 1) * 256, (c - c0) * 256:(c - c0 + 1) * 256] = a
    px = tdeg / 256
    # output: 2 px per DEM post
    m = n * 2
    lons = lon0 + (np.arange(m) + 0.5) * deg_px / 2
    lats = lat0 - (np.arange(m) + 0.5) * deg_px / 2
    X = (lons[None, :] + 180 - c0 * tdeg) / px
    Y = (90 - lats[:, None] - r0 * tdeg) / px
    return bilinear(mos, np.broadcast_to(X, (m, m)), np.broadcast_to(Y, (m, m)))


def main():
    print("build_world: DTM + HiRISE + blend DEM -> 3D world")
    WORLD.mkdir(parents=True, exist_ok=True)
    (WORLD / "chunks").mkdir(exist_ok=True)
    dem, ox, oy = read_dem()                     # 1 m, row 0 = north, origin = NW corner
    H, W = dem.shape
    dem = np.where(np.isnan(dem), np.nanmean(dem), dem)

    # ---- 2 m heightmap (vertex grid = cell centres of the 2 m blocks) ----
    dem2 = block(dem, 2).mean(axis=2)
    h_min, h_max = float(dem2.min()) - 1, float(dem2.max()) + 1
    q = np.round((dem2 - h_min) / (h_max - h_min) * 65535).astype("<u2")
    q.tofile(WORLD / "height.bin")
    print(f"  wrote world/height.bin {dem2.shape[1]}x{dem2.shape[0]} (2 m), {h_min:.0f}..{h_max:.0f} m")

    # ---- HiRISE mosaics (z17 primary, z16 fill) ----
    lon_w, lat_n = np.degrees(ox / R_MARS), np.degrees(oy / R_MARS)
    lon_e, lat_s = np.degrees((ox + W) / R_MARS), np.degrees((oy - H) / R_MARS)
    pad = 0.001
    mosaics = [(z, load_mosaic(z, lon_w - pad, lon_e + pad, lat_s - pad, lat_n + pad)) for z in (17, 16)]

    # ---- chunks ----
    chunks = []
    nx, nz = math.ceil(W / CHUNK_M), math.ceil(H / CHUNK_M)
    gap_px = 0
    for j in range(nz):
        for i in range(nx):
            x0, z0 = i * CHUNK_M, j * CHUNK_M
            w, h = min(CHUNK_M, W - x0), min(CHUNK_M, H - z0)
            cw, ch = int(round(w / COLOR_MPP)), int(round(h / COLOR_MPP))
            xs = ox + x0 + (np.arange(cw) + 0.5) * COLOR_MPP
            ys = oy - z0 - (np.arange(ch) + 0.5) * COLOR_MPP
            rgb, ok = sample_hirise(*np.meshgrid(xs, ys), mosaics)
            gap_px += int((~ok).sum())
            Image.fromarray(rgb).save(WORLD / "chunks" / f"c{i}_{j}.jpg", quality=86)
            # normals from the 1 m DEM with a 1-post apron so neighbouring chunks agree at seams
            a0, a1 = max(z0 - 1, 0), min(z0 + h + 1, H)
            b0, b1 = max(x0 - 1, 0), min(x0 + w + 1, W)
            n = normals_rgb(dem[a0:a1, b0:b1], 1.0)[z0 - a0:z0 - a0 + h, x0 - b0:x0 - b0 + w]
            Image.fromarray(n).save(WORLD / "chunks" / f"n{i}_{j}.jpg", quality=92)
            chunks.append({"i": i, "j": j, "x0": x0, "z0": z0, "w": w, "h": h})
    print(f"  wrote {len(chunks)} chunks ({nx}x{nz}); HiRISE gap pixels: {gap_px}")

    # ---- overview (2 m/px) for the minimap ----
    xs = ox + (np.arange(W // 2) + 0.5) * 2
    ys = oy - (np.arange(H // 2) + 0.5) * 2
    ov, _ = sample_hirise(*np.meshgrid(xs, ys), mosaics)
    Image.fromarray(ov).save(WORLD / "overview.jpg", quality=84)
    hirise_mean = ov.reshape(-1, 3).mean(axis=0)
    hirise_std = ov.reshape(-1, 3).std(axis=0)

    # ---- backdrop: HRSC-MOLA blend DEM, offset to match the DTM, DTM pasted inside the AOI ----
    lon_c, lat_c = (lon_w + lon_e) / 2, (lat_n + lat_s) / 2
    bd, blon0, blat0, deg_px = read_backdrop(lon_c, lat_c)
    n = bd.shape[0]
    post_m = math.radians(deg_px) * R_MARS
    # backdrop post centres in world coords
    bx = R_MARS * np.radians(blon0 + (np.arange(n) + 0.5) * deg_px) - ox
    bz = oy - R_MARS * np.radians(blat0 - (np.arange(n) + 0.5) * deg_px)
    BX, BZ = np.meshgrid(bx, bz)
    inside = (BX >= 0) & (BX < W) & (BZ >= 0) & (BZ < H)
    dtm_at = np.full(bd.shape, np.nan, np.float32)
    ci = np.clip((BX / 2).astype(int), 0, dem2.shape[1] - 1)
    ri = np.clip((BZ / 2).astype(int), 0, dem2.shape[0] - 1)
    dtm_at[inside] = dem2[ri[inside], ci[inside]]
    offset = float(np.nanmedian(dtm_at[inside] - bd[inside]))
    bd = bd + offset
    # Under and next to the AOI the coarse mesh must never poke through the detailed terrain: a triangle
    # spanning 200 m can rise above a valley floor. Sink each post to the lowest DTM point within
    # one post spacing (plus 6 m), for posts inside the AOI or within one post of it.
    near = (BX >= -post_m) & (BX < W + post_m) & (BZ >= -post_m) & (BZ < H + post_m)
    rr, cc = np.nonzero(near)
    win = int(post_m / 2) + 2  # in 2 m pixels
    for r, c in zip(rr, cc):
        ci0, ri0 = int(BX[r, c] / 2), int(BZ[r, c] / 2)
        sl = dem2[max(ri0 - win, 0):max(min(ri0 + win, dem2.shape[0]), 0),
                  max(ci0 - win, 0):max(min(ci0 + win, dem2.shape[1]), 0)]
        if sl.size:
            bd[r, c] = min(bd[r, c], float(sl.min()) - 6.0)
    bd.round().astype("<i2").tofile(WORLD / "backdrop.bin")
    print(f"  wrote world/backdrop.bin {n}x{n} posts @ {post_m:.0f} m, DTM-blend offset {offset:+.1f} m")

    col = viking_colour(blon0, blat0, deg_px, n)
    # colour-match Viking to the HiRISE mosaic (per-channel mean/std)
    flat = col.reshape(-1, 3)
    col = (col - flat.mean(axis=0)) / (flat.std(axis=0) + 1e-6) * hirise_std * 0.8 + hirise_mean
    col = np.clip(col, 0, 255).astype(np.uint8)
    # paste the HiRISE overview inside the AOI so the far view is seamless
    m = col.shape[0]
    tx = R_MARS * np.radians(blon0 + (np.arange(m) + 0.5) * deg_px / 2) - ox
    tz = oy - R_MARS * np.radians(blat0 - (np.arange(m) + 0.5) * deg_px / 2)
    TX, TZ = np.meshgrid(tx, tz)
    ins = (TX >= 0) & (TX < W) & (TZ >= 0) & (TZ < H)
    col[ins] = ov[np.clip((TZ[ins] / 2).astype(int), 0, ov.shape[0] - 1),
                  np.clip((TX[ins] / 2).astype(int), 0, ov.shape[1] - 1)]
    Image.fromarray(col).save(WORLD / "backdrop.jpg", quality=85)

    write_json(WORLD / "world.json", {
        "width": W, "depth": H,               # metres (X east, Z south)
        "originX": ox, "originY": oy,         # projected metres of the NW corner (matches grid.json)
        "yRef": round(float(np.median(dem2))),
        "height": {"file": "world/height.bin", "cols": dem2.shape[1], "rows": dem2.shape[0],
                   "spacing": 2, "min": h_min, "max": h_max},
        "chunkSize": CHUNK_M, "colorMpp": COLOR_MPP, "chunks": chunks,
        "overview": {"file": "world/overview.jpg", "mpp": 2},
        "backdrop": {"file": "world/backdrop.bin", "color": "world/backdrop.jpg", "n": n,
                     "postM": post_m, "x0": float(bx[0]), "z0": float(bz[0]), "offsetM": offset},
        "sources": {
            "height": "USGS MSL Gale DEM Mosaic 1m v3 (Calef & Parker 2016), averaged to 2 m",
            "color": "HiRISE colour basemap, NASA/JPL-Caltech/UArizona via NASA MMGIS, reprojected",
            "normals": "Derived from USGS MSL Gale DEM Mosaic 1m v3 (1 m)",
            "backdrop": "USGS/DLR/ESA HRSC-MOLA blended DEM global 200 m v2 (Fergason et al. 2018)",
            "backdropColor": "Viking MDIM 2.1 colour mosaic via NASA Mars Trek, colour-matched to HiRISE",
        },
    })


if __name__ == "__main__":
    main()
