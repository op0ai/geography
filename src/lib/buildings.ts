/**
 * buildings.ts — real building footprints from OpenStreetMap.
 *
 * Source: the Overpass API. Verified from a browser on this origin (2026-07-26)
 * as CORS-open and returning inline geometry. It's the only building source I
 * could confirm as both keyless and browser-fetchable — Mapbox, MapTiler and
 * Protomaps' hosted API all require tokens, and Overture/Microsoft ship
 * parquet and CSV meant for bulk processing rather than live queries.
 *
 * Data is ODbL: © OpenStreetMap contributors.
 *
 * A note on scale: Overpass's public instances explicitly ask not to be used
 * as a production backend for general-audience apps. This app makes one small
 * bbox query per location on demand and caches it, which is well inside fair
 * use — but if this ever got real traffic the honest move is to self-host.
 */

export interface Building {
  id: number
  /** outer ring, lat/lon */
  outer: { lat: number; lon: number }[]
  /** holes — courtyards and the like */
  inner: { lat: number; lon: number }[][]
  /** roof height above ground, metres */
  height: number
  /** base height, for buildings that start above ground (bridges, parts) */
  minHeight: number
  /** what kind of building, from the OSM tag */
  kind: string
  name?: string
  /** true when the height was guessed rather than tagged */
  estimated: boolean
}

/** Metres per storey — the standard OSM rendering assumption. */
const METRES_PER_LEVEL = 3

/** Used when a building has neither height nor levels: 3 levels. */
const DEFAULT_HEIGHT = 9

/**
 * Parse an OSM height value to metres.
 * Usually a plain number, but the wild data contains "12 m", "40'", and
 * occasionally feet-and-inches like 7'4".
 */
