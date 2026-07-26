/**
 * planets.ts — the remap.
 *
 * The premise: take a real place on Earth, keep its latitude, and ask what the
 * sun would do overhead if that patch of ground were somewhere else.
 *
 * This works because the sun-elevation equation doesn't care which planet it is:
 *
 *     sin(altitude) = sin(φ)·sin(δ) + cos(φ)·cos(δ)·cos(H)
 *
 * Only three things change between worlds:
 *   • δ, the declination, bounded by that planet's axial tilt
 *   • how fast H advances — the length of a solar day
 *   • how bright and how big the sun is, from orbital distance
 *
 * Everything below is measured data (NASA/NSSDCA fact sheets) plus that one
 * equation. Nothing here is invented.
 */

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** Solar constant at Earth, W/m². Everything scales off this. */
export const SOLAR_CONSTANT = 1361

/** Sun radius in km, for angular size. */
const SUN_RADIUS_KM = 695_500
const AU_KM = 149_597_870.7

export interface Planet {
  id: string
  name: string
  /** axial tilt relative to the orbital plane, degrees */
  obliquity: number
  /** sidereal rotation period, Earth hours */
  siderealDay: number
  /** sunrise-to-sunrise, Earth hours — this is what a "day" means to a resident */
  solarDay: number
  /** orbital period, Earth days */
  yearDays: number
  /** semi-major axis, AU */
  semiMajorAxis: number
  eccentricity: number
  /** spins backwards: the sun rises in the west */
  retrograde: boolean
  /** surface gravity relative to Earth */
  gravity: number
  /** representative surface/cloud colour, for the UI */
  color: string
  /** deeper shade for gradients */
  colorDark: string
  /** equirectangular texture, when we have one */
  texture?: string
  /** the one thing that makes this world's sky strange */
  hook: string
  /** what standing there would actually be like */
  note: string
}

