/**
 * sunhours.ts — how much direct sun does *this exact spot* actually get?
 *
 * Every other number in this app is astronomy: where the sun is, when it rises,
 * how high it climbs. Those are the same for everyone within a few kilometres.
 * This file answers the question people actually have, which is local rather
 * than astronomical — the sun is up, but is it up *for me*, or is the building
 * across the street in the way?
 *
 * The method is deliberately plain:
 *
 *   1. Walk the day in fixed steps.
 *   2. At each step, compute the sun's altitude and azimuth (solar.ts already
 *      does this, and it's verified against published values).
 *   3. If the sun is below the horizon, it's dark — no further work.
 *   4. Otherwise cast a ray from the observer toward the sun and see whether
 *      anything — terrain or a building — gets in the way before it escapes
 *      the scene.
 *
 * The interesting part is step 4, and the interesting choice is *not* using a
 * three.js Raycaster against the rendered meshes. Two reasons. It would tie the
 * answer to whatever the renderer happened to have loaded, which is a bad
 * property for a number people might plan a garden around. And it would only
 * work while the 3D scene is mounted, when the useful version of this is a
 * calculation you can run for a whole year in the background.
 *
 * So this raymarches the height field and tests building prisms analytically.
 * Both are pure functions of data we already have. No WebGL, no DOM, runs in a
 * Worker or in Node, and the tests can check it against hand-computable cases.
 *
 * ## What this models, and what it doesn't
 *
 * Models: terrain within the loaded tile mosaic, OSM building footprints
 * extruded to their tagged (or estimated) heights, the sun's true position
 * including refraction at the horizon.
 *
 * Does NOT model: trees — OSM building data has no vegetation, and a tree next
 * door is the single most common real-world shade source in a garden. Nor
 * anything outside the scene radius, nor overhangs, nor the sun's angular
 * diameter (treated as a point, so shadow edges are hard rather than penumbral).
 *
 * These limits are stated in the UI rather than buried here. A number that
 * looks authoritative and isn't is worse than no number.
 */

import { solarPosition, refraction } from './solar'
import {
  project,
  sampleHeightLocal,
  type HeightField,
  type LocalFrame,
} from './terrain'
import type { Building } from './buildings'

const DEG = Math.PI / 180

/**
 * The sun's disc is about half a degree across, so "sunrise" is conventionally
 * when the *upper limb* clears the horizon — the centre is still 0.833° below.
 * The rest of the app uses this threshold; using a different one here would
 * make the two disagree at the edges of the day.
 */
const HORIZON = -0.833

export interface SunHourStep {
  /** minutes since local midnight (in the observer's UTC-offset clock) */
  minute: number
  /** true when the sun is above the horizon at all */
  up: boolean
  /** true when the sun is up AND nothing blocks the line of sight */
  sunlit: boolean
  altitude: number
  azimuth: number
  /** what interrupted the ray, when something did */
  blockedBy: 'terrain' | 'building' | null
}

export interface SunHourResult {
  /** hours of unobstructed direct sun */
  directHours: number
  /** hours the sun is above the horizon, obstructed or not */
  daylightHours: number
  /** directHours / daylightHours, 0..1 — how much of the available sun you get */
  exposure: number
  /** first moment of direct sun, minutes since midnight, or null */
  firstLight: number | null
  /** last moment of direct sun */
  lastLight: number | null
  /** every sampled step, for the chart */
  steps: SunHourStep[]
  /** contiguous sunlit windows, merged */
  windows: { start: number; end: number }[]
  /** sampling interval actually used, minutes */
  stepMinutes: number
  /** true when buildings were part of the calculation */
  hadBuildings: boolean
}

/* ------------------------------------------------------------------ */
/* the occlusion test                                                   */
/* ------------------------------------------------------------------ */

/**
 * A building reduced to the form the ray test needs: a prism with a polygon
 * base in local metres and a top/bottom height. Precomputed once per scene
 * rather than per ray, because the ray test runs ~200 times a day and ~73,000
 * times for a year.
 */
