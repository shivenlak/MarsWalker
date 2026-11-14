import { defineConfig } from "vite";

// data/processed is served as static files at the site root (e.g. /terrain/grid.json),
// so the app works fully offline after the data pipeline has run once.
export default defineConfig({
  base: "./",
  publicDir: "data/processed",
  server: { host: true }, // reachable from a tablet on the same network
});
