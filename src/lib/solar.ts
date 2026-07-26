/**
 * solar.ts — the astronomy core.
 *
 * Hand-rolled rather than pulling `suncalc`, for two reasons:
 *
 *  1. suncalc shipped a v2.0 rewrite (2026-07) that flipped altitude to degrees
 *     and azimuth from south-based to north-based. Half the tutorials on the
 *     internet are now silently wrong. Owning the math means owning the units.
 *  2. The planet remap needs the same equation with a different obliquity and
 *     day length. `sin(alt) = sinφ·sinδ + cosφ·cosδ·cosH` is universal — only δ
 *     and the rotation rate change. One core serves Earth and everywhere else.
 *
 * Algorithm: NOAA / Meeus "Astronomical Algorithms" ch.25 low-precision sun.
 * Accurate to ~0.01° over ±1 century, which is several orders of magnitude
 * better than a globe can display.
 *
 * CONVENTIONS — fixed here once, obeyed everywhere:
 *   • angles in DEGREES at every public boundary (radians only stay inside)
 *   • longitude EAST-positive
 *   • azimuth NORTH-based, clockwise (0=N, 90=E, 180=S, 270=W)
 *   • hour angle 0 at local solar noon, positive in the afternoon
 */

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const J2000 = 2451545.0

export const norm360 = (d: number) => ((d % 360) + 360) % 360
export const norm180 = (d: number) => {
  const x = norm360(d)
  return x > 180 ? x - 360 : x
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export const toJulian = (date: Date) => date.getTime() / 86400000 + 2440587.5
export const fromJulian = (jd: number) => new Date((jd - 2440587.5) * 86400000)

/* ------------------------------------------------------------------ */
/* The sun's position in space (independent of any observer)           */
/* ------------------------------------------------------------------ */

export interface SunState {
  /** Julian centuries since J2000.0 */
  T: number
  /** apparent ecliptic longitude, deg — also Earth's solar longitude Ls */
  lambda: number
  /** obliquity of the ecliptic, deg */
  epsilon: number
  /** solar declination, deg — this is the subsolar latitude */
  declination: number
  /** right ascension, deg */
  rightAscension: number
  /** Greenwich mean sidereal time, deg */
  gmst: number
  /** equation of time, minutes (apparent solar - mean solar) */
  equationOfTime: number
  /** Earth-Sun distance, AU */
  distanceAU: number
}

export function sunState(jd: number): SunState {
  const T = (jd - J2000) / 36525

  // geometric mean longitude & mean anomaly
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T)
  const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T)
  const Mr = M * D2R

  // equation of center → true longitude
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) +
    0.000289 * Math.sin(3 * Mr)
  const trueLong = L0 + C

  // nutation/aberration correction → apparent longitude
  const omega = 125.04 - 1934.136 * T
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * D2R)

  // obliquity
  const eps0 = 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T
  const epsilon = eps0 + 0.00256 * Math.cos(omega * D2R)

  const lr = lambda * D2R
  const er = epsilon * D2R
  const declination = Math.asin(clamp(Math.sin(er) * Math.sin(lr), -1, 1)) * R2D
  const rightAscension = norm360(
    Math.atan2(Math.cos(er) * Math.sin(lr), Math.cos(lr)) * R2D,
  )

  const gmst = norm360(
    280.46061837 +
      360.98564736629 * (jd - J2000) +
      0.000387933 * T * T -
      (T * T * T) / 38710000,
  )

  // orbital radius from the true anomaly
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T
  const nu = (M + C) * D2R
  const distanceAU = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(nu))

  // equation of time (Meeus 28.3)
  const y = Math.tan(er / 2) ** 2
  const L0r = L0 * D2R
  const eqRad =
    y * Math.sin(2 * L0r) -
    2 * e * Math.sin(Mr) +
    4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
    0.5 * y * y * Math.sin(4 * L0r) -
    1.25 * e * e * Math.sin(2 * Mr)

  return {
    T,
    lambda: norm360(lambda),
    epsilon,
    declination,
    rightAscension,
    gmst,
    equationOfTime: 4 * eqRad * R2D,
    distanceAU,
  }
}

/**
 * The subsolar point: where the sun is exactly overhead.
 * Latitude is just the declination; longitude is RA minus sidereal time.
 * This single point drives the entire day/night terminator — everything the
 * globe shader needs is this one vector.
 */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const s = sunState(toJulian(date))
  return { lat: s.declination, lon: norm180(s.rightAscension - s.gmst) }
}

/* ------------------------------------------------------------------ */
/* Where the sun is from somewhere                                     */
/* ------------------------------------------------------------------ */

/** Atmospheric refraction near the horizon, degrees (Bennett / Sæmundsson). */
export function refraction(altDeg: number): number {
  if (altDeg < -1.5) return 0
  return 1.02 / Math.tan((altDeg + 10.3 / (altDeg + 5.11)) * D2R) / 60
}

