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
    {
        "id": "mineral_king", "kind": "science", "name": "Mineral King drill site", "sol": 4102,
        "what": "Gray rock block drilled as Curiosity's 40th successful drill hole (sols ~4107-4115, Feb-Mar 2024), beside the Gediz Vallis ridge.",
        "why": "The rock was so hard the hole came out shallow; a test of how cemented the sulfate-bearing layers are, with the chaotic Gediz Vallis ridge deposit in view.",
        "evidence": "NASA Curiosity blogs 'Sols 4107-4109: Drilling Mineral King', 'Sols 4110-4111: Mining into Mineral King', 'Sols 4114-4115: Bingo! 40th successful drill hole'.",
        "lookFor": "Gray, fine-grained bedrock blocks; the Gediz Vallis ridge (debris pile) on the skyline.",
        "imgSols": [4102, 4112],
    },
    {
        "id": "kings_canyon", "kind": "science", "name": "Kings Canyon drill site", "sol": 4255,
        "what": "Drill site inside the Gediz Vallis channel (Aug 2024); Curiosity marked its 12th landing anniversary here (sol 4265, Aug 6 2024).",
        "why": "Samples from the channel floor went to CheMin and SAM (evolved gas analysis) to compare with the sulfur-rich debris upstream.",
        "evidence": "NASA Curiosity blogs 'Sols 4263-4265: A Royal Birthday Celebration at Kings Canyon', 'Sols 4270-4272: Sample for SAM', 'Sols 4280-4281: Last Call at Kings Canyon'.",
        "lookFor": "Channel-floor bedrock between debris-flow boulders; the walls of Gediz Vallis.",
        "imgSols": [4256, 4270],
    },
    {
        "id": "altadena", "kind": "science", "name": "Altadena drill site", "sol": 4560,
        "what": "Curiosity's 43rd drill hole (June 2025) at the edge of the boxwork unit.",
        "why": "Baseline chemistry of the bedrock just before the boxwork ridges, to compare with samples from ridges and hollows.",
        "evidence": "NASA Curiosity blogs 'Sols 4561-4562: Prepping to Drill at Altadena', 'Sols 4566-4567: Drilling Success', 'Sols 4568-4569: A Close Look at the Altadena Drill Hole and Tailings'.",
        "lookFor": "Flat layered bedrock with the first low boxwork ridges ahead to the south.",
        "imgSols": [4560, 4570],
    },
    {
        "id": "basque_lakes", "kind": "science", "name": "Basque Lakes drill site", "sol": 5021,
        "what": "Recent drill campaign south of the boxwork (rover parked sols ~5021-5041, mid-2026).",
        "why": "Newest terrain on the climb up Mount Sharp; the team gathered context imaging around the drill hole while operating on limited power.",
        "evidence": "NASA Curiosity blog 'Sols 5029-5035: Back in the Lab' (Basque Lakes drill hole); MSL waypoints sols 5021-5041.",
        "lookFor": "Pale layered rock rising toward the higher sulfate unit; Mount Sharp's upper slopes beyond.",
        "imgSols": [5021, 5035],
    },
    {
        "id": "curiosity", "kind": "rover", "name": "Curiosity rover (latest position)", "sol": 5073,
        "what": "Where NASA's Curiosity rover was parked at the end of the latest published drive (sol 5073).",
        "why": "Curiosity has driven over every science stop on this map since 2024; its cameras supplied the photos in this game.",
        "evidence": "MSL waypoints feed (NASA MMGIS), latest drive end point in the data.",
        "lookFor": "A six-wheeled, car-sized rover with a mast; fresh wheel tracks behind it.",
        "imgSols": [5069, 5073],
    },
]

# Gameplay sample each science stop yields (descriptions follow the cited science; the sample itself is a game item).
SAMPLES = {
    "gediz": ("Sulfur-bearing stone", "Light-toned stone from the Gediz Vallis debris: Curiosity found pure elemental sulfur in this field."),
    "boxwork_entry": ("Ridge vein fragment", "Mineral-cemented fracture fill from a boxwork ridge."),
    "boxwork_main": ("Ridge/hollow core pair", "Paired cores from a boxwork ridge and the hollow beside it (Curiosity drilled 'Nevado Sajama' on a ridge, sol ~4718)."),
    "mineral_king": ("Hard gray bedrock core", "Strongly cemented sulfate-unit rock - the drill barely got in."),
    "kings_canyon": ("Channel-floor drill powder", "Gediz Vallis channel bedrock, for comparison with the sulfur debris."),
    "altadena": ("Boxwork-edge bedrock core", "Baseline bedrock just outside the boxwork unit."),
    "basque_lakes": ("Upper-unit drill powder", "Newest layers on the climb up Mount Sharp."),
}


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
        if s["id"] in SAMPLES:
            s["sample"] = {"name": SAMPLES[s["id"]][0], "about": SAMPLES[s["id"]][1]}
    write_json(OUT / "stops.json", STOPS)
    landmarks(all_wp)


def landmarks(all_wp, spacing_m=150, n_max=16):
    """'Curiosity was here' discoveries: real drive end-points spread over the AOI, each with a Navcam frame from that sol."""
    import math
    from common import R_MARS
    def xy(lon, lat):
        return R_MARS * math.radians(lon), R_MARS * math.radians(lat)
    taken = [xy(s["lon"], s["lat"]) for s in STOPS]
    wps = sorted([f for f in all_wp if in_aoi(*f["geometry"]["coordinates"][:2])], key=lambda f: f["properties"]["sol"])
    out = []
    for f in wps:
        p = f["properties"]
        q = xy(p["lon"], p["lat"])
        if any(math.dist(q, t) < spacing_m for t in taken):
            continue
        lm = {"id": f"wp{p['sol']}", "kind": "landmark", "name": f"Curiosity, sol {p['sol']}", "sol": p["sol"],
              "lon": p["lon"], "lat": p["lat"], "elev": p["elev_geoid"],
              "waypoint": f"site {p['site']} drive {p['drive']} (sol {p['sol']})",
              "odometerKm": round(p["dist_total_m"] / 1000, 2) if p.get("dist_total_m") else None,
              "imgSols": [p["sol"], p["sol"] + 1]}
        imgs = pov_images(lm, n=1)
        if not imgs:
            continue
        lm["images"] = imgs
        out.append(lm)
        taken.append(q)
        if len(out) >= n_max:
            break
    write_json(OUT / "landmarks.json", out)


if __name__ == "__main__":
    main()
