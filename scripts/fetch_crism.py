"""CRISM hydrated-mineral map for the AOI (MRO CRISM MTRDR browse product "HYD").

Source: PDS Geosciences Node, MRO CRISM map-projected targeted RDR (MTRDR), observation FRT000058A3
(2007-04-22). ODE lists 6 MTRDR observations over the AOI; this one's footprint covers all of it.
The HYD browse is an RGB composite of three spectral summary parameters (Viviano-Beck et al. 2014):
  R = SINDEX2  (polyhydrated sulfates, 1.9 + 2.4 um)
  G = BD2100_2 (monohydrated sulfates, 2.1 um)
  B = BD1900_2 (bound water, 1.9 um)
Per the product label: polyhydrated sulfates may appear magenta, monohydrated sulfates yellow/green,
blue likely other hydrated minerals; spectra are needed for positive identification.

The MTRDR is equirectangular, centre lon/lat 0, sphere R = 3396.19 km: the same projection as the USGS
DTM, so georeferencing is exact arithmetic from the label (no resampling between projections).

Writes data/processed/overlays/crism_hyd.png (AOI crop, alpha = no data) and crism.json with bounds,
provenance and the label's DN -> physical scaling (DN * SCALING_FACTOR + OFFSET).
"""
import io
import re

import numpy as np
from PIL import Image

from common import AOI, OUT, RAW, get, write_json

BASE = ("https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/browse/"
        "2007/2007_112/frt000058a3/frt000058a3_07_brhydj_mtr3")


def fetch(ext):
    cache = RAW / "crism" / f"frt000058a3_07_brhydj_mtr3.{ext}"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(get(f"{BASE}.{ext}").content)
    return cache.read_bytes()


def label_value(lbl, key):
    m = re.search(rf"^\s*{key}\s*=\s*([^\n<]+)", lbl, re.M)
    if not m:
        raise ValueError(f"{key} missing from label")
    return m.group(1).strip()


def triple(s):
    return [float(v) for v in s.strip("() ").split(",")]


def main():
    lbl = fetch("lbl").decode("latin-1")
    img = Image.open(io.BytesIO(fetch("png"))).convert("RGBA")
    a = np.asarray(img)
    assert label_value(lbl, "MAP_PROJECTION_TYPE").strip('"') == "EQUIRECTANGULAR"
    assert float(label_value(lbl, "A_AXIS_RADIUS")) == 3396.19
    res = float(label_value(lbl, "MAP_RESOLUTION"))        # pixels per degree
    lpo = float(label_value(lbl, "LINE_PROJECTION_OFFSET"))
    spo = float(label_value(lbl, "SAMPLE_PROJECTION_OFFSET"))
    lines, samples = int(label_value(lbl, "LINES")), int(label_value(lbl, "LINE_SAMPLES"))
    assert a.shape[:2] == (lines, samples)
    offset, scale = triple(label_value(lbl, "OFFSET")), triple(label_value(lbl, "SCALING_FACTOR"))
    bands = [b.strip(' "') for b in label_value(lbl, "BAND_NAME").strip("()").split(",")]

    # PDS equirectangular (centre 0,0), pixel edges: line = LPO - lat*res, sample = lon*res + SPO.
    # Checked against the label: line 0 -> MAXIMUM_LATITUDE, sample 0 -> WESTERNMOST_LONGITUDE.
    lat_of = lambda line: (lpo - line) / res
    lon_of = lambda sample: (sample - spo) / res
    r0 = int(np.floor(lpo - AOI["north"] * res)); r1 = int(np.ceil(lpo - AOI["south"] * res))
    c0 = int(np.floor(AOI["west"] * res + spo)); c1 = int(np.ceil(AOI["east"] * res + spo))
    assert abs(lat_of(0) - float(label_value(lbl, "MAXIMUM_LATITUDE"))) < 1e-3
    assert abs(lon_of(0) - float(label_value(lbl, "WESTERNMOST_LONGITUDE"))) < 1e-3
    crop = a[r0:r1, c0:c1]
    bounds = {"north": lat_of(r0), "south": lat_of(r1), "west": lon_of(c0), "east": lon_of(c1)}
    valid = crop[..., 3] > 0
    print(f"CRISM crop {crop.shape[1]}x{crop.shape[0]} px at {1 / res * 59274:.1f} m/px, {valid.mean() * 100:.0f}% valid")

    out = OUT / "overlays" / "crism_hyd.png"
    Image.fromarray(crop).save(out, optimize=True)
    phys = [np.where(valid, crop[..., k].astype(float) * scale[k] + offset[k], np.nan) for k in range(3)]
    write_json(OUT / "overlays" / "crism.json", {
        "file": "overlays/crism_hyd.png",
        "product": "FRT000058A3_07_BRHYDJ_MTR3",
        "observed": "2007-04-22",
        "bounds": bounds,
        "width": int(crop.shape[1]), "height": int(crop.shape[0]),
        "bands": bands,
        # physical value = DN * scale + offset, per RGB channel of the PNG (alpha 0 = no data)
        "scale": scale, "offset": offset,
        "p95": {bands[k]: round(float(np.nanpercentile(phys[k], 95)), 5) for k in range(3)},
        "legend": "magenta = polyhydrated sulfates · yellow/green = monohydrated sulfates · blue = other hydrated minerals (product label; spectra needed for positive ID)",
        "source": ("MRO CRISM MTRDR HYD browse (SINDEX2 / BD2100_2 / BD1900_2), FRT000058A3, PDS Geosciences Node; "
                   "parameters per Viviano-Beck et al. 2014, JGR Planets 119. NASA/JPL/JHUAPL."),
        "url": f"{BASE}.png",
    })


if __name__ == "__main__":
    main()
