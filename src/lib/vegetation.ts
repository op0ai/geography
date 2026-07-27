/**
 * vegetation.ts — the tree next door.
 *
 * The shading engine could see buildings and terrain and nothing else, which
 * meant it confidently told gardeners their bed got six hours of sun while a
 * sycamore stood over it. Vegetation is the single most common real-world
 * shade source at garden scale, and its absence was the biggest honest gap in
 * the product.
 *
 * ## Trees are not boxes
 *
 * The important thing this file gets right, and that a naive implementation
 * gets wrong, is that **trees are not opaque**. A building blocks the sun; a
 * tree filters it. And how much it filters depends on the season in a way
 * that completely changes the answer:
 *
 *   Deciduous, in leaf     0.01 – 0.05 of direct beam gets through
 *   Deciduous, bare        0.40 – 0.52  (bare branches still block half)
 *   Conifer, year-round    0.05 – 0.15
 *
 * — Konarska et al. 2014 (Göteborg, five species, measured); Takács et al.
 * 2016 (Szeged) found a median swing of 0.03 → 0.47 on a single horse
 * chestnut between summer and leafless. SOLWEIG, the standard urban radiation
 * model, defaults to 0.03 in leaf-on with a leaf season of day 97–300.
 *
 * So a garden shaded by an oak has a completely different February to its
 * July, and a binary "blocked / not blocked" test cannot express that. The
 * engine therefore treats canopy as *attenuating* rather than occluding: a ray
 * that passes only through leaves still delivers a fraction of a sun-hour.
 *
 * ## What OSM actually has
 *
 * 34.1 million `natural=tree` nodes worldwide — and only **3.3% carry a
 * height**, 2.1% a crown diameter. So for ~97% of trees the geometry here is
 * synthesised from defaults. `leaf_type` is the one genuinely useful tag, on
 * ~24%, and it's the one that matters most because it picks the seasonal
 * model.
 *
 * Coverage is also wildly uneven, and the app says so rather than pretending
 * otherwise: Germany has 4.07M mapped trees for 84M people; India has 111k for
 * 1.4 billion. Vegetation data is excellent in northern Europe and absent
 * across most of the world, so the count of trees found near a point is
 * reported as a confidence signal instead of being quietly folded into a
 * number.
 */

import type { LocalFrame } from './terrain'
import { project } from './terrain'

/* ------------------------------------------------------------------ */
/* the model                                                            */
/* ------------------------------------------------------------------ */

export type LeafType = 'broadleaved' | 'needleleaved' | 'unknown'

export interface Tree {
  /** metres east of the scene origin */
  x: number
  /** metres south of the scene origin */
  z: number
  /** total height, metres */
  height: number
  /** crown radius, metres */
  crown: number
  /** height of the crown's centre above ground */
  crownCentre: number
  leaf: LeafType
  /** true when height/crown were defaulted rather than tagged */
  estimated: boolean
}

export interface CanopyArea {
  /** polygon ring in local metres */
  poly: [number, number][]
  cx: number
  cz: number
  r: number
  height: number
  leaf: LeafType
}

export interface Vegetation {
  trees: Tree[]
  areas: CanopyArea[]
  /** how many trees carried a real height tag */
  tagged: number
  /** true when the lookup errored rather than genuinely finding nothing */
  failed: boolean
}

/* ------------------------------------------------------------------ */
/* transmissivity                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fraction of direct sunlight passing through a canopy.
 *
 * Figures from Konarska et al. 2014 and the SOLWEIG defaults. Chosen at the
 * conservative end of the measured ranges — claiming a tree blocks *more*
 * light than it does would overstate our confidence in geometry that is
 * usually guessed.
 */
const TRANSMISSIVITY = {
  /** in leaf: almost nothing gets through */
  broadleavedLeafOn: 0.05,
  /** bare branches still block roughly half */
  broadleavedLeafOff: 0.45,
  /** conifers barely change through the year */
  needleleaved: 0.1,
} as const

/**
 * Is this canopy in leaf on this date?
 *
 * SOLWEIG anchors the leaf season at day-of-year 97–300 for mid-northern
 * latitudes. That's the right shape but the wrong constant everywhere else, so
 * the window widens toward the equator and flips in the southern hemisphere.
 * Inside the tropics, treat canopy as evergreen — which is both roughly true
 * and the safer assumption, since it doesn't invent a bare-branch winter that
 * never happens.
 */
