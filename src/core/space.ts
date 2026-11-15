// Earth-Mars distance and one-way light time for a date, from JPL's "Approximate Positions of the Planets"
// (E. M. Standish, Keplerian elements Table 1, valid 1800-2050, Mars error < ~ 1-2 arcmin).
// Used for the comms-delay feature: every message to Earth waits for the real light time.

const AU_KM = 149597870.7;
const C_KMS = 299792.458;
const DEG = Math.PI / 180;

// [a (AU), e, I (deg), L (deg), long.peri (deg), long.node (deg)] at J2000 and per Julian century
const EMB = { el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0] };
const MARS = { el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] };

/** Heliocentric ecliptic position (AU) from JPL approximate elements. */
function helio(p: { el: number[]; rate: number[] }, T: number): [number, number, number] {
  const [a, e, I, L, wbar, node] = p.el.map((v, i) => v + p.rate[i] * T);
  const w = wbar - node;
  let M = ((L - wbar) % 360 + 540) % 360 - 180; // mean anomaly in [-180, 180)
  M *= DEG;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w * DEG), sw = Math.sin(w * DEG), cO = Math.cos(node * DEG), sO = Math.sin(node * DEG), cI = Math.cos(I * DEG), sI = Math.sin(I * DEG);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

export interface CommLink { distAU: number; distKm: number; oneWayS: number; sunAngleDeg: number }

/** Earth-Mars geometry at a date. sunAngleDeg = Sun-Earth-Mars elongation (small = near solar conjunction). */
export function commLink(date: Date): CommLink {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const e = helio(EMB, T), m = helio(MARS, T);
  const d = [m[0] - e[0], m[1] - e[1], m[2] - e[2]];
  const distAU = Math.hypot(d[0], d[1], d[2]);
  const dot = -(e[0] * d[0] + e[1] * d[1] + e[2] * d[2]) / (Math.hypot(...e) * distAU);
  return { distAU, distKm: distAU * AU_KM, oneWayS: (distAU * AU_KM) / C_KMS, sunAngleDeg: Math.acos(Math.max(-1, Math.min(1, dot))) / DEG };
}

/** Solar conjunction blackout: DSN avoids commanding when Mars is within ~2-3 deg of the Sun as seen from Earth. */
export const CONJUNCTION_DEG = { value: 3, source: "NASA: Mars solar conjunction, commanding paused when Mars is within ~2 deg of the Sun (mars.nasa.gov 'Mars Solar Conjunction'); 3 deg used for margin." };
