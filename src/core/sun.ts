// Mars clock + sun position at Gale (Mars24 algorithm, Allison & McEwen 2000; NASA GISS Mars24).
// Gives Ls (season), MSL sol number, local solar time, and sun elevation/azimuth for any Earth date.
// Validated against Curiosity REMS daily records in sun.test.ts.

const D2R = Math.PI / 180;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export const GALE = { lonE: 137.39, lat: -4.79 }; // AOI centre

export const SUN_SOURCE =
  "Mars24 algorithm (Allison & McEwen 2000, Planet. Space Sci. 48; NASA GISS Mars24). Checked against Curiosity REMS sol/Ls/sunrise.";

export interface MarsTime {
  msd: number;   // Mars Sol Date
  ls: number;    // areocentric solar longitude (deg), season
  lmst: number;  // local mean solar time, hours
  ltst: number;  // local true solar time, hours
  sol: number;   // Curiosity mission sol
  decl: number;  // solar declination (deg)
}

/** Mars time at Gale for a JS Date (UTC). TT-UTC taken as 69.184 s (leap seconds since 2017). */
export function marsTime(date: Date, lonE = GALE.lonE): MarsTime {
  const jdUT = date.getTime() / 86400000 + 2440587.5;
  const jdTT = jdUT + 69.184 / 86400;
  const dt = jdTT - 2451545.0;

  const M = 19.3871 + 0.52402073 * dt;
  const aFMS = 270.3871 + 0.524038496 * dt;
  const A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.0020, 0.0018];
  const T = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493];
  const P = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095];
  let pbs = 0;
  for (let i = 0; i < 7; i++) pbs += A[i] * Math.cos(((0.985626 * dt) / T[i] + P[i]) * D2R);
  const m = M * D2R;
  const vMinusM = (10.691 + 3.0e-7 * dt) * Math.sin(m) + 0.623 * Math.sin(2 * m) + 0.050 * Math.sin(3 * m)
    + 0.005 * Math.sin(4 * m) + 0.0005 * Math.sin(5 * m) + pbs;
  const ls = mod(aFMS + vMinusM, 360);
  const l = ls * D2R;
  const eot = 2.861 * Math.sin(2 * l) - 0.071 * Math.sin(4 * l) + 0.002 * Math.sin(6 * l) - vMinusM; // deg

  const msd = (dt - 4.5) / 1.0274912517 + 44796.0 - 0.0009626;
  const mst = mod(24 * msd, 24);
  const lmst = mod(mst + lonE / 15, 24);
  const ltst = mod(lmst + eot / 15, 24);
  const decl = Math.asin(0.42565 * Math.sin(l)) / D2R + 0.25 * Math.sin(l);
  // MSL sols count local mean solar days at Gale from landing (sol 0 = MSD 49268.x local)
  const sol = Math.floor(msd + lonE / 360) - MSL_SOL0;
  return { msd, ls, lmst, ltst, sol, decl };
}

/** Local-MSD of MSL sol 0 (landing, 2012-08-06). Checked against REMS sol numbers. */
export const MSL_SOL0 = 49269;

/** Sun elevation and azimuth (deg; azimuth 0 = north, clockwise) at local true solar time. */
export function sunPosition(ltst: number, declDeg: number, latDeg = GALE.lat) {
  const H = (ltst - 12) * 15 * D2R;
  const d = declDeg * D2R, p = latDeg * D2R;
  const sinEl = Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H);
  const el = Math.asin(sinEl);
  const az = Math.atan2(-Math.sin(H) * Math.cos(d), Math.cos(p) * Math.sin(d) - Math.sin(p) * Math.cos(d) * Math.cos(H));
  return { elevDeg: el / D2R, azDeg: mod(az / D2R, 360) };
}

/** Mars Earth-seconds per sol and per Mars hour (1/24 sol). */
export const SOL_S = 88775.244;
export const MARS_HOUR_S = SOL_S / 24;

/** "HH:MM" from fractional hours. */
export function fmtClock(h: number): string {
  const t = mod(h, 24);
  const hh = Math.floor(t), mm = Math.floor((t - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Earth Date when Gale's local true solar time is `ltst` on the same sol as `near` (Newton steps). */
export function dateAtLTST(near: Date, ltst: number): Date {
  let t = near.getTime();
  const sol0 = marsTime(near).sol;
  for (let i = 0; i < 8; i++) {
    const m = marsTime(new Date(t));
    const errH = (m.sol - sol0) * 24 + (m.ltst - ltst);
    t -= errH * MARS_HOUR_S * 1000;
  }
  return new Date(t);
}
