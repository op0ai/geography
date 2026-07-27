/**
 * seed-cache.mjs — pre-populate the map data cache for well-known places.
 *
 * Overpass allows exactly TWO concurrent queries per client IP (confirmed by
 * its own /api/status: "Rate limit: 2"). Every Cloudflare Worker request
 * shares one IP, so on a traffic spike most visitors would find the headline
 * feature unavailable — not because anything is broken, but because a public
 * good has a fair-use limit and we'd be standing on it.
 *
 * Buildings don't move. So the fix isn't to hammer Overpass harder, it's to
 * ask once, politely, ahead of time. This walks the curated places list at a
 * respectful pace and stores each result in R2, where the Worker finds it
 * permanently.
 *
 * Deliberately serial with a pause between queries. This script is a good
 * citizen by design — it's the reason the app can be one too.
 *
 * Both layers are seeded: buildings AND vegetation. They're separate Overpass
 * queries against separate cache keys, so warming one does nothing for the
 * other — and a location with cached buildings but cold trees still stalls on
 * the tree query when someone lands there.
 *
 *   node scripts/seed-cache.mjs
 *   node scripts/seed-cache.mjs --dry
 *   node scripts/seed-cache.mjs --only=vegetation
 */

// The canonical host. The workers.dev subdomain 301s here, and while fetch
// follows redirects, seeding through one would warm the cache under a URL
// nobody visits — the Worker keys on a fixed synthetic host now, but there's
// no reason to add a round trip to every one of 184 queries.
const BASE = process.env.SEED_BASE ?? 'https://opensolar.app'
const DRY = process.argv.includes('--dry')

/** Rate limit is 2 concurrent; one at a time with a pause is well inside it. */
const PAUSE_MS = 2500

/**
 * Must exceed the Worker's own retry budget (~76s worst case across two
 * passes and three mirrors).
 *
 * This is not a detail. When the client aborts, the Worker's request is
 * cancelled with it — so a client timeout firing while the Worker is still
 * retrying doesn't merely report a failure, it *throws the work away* and
 * leaves the cache cold. An earlier run at 70s recorded a third of its queries
 * as failures while Overpass was answering fine, and seeded nothing for them.
 *
 * Better to wait out one slow query than to spend 45 seconds achieving
 * nothing.
 */
const TIMEOUT_MS = 100_000
const RADII = [300, 700]

/**
 * The two layers, and what a result means for each.
 *
 * `count` pulls the number worth reporting out of the response — buildings and
 * trees are both Overpass elements, but "1,840 buildings" and "78 trees" are
 * the figures a human reading this output actually wants.
 */
const LAYERS = [
  {
    id: 'buildings',
    path: '/api/buildings',
    label: 'bldg',
    count: (json) => json.elements?.length ?? 0,
  },
  {
    id: 'vegetation',
    path: '/api/vegetation',
    label: 'tree',
    // Individual trees are the interesting figure; rows and woods are folded
    // in as elements but a count of "3 forest polygons" reads as nothing.
    count: (json) =>
      (json.elements ?? []).filter((e) => e.tags?.natural === 'tree').length,
  },
]

// --only=buildings / --only=vegetation, for re-running just the failures of
// one layer without re-walking the other.
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const LAYERS_TO_SEED = onlyArg
  ? LAYERS.filter((l) => l.id === onlyArg.slice(7))
  : LAYERS

/**
 * The places the app itself offers, plus the cities people reach for first.
 * Kept here rather than imported so this script has no build step.
 */