export function leafOn(date: Date, lat: number): boolean {
  const absLat = Math.abs(lat)
  if (absLat < 23.44) return true // tropics: no leaf-off season worth modelling

  const doy = dayOfYear(date)
  // Mid-latitudes get SOLWEIG's 97–300. The season shortens toward the poles
  // and lengthens toward the tropics, interpolated on latitude.
  const k = (absLat - 23.44) / (66.56 - 23.44) // 0 at the tropic, 1 at the circle
  const start = 75 + k * 40 // day 75 → 115
  const end = 320 - k * 40 // day 320 → 280

  if (lat >= 0) return doy >= start && doy <= end
  // Southern hemisphere: the same season, half a year out of phase.
  const shifted = (doy + 182.5) % 365
  return shifted >= start && shifted <= end
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  return Math.floor((d.getTime() - start) / 86400000)
}

/** Transmissivity for a given leaf type at a given moment. */
export function transmissivity(leaf: LeafType, date: Date, lat: number): number {
  if (leaf === 'needleleaved') return TRANSMISSIVITY.needleleaved
  // Unknown is treated as broadleaved: it's the global majority in the
  // temperate zones where OSM tree data actually exists, and it's the
  // assumption that produces a *seasonal* answer rather than a flat one.
  return leafOn(date, lat)
    ? TRANSMISSIVITY.broadleavedLeafOn
    : TRANSMISSIVITY.broadleavedLeafOff
}

/* ------------------------------------------------------------------ */
/* defaults — used for ~97% of trees                                    */
/* ------------------------------------------------------------------ */

/**
 * Height and crown when OSM doesn't say.
 *
 * OSM2World — the reference renderer, and what F4map is built on — uses 10m
 * for a standalone tree, 20m inside a forest, and a crown radius of 0.2 ×
 * height. That last ratio is too narrow for street and garden trees: an
 * open-grown broadleaf spreads far wider than a forest specimen competing for
 * light, and published urban-tree allometry puts crown diameter at roughly
 * 0.5–0.7 × height. Conifers genuinely are narrow, so they keep a low ratio.
 *
 * Crown diameter also scales with height as a power law (exponent ≈ 0.6),
 * not linearly, but at the 5–20m range that matters here the linear ratio is
 * within the noise of guessing the height in the first place.
 */
const DEFAULTS = {
  broadleaved: { height: 8, crownRatio: 0.375 }, // Ø ≈ 0.75 × h
  needleleaved: { height: 10, crownRatio: 0.2 }, // Ø ≈ 0.4 × h
  forest: { height: 15 },
} as const

/**
 * Where the crown sits on the trunk. Broadleaves carry their canopy over the
 * top half; conifers over the top ~70%, which is why they shade so much more
 * of a low winter sun.
 */
const CROWN_SPAN = { broadleaved: 0.5, needleleaved: 0.7 } as const

function leafTypeOf(tags: Record<string, string>): LeafType {
  const t = tags.leaf_type ?? tags['leaf_type:winter']
  if (t === 'broadleaved') return 'broadleaved'
  if (t === 'needleleaved') return 'needleleaved'

  // leaf_cycle is a decent proxy where leaf_type is missing.
  const c = tags.leaf_cycle
  if (c === 'deciduous') return 'broadleaved'
  if (c === 'evergreen') return 'needleleaved'

  // A few very common genera, since `genus` is tagged more often than
  // `leaf_type` on street trees in some cities.
  const g = (tags.genus ?? tags.species ?? '').toLowerCase()
  if (/pinus|picea|abies|larix|cedrus|thuja|juniperus|taxus/.test(g)) {
    return 'needleleaved'
  }
  if (/quercus|acer|tilia|platanus|fraxinus|betula|fagus|populus|salix|ulmus/.test(g)) {
    return 'broadleaved'
  }
  return 'unknown'
}

function treeFrom(
  tags: Record<string, string>,
  x: number,
  z: number,
): Tree {
  const leaf = leafTypeOf(tags)
  const kind = leaf === 'needleleaved' ? 'needleleaved' : 'broadleaved'
  const d = DEFAULTS[kind]

  const taggedHeight = parseFloat(tags.height)
  const height = isFinite(taggedHeight) && taggedHeight > 0 ? taggedHeight : d.height

  const taggedCrown = parseFloat(tags.diameter_crown)
  const crown =
    isFinite(taggedCrown) && taggedCrown > 0
      ? taggedCrown / 2
      : height * d.crownRatio

  const span = CROWN_SPAN[kind]
  // Centre of the crown ellipsoid: the canopy occupies the top `span` of the
  // tree, so its midpoint sits half a span below the crown.
  const crownCentre = height * (1 - span / 2)

  return {
    x,
    z,
    height,
    crown,
    crownCentre,
    leaf,
    estimated: !(isFinite(taggedHeight) && taggedHeight > 0),
  }
}

/* ------------------------------------------------------------------ */
/* parsing Overpass                                                     */
/* ------------------------------------------------------------------ */