function parseHeight(v: string | undefined): number | null {
  if (!v) return null
  const s = v.trim()

  const ftIn = s.match(/^(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)?"?$/)
  if (ftIn) {
    const ft = parseFloat(ftIn[1])
    const inch = ftIn[2] ? parseFloat(ftIn[2]) : 0
    return ft * 0.3048 + inch * 0.0254
  }

  const n = parseFloat(s)
  if (!isFinite(n)) return null
  if (/ft|feet|'/.test(s)) return n * 0.3048
  return n
}

function heightFor(tags: Record<string, string>): {
  height: number
  estimated: boolean
} {
  const explicit = parseHeight(tags.height)
  if (explicit !== null && explicit > 0) return { height: explicit, estimated: false }

  const levels = parseFloat(tags['building:levels'])
  if (isFinite(levels) && levels > 0) {
    return { height: levels * METRES_PER_LEVEL, estimated: true }
  }

  return { height: DEFAULT_HEIGHT, estimated: true }
}

function baseFor(tags: Record<string, string>): number {
  const explicit = parseHeight(tags.min_height)
  if (explicit !== null) return explicit
  const lvl = parseFloat(tags['building:min_level'])
  if (isFinite(lvl)) return lvl * METRES_PER_LEVEL
  return 0
}

/* ------------------------------------------------------------------ */

/**
 * Mirrors, tried in order. overpass-api.de is the reference instance and the
 * one verified working from the browser; private.coffee explicitly permits
 * production use and is the first fallback.
 */
/**
 * Direct Overpass mirrors, used only as a fallback.
 *
 * The primary path is `/api/buildings`, our own edge proxy — Cloudflare caches
 * the response and collapses concurrent requests for the same area into one
 * upstream query. That matters because Overpass rate-limits per client IP, so
 * without the proxy a traffic spike means every visitor gets throttled and the
 * shading feature silently degrades to "no buildings here".
 *
 * These stay as a fallback for local development, where there's no Worker in
 * front, and for the case where our own edge is having a bad day.
 */
const PROXY = '/api/buildings'

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const cache = new Map<string, Building[]>()

/**
 * Whether the last fetch actually reached a mirror.
 * "OSM has nothing mapped here" and "every mirror timed out" both produce an
 * empty array, but they mean very different things to a user — one is a fact
 * about the world, the other is a fact about our network. Don't conflate them.
 */
export let lastFetchFailed = false

/**
 * Fetch buildings in a bounding box.
 *
 * Asks for ways and relations so multipolygon buildings (the ones with
 * courtyards) come back whole. `out geom` inlines the coordinates, which
 * avoids a second round-trip to resolve node references.
 */
export async function fetchBuildings(
  lat: number,
  lon: number,
  radiusMetres = 500,
  signal?: AbortSignal,
): Promise<Building[]> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${radiusMetres}`
  const hit = cache.get(key)
  if (hit) return hit
  lastFetchFailed = false

  // bbox from a metre radius
  const dLat = radiusMetres / 111320
  const dLon = radiusMetres / (111320 * Math.cos((lat * Math.PI) / 180))
  const s = (lat - dLat).toFixed(6)
  const w = (lon - dLon).toFixed(6)
  const n = (lat + dLat).toFixed(6)
  const e = (lon + dLon).toFixed(6)

  const query = `[out:json][timeout:30];(way["building"](${s},${w},${n},${e});relation["building"](${s},${w},${n},${e}););out geom;`

  // Overpass mirrors can hang for a minute or more under load without ever
  // returning — observed live at 40s+ on overpass-api.de. A bare fetch has no
  // timeout, so the scene would sit on "Loading…" indefinitely. Race each
  // mirror against a deadline and move on.
  const PER_MIRROR_MS = 12_000

  // Try our edge proxy first: cached, deduplicated, and far faster than a
  // cold Overpass query. Skipped when running against a dev server with no
  // Worker in front of it, which returns the SPA's index.html for /api/*.
  try {
    const proxyUrl =
      `${PROXY}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&r=${Math.round(radiusMetres)}`
    const res = await fetch(proxyUrl, {
      signal: signal ?? AbortSignal.timeout(22_000),
    })
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      const json = await res.json()
      if (Array.isArray(json?.elements)) {
        const out = parseOverpass(json)
        cache.set(key, out)
        lastFetchFailed = false
        return out
      }
    }
  } catch {
    // Fall through to the direct mirrors.
  }

  for (const endpoint of ENDPOINTS) {
    if (signal?.aborted) return []
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), PER_MIRROR_MS)
    // Cancel our attempt if the caller gives up first.
    const onAbort = () => timer.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        // Required — without it Overpass returns 504 on a body it can't parse.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: timer.signal,
      })
      if (!res.ok) continue
      const json = await res.json()
      const out = parseOverpass(json)
      cache.set(key, out)
      lastFetchFailed = false
      return out
    } catch {
      if (signal?.aborted) return []
      // timed out or failed — try the next mirror
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // Every mirror failed. Don't cache this — a timeout is transient, and
  // caching it would permanently blank the buildings for this location.
  lastFetchFailed = true
  return []
}

/** The longest building on Earth is ~1.2 km; in a 1.4 km scene, 300 m is plenty. */
const MAX_SPAN_M = 300

function parseOverpass(json: any): Building[] {
  const out: Building[] = []
  const emit = (b: Building) => {
    // Final gate. Anything that fails here is bad geometry, not a building —
    // rendering it produces a spike or a wall that reads as real data.
    if (ringSpan(b.outer) > MAX_SPAN_M) return
    if (!(b.height > 0) || b.height > 300) return
    out.push(b)
  }

  for (const el of json.elements ?? []) {
    const tags: Record<string, string> = el.tags ?? {}
    if (!tags.building) continue

    const { height, estimated } = heightFor(tags)
    const minHeight = baseFor(tags)

    if (el.type === 'way' && Array.isArray(el.geometry)) {
      const ring = el.geometry.filter((p: any) => p && isFinite(p.lat))
      if (ring.length < 3) continue
      emit({
        id: el.id,
        outer: ring,
        inner: [],
        height,
        minHeight,
        kind: tags.building,
        name: tags.name,
        estimated,
      })
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      // A multipolygon. The trap here: OSM rarely stores one way per ring.
      // A single building outline is usually SPLIT across many way segments —
      // Þjóðminjasafn Íslands in Reykjavík is 18 fragments, most of them just
      // 2 points. Treating each fragment as its own polygon extrudes a stack
      // of degenerate slivers, which is exactly the spike this produced.
      // The fragments have to be stitched end-to-end into closed rings first.
      const outerParts: { lat: number; lon: number }[][] = []
      const innerParts: { lat: number; lon: number }[][] = []
      for (const m of el.members) {
        if (m.type !== 'way' || !Array.isArray(m.geometry)) continue
        const seg = m.geometry.filter((p: any) => p && isFinite(p.lat))
        if (seg.length < 2) continue
        ;(m.role === 'inner' ? innerParts : outerParts).push(seg)
      }

      const outers = stitchRings(outerParts)
      const inners = stitchRings(innerParts)

      outers.forEach((ring, i) => {
        emit({
          id: el.id * 10 + i,
          outer: ring,
          inner: i === 0 ? inners : [],
          height,
          minHeight,
          kind: tags.building,
          name: tags.name,
          estimated,
        })
      })
    }
  }

  return out
}

/**
 * Stitch open way fragments into closed rings.
 *
 * OSM multipolygons store an outline as an unordered bag of way segments that
 * share endpoints. Walk them: take a segment, then repeatedly find another
 * whose start (or end — segments can be stored in either direction) matches
 * the current tail, until the ring closes back on itself.
 *
 * Anything that can't be closed is discarded rather than rendered: a partial
 * outline extrudes into a wall-shaped artefact, which is worse than a missing
 * building because it looks like real data.
 */
function stitchRings(
  parts: { lat: number; lon: number }[][],
): { lat: number; lon: number }[][] {
  const key = (p: { lat: number; lon: number }) =>
    `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`

  const pool = parts.slice()
  const rings: { lat: number; lon: number }[][] = []

  while (pool.length) {
    let ring = pool.shift()!

    // Already a closed loop on its own.
    if (key(ring[0]) === key(ring[ring.length - 1])) {
      if (ring.length >= 4) rings.push(ring)
      continue
    }

    let extended = true
    while (extended && key(ring[0]) !== key(ring[ring.length - 1])) {
      extended = false
      const tail = key(ring[ring.length - 1])

      for (let i = 0; i < pool.length; i++) {
        const seg = pool[i]
        const a = key(seg[0])
        const b = key(seg[seg.length - 1])

        if (a === tail) {
          ring = ring.concat(seg.slice(1))
          pool.splice(i, 1)
          extended = true
          break
        }
        if (b === tail) {
          // stored backwards — reverse it
          ring = ring.concat(seg.slice(0, -1).reverse())
          pool.splice(i, 1)
          extended = true
          break
        }
      }
    }

    // Only keep it if it actually closed into a polygon.
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) {
      rings.push(ring)
    }
  }

  return rings
}

/**
 * Bounding-box span of a ring in metres.
 *
 * Area alone doesn't catch everything: a long thin sliver can have a small
 * area but stretch a kilometre across the scene, and extruded it becomes a
 * wall. Span is the check that actually catches bad geometry.
 */
export function ringSpan(ring: { lat: number; lon: number }[]): number {
  if (!ring.length) return 0
  let mnLat = Infinity, mxLat = -Infinity, mnLon = Infinity, mxLon = -Infinity
  for (const p of ring) {
    if (p.lat < mnLat) mnLat = p.lat
    if (p.lat > mxLat) mxLat = p.lat
    if (p.lon < mnLon) mnLon = p.lon
    if (p.lon > mxLon) mxLon = p.lon
  }
  const mPerLat = 111320
  const mPerLon = 111320 * Math.cos((mnLat * Math.PI) / 180)
  return Math.max((mxLat - mnLat) * mPerLat, (mxLon - mnLon) * mPerLon)
}

/** Centroid of a ring, for sampling the ground height under a building. */
export function centroid(ring: { lat: number; lon: number }[]) {
  let lat = 0
  let lon = 0
  // The ring is closed (last point repeats the first) — skip the duplicate.
  const n = ring.length > 1 && ring[0].lat === ring[ring.length - 1].lat ? ring.length - 1 : ring.length
  for (let i = 0; i < n; i++) {
    lat += ring[i].lat
    lon += ring[i].lon
  }
  return { lat: lat / n, lon: lon / n }
}

/** Rough footprint area in m², for filtering out noise and colouring. */
export function footprintArea(ring: { lat: number; lon: number }[]): number {
  if (ring.length < 3) return 0
  const lat0 = ring[0].lat
  const mPerLat = 111320
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180)
  let a = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i].lon * mPerLon
    const y1 = ring[i].lat * mPerLat
    const x2 = ring[i + 1].lon * mPerLon
    const y2 = ring[i + 1].lat * mPerLat
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2)
}
