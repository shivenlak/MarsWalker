"""Surface + space-weather snapshot for the EVA (cached offline).

  data/processed/conditions/rems.json   Curiosity REMS daily summaries, last ~1.1 Mars years
  data/processed/conditions/donki.json  NASA DONKI events (CME, SEP, GST, notifications), last 30 days

The app never calls these APIs live; rerun this script to refresh the snapshot.
"""
import datetime as dt
import os
import time

from common import OUT, get, write_json

REMS = "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json"
DONKI = "https://api.nasa.gov/DONKI/{kind}?startDate={start}&endDate={end}&api_key={key}"


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def rems():
    soles = get(REMS).json()["soles"]
    keep = []
    for s in soles[:760]:  # newest first; 1 Mars year = 668.6 sols
        keep.append({
            "sol": int(s["sol"]), "date": s["terrestrial_date"], "ls": num(s["ls"]),
            "minAirC": num(s["min_temp"]), "maxAirC": num(s["max_temp"]),
            "minGroundC": num(s["min_gts_temp"]), "maxGroundC": num(s["max_gts_temp"]),
            "pressurePa": num(s["pressure"]), "opacity": s["atmo_opacity"],
            "sunrise": s["sunrise"], "sunset": s["sunset"], "uv": s["local_uv_irradiance_index"],
        })
    write_json(OUT / "conditions" / "rems.json", {
        "source": "NASA/JPL-Caltech/CAB(CSIC-INTA) Curiosity REMS weather feed (mars.nasa.gov RSS API)",
        "note": "Times are local mean solar time at Gale. Wind and humidity are mostly unreported ('--').",
        "fetched": dt.date.today().isoformat(),
        "soles": keep,
    })


def donki():
    end = dt.date.today()
    start = end - dt.timedelta(days=30)
    out = {"source": "NASA CCMC DONKI via api.nasa.gov", "start": start.isoformat(), "end": end.isoformat()}
    for kind in ("CME", "SEP", "GST", "notifications"):
        try:
            key = os.environ.get("NASA_API_KEY", "DEMO_KEY")  # DEMO_KEY is heavily rate-limited
            data = get(DONKI.format(kind=kind, start=start, end=end, key=key)).json()
            time.sleep(2)
        except Exception as e:  # DEMO_KEY rate limits / outages: record and carry on
            msg = str(e).split(" for url")[0][:80]  # never store the URL (it carries the API key)
            print(f"  DONKI {kind}: {msg}")
            out.setdefault("errors", {})[kind] = msg
            data = None
        if kind == "notifications" and data:
            data = [{"type": n.get("messageType"), "time": n.get("messageIssueTime"),
                     "url": n.get("messageURL")} for n in data]
        elif kind == "CME" and data:
            data = [{"time": c.get("startTime"), "note": (c.get("note") or "")[:200],
                     "speed": next((a.get("speed") for a in (c.get("cmeAnalyses") or []) if a.get("isMostAccurate")), None)}
                    for c in data]
        elif kind == "SEP" and data:
            data = [{"time": s.get("eventTime"), "instruments": [i.get("displayName") for i in s.get("instruments") or []]}
                    for s in data]
        elif kind == "GST" and data:
            data = [{"time": g.get("startTime"),
                     "kpMax": max((k.get("kpIndex") or 0) for k in g.get("allKpIndex") or [{}])} for g in data]
        out[kind] = data
        print(f"  DONKI {kind}: {len(data) if data else 0} events")
    write_json(OUT / "conditions" / "donki.json", out)


if __name__ == "__main__":
    print("fetch_conditions: REMS + DONKI snapshot")
    rems()
    donki()
