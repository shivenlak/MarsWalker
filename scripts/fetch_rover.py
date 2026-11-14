"""Curiosity ground truth: traverse, waypoints, science stops and POV images.

Outputs:
  data/processed/rover/traverse.geojson   rover path clipped to the AOI
  data/processed/rover/waypoints.geojson  drive end-points in the AOI (sol, elev, tilt)
  data/processed/stops.json               science stops, positions snapped to real waypoints
  data/processed/pov/<stop>/*.jpg         raw Navcam/Mastcam frames taken at that stop
"""
import re

from common import AOI, OUT, RAW, get, write_json

TRAVERSE = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json"
WAYPOINTS = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
RAW_API = ("https://mars.nasa.gov/api/v1/raw_image_items/?order=sol%20desc&per_page=200&page={page}"
           "&condition_1=msl:mission&condition_2={s0}:sol:gte&condition_3={s1}:sol:lte")

# Each stop is pinned to the Curiosity waypoint at `sol` (rover position at end of that sol's drive).
STOPS = [
    {
        "id": "base", "kind": "base", "name": "Habitat / EVA base", "sol": 4439,
        "what": "EVA start/end point on the floor of the Gediz Vallis area, between the two science targets.",
        "why": "Curiosity drove across this ground (sol 4439), so it is demonstrated-trafficable terrain.",
        "evidence": "MSL waypoint site 112 drive 2616 (sol 4439).",
        "lookFor": "Flat, fine-grained sulfate-unit bedrock; Mount Sharp rising to the south.",
        "imgSols": [4438, 4440],
    },
    {
        "id": "gediz", "kind": "science", "name": "Gediz Vallis channel - 'Mammoth Lakes'", "sol": 4210,
        "what": "Debris mound in Gediz Vallis, the channel where Curiosity found pure elemental sulfur (May 30, 2024) and drilled 'Mammoth Lakes' (June 2024).",
        "why": "Flood/debris-flow deposits record one of the last wet episodes on Mount Sharp; the first pure sulfur ever found on Mars.",
        "evidence": "Curiosity Mastcam/ChemCam/APXS/drill (sols ~4200-4240); NASA release 2024-07-18; PIA26363 360-degree view (sol 4220).",
        "lookFor": "Light-toned, yellowish sulfur-bearing stones among dark boulders; jumbled channel debris.",
        "imgSols": [4200, 4222],
    },
    {
        "id": "boxwork_entry", "kind": "science", "name": "Boxwork entrance ridge", "sol": 4605,
        "what": "Ridge at the entrance of the boxwork region, reached after a short steep climb.",
        "why": "First close look at the boxwork ridges mapped from orbit: mineral-cemented fractures from ancient groundwater.",
        "evidence": "Curiosity drive sols ~4602-4605 (rover elevation -3645 -> -3631 m in waypoint data); NASA/JPL boxwork releases (2025).",
        "lookFor": "Low, resistant ridges a few metres apart enclosing shallow hollows.",
        "imgSols": [4602, 4606],
    },
    {
        "id": "boxwork_main", "kind": "science", "name": "Boxwork main exposure", "sol": 4709,
        "what": "Interior of the boxwork network where Curiosity paused for a long campaign (sols ~4709-4789).",
        "why": "Ridge vs. hollow chemistry tests how groundwater moved through the sulfate unit late in Mars' wet era.",
        "evidence": "MSL waypoints (stationary sols 4709-4789); PIA26559 360-degree view of boxwork; NASA 'starts unpacking boxwork' release.",
        "lookFor": "Criss-crossing ridge network, ridge crests with lighter mineral veins.",
        "imgSols": [4709, 4715],
    },
]


def in_aoi(lon, lat, pad=0.0):
    return (AOI["west"] - pad <= lon <= AOI["east"] + pad
            and AOI["south"] - pad <= lat <= AOI["north"] + pad)