/** Spacing along a tree row, metres. Street planting is typically 6–10m. */
const ROW_SPACING = 7

export function parseVegetation(
  json: { elements?: OverpassElement[] },
  frame: LocalFrame,
): Vegetation {
  const trees: Tree[] = []
  const areas: CanopyArea[] = []
  let tagged = 0

  for (const el of json.elements ?? []) {
    const tags = (el.tags ?? {}) as Record<string, string>

    // ---- individual trees ----
    if (el.type === 'node' && tags.natural === 'tree') {
      if (el.lat === undefined || el.lon === undefined) continue
      const [x, z] = project(frame, el.lat, el.lon)
      const t = treeFrom(tags, x, z)
      if (!t.estimated) tagged++
      trees.push(t)
      continue
    }

    const geom = el.geometry
    if (!geom || geom.length < 2) continue

    // ---- tree rows: sample along the line ----
    if (tags.natural === 'tree_row') {
      const pts = geom.map((g) => project(frame, g.lat, g.lon))
      let carry = 0
      for (let i = 1; i < pts.length; i++) {
        const [x0, z0] = pts[i - 1]
        const [x1, z1] = pts[i]
        const seg = Math.hypot(x1 - x0, z1 - z0)
        for (let d = carry; d < seg; d += ROW_SPACING) {
          const f = d / seg
          trees.push(treeFrom(tags, x0 + (x1 - x0) * f, z0 + (z1 - z0) * f))
        }
        carry = (carry - seg) % ROW_SPACING
        if (carry < 0) carry += ROW_SPACING
      }
      continue
    }

    // ---- woods and forests: a filled canopy, not individual trees ----
    const isWood =
      tags.natural === 'wood' ||
      tags.landuse === 'forest' ||
      tags.landcover === 'trees'
    if (isWood && geom.length >= 3) {
      const poly: [number, number][] = []
      let sx = 0
      let sz = 0
      for (const g of geom) {
        const [x, z] = project(frame, g.lat, g.lon)
        poly.push([x, z])
        sx += x
        sz += z
      }
      const cx = sx / poly.length
      const cz = sz / poly.length
      let r = 0
      for (const [x, z] of poly) r = Math.max(r, Math.hypot(x - cx, z - cz))

      const h = parseFloat(tags.height)
      areas.push({
        poly,
        cx,
        cz,
        r,
        height: isFinite(h) && h > 0 ? h : DEFAULTS.forest.height,
        leaf: leafTypeOf(tags),
      })
    }
  }

  return { trees, areas, tagged, failed: false }
}

interface OverpassElement {
  type: string
  lat?: number
  lon?: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
}

/* ------------------------------------------------------------------ */
/* fetching                                                             */
/* ------------------------------------------------------------------ */

const PROXY = '/api/vegetation'
const cache = new Map<string, Vegetation>()

/**
 * Fetch vegetation around a point.
 *
 * Goes through the same edge proxy as buildings, for the same reason —
 * Overpass allows two concurrent queries per IP and every Worker request
 * shares one. See `worker/index.ts`.
 */