export interface SolarPosition {
  /** geometric altitude above the horizon, deg (negative = below) */
  altitude: number
  /** altitude including atmospheric refraction, deg — what you'd actually see */
  apparentAltitude: number
  /** compass bearing of the sun, deg clockwise from north */
  azimuth: number
  /** hour angle, deg — 0 at solar noon, +15°/hr into the afternoon */
  hourAngle: number
  /** solar declination, deg */
  declination: number
  /** the subsolar point at this instant */
  subsolar: { lat: number; lon: number }
  /** length of a shadow as a multiple of object height (Infinity below horizon) */
  shadowRatio: number
  /** fraction of top-of-atmosphere irradiance reaching a horizontal surface */
  irradianceFactor: number
}

export function solarPosition(
  date: Date,
  lat: number,
  lon: number,
): SolarPosition {
  const s = sunState(toJulian(date))
  const subsolar = {
    lat: s.declination,
    lon: norm180(s.rightAscension - s.gmst),
  }

  // hour angle collapses to a longitude difference against the subsolar point
  const hourAngle = norm180(lon - subsolar.lon)

  const phi = lat * D2R
  const dec = s.declination * D2R
  const H = hourAngle * D2R

  const sinAlt =
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  const altitude = Math.asin(clamp(sinAlt, -1, 1)) * R2D

  const azimuth = norm360(
    Math.atan2(
      -Math.sin(H),
      Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H),
    ) * R2D,
  )

  return {
    altitude,
    apparentAltitude: altitude + refraction(altitude),
    azimuth,
    hourAngle,
    declination: s.declination,
    subsolar,
    shadowRatio: altitude > 0 ? 1 / Math.tan(altitude * D2R) : Infinity,
    irradianceFactor: Math.max(0, sinAlt) / (s.distanceAU * s.distanceAU),
  }
}

/* ------------------------------------------------------------------ */
/* Times of day                                                        */
/* ------------------------------------------------------------------ */

/**
 * Solar elevation thresholds that define each phase of the day.
 * −0.833° is sunrise/sunset: the sun's upper limb touching the horizon,
 * being −0.266° of semidiameter and −0.567° of refraction.
 */
export const SUN_ANGLES = {
  sunrise: -0.833,
  sunriseEnd: -0.3,
  goldenHour: 6,
  blueHour: -4,
  civil: -6,
  nautical: -12,
  astronomical: -18,
} as const

export type PhaseKey =
  | 'night'
  | 'astronomicalTwilight'
  | 'nauticalTwilight'
  | 'blueHour'
  | 'civilTwilight'
  | 'sunrise'
  | 'goldenHour'
  | 'day'

export interface Phase {
  key: PhaseKey
  label: string
  /** how the sky reads at this elevation — drives the UI accent */
  tint: string
}

/** Classify an instant by the sun's elevation. */
export function phaseFor(altitude: number): Phase {
  if (altitude >= 6) return { key: 'day', label: 'Daylight', tint: '#7cc0ff' }
  if (altitude >= -0.833)
    return { key: 'goldenHour', label: 'Golden hour', tint: '#ffb454' }
  if (altitude >= -4)
    return { key: 'civilTwilight', label: 'Civil twilight', tint: '#ff8a5c' }
  if (altitude >= -6)
    return { key: 'blueHour', label: 'Blue hour', tint: '#6f8fd6' }
  if (altitude >= -12)
    return {
      key: 'nauticalTwilight',
      label: 'Nautical twilight',
      tint: '#41568f',
    }
  if (altitude >= -18)
    return {
      key: 'astronomicalTwilight',
      label: 'Astronomical twilight',
      tint: '#2a3260',
    }
  return { key: 'night', label: 'Night', tint: '#161a2e' }
}

export interface SunTimes {
  solarNoon: Date
  nadir: Date
  sunrise: Date | null
  sunset: Date | null
  goldenHourEnd: Date | null
  goldenHourStart: Date | null
  civilDawn: Date | null
  civilDusk: Date | null
  nauticalDawn: Date | null
  nauticalDusk: Date | null
  astronomicalDawn: Date | null
  astronomicalDusk: Date | null
  /** true when the sun never sets that day */
  alwaysUp: boolean
  /** true when the sun never rises that day */
  alwaysDown: boolean
  /** hours between sunrise and sunset (24 / 0 in polar conditions) */
  dayLengthHours: number
}

/**
 * Sun event times for the solar day containing `date`.
 * Uses the standard sunrise equation: find solar transit, then step out by the
 * hour angle at which the sun crosses each elevation threshold.
 */