export const PLANETS: Planet[] = [
  {
    id: 'earth',
    name: 'Earth',
    obliquity: 23.44,
    siderealDay: 23.9345,
    solarDay: 24,
    yearDays: 365.256,
    semiMajorAxis: 1,
    eccentricity: 0.0167,
    retrograde: false,
    gravity: 1,
    color: '#4a9eff',
    colorDark: '#0a1f3d',
    texture: '/textures/earth_day_4096.jpg',
    hook: 'The reference. A 24-hour day and a 23.4° tilt — the only sky you have ever actually stood under.',
    note: 'Every other world on this list is described relative to here.',
  },
  {
    id: 'mars',
    name: 'Mars',
    obliquity: 25.19,
    siderealDay: 24.6229,
    solarDay: 24.6597,
    yearDays: 686.98,
    semiMajorAxis: 1.5237,
    eccentricity: 0.0935,
    retrograde: false,
    gravity: 0.379,
    color: '#e27b58',
    colorDark: '#3d1a0f',
    hook: 'Almost Earth. A 24h39m day, a 25.2° tilt — familiar seasons, stretched over a year twice as long.',
    note: 'The eccentric orbit makes southern summers short and fierce; sunlight swings 45% between perihelion and aphelion. Dust turns the sun into a pale blue-white disk, and the sunsets are blue.',
  },
  {
    id: 'venus',
    name: 'Venus',
    obliquity: 177.36,
    siderealDay: 5832.5,
    solarDay: 2802,
    yearDays: 224.7,
    semiMajorAxis: 0.7233,
    eccentricity: 0.0068,
    retrograde: true,
    gravity: 0.905,
    color: '#e8cda2',
    colorDark: '#3d3018',
    hook: 'Upside down and running backwards. The sun rises in the west and takes 117 Earth days to do it again.',
    note: 'Tilted 177°, which is another way of saying "flipped over" — the effective tilt is only 2.6°, so there are essentially no seasons. Below the clouds you would never see the sun as a disk at all, just a sourceless orange glow.',
  },
  {
    id: 'mercury',
    name: 'Mercury',
    obliquity: 0.034,
    siderealDay: 1407.6,
    solarDay: 4222.6,
    yearDays: 87.97,
    semiMajorAxis: 0.3871,
    eccentricity: 0.2056,
    retrograde: false,
    gravity: 0.38,
    color: '#a8a29e',
    colorDark: '#2b2724',
    hook: 'One day lasts two years. A 3:2 spin-orbit resonance means 176 Earth days from sunrise to sunrise.',
    note: 'Effectively no tilt, so no seasons — but the orbit is so eccentric that near perihelion the sun slows, stops, and briefly reverses direction in the sky before carrying on.',
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    obliquity: 3.13,
    siderealDay: 9.925,
    solarDay: 9.926,
    yearDays: 4332.59,
    semiMajorAxis: 5.2038,
    eccentricity: 0.0487,
    retrograde: false,
    gravity: 2.53,
    color: '#d9a066',
    colorDark: '#3a2515',
    hook: 'Ten-hour days. The largest planet spins the fastest, and its 3° tilt means no seasons at all.',
    note: 'At 5.2 AU the sun delivers 3.7% of Earth\'s light — bright as a heavily overcast afternoon, from a disk one-fifth the width.',
  },
  {
    id: 'saturn',
    name: 'Saturn',
    obliquity: 26.73,
    siderealDay: 10.656,
    solarDay: 10.656,
    yearDays: 10759.22,
    semiMajorAxis: 9.5726,
    eccentricity: 0.052,
    retrograde: false,
    gravity: 1.07,
    color: '#e3d6a8',
    colorDark: '#3a3320',
    hook: 'Earth-like seasons, each one lasting more than seven years.',
    note: 'The 26.7° tilt is nearly Earth\'s, but a 29-year orbit stretches every season into a Saturnian decade. That tilt is also why the rings open and close from our view.',
  },
  {
    id: 'uranus',
    name: 'Uranus',
    obliquity: 97.77,
    siderealDay: 17.24,
    solarDay: 17.24,
    yearDays: 30688.5,
    semiMajorAxis: 19.165,
    eccentricity: 0.0469,
    retrograde: true,
    gravity: 0.89,
    color: '#a8dfe8',
    colorDark: '#173238',
    hook: 'Lying on its side. Each pole gets 42 years of unbroken daylight, then 42 years of night.',
    note: 'A 98° tilt puts the axis almost in the orbital plane, so the poles receive more annual sunlight than the equator — the only planet where that is true. The sun tracks nearly overhead at the pole in midsummer.',
  },
  {
    id: 'neptune',
    name: 'Neptune',
    obliquity: 28.32,
    siderealDay: 16.11,
    solarDay: 16.11,
    yearDays: 60195,
    semiMajorAxis: 30.178,
    eccentricity: 0.0097,
    retrograde: false,
    gravity: 1.14,
    color: '#5b7cfa',
    colorDark: '#131a3d',
    hook: 'A 28° tilt and a 165-year orbit: one season lasts forty-one years.',
    note: 'Sunlight is 0.1% of Earth\'s and the sun is a 1-arcminute point — bright, but barely more than the brightest star. Noon here is roughly Earth twilight.',
  },
  {
    id: 'moon',
    name: 'The Moon',
    obliquity: 1.54,
    siderealDay: 655.7,
    solarDay: 708.7,
    yearDays: 365.256,
    semiMajorAxis: 1,
    // The Moon's own orbit is eccentric (0.0549), but that's around Earth.
    // Its distance from the SUN is Earth's, so sunlight here must read 1.00×.
    eccentricity: 0.0167,
    retrograde: false,
    gravity: 0.166,
    color: '#c9c5be',
    colorDark: '#2a2825',
    texture: '/textures/moon_1024.jpg',
    hook: 'Earth\'s sunlight, spread over a 29-day day. Two weeks of noon, then two weeks of night.',
    note: 'Same distance from the sun as Earth, so the same 1361 W/m² — but with no atmosphere the sky stays black and the shadows are absolute. The 1.5° tilt leaves polar crater floors in permanent shadow, never sunlit in billions of years.',
  },
]