interface Prism {
  /** footprint in local metres, [x, z] pairs */
  poly: [number, number][]
  /** bounding circle, for the cheap early-out */
  cx: number
  cz: number
  r: number
  /** absolute heights in metres, same datum as the height field */
  base: number
  top: number
}

export function buildPrisms(
  buildings: Building[],
  frame: LocalFrame,
  hf: HeightField,
  originHeight: number,
): Prism[] {
  const out: Prism[] = []
  for (const b of buildings) {
    if (b.outer.length < 3) continue
    const poly: [number, number][] = []
    let sx = 0
    let sz = 0
    for (const p of b.outer) {
      // project() returns [east, south] metres — a tuple, not {x,z}.
      const [x, z] = project(frame, p.lat, p.lon)
      poly.push([x, z])
      sx += x
      sz += z
    }
    const cx = sx / poly.length
    const cz = sz / poly.length
    let r = 0
    for (const [x, z] of poly) r = Math.max(r, Math.hypot(x - cx, z - cz))

    // Buildings sit on the terrain, so their absolute height is the ground
    // under them plus the tagged height — not height above the observer.
    const ground = sampleHeightLocal(hf, frame, cx, cz) - originHeight
    out.push({
      poly,
      cx,
      cz,
      r,
      base: ground + b.minHeight,
      top: ground + b.height,
    })
  }
  return out
}

/** Standard ray-crossing point-in-polygon. */
function inside(poly: [number, number][], x: number, z: number): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
  }
  return hit
}

export interface OcclusionScene {
  frame: LocalFrame
  hf: HeightField
  prisms: Prism[]
  /** ground elevation at the observer, metres — the datum for all heights */
  originHeight: number
  /** how far to march before giving up, metres */
  radius: number
  /** observer's eye height above local ground, metres */
  eyeHeight: number
}

/**
 * Is the sun visible from the observer at this altitude and azimuth?
 *
 * Marches outward along the ground track of the sun's bearing, comparing the
 * ray's height against the terrain and any building it passes through. Step
 * size grows with distance: near the observer a metre matters (the wall next
 * to you), at 500m it doesn't, and a uniform fine step would be ~700 samples
 * per ray for no gain.
 */
export function sunVisible(
  scene: OcclusionScene,
  altitudeDeg: number,
  azimuthDeg: number,
): 'terrain' | 'building' | null {
  if (altitudeDeg <= HORIZON) return 'terrain'

  // Refraction, and why the ray is never allowed to point downward.
  //
  // The −0.833° sunrise convention bundles two effects: the atmosphere bends
  // light over the horizon (0.567°) and the sun is a disc whose upper limb
  // clears first (0.267°). So between −0.833° and 0° the sun is *geometrically*
  // below the horizon but its light still reaches you, arriving essentially
  // horizontally.
  //
  // Marching a downward-sloping ray in that window made a flat, featureless
  // plain report itself as shaded — the ray dipped below the ground plane a
  // couple of hundred metres out and "hit terrain". Clamping at zero models
  // what actually happens: grazing light skimming in along the surface.
  const apparent = Math.max(0, altitudeDeg + refraction(altitudeDeg))
  const alt = apparent * DEG
  const az = azimuthDeg * DEG
  // Azimuth is a compass bearing: 0 = north = -Z, 90 = east = +X.
  const dx = Math.sin(az)
  const dz = -Math.cos(az)
  const slope = Math.tan(alt)
  const eye = scene.eyeHeight

  // ---- buildings: solved, not sampled ----------------------------------
  //
  // These were originally tested by checking point-in-polygon at each march
  // step, which silently missed thin obstacles: a 4m-deep wall sitting between
  // two 2m samples is invisible to the march. That's not an edge case — walls,
  // fences and narrow terraces are exactly the things that shade a garden.
  //
  // Instead, intersect the ray's ground track with each footprint analytically
  // and get the exact distance interval spent inside it. Because the ray's
  // height is monotonic in distance, the heights at the interval's ends bound
  // every height within it, so a single overlap test against the prism's
  // vertical extent is exact. It's also faster: no inner loop over steps.
  for (const p of scene.prisms) {
    // Cheap reject: does the ray pass anywhere near this footprint's circle?
    // Distance from the circle's centre to the (infinite) ray line.
    const proj = p.cx * dx + p.cz * dz
    if (proj < -p.r) continue // entirely behind the observer
    const perp = Math.abs(p.cx * dz - p.cz * dx)
    if (perp > p.r) continue

    for (const [enter, exitD] of polyIntervals(p.poly, dx, dz)) {
      if (exitD <= 0) continue
      const d0 = Math.max(enter, 0)
      const h0 = eye + slope * d0
      const h1 = eye + slope * exitD
      const lo = Math.min(h0, h1)
      const hi = Math.max(h0, h1)
      // Overlapping vertical extents means the ray passes through the solid.
      if (hi >= p.base && lo <= p.top) return 'building'
    }
  }

  // ---- terrain: marched, because a height field has no closed form ------
  //
  // Step size grows with distance. Near the observer a metre matters; at 500m
  // the terrain sample spacing is coarser than the step anyway.
  let d = 1.5
  while (d < scene.radius) {
    const ground =
      sampleHeightLocal(scene.hf, scene.frame, dx * d, dz * d) - scene.originHeight
    if (ground > eye + slope * d) return 'terrain'
    d += d < 60 ? 2 : d < 200 ? 5 : 12
  }

  return null
}

