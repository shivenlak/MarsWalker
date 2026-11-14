"""Run the whole offline data pipeline. Safe to re-run (downloads are cached)."""
import build_terrain
import build_world
import fetch_basemap
import fetch_conditions
import fetch_rover

if __name__ == "__main__":
    build_terrain.main()
    fetch_basemap.basemap()
    fetch_basemap.themis()
    fetch_rover.main()
    build_world.main()        # needs the HiRISE tiles from fetch_basemap
    fetch_conditions.rems()
    fetch_conditions.donki()
    print("done -> data/processed/")