export const PLANET_BY_ID = Object.fromEntries(
  PLANETS.map((p) => [p.id, p]),
) as Record<string, Planet>

export const EARTH = PLANET_BY_ID.earth

/* ------------------------------------------------------------------ */
/* Derived physics                                                     */
/* ------------------------------------------------------------------ */

/** Orbital distance in AU at solar longitude Ls, from the ellipse. */
export function distanceAtLs(planet: Planet, Ls: number): number {
  // Ls is measured from northern spring equinox; perihelion sits ~90° before
  // northern summer solstice for a generic world. Good enough for the visual,
  // and exact for the circular-orbit cases.
  const nu = (Ls - 90) * D2R
  const { semiMajorAxis: a, eccentricity: e } = planet
  return (a * (1 - e * e)) / (1 + e * Math.cos(nu))
}

/** Top-of-atmosphere solar irradiance, W/m², at a given point in the orbit. */
export function irradianceAt(planet: Planet, Ls = 90): number {
  const d = distanceAtLs(planet, Ls)
  return SOLAR_CONSTANT / (d * d)
}

/**
 * Irradiance at the planet's mean orbital distance.
 *
 * This is the number to quote when comparing worlds side by side. Sampling a
 * specific Ls lands on perihelion or aphelion and misleads badly for eccentric
 * orbits — Mercury reads 10.6× Earth at perihelion but 6.7× on average.
 */
export const meanIrradiance = (planet: Planet) =>
  SOLAR_CONSTANT / (planet.semiMajorAxis * planet.semiMajorAxis)

/** Apparent angular diameter of the sun, degrees. */
export function sunAngularSize(planet: Planet, Ls = 90): number {
  const d = distanceAtLs(planet, Ls) * AU_KM
  return 2 * Math.atan(SUN_RADIUS_KM / d) * R2D
}

/**
 * Effective tilt — how far the subsolar point can wander from the equator.
 * Venus is tilted 177°, but that describes a flipped planet with a 2.6° lean,
 * not a 177° season swing. min(ε, 180−ε) is the honest number.
 */
export const effectiveTilt = (planet: Planet) =>
  Math.min(planet.obliquity, 180 - planet.obliquity)

/**
 * Solar declination on any world.
 * Ls is the planet's solar longitude: 0° northern spring, 90° northern summer
 * solstice, 180° autumn, 270° winter. Using asin(sin ε · sin Ls) rather than
 * the linear ε·sin(Ls) approximation is what keeps Venus and Uranus honest.
 */
export function declinationFor(planet: Planet, Ls: number): number {
  return (
    Math.asin(
      clamp(Math.sin(planet.obliquity * D2R) * Math.sin(Ls * D2R), -1, 1),
    ) * R2D
  )
}

export interface AlienSky {
  planet: Planet
  /** latitude of the transplanted location */
  latitude: number
  /** solar longitude — the season, 0-360° */
  Ls: number
  /** local time as a fraction of that planet's solar day, 0-1 */
  dayFraction: number
  /** subsolar latitude right now */
  declination: number
  /** sun elevation above the local horizon, deg */
  altitude: number
  /** compass bearing of the sun, deg from north */
  azimuth: number
  /** hour angle, deg */
  hourAngle: number
  /** highest the sun gets today, deg */
  maxAltitude: number
  /** hours of daylight in that planet's own day (its hours, not Earth's) */
  daylightHours: number
  /** fraction of the solar day that is lit */
  daylightFraction: boolean | number
  /** sun never sets today */
  polarDay: boolean
  /** sun never rises today */
  polarNight: boolean
  /** W/m² hitting a surface facing the sun head-on */
  peakIrradiance: number
  /** W/m² actually landing on level ground right now */
  currentIrradiance: number
  /** relative to Earth noon at the equator */
  brightnessVsEarth: number
  /** apparent solar diameter, deg (Earth ≈ 0.533) */
  sunSize: number
  /** how much wider/narrower the sun looks than from Earth */
  sunSizeVsEarth: number
  /** shadow length as a multiple of height */
  shadowRatio: number
  /** length of the solar day in Earth hours */
  solarDayHours: number
}