/**
 * Distance intervals where a ray from the origin along (dx, dz) lies inside a
 * polygon. Standard even-odd scanline, in ray-parameter space instead of x.
 *
 * Returns pairs sorted by distance. An observer standing *inside* a footprint
 * (on a rooftop terrace, say) yields an odd number of crossings; the leading
 * partial interval is handled by prepending zero.
 */
function polyIntervals(
  poly: [number, number][],
  dx: number,
  dz: number,
): [number, number][] {
  const hits: number[] = []
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, z1] = poly[j]
    const [x2, z2] = poly[i]
    const ex = x2 - x1
    const ez = z2 - z1
    // Solve  origin + t·d  =  p1 + u·e  for t, with 0 ≤ u ≤ 1.
    const denom = dx * ez - dz * ex
    if (Math.abs(denom) < 1e-12) continue // parallel
    // Solving  t·(dx,dz) = p1 + u·e  by eliminating t:
    //   0 = dz·x1 − dx·z1 + u·(dz·ex − dx·ez)
    //   u = (dz·x1 − dx·z1) / (dx·ez − dz·ex)
    const u = (dz * x1 - dx * z1) / denom
    if (u < 0 || u >= 1) continue // outside this edge's span
    const t = Math.abs(dx) > Math.abs(dz) ? (x1 + u * ex) / dx : (z1 + u * ez) / dz
    if (t > 0) hits.push(t)
  }
  if (hits.length === 0) return []
  hits.sort((a, b) => a - b)
  // Odd count means the origin is inside the footprint.
  if (hits.length % 2 === 1) hits.unshift(0)
  const out: [number, number][] = []
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]])
  return out
}

/* ------------------------------------------------------------------ */
/* the day                                                              */
/* ------------------------------------------------------------------ */

/**
 * Sun hours for a single day.
 *
 * `stepMinutes` trades resolution for time. At 10 minutes a day is 144 rays,
 * which runs in a few milliseconds and is well inside the noise of the input
 * data — OSM heights are guessed to the nearest storey, so claiming
 * minute-level precision would be false confidence.
 */