const PLACES = [
  ['Tromsø', 69.6492, 18.9553],
  ['Longyearbyen', 78.2232, 15.6267],
  ['Reykjavík', 64.1466, -21.9426],
  ['London', 51.5074, -0.1278],
  ['Paris', 48.8566, 2.3522],
  ['New York', 40.7128, -74.006],
  ['Manhattan Midtown', 40.759, -73.9845],
  ['San Francisco', 37.7749, -122.4194],
  ['Tokyo', 35.6762, 139.6503],
  ['Singapore', 1.3521, 103.8198],
  ['Sydney', -33.8688, 151.2093],
  ['Berlin', 52.52, 13.405],
  ['Amsterdam', 52.3676, 4.9041],
  ['Barcelona', 41.3851, 2.1734],
  ['Rome', 41.9028, 12.4964],
  ['Vienna', 48.2082, 16.3738],
  ['Copenhagen', 55.6761, 12.5683],
  ['Stockholm', 59.3293, 18.0686],
  ['Oslo', 59.9139, 10.7522],
  ['Helsinki', 60.1699, 24.9384],
  ['Dublin', 53.3498, -6.2603],
  ['Edinburgh', 55.9533, -3.1883],
  ['Lisbon', 38.7223, -9.1393],
  ['Madrid', 40.4168, -3.7038],
  ['Zurich', 47.3769, 8.5417],
  ['Prague', 50.0755, 14.4378],
  ['Budapest', 47.4979, 19.0402],
  ['Istanbul', 41.0082, 28.9784],
  ['Dubai', 25.2048, 55.2708],
  ['Mumbai', 19.076, 72.8777],
  ['Hong Kong', 22.3193, 114.1694],
  ['Seoul', 37.5665, 126.978],
  ['Shanghai', 31.2304, 121.4737],
  ['Toronto', 43.6532, -79.3832],
  ['Vancouver', 49.2827, -123.1207],
  ['Chicago', 41.8781, -87.6298],
  ['Los Angeles', 34.0522, -118.2437],
  ['Mexico City', 19.4326, -99.1332],
  ['São Paulo', -23.5505, -46.6333],
  ['Buenos Aires', -34.6037, -58.3816],
  ['Cape Town', -33.9249, 18.4241],
  ['Nairobi', -1.2921, 36.8219],
  ['Cairo', 30.0444, 31.2357],
  ['Auckland', -36.8485, 174.7633],
  ['Ushuaia', -54.8019, -68.303],
  ['Anchorage', 61.2181, -149.9003],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ok = 0
let cached = 0
let failed = 0
const failures = []

const total = PLACES.length * RADII.length * LAYERS_TO_SEED.length
console.log(
  `\nSeeding ${PLACES.length} places × ${RADII.length} radii × ` +
    `${LAYERS_TO_SEED.length} layer${LAYERS_TO_SEED.length === 1 ? '' : 's'} ` +
    `= ${total} queries → ${BASE}`,
)
console.log(`One query at a time, ${PAUSE_MS}ms apart. Overpass allows 2 concurrent.\n`)

for (const [name, lat, lon] of PLACES) {
  for (const r of RADII) {
    for (const layer of LAYERS_TO_SEED) {
      const url = `${BASE}${layer.path}?lat=${lat}&lon=${lon}&r=${r}`
      if (DRY) {
        console.log(`  would seed  ${name} ${layer.id} @ ${r}m`)
        continue
      }

      const t0 = Date.now()
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        const source = res.headers.get('x-cache') ?? '?'
        const ms = Date.now() - t0

        if (res.ok) {
          const json = await res.json()
          const n = layer.count(json)
          const warm = source === 'edge' || source === 'r2' || source === 'r2-wider'
          if (warm) cached++
          else ok++
          console.log(
            `  ${(warm ? 'cached ' : 'fetched').padEnd(8)}` +
              `${name.padEnd(20)} ${layer.id.padEnd(11)} ${String(r).padStart(4)}m  ` +
              `${String(n).padStart(5)} ${layer.label}  ${String(ms).padStart(6)}ms`,
          )
        } else {
          failed++
          failures.push(`${name} ${layer.id} @ ${r}m (HTTP ${res.status})`)
          console.log(
            `  FAILED  ${name.padEnd(20)} ${layer.id.padEnd(11)} ` +
              `${String(r).padStart(4)}m  HTTP ${res.status}`,
          )
        }
      } catch (e) {
        failed++
        failures.push(`${name} ${layer.id} @ ${r}m (${String(e).slice(0, 40)})`)
        console.log(
          `  FAILED  ${name.padEnd(20)} ${layer.id.padEnd(11)} ` +
            `${String(r).padStart(4)}m  ${String(e).slice(0, 40)}`,
        )
      }

      // Pause between every query, not every place. Overpass counts requests,
      // and doubling the layers without doubling the pauses would double the
      // rate we hit it at.
      await sleep(PAUSE_MS)
    }
  }
}

console.log(`\n  ${ok} fetched, ${cached} already cached, ${failed} failed`)
if (failures.length) {
  console.log('\n  Re-run to retry:')
  for (const f of failures) console.log(`    ${f}`)
}
console.log()
