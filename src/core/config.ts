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
  speedModel?: "tobler" | "vehicle"; // how speed falls off with grade (default tobler = walking)
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

/** Unpressurised crew buggy, numbers from the Apollo Lunar Roving Vehicle (the only crewed off-world rover flown). */
export const ROVER: TerrainProfile = {
  name: "Crew buggy (LRV-class), 2 crew",
  maxSlopeDeg: {
    value: 20,
    source: "ASSUMED: kept below the Apollo LRV's 25 deg design slope capability (LRV Operations Handbook, NASA/Boeing 1971) for margin on loose Mars soil.",
  },
  maxRoughM: {
    value: 0.3,
    source: "Apollo LRV obstacle-crossing height ~30 cm (LRV Operations Handbook); used as the RMS relief limit per 10 m cell.",
  },
  slopeWeight: 4,
  roughWeight: 3,
  uphillMetresPerMetre: { value: 3, source: "ASSUMED: climbing costs a vehicle less than a walker (energy, not legs)." },
  flatSpeedKmh: {
    value: 10,
    source: "Apollo LRV top speed ~13 km/h, typical traverse speeds ~7-10 km/h (Apollo 15-17 mission reports); 10 km/h used on flat.",
  },
  speedModel: "vehicle",
};

/** Curiosity itself, used only to validate the planner against the drives the rover team actually chose. */
export const CURIOSITY: TerrainProfile = {
  name: "Curiosity rover (validation)",
  maxSlopeDeg: {
    value: 30,
    source: "ASSUMED: working drive-planning limit, kept well under MSL's 45 deg static tilt rating (NASA MSL rover page: 'withstand a tilt of 45 degrees in any direction without overturning').",
  },
  maxRoughM: {
    value: 0.65,
    source: "NASA MSL rover page: wheels 'can roll over obstacles approaching 65 centimeters'. Used as the RMS relief limit per 10 m cell.",
  },
  slopeWeight: 3,
  roughWeight: 3,
  uphillMetresPerMetre: { value: 3, source: "ASSUMED: same climb penalty as the crew buggy." },
  flatSpeedKmh: { value: 0.1, source: "Curiosity's top speed ~0.14 km/h (NASA MSL rover page). Not used in the comparison metrics." },
  speedModel: "vehicle",
};

/** A copy of a profile with a different slope limit (crew-capability slider). */
export function withSlopeLimit(p: TerrainProfile, deg: number): TerrainProfile {
  if (deg === p.maxSlopeDeg.value) return p;
  return { ...p, name: `${p.name}, slope limit ${deg} deg`, maxSlopeDeg: { value: deg, source: `ASSUMED: user-set crew capability (default ${p.maxSlopeDeg.value} deg)` } };
}

export const BUGGY = {
  maxSpeedKmh: { value: 13, source: "Apollo LRV maximum speed ~13 km/h (LRV Operations Handbook)." } as Sourced<number>,
  rangeKm: { value: 90, source: "Apollo LRV design range 92 km on two 36 V silver-zinc batteries (LRV Operations Handbook)." } as Sourced<number>,
  rolloverDeg: { value: 45, source: "ASSUMED: static rollover angle for a wide, low buggy (LRV handbook gives 45 deg stability limits)." } as Sourced<number>,
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

/** Survival / hazard model used by the game (see ASSUMPTIONS.md). */
export const SURVIVAL = {
  heaterOnBelowC: { value: -40, source: "ASSUMED: below this outside air temperature the suit heater starts drawing extra power." } as Sourced<number>,
  heaterPerDegree: { value: 0.012, source: "ASSUMED: +1.2% consumption per degree C below the heater threshold (night at -80 C ~ +50%)." } as Sourced<number>,
  safeImpactMs: { value: 4, source: "ASSUMED: landing speed a suited human absorbs safely (~2.1 m fall on Mars, g = 3.72)." } as Sourced<number>,
  damagePerMs: { value: 14, source: "ASSUMED: health lost per m/s of impact speed above the safe limit." } as Sourced<number>,
  hypoxiaS: { value: 60, source: "ASSUMED (game-forgiving): seconds of sim time from empty O2 to loss of life; real useful consciousness is shorter." } as Sourced<number>,
  shelterHours: { value: 30, source: "ASSUMED: emergency shelter kit supplies (O2, heat) for one Mars night plus margin." } as Sourced<number>,
  sepDoseMultiplier: { value: 20, source: "ILLUSTRATIVE: solar particle event raises the surface dose rate for a few hours; RAD has measured surface dose doubling (Sept 2017 event) - this game exaggerates it for play." } as Sourced<number>,
};

/** Dust storms (game event). Optical depth tau drives light and visibility in the renderer. */
export const DUST = {
  clearTau: { value: 0.6, source: "MSL Mastcam/REMS: Gale's background dust optical depth is typically ~0.3-1 outside storms (e.g. Lemmon et al. 2015, Icarus 251); 0.6 used." } as Sourced<number>,
  stormPeakTau: { value: 4.5, source: "ASSUMED: a strong regional storm. For scale, the 2018 global storm peaked near tau ~8.5 at Gale (Guzewich et al. 2019, GRL 46)." } as Sourced<number>,
  seasonLs: { value: [180, 330] as [number, number], source: "Large dust storms occur mainly in southern spring/summer, Ls ~180-330 (e.g. Kass et al. 2016, GRL 43)." } as Sourced<[number, number]>,
  perSolChance: { value: 0.35, source: "ASSUMED for gameplay: chance of a regional storm reaching the site per EVA sol in dust season (x0.15 outside it). Real regional storms are far rarer." } as Sourced<number>,
};