export async function fetchVegetation(
  lat: number,
  lon: number,
  frame: LocalFrame,
  radiusMetres = 700,
  signal?: AbortSignal,
): Promise<Vegetation> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${radiusMetres}`
  const hit = cache.get(key)
  if (hit) return hit

  const empty: Vegetation = { trees: [], areas: [], tagged: 0, failed: true }

  try {
    const url =
      `${PROXY}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&r=${Math.round(radiusMetres)}`
    const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(30_000) })
    if (!res.ok) return empty
    if (!res.headers.get('content-type')?.includes('json')) return empty

    const json = await res.json()
    if (!Array.isArray(json?.elements)) return empty

    const out = parseVegetation(json, frame)
    cache.set(key, out)
    return out
  } catch {
    return empty
  }
}

/* ------------------------------------------------------------------ */
/* occlusion                                                            */
/* ------------------------------------------------------------------ */

/**
 * How much light survives the canopy along this ray?
 *
 * Returns a multiplier in 0..1 — 1 means nothing in the way, 0.05 means a
 * leafy broadleaf crown stands between you and the sun. Multiple crowns
 * compound, because light passing through two trees really is dimmer than
 * through one.
 *
 * Crowns are ellipsoids: a sphere of the crown radius, squashed vertically to
 * the canopy's span. The ray-ellipsoid test is the standard quadratic, done in
 * a space where the ellipsoid is a unit sphere — scale the ray, solve, done.
 */
export function canopyTransmission(
  veg: Vegetation,
  origin: { x: number; y: number; z: number },
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  date: Date,
  lat: number,
): number {
  let through = 1

  for (const t of veg.trees) {
    // Cheap reject: is the ray anywhere near this crown, and is the crown
    // ahead of us rather than behind?
    const ox = t.x - origin.x
    const oz = t.z - origin.z
    const along = ox * dx + oz * dz
    if (along < -t.crown || along > maxDistance + t.crown) continue
    if (Math.hypot(ox - along * dx, oz - along * dz) > t.crown) continue

    // Vertical semi-axis: the crown spans the top fraction of the tree.
    const span = t.leaf === 'needleleaved' ? CROWN_SPAN.needleleaved : CROWN_SPAN.broadleaved
    const b = Math.max(1, (t.height * span) / 2)

    if (
      raySphereish(
        origin.x - t.x,
        origin.y - t.crownCentre,
        origin.z - t.z,
        dx,
        dy,
        dz,
        t.crown,
        b,
        maxDistance,
      )
    ) {
      through *= transmissivity(t.leaf, date, lat)
      // Below this, the canopy is effectively opaque and further multiplication
      // is meaningless precision on top of guessed geometry.
      if (through < 0.005) return 0
    }
  }

  // Woods: treated as a solid slab of canopy rather than individual crowns.
  for (const a of veg.areas) {
    const ox = a.cx - origin.x
    const oz = a.cz - origin.z
    const along = ox * dx + oz * dz
    if (along < -a.r || along > maxDistance + a.r) continue
    if (Math.hypot(ox - along * dx, oz - along * dz) > a.r) continue

    if (rayCrossesSlab(origin, dx, dy, dz, a, maxDistance)) {
      through *= transmissivity(a.leaf, date, lat)
      if (through < 0.005) return 0
    }
  }

  return through
}

/**
 * Does the ray hit an ellipsoid with horizontal radius `a` and vertical
 * semi-axis `b`, centred at the origin of the passed-in relative coordinates?
 *
 * Scaling y by a/b turns the ellipsoid into a sphere of radius a, which makes
 * this the ordinary quadratic. The direction has to be rescaled and
 * renormalised to match, and the distance limit rescaled with it.
 */
function raySphereish(
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
  a: number,
  b: number,
  maxDistance: number,
): boolean {
  const k = a / b
  const sy = py * k
  const sdy = dy * k
  const len = Math.hypot(dx, sdy, dz)
  if (len < 1e-9) return false
  const nx = dx / len
  const ny = sdy / len
  const nz = dz / len

  const bq = px * nx + sy * ny + pz * nz
  const c = px * px + sy * sy + pz * pz - a * a
  const disc = bq * bq - c
  if (disc < 0) return false

  const root = Math.sqrt(disc)
  const t0 = -bq - root
  const t1 = -bq + root
  const limit = maxDistance * len
  // Any part of the intersection interval in front of us and within range.
  return t1 > 0 && t0 < limit
}

/** Does the ray pass through a wood's canopy slab? */
function rayCrossesSlab(
  origin: { x: number; y: number; z: number },
  dx: number,
  dy: number,
  dz: number,
  area: CanopyArea,
  maxDistance: number,
): boolean {
  // Canopy occupies the top half of the stand's height.
  const top = area.height
  const base = area.height * 0.5

  // Sample where the ray is inside the vertical band, then test the polygon.
  // Cheap and adequate: stands are tens of metres across, far wider than the
  // step.
  const step = Math.max(4, area.r / 12)
  for (let d = 0; d < maxDistance; d += step) {
    const y = origin.y + dy * d
    if (y < base || y > top) continue
    const x = origin.x + dx * d
    const z = origin.z + dz * d
    if (Math.hypot(x - area.cx, z - area.cz) > area.r) continue
    if (pointInPoly(area.poly, x, z)) return true
  }
  return false
}

function pointInPoly(poly: [number, number][], x: number, z: number): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
  }
  return hit
}

/**
 * How much to trust the vegetation layer here.
 *
 * OSM tree coverage is a northern-European luxury — Germany has 4.07M mapped
 * trees for 84M people, India 111k for 1.4 billion. Reporting the count lets
 * the UI say "12 trees mapped nearby" or "no trees mapped here, so vegetation
 * isn't modelled" instead of silently producing a confident number in a place
 * where the data doesn't exist.
 */
export function vegetationConfidence(veg: Vegetation): {
  level: 'none' | 'sparse' | 'good'
  trees: number
  areas: number
  taggedFraction: number
} {
  const n = veg.trees.length
  return {
    level: n === 0 && veg.areas.length === 0 ? 'none' : n < 8 ? 'sparse' : 'good',
    trees: n,
    areas: veg.areas.length,
    taggedFraction: n > 0 ? veg.tagged / n : 0,
  }
}
