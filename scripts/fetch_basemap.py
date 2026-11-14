"""Cache the HiRISE colour basemap tiles for the AOI (zoom 13-17) + THEMIS overlay.

HiRISE tiles come from NASA's MMGIS "Curiosity's Location" map. They are
TMS-ordered (y flipped vs. standard XYZ). We save them in standard XYZ order
as JPEG so Leaflet can use them with no custom options:
  data/processed/tiles/hirise/{z}/{x}/{y}.jpg

THEMIS Day IR (Mars Trek WMTS, equirectangular, level 9 ~ 81 m/px) is stitched
and cropped to the AOI into data/processed/overlays/themis_dayir.png.
"""
import io
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

from common import AOI, OUT, get, write_json

HIRISE = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/MSL_Gale_HiRISE-LRGB_78quads/{z}/{x}/{y}.png"
THEMIS = ("https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018/"
          "1.0.0/default/default028mm/{z}/{row}/{col}.png")
ZOOMS = range(13, 18)
PAD = 0.004  # deg of padding around the AOI so the map edge isn't blank


def xyz_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def fetch_hirise(z, x, y):
    out = OUT / "tiles" / "hirise" / str(z) / str(x) / f"{y}.jpg"
    if out.exists():
        return "cached"
    tms_y = 2 ** z - 1 - y
    try:
        r = get(HIRISE.format(z=z, x=x, y=tms_y))
    except Exception:
        return "missing"
    img = Image.open(io.BytesIO(r.content)).convert("RGBA")
    bg = Image.new("RGB", img.size, (0, 0, 0))
    bg.paste(img, mask=img.split()[3])
    out.parent.mkdir(parents=True, exist_ok=True)
    bg.save(out, quality=82)
    return "ok"


def basemap():
    jobs = []
    for z in ZOOMS:
        x0, y0 = xyz_tile(AOI["west"] - PAD, AOI["north"] + PAD, z)
        x1, y1 = xyz_tile(AOI["east"] + PAD, AOI["south"] - PAD, z)
        jobs += [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    print(f"  HiRISE: {len(jobs)} tiles (z{ZOOMS.start}-{ZOOMS.stop - 1})")
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda j: fetch_hirise(*j), jobs))
    print("   ", {k: res.count(k) for k in set(res)})


def themis():
    z, deg = 9, 360 / 1024  # level 9: 1024 x 512 tiles of 256 px, origin (-180, 90)
    c0, c1 = int((AOI["west"] + 180) // deg), int((AOI["east"] + 180) // deg)
    r0, r1 = int((90 - AOI["north"]) // deg), int((90 - AOI["south"]) // deg)
    mosaic = Image.new("L", ((c1 - c0 + 1) * 256, (r1 - r0 + 1) * 256))
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            img = Image.open(io.BytesIO(get(THEMIS.format(z=z, row=r, col=c)).content)).convert("L")
            mosaic.paste(img, ((c - c0) * 256, (r - r0) * 256))
    px = deg / 256
    left = (AOI["west"] + 180 - c0 * deg) / px
    top = (90 - AOI["north"] - r0 * deg) / px
    right = (AOI["east"] + 180 - c0 * deg) / px
    bottom = (90 - AOI["south"] - r0 * deg) / px
    crop = mosaic.crop((int(left), int(top), int(math.ceil(right)), int(math.ceil(bottom))))
    # bounds of the integer crop (slightly larger than AOI)
    b = {"west": -180 + c0 * deg + int(left) * px, "north": 90 - r0 * deg - int(top) * px}
    b["east"] = b["west"] + crop.width * px
    b["south"] = b["north"] - crop.height * px
    # colourise: dark (cool, sandy/fine) -> blue, bright (warm, rocky) -> orange.
    # Upsample 8x with bilinear so it reads as a smooth field rather than blocks.
    a = np.asarray(crop, np.float32)
    lo, hi = np.percentile(a, 2), np.percentile(a, 98)
    t = np.clip((a - lo) / max(hi - lo, 1), 0, 1)
    rgb = np.stack([40 + 215 * t, 80 + 90 * t, 200 - 170 * t], -1).astype(np.uint8)
    img = Image.fromarray(rgb).resize((crop.width * 8, crop.height * 8), Image.BILINEAR)
    path = OUT / "overlays" / "themis_dayir.png"
    img.save(path, optimize=True)
    print(f"  wrote {path.name} from {crop.width}x{crop.height} THEMIS px (~81 m/px)")
    # raw DN values too, for later use as a cost term
    write_json(OUT / "overlays" / "themis.json", {
        "file": "overlays/themis_dayir.png", "bounds": b,
        "width": crop.width, "height": crop.height, "dn": a.astype(int).ravel().tolist(),
        "source": "NASA/JPL-Caltech/ASU THEMIS Day IR controlled mosaic 100 m v2 (Mars Trek WMTS, level 9)",
        "note": "Relative daytime brightness temperature (8-bit DN), not calibrated K. "
                "Bright = warmer by day = typically rockier/lower thermal inertia contrast; interpret qualitatively.",
    })


if __name__ == "__main__":
    print("fetch_basemap")
    basemap()
    themis()