/**
 * The whole point of the app: take a latitude, a season, and a time of day,
 * and work out what the sun is doing on some other world.
 */
export function alienSky(
  planet: Planet,
  latitude: number,
  Ls: number,
  dayFraction: number,
): AlienSky {
  const declination = declinationFor(planet, Ls)

  // dayFraction 0.5 is local noon; retrograde worlds run the sun the other way
  let hourAngle = (dayFraction - 0.5) * 360
  if (planet.retrograde) hourAngle = -hourAngle
  if (hourAngle > 180) hourAngle -= 360
  if (hourAngle < -180) hourAngle += 360

  const phi = latitude * D2R
  const dec = declination * D2R
  const H = hourAngle * D2R

  const sinAlt =
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  const altitude = Math.asin(clamp(sinAlt, -1, 1)) * R2D

  let azimuth =
    Math.atan2(
      -Math.sin(H),
      Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H),
    ) * R2D
  azimuth = ((azimuth % 360) + 360) % 360

  const maxAltitude = 90 - Math.abs(latitude - declination)

  // daylight length from the sunrise equation
  const cosH0 = -Math.tan(phi) * Math.tan(dec)
  let polarDay = false
  let polarNight = false
  let daylightFrac: number
  if (cosH0 <= -1) {
    polarDay = true
    daylightFrac = 1
  } else if (cosH0 >= 1) {
    polarNight = true
    daylightFrac = 0
  } else {
    daylightFrac = (Math.acos(cosH0) * R2D) / 180
  }

  const peakIrradiance = irradianceAt(planet, Ls)
  const sunSize = sunAngularSize(planet, Ls)

  return {
    planet,
    latitude,
    Ls,
    dayFraction,
    declination,
    altitude,
    azimuth,
    hourAngle,
    maxAltitude,
    daylightHours: daylightFrac * planet.solarDay,
    daylightFraction: daylightFrac,
    polarDay,
    polarNight,
    peakIrradiance,
    currentIrradiance: Math.max(0, sinAlt) * peakIrradiance,
    brightnessVsEarth: peakIrradiance / SOLAR_CONSTANT,
    sunSize,
    sunSizeVsEarth: sunSize / 0.533,
    shadowRatio: altitude > 0 ? 1 / Math.tan(altitude * D2R) : Infinity,
    solarDayHours: planet.solarDay,
  }
}

/**
 * Convert an Earth timestamp to a plausible Ls and time-of-day on another
 * world, so switching planets keeps the moment rather than resetting it.
 */
export function mapEarthMoment(
  planet: Planet,
  date: Date,
  lon: number,
): { Ls: number; dayFraction: number } {
  const epoch = Date.UTC(2000, 0, 1) // arbitrary but stable
  const elapsedDays = (date.getTime() - epoch) / 86400000

  const Ls = ((elapsedDays / planet.yearDays) * 360) % 360

  const hoursElapsed = elapsedDays * 24
  const local = hoursElapsed + (lon / 15) * (planet.solarDay / 24)
  const dayFraction = (local % planet.solarDay) / planet.solarDay

  return { Ls: (Ls + 360) % 360, dayFraction: (dayFraction + 1) % 1 }
}

/** Human-readable duration for wildly different day lengths. */
export function formatDuration(earthHours: number): string {
  if (!isFinite(earthHours)) return '—'
  if (earthHours < 1) return `${Math.round(earthHours * 60)} min`
  if (earthHours < 48) {
    const h = Math.floor(earthHours)
    const m = Math.round((earthHours - h) * 60)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const days = earthHours / 24
  if (days < 400) return `${days.toFixed(days < 10 ? 1 : 0)} Earth days`
  return `${(days / 365.25).toFixed(1)} Earth years`
}

/** Season name from solar longitude, northern hemisphere. */
export function seasonName(Ls: number): string {
  const n = ((Ls % 360) + 360) % 360
  if (n < 90) return 'Northern spring'
  if (n < 180) return 'Northern summer'
  if (n < 270) return 'Northern autumn'
  return 'Northern winter'
}