export function sunTimes(date: Date, lat: number, lon: number): SunTimes {
  const jd = toJulian(date)

  // Solar transit: the instant the sun crosses the local meridian, i.e. when
  // the observer's longitude equals the subsolar longitude. Rather than lean
  // on the usual magic-constant approximation, solve it directly — the hour
  // angle is a smooth function of time, so a few fixed-point steps nail it.
  const noonGuess = Math.round(jd - J2000 - lon / 360) + J2000 + lon / -360
  let jTransit = noonGuess
  for (let i = 0; i < 4; i++) {
    const s = sunState(jTransit)
    // how far past the meridian the sun already is, in degrees
    const H = norm180(lon - norm180(s.rightAscension - s.gmst))
    // the sun tracks ~360.9856° per day relative to the meridian
    jTransit -= H / 360.9856235
  }

  const phi = lat * D2R

  /**
   * Time at which the sun reaches `altDeg`, refined.
   *
   * The first pass uses the declination at transit; but sunrise can be eight
   * hours from noon, and the declination has moved by then. Re-solving at the
   * estimated time and iterating removes that error — worth ~1-2 minutes at
   * high latitude, which is exactly where people care about the light.
   */
  const solve = (altDeg: number, dir: -1 | 1): Date | null => {
    let jd_ = jTransit + (dir * 0.25) // seed a quarter-day either side
    for (let i = 0; i < 3; i++) {
      const s = sunState(jd_)
      const dec = s.declination * D2R
      const cosH =
        (Math.sin(altDeg * D2R) - Math.sin(phi) * Math.sin(dec)) /
        (Math.cos(phi) * Math.cos(dec))
      if (cosH > 1 || cosH < -1) return null
      const h = Math.acos(cosH) * R2D
      jd_ = jTransit + (dir * h) / 360
    }
    return fromJulian(jd_)
  }

  const pair = (altDeg: number): [Date | null, Date | null] => [
    solve(altDeg, -1),
    solve(altDeg, 1),
  ]

  const [sunrise, sunset] = pair(SUN_ANGLES.sunrise)
  const [goldenHourEnd, goldenHourStart] = pair(SUN_ANGLES.goldenHour)
  const [civilDawn, civilDusk] = pair(SUN_ANGLES.civil)
  const [nauticalDawn, nauticalDusk] = pair(SUN_ANGLES.nautical)
  const [astronomicalDawn, astronomicalDusk] = pair(SUN_ANGLES.astronomical)

  // no sunrise crossing means either permanent day or permanent night —
  // resolve which by sampling the sun at transit, its highest point
  const decNoon = sunState(jTransit).declination * D2R
  const noonAlt =
    Math.asin(
      clamp(
        Math.sin(phi) * Math.sin(decNoon) +
          Math.cos(phi) * Math.cos(decNoon) * Math.cos(0),
        -1,
        1,
      ),
    ) * R2D
  const polar = sunrise === null
  const alwaysUp = polar && noonAlt > SUN_ANGLES.sunrise
  const alwaysDown = polar && noonAlt <= SUN_ANGLES.sunrise

  const dayLengthHours = alwaysUp
    ? 24
    : alwaysDown
      ? 0
      : sunrise && sunset
        ? (sunset.getTime() - sunrise.getTime()) / 3600000
        : 0

  return {
    solarNoon: fromJulian(jTransit),
    nadir: fromJulian(jTransit - 0.5),
    sunrise,
    sunset,
    goldenHourEnd,
    goldenHourStart,
    civilDawn,
    civilDusk,
    nauticalDawn,
    nauticalDusk,
    astronomicalDawn,
    astronomicalDusk,
    alwaysUp,
    alwaysDown,
    dayLengthHours,
  }
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * lat/lon → a point on a unit sphere.
 * The −sin(lon) on Z is what lines the mesh up with an equirectangular
 * texture whose prime meridian sits at the horizontal centre. Verified by
 * dropping a marker at 0,0 (Gulf of Guinea) and 0,90E (Sumatra).
 */
export function latLonToVec3(
  latDeg: number,
  lonDeg: number,
  radius = 1,
): [number, number, number] {
  const phi = latDeg * D2R
  const lambda = lonDeg * D2R
  return [
    radius * Math.cos(phi) * Math.cos(lambda),
    radius * Math.sin(phi),
    -radius * Math.cos(phi) * Math.sin(lambda),
  ]
}

/** The exact inverse of latLonToVec3 — for turning a raycast hit into a place. */
export function vec3ToLatLon(x: number, y: number, z: number) {
  const r = Math.hypot(x, y, z) || 1
  return {
    lat: Math.asin(clamp(y / r, -1, 1)) * R2D,
    lon: Math.atan2(-z, x) * R2D,
  }
}

/** Great-circle distance in km. */
export function haversine(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = (b.lat - a.lat) * D2R
  const dLon = (b.lon - a.lon) * D2R
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(clamp(s, 0, 1)))
}

/**
 * Offset from UTC implied purely by longitude (15° per hour).
 * Not a real timezone — deliberately. Solar time is what this app is about,
 * and political timezones lie about the sun by up to three hours.
 */
export const solarOffsetHours = (lon: number) => lon / 15
