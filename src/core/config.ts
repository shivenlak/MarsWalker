// Every tunable number lives here, each with its source or an "assumed" label.
// ASSUMPTIONS.md explains the reasoning; change values here, nowhere else.

export interface Sourced<T> {
  value: T;
  source: string; // citation, or "ASSUMED: <reason>"
}

/** Terrain limits + cost weights for the router. One profile per crew config (Phase 2 adds more). */
export interface TerrainProfile {
  name: string;
  maxSlopeDeg: Sourced<number>;   // cells whose p90 slope exceeds this are impassable
  maxRoughM: Sourced<number>;     // cells whose plane-fit RMS roughness exceeds this are impassable
  slopeWeight: number;            // cost multiplier: 1 + slopeWeight * (slope / maxSlope)^2
  roughWeight: number;            // cost multiplier: 1 + roughWeight * (rough / maxRough)
  uphillMetresPerMetre: Sourced<number>; // extra flat-equivalent metres per metre climbed
  flatSpeedKmh: Sourced<number>;  // walking speed on flat ground
}

export const WALKING: TerrainProfile = {
  name: "Walking, 2 crew, standard tool load",
  maxSlopeDeg: {
    value: 25,
    source: "ASSUMED: suited walking limit. Apollo crews walked on slopes up to ~20-25 deg with difficulty; p90 of 2 m slopes is already conservative.",
  },
  maxRoughM: {
    value: 0.5,
    source: "ASSUMED: ~knee-height relief inside a 10 m cell = boulders/scarps a suited crew should not cross.",
  },
  slopeWeight: 3,
  roughWeight: 2,
  uphillMetresPerMetre: {
    value: 8,
    source: "Naismith's rule (Earth hiking): 1 h per 600 m ascent at 5 km/h -> 1 m climb ~ 8.3 m flat. ASSUMED to transfer to suited Mars walking.",
  },
  flatSpeedKmh: {
    value: 3.0,
    source: "ASSUMED: suited EVA walking pace, below Earth's ~5 km/h; Apollo lunar walking traverses were typically ~2-3 km/h.",
  },
};

/** EVA-level constants. */
export const EVA = {
  stopDwellMin: { value: 30, source: "ASSUMED: time on station per science stop (imaging, sampling)." } as Sourced<number>,
  maxDurationH: { value: 8, source: "ASSUMED: planning EVA length; NASA xEMU suit design target is ~8 h." } as Sourced<number>,
};

/** Radiation (used in Phase 2 conditions panel; defined here so the source is in one place). */
export const RADIATION = {
  surfaceDoseMSvPerDay: {
    value: 0.64,
    source: "Hassler et al. 2014, Science 343(6169): MSL/RAD surface dose equivalent 0.64 +/- 0.12 mSv/day.",
  } as Sourced<number>,
};

/** Tobler's hiking function shape (Tobler 1993), normalised so flat ground = flatSpeed. */
export const TOBLER = {
  k: 3.5,
  offset: 0.05,
  source: "Tobler, W. (1993) 'Three presentations on geographical analysis and modeling', NCGIA TR 93-1. Shape only; flat speed is ASSUMED (see profile).",
};

/** Suit consumables (game + planner). Capacities are in "nominal hours": hours at metabolic factor 1.0. */
export const SUIT = {
  capacityH: {
    value: 8.5,
    source: "ASSUMED: sized like NASA xEMU/EMU PLSS (~8 h EVA + 30 min reserve). O2, water and battery share this budget for simplicity.",
  } as Sourced<number>,
  reserveH: { value: 0.5, source: "ASSUMED: 30 min reserve that must remain on return to base (EMU practice)." } as Sourced<number>,
  metabolic: {
    value: { rest: 0.7, flat: 1.0, perGradeUp: 4.0, max: 2.2, downhill: 0.9 },
    source: "ASSUMED: consumption multiplier vs. activity. Resting 0.7, flat walking 1.0, +4 per unit uphill grade (capped 2.2). Shape follows Earth walking metabolic studies (e.g. Pandolf 1977), magnitudes not Mars-validated.",
  } as Sourced<{ rest: number; flat: number; perGradeUp: number; max: number; downhill: number }>,
};

/** Physical constants used by the walk sim. */
export const MARS = {
  gravity: { value: 3.721, source: "NASA Mars Fact Sheet: surface gravity 3.71-3.72 m/s^2." } as Sourced<number>,
  maxClimbDeg: { value: 30, source: "ASSUMED: steepest 2 m-scale slope a suited walker can physically step up in the sim (router limit is 25 deg p90)." } as Sourced<number>,
};