def clip_traverse():
    gj = get(TRAVERSE).json()
    feats = []
    for f in gj["features"]:
        g = f["geometry"]
        lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for line in lines:
            seg = []
            for c in line:
                if in_aoi(c[0], c[1], 0.002):
                    seg.append(c[:2])
                elif seg:
                    feats.append(seg)
                    seg = []
            if len(seg) > 1:
                feats.append(seg)
    out = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": s}}
        for s in feats if len(s) > 1]}
    write_json(OUT / "rover" / "traverse.geojson", out)


def waypoints():
    gj = get(WAYPOINTS).json()
    keep = [{"type": "Feature", "geometry": f["geometry"],
             "properties": {k: f["properties"][k] for k in ("sol", "site", "drive", "elev_geoid", "tilt", "dist_total_m")}}
            for f in gj["features"] if in_aoi(*f["geometry"]["coordinates"][:2])]
    write_json(OUT / "rover" / "waypoints.geojson", {"type": "FeatureCollection", "features": keep})
    return gj["features"]


def snap_stops(all_wp):
    for s in STOPS:
        cands = [f for f in all_wp if f["properties"]["sol"] <= s["sol"]]
        wp = max(cands, key=lambda f: (f["properties"]["sol"], f["properties"]["drive"]))
        p = wp["properties"]
        s["lon"], s["lat"], s["elev"] = p["lon"], p["lat"], p["elev_geoid"]
        s["waypoint"] = f"site {p['site']} drive {p['drive']} (sol {p['sol']})"
        assert in_aoi(s["lon"], s["lat"]), s["id"]


def full_frame(item):
    m = re.findall(r"\d+", item.get("subframe_rect") or "")
    return len(m) == 4 and int(m[2]) >= 1022 and int(m[3]) >= 512


def look_vec(item):
    v = re.findall(r"-?\d+\.?\d*(?:e-?\d+)?", item.get("camera_vector") or "")
    return [float(a) for a in v] if len(v) == 3 else [0.0, 0.0, 9.0]


def pov_images(stop, n=3):
    s0, s1 = stop["imgSols"]
    items, page = [], 0
    while True:
        d = get(RAW_API.format(page=page, s0=s0, s1=s1)).json()
        items += d["items"]
        if len(items) >= d["total"] or not d["items"] or page > 10:
            break
        page += 1
    # keep near-horizontal looks (landscape): rover frame z points down, so |z| small
    # = looking at the horizon; z >> 0 = ground, z << 0 = sky. x < -0.5 = looking back at the deck.
    good = [i for i in items if not i["is_thumbnail"] and full_frame(i) and -0.05 < look_vec(i)[2] < 0.3 and look_vec(i)[0] > -0.5]
    nav = [i for i in good if i["instrument"].startswith("NAV")]
    mast = [i for i in good if i["instrument"] == "MAST_LEFT"]
    picks = (nav or mast or [i for i in items if not i["is_thumbnail"]])
    step = max(1, len(picks) // n)
    picks = picks[::step][:n]
    out = []
    for k, it in enumerate(picks):
        path = OUT / "pov" / stop["id"] / f"{k}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(get(it["https_url"]).content)
        out.append({"file": f"pov/{stop['id']}/{k}.jpg", "sol": it["sol"], "instrument": it["instrument"],
                    "source": it["https_url"], "credit": it.get("image_credit", "NASA/JPL-Caltech")})
    print(f"  {stop['id']}: {len(items)} raw items in sols {s0}-{s1}, "
          f"{len(nav)} full-frame Navcam, {len(mast)} full-frame Mastcam-left -> kept {len(out)}")
    return out


def main():
    print("fetch_rover")
    clip_traverse()
    all_wp = waypoints()
    snap_stops(all_wp)
    for s in STOPS:
        s["images"] = pov_images(s)
    write_json(OUT / "stops.json", STOPS)


if __name__ == "__main__":
    main()