export function sunHoursForDay(
  scene: OcclusionScene,
  lat: number,
  lon: number,
  day: Date,
  stepMinutes = 10,
): SunHourResult {
  const steps: SunHourStep[] = []
  // Work in the local solar day rather than UTC, so "the day" is the one the
  // observer experiences. Longitude gives the offset directly, which avoids a
  // timezone database for a number that doesn't need political boundaries.
  const offsetMs = (lon / 15) * 3600_000
  const localMidnight = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
  ).getTime() - offsetMs

  let direct = 0
  let daylight = 0
  let first: number | null = null
  let last: number | null = null

  for (let m = 0; m < 1440; m += stepMinutes) {
    const t = new Date(localMidnight + m * 60_000)
    const { altitude, azimuth } = solarPosition(t, lat, lon)
    const up = altitude > HORIZON
    let blockedBy: SunHourStep['blockedBy'] = null
    let sunlit = false

    if (up) {
      daylight += stepMinutes
      blockedBy = sunVisible(scene, altitude, azimuth)
      sunlit = blockedBy === null
      if (sunlit) {
        direct += stepMinutes
        if (first === null) first = m
        last = m + stepMinutes
      }
    }

    steps.push({ minute: m, up, sunlit, altitude, azimuth, blockedBy })
  }

  // Merge contiguous sunlit steps into windows — "9:40 to 13:10 and 15:20 to
  // 17:00" is far more useful than "5.3 hours", because it tells you *when*.
  const windows: { start: number; end: number }[] = []
  for (const s of steps) {
    if (!s.sunlit) continue
    const lastW = windows[windows.length - 1]
    if (lastW && s.minute === lastW.end) lastW.end = s.minute + stepMinutes
    else windows.push({ start: s.minute, end: s.minute + stepMinutes })
  }

  return {
    directHours: direct / 60,
    daylightHours: daylight / 60,
    exposure: daylight > 0 ? direct / daylight : 0,
    firstLight: first,
    lastLight: last,
    steps,
    windows,
    stepMinutes,
    hadBuildings: scene.prisms.length > 0,
  }
}

/**
 * Sun hours across a whole year, sampled every `everyNDays`.
 *
 * A single day answers "is my balcony sunny today". The year answers the
 * question people actually plan around — whether it's sunny *in February*,
 * when the sun is low and the building opposite is in the way. That's the one
 * you can't work out by standing outside, because you'd have to stand there
 * for a year.
 *
 * Sampling every 5 days at 20-minute resolution is 73 × 72 = ~5,300 rays,
 * which stays interactive. The sun's declination moves slowly enough that
 * 5-day sampling captures the shape.
 */
export function sunHoursForYear(
  scene: OcclusionScene,
  lat: number,
  lon: number,
  year: number,
  everyNDays = 5,
  stepMinutes = 20,
): { date: Date; directHours: number; daylightHours: number }[] {
  const out: { date: Date; directHours: number; daylightHours: number }[] = []
  for (let doy = 0; doy < 365; doy += everyNDays) {
    const date = new Date(Date.UTC(year, 0, 1 + doy))
    const r = sunHoursForDay(scene, lat, lon, date, stepMinutes)
    out.push({ date, directHours: r.directHours, daylightHours: r.daylightHours })
  }
  return out
}

/**
 * The horizon profile: how high the skyline stands in every direction.
 *
 * This is what a fisheye photo of the sky would show, reduced to one number
 * per bearing. It's computed once and is independent of date, which makes it
 * the cheap way to sanity-check a result — if the south horizon is 40° up,
 * a winter afternoon is obviously going to be shaded, and you can see why.
 */
export function horizonProfile(
  scene: OcclusionScene,
  stepDeg = 3,
): { azimuth: number; altitude: number }[] {
  const out: { azimuth: number; altitude: number }[] = []
  for (let az = 0; az < 360; az += stepDeg) {
    // Binary search for the lowest unobstructed altitude at this bearing.
    let lo = 0
    let hi = 60
    if (sunVisible(scene, hi, az) !== null) {
      out.push({ azimuth: az, altitude: hi })
      continue
    }
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2
      if (sunVisible(scene, mid, az) === null) hi = mid
      else lo = mid
    }
    out.push({ azimuth: az, altitude: hi })
  }
  return out
}

/** Minutes since midnight → "14:20". */
export function clockOf(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = Math.round(minutes % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "5.3 hours" → "5h 20m", which people read faster. */
export function formatHours(h: number): string {
  if (h <= 0) return 'none'
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  if (hh === 0) return `${mm}m`
  if (mm === 0) return `${hh}h`
  return `${hh}h ${mm}m`
}
