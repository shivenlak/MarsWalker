"""Run the whole offline data pipeline. Safe to re-run (downloads are cached)."""
import build_terrain
import fetch_basemap
import fetch_rover

if __name__ == "__main__":
    build_terrain.main()
    fetch_basemap.basemap()
    fetch_basemap.themis()
    fetch_rover.main()
    print("done -> data/processed/")
