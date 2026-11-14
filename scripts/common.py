"""Shared constants for the offline data pipeline.

All map data uses the same projection as the USGS MSL Gale DEM mosaic:
Equirectangular, center lon 0, Mars 2000 sphere (R = 3,396,190 m).
So x = R * lon_rad, y = R * lat_rad, and 1 projected unit = 1 metre.
"""
import json
import math
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"
RAW.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

R_MARS = 3396190.0

# Area of interest (see DATA_SOURCES.md)
AOI = {"west": 137.374, "east": 137.414, "south": -4.830, "north": -4.774}

# Route grid cell size in metres (see README "why 10 m")
CELL_M = 10

DEM_URL = ("/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/"
           "mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif")

HTTP = requests.Session()
HTTP.headers["User-Agent"] = "marswalk-hackathon-pipeline/0.1"


def lonlat_to_xy(lon, lat):
    return R_MARS * math.radians(lon), R_MARS * math.radians(lat)


def xy_to_lonlat(x, y):
    return math.degrees(x / R_MARS), math.degrees(y / R_MARS)


def aoi_xy_snapped():
    """AOI in projected metres, snapped outward to whole grid cells."""
    x0, y0 = lonlat_to_xy(AOI["west"], AOI["south"])
    x1, y1 = lonlat_to_xy(AOI["east"], AOI["north"])
    x0 = math.floor(x0 / CELL_M) * CELL_M
    y0 = math.floor(y0 / CELL_M) * CELL_M
    x1 = math.ceil(x1 / CELL_M) * CELL_M
    y1 = math.ceil(y1 / CELL_M) * CELL_M
    return x0, y0, x1, y1


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1))
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e3:.0f} KB)")


def get(url, **kw):
    r = HTTP.get(url, timeout=60, **kw)
    r.raise_for_status()
    return r
