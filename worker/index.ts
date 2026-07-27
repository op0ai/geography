/**
 * worker/index.ts — the edge layer.
 *
 * Three jobs the static asset handler can't do:
 *
 *  1. Per-location OG metadata. A shared link needs a title and image that
 *     describe THAT place at THAT moment. Crawlers don't run JavaScript, so
 *     this has to be injected server-side before the HTML goes out.
 *  2. The OG image itself, drawn per request.
 *  3. Agent-readable surfaces — /llms.txt, robots.txt with real AI-crawler
 *     rules, and a /.well-known/agent-skills index, per the checks
 *     isitagentready.com actually runs.
 */

import { solarPosition, sunTimes, phaseFor } from '../src/lib/solar'
import { Raster, text, measure, encodePng, hex } from './png'
import { sampleCanopy } from './cog'

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
  /** Permanent store for building footprints. See the /api/buildings route. */
  BUILDINGS?: R2Bucket
}

/**
 * The canonical origin. Everything else redirects here.
 *
 * Shared links, OG cards and canonical tags all have to agree on one hostname
 * or crawlers will index the same view twice and social platforms will cache
 * whichever they saw first.
 */
const SITE = 'https://opensolar.app'

/** The old workers.dev hostname, kept alive purely to redirect. */
const LEGACY_HOST = 'geography-globe.op0.workers.dev'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * The default view. Must stay in sync with DEFAULT_PLACE in src/lib/places.ts —
 * a bare URL previously fell back to Tromsø's *coordinates* with an empty name,
 * so the homepage shared as "69.65°, 18.96°" instead of "Tromsø". The name has
 * to live here too; the Worker can't import from src.
 */
const DEFAULT_VIEW = {
  lat: 69.6492,
  lon: 18.9553,
  name: 'Tromsø',
  country: 'Norway',
}

function parseView(url: URL) {
  const at = url.searchParams.get('at')
  let lat = DEFAULT_VIEW.lat
  let lon = DEFAULT_VIEW.lon
  if (at) {
    const [la, lo] = at.split(',').map(Number)
    if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
      lat = la
      lon = lo
    }
  }
  const tRaw = url.searchParams.get('t')
  const t = tRaw && !isNaN(Date.parse(tRaw)) ? new Date(tRaw) : new Date()
  // Only inherit the default name when the coordinate is also the default —
  // otherwise a shared pin with no ?name would be mislabelled "Tromsø".
  const atDefault = !at
  const name = (url.searchParams.get('name') || (atDefault ? DEFAULT_VIEW.name : '')).slice(0, 60)
  const country = (url.searchParams.get('in') || (atDefault ? DEFAULT_VIEW.country : '')).slice(0, 60)
  const planet = (url.searchParams.get('on') || 'earth').slice(0, 20)
  const ground = url.searchParams.has('ground')

  /*
   * The shading result, carried in the link.
   *
   * `sun` is hours of unobstructed direct sun at this exact point, and `dap`
   * is hours of dappled light through canopy. Both computed in the browser —
   * the trace needs terrain tiles and building geometry the Worker doesn't
   * have — so the client encodes its answer into the URL when it shares one.
   *
   * That makes the OG card say "5h 20m of direct sun here" instead of a
   * generic sun-position readout, which is the difference between a link that
   * explains itself in a chat window and one that doesn't.
   *
   * Range-checked rather than trusted: these arrive from a querystring anyone
   * can edit, and a card claiming 900 hours of sunlight would be worse than
   * no card at all.
   */
  const rawSun = parseFloat(url.searchParams.get('sun') ?? '')
  const sunHours = isFinite(rawSun) && rawSun >= 0 && rawSun <= 24 ? rawSun : null
  const rawDap = parseFloat(url.searchParams.get('dap') ?? '')
  const dappled = isFinite(rawDap) && rawDap >= 0 && rawDap <= 24 ? rawDap : null

  return { lat, lon, t, name, country, planet, ground, sunHours, dappled }
}

/** "5.33" → "5h 20m". Matches the in-app formatting exactly. */
function fmtHours(h: number): string {
  if (h <= 0) return 'no direct sun'
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  if (hh === 0) return `${mm}m`
  if (mm === 0) return `${hh}h`
  return `${hh}h ${mm}m`
}

const fmt = (d: Date | null) =>
  d
    ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    : '—'

/* ------------------------------------------------------------------ */
/* OG image — SVG, rasterized by Cloudflare's image resizing            */
/* ------------------------------------------------------------------ */

/**
 * Social platforms do NOT render SVG OG images — verified across Twitter,
 * Slack, Discord, iMessage, WhatsApp, LinkedIn and Facebook. So the SVG is
 * only an intermediate: `cf.image.format` rasterizes it to PNG at the edge,
 * which avoids shipping a ~2MB resvg WASM binary into the Worker bundle.
 */
function ogSvg(v: ReturnType<typeof parseView>) {
  const sun = solarPosition(v.t, v.lat, v.lon)
  const times = sunTimes(v.t, v.lat, v.lon)
  const phase = phaseFor(sun.altitude)

  const title = v.name || `${v.lat.toFixed(2)}°, ${v.lon.toFixed(2)}°`
  const sub =
    v.country ||
    `${Math.abs(v.lat).toFixed(2)}°${v.lat >= 0 ? 'N' : 'S'}, ${Math.abs(v.lon).toFixed(2)}°${v.lon >= 0 ? 'E' : 'W'}`

  const dayLen = times.alwaysUp
    ? '24h'
    : times.alwaysDown
      ? '0h'
      : `${times.dayLengthHours.toFixed(1)}h`

  // Arc showing where the sun sits in the sky — the card's one graphic, and
  // it's the actual measurement rather than decoration.
  const cx = 980
  const cy = 430
  const r = 150
  const altClamp = Math.max(-12, Math.min(90, sun.altitude))
  const azRad = ((sun.azimuth - 180) * Math.PI) / 180
  const altRad = (altClamp * Math.PI) / 180
  const sx = cx + Math.sin(azRad) * r * Math.cos(altRad)
  const sy = cy - Math.sin(altRad) * r
  const below = sun.altitude < -0.833

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1020"/>
      <stop offset="55%" stop-color="#0a0d18"/>
      <stop offset="100%" stop-color="#141019"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${phase.tint}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${phase.tint}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="dome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${phase.tint}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${phase.tint}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="${cx}" cy="${cy - 40}" r="330" fill="url(#glow)"/>

  <text x="80" y="112" font-family="Georgia, serif" font-size="40" fill="#f2f4f8" opacity="0.92">geography</text>
  <text x="80" y="140" font-family="Inter, system-ui, sans-serif" font-size="17" fill="#7c8395">where the light falls</text>

  <text x="80" y="266" font-family="Georgia, serif" font-size="74" fill="#ffffff">${esc(title)}</text>
  <text x="80" y="308" font-family="Inter, system-ui, sans-serif" font-size="24" fill="#98a0b4">${esc(sub)}</text>

  <rect x="80" y="342" width="${18 + phase.label.length * 12}" height="36" rx="18" fill="${phase.tint}" fill-opacity="0.18" stroke="${phase.tint}" stroke-opacity="0.45"/>
  <text x="${92}" y="366" font-family="Inter, system-ui, sans-serif" font-size="17" font-weight="600" fill="${phase.tint}">${esc(phase.label)}</text>

  <g font-family="Inter, system-ui, sans-serif">
    <text x="80" y="452" font-size="15" fill="#6d7488" letter-spacing="2">SUN ALTITUDE</text>
    <text x="80" y="498" font-size="46" font-weight="600" fill="${phase.tint}">${sun.altitude.toFixed(1)}°</text>

    <text x="330" y="452" font-size="15" fill="#6d7488" letter-spacing="2">BEARING</text>
    <text x="330" y="498" font-size="46" font-weight="600" fill="#e8ebf2">${sun.azimuth.toFixed(0)}°</text>

    <text x="560" y="452" font-size="15" fill="#6d7488" letter-spacing="2">DAYLIGHT</text>
    <text x="560" y="498" font-size="46" font-weight="600" fill="#e8ebf2">${dayLen}</text>

    <text x="80" y="556" font-size="17" fill="#8b93a7">Sunrise ${fmt(times.sunrise)} · Sunset ${fmt(times.sunset)} UTC</text>
    <text x="80" y="586" font-size="15" fill="#5d6478">${esc(v.t.toISOString().slice(0, 16).replace('T', ' '))} UTC</text>
  </g>

  <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z" fill="url(#dome)"/>
  <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="#3a4152" stroke-width="1.5"/>
  <line x1="${cx - r - 16}" y1="${cy}" x2="${cx + r + 16}" y2="${cy}" stroke="#4d556a" stroke-width="2"/>
  <text x="${cx - r - 14}" y="${cy + 26}" font-family="Inter, sans-serif" font-size="15" fill="#6d7488">E</text>
  <text x="${cx - 6}" y="${cy + 26}" font-family="Inter, sans-serif" font-size="15" fill="#6d7488">S</text>
  <text x="${cx + r + 2}" y="${cy + 26}" font-family="Inter, sans-serif" font-size="15" fill="#6d7488">W</text>
  <circle cx="${sx}" cy="${sy}" r="26" fill="${phase.tint}" opacity="${below ? 0.14 : 0.3}"/>
  <circle cx="${sx}" cy="${sy}" r="12" fill="${below ? '#1b2030' : phase.tint}" stroke="${phase.tint}" stroke-width="2.5"${below ? ' stroke-dasharray="4 3"' : ''}/>
</svg>`
}

/* ------------------------------------------------------------------ */

function metaFor(v: ReturnType<typeof parseView>, url: URL) {
  const sun = solarPosition(v.t, v.lat, v.lon)
  const times = sunTimes(v.t, v.lat, v.lon)
  const phase = phaseFor(sun.altitude)
  const place = v.name || `${v.lat.toFixed(2)}°, ${v.lon.toFixed(2)}°`

  const onPlanet =
    v.planet !== 'earth'
      ? ` on ${v.planet[0].toUpperCase()}${v.planet.slice(1)}`
      : ''

  // With a shading result the title says the thing worth saying. "Tromsø —
  // 5h 20m of direct sun" is a headline; "Tromsø — Daylight" is a label.
  const title =
    v.sunHours !== null
      ? `${place} — ${fmtHours(v.sunHours)} of direct sun · geography`
      : `${place}${onPlanet} — ${phase.label} · geography`

  const dayLen = times.alwaysUp
    ? 'the sun never sets today'
    : times.alwaysDown
      ? 'the sun never rises today'
      : `${times.dayLengthHours.toFixed(1)} hours of daylight`

  const description =
    v.sunHours !== null
      ? `Ray-traced against the terrain and buildings around this exact point: ` +
        `${fmtHours(v.sunHours)} of direct sun` +
        (v.dappled !== null && v.dappled > 0.08
          ? `, plus ${fmtHours(v.dappled)} of dappled light through the trees`
          : '') +
        `, out of ${dayLen}.`
      : `The sun is ${sun.altitude.toFixed(1)}° above the horizon at bearing ` +
        `${sun.azimuth.toFixed(0)}° — ${dayLen}. ` +
        `Sunrise ${fmt(times.sunrise)}, sunset ${fmt(times.sunset)} UTC.`

  // The OG image mirrors the view's own parameters so the card matches the page.
  const og = new URL('/og.png', SITE)
  og.searchParams.set('at', `${v.lat.toFixed(4)},${v.lon.toFixed(4)}`)
  og.searchParams.set('t', v.t.toISOString())
  if (v.name) og.searchParams.set('name', v.name)
  if (v.country) og.searchParams.set('in', v.country)
  if (v.sunHours !== null) og.searchParams.set('sun', v.sunHours.toFixed(2))
  if (v.dappled !== null) og.searchParams.set('dap', v.dappled.toFixed(2))

  const canonical = `${SITE}${url.pathname}${url.search}`

  return { title, description, image: og.toString(), canonical }
}

/* ------------------------------------------------------------------ */


/**
 * Fetch building footprints for an area from Overpass.
 *
 * Extracted from the request handler so the background warm can call it
 * directly. Re-fetching our own URL to warm the cache doesn't work — a Worker
 * fetching itself doesn't populate `caches.default`.
 *
 * Overpass rate-limits per client IP by CONCURRENCY, not by rate: the public
 * instance allows ~2 simultaneous queries and answers the third with HTTP 406
 * in under half a second. Measured directly — four parallel cold queries
 * returned 200, 200, 406, 406. That's the front-page failure mode, so 406 and
 * 429 mean "try the next mirror now", not "this mirror is dead".
 *
 * Relations are dropped on the retry passes. `out geom` on relations is the
 * expensive half of the query — dense European centres time out on it while
 * the ways alone return in ~2s. Multipolygon buildings (the ones with
 * courtyards) are a small minority, and a missing courtyard changes a shading
 * answer far less than missing the whole street does.
 */
async function fetchBuildingArea(
  lat: number,
  lon: number,
  radius: number,
  kind: 'buildings' | 'vegetation' = 'buildings',
): Promise<{ ok: boolean; body: string; rateLimited: boolean }> {
  const dLat = radius / 111320
  const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180))
  const bbox = [
    (lat - dLat).toFixed(6),
    (lon - dLon).toFixed(6),
    (lat + dLat).toFixed(6),
    (lon + dLon).toFixed(6),
  ].join(',')

  /*
   * Two query shapes.
   *
   * Buildings: ways plus relations, because multipolygon buildings (the ones
   * with courtyards) only come back whole with relations included.
   *
   * Vegetation: individual tree nodes, tree rows, and wood/forest polygons.
   * Trees are nodes rather than ways, so `out geom` isn't needed for them —
   * but it is for the rows and stands, and mixing both in one query is
   * cheaper than two round trips against a rate-limited service.
   */
  const vegetation =
    `[out:json][timeout:20];(` +
    `node["natural"="tree"](${bbox});` +
    `way["natural"="tree_row"](${bbox});` +
    `way["natural"="wood"](${bbox});` +
    `way["landuse"="forest"](${bbox});` +
    `);out geom;`
  // Dropping the stands keeps individual trees, which matter far more at
  // garden scale, when the full query is too slow.
  const vegetationLite =
    `[out:json][timeout:20];(node["natural"="tree"](${bbox});way["natural"="tree_row"](${bbox}););out geom;`

  const withRelations =
    `[out:json][timeout:20];(way["building"](${bbox});relation["building"](${bbox}););out geom;`
  const waysOnly = `[out:json][timeout:20];(way["building"](${bbox}););out geom;`

  const MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ]
  /*
   * Two passes, not three.
   *
   * Three passes across three mirrors, at up to 18s and 12s each plus a
   * backoff, adds up to a worst case near 128 seconds. Nothing waits that
   * long: browsers give up, the seeder gave up at 70s, and — crucially — when
   * the client aborts, the Worker's own request is cancelled with it, so all
   * that patient retrying is thrown away without ever reaching the cache. The
   * result was a run where a third of the queries "failed" while the upstream
   * was working fine.
   *
   * Two passes caps the worst case around 60s, which is inside what a client
   * will actually wait for, so the work finishes and gets cached.
   */
  const PASSES =
    kind === 'vegetation'
      ? [vegetation, vegetationLite]
      : [withRelations, waysOnly]

  let rateLimited = false

  for (let attempt = 0; attempt < PASSES.length; attempt++) {
    for (const endpoint of MIRRORS) {
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(PASSES[attempt]),
          headers: {
            // Overpass will not parse the body without this. Worker fetch
            // defaults a string body to text/plain, which the server accepts
            // and then fails to read — returning a 504 that looks like a
            // timeout rather than the malformed request it is.
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'opensolar.app (+https://opensolar.app)',
          },
          // Measured: central Berlin takes ~9s cold with no contention, so a
          // 12s ceiling was cutting off requests that were about to succeed.
          // 15s on the full query, 10s on the cheaper retry — two passes over
          // three mirrors then caps at ~60s total, inside any client's
          // patience.
          signal: AbortSignal.timeout(attempt === 0 ? 15_000 : 10_000),
        })

        if (upstream.status === 406 || upstream.status === 429) {
          rateLimited = true
          continue
        }
        if (!upstream.ok) continue

        return { ok: true, body: await upstream.text(), rateLimited }
      } catch {
        // Timed out or the connection failed — try the next mirror.
      }
    }

    // Only pause when the mirrors were busy rather than slow. A timeout means
    // the next pass, with its cheaper query, should start at once.
    if (rateLimited && attempt < PASSES.length - 1) {
      await new Promise((r) => setTimeout(r, 1200))
    }
  }

  return { ok: false, body: '', rateLimited }
}

/** Small JSON responder for the API routes. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    /*
     * Canonical host.
     *
     * The app answers on opensolar.app now. The workers.dev subdomain stays
     * enabled deliberately rather than being switched off in config — turning
     * it off makes every previously shared link, every OG card already cached
     * by Slack and Twitter, and every crawler-indexed URL simply fail. A 301
     * keeps them all working and consolidates the ranking signal.
     *
     * This runs FIRST, before any cache lookup. A redirect must never be
     * written into the cache under a content URL's key, and returning early is
     * the simplest way to guarantee that.
     */
    if (url.hostname === LEGACY_HOST) {
      const to = new URL(url.pathname + url.search, SITE)
      return Response.redirect(to.toString(), 301)
    }

    /* ---- dynamic OG image ----
       Drawn with a hand-rolled rasterizer (worker/png.ts) rather than Satori
       or resvg. Cloudflare image resizing is unavailable on workers.dev
       (verified: /cdn-cgi/image/ returns 404) and a WASM rasterizer would add
       ~2MB to the bundle. Social platforms reject SVG, so a real PNG is the
       only thing that actually renders in a share card. */
    if (url.pathname === '/og.png' || url.pathname === '/og.svg') {
      const v = parseView(url)

      if (url.pathname === '/og.svg') {
        return new Response(ogSvg(v), {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }

      const sun = solarPosition(v.t, v.lat, v.lon)
      const times = sunTimes(v.t, v.lat, v.lon)
      const phase = phaseFor(sun.altitude)
      const tint = hex(phase.tint)

      const INK: [number, number, number] = [242, 244, 248]
      const MUTE: [number, number, number] = [150, 158, 178]
      const FAINT: [number, number, number] = [104, 112, 134]

      const r = new Raster(1200, 630, [11, 14, 26])

      // Ambient glow behind the sky dome, tinted by the current light phase.
      r.glow(958, 372, 430, tint, 0.20)

      // Masthead
      text(r, 'geography', 80, 104, 38, INK, false, 0.95)
      text(r, 'where the light falls', 80, 138, 17, FAINT)

      // Place — the headline. Shrinks for long names so it never clips.
      const title = v.name || `${v.lat.toFixed(2)}°, ${v.lon.toFixed(2)}°`
      let titleSize = 68
      while (measure(title, titleSize, true) > 700 && titleSize > 30) titleSize -= 2
      text(r, title, 80, 272, titleSize, [255, 255, 255], true)

      const sub =
        v.country ||
        `${Math.abs(v.lat).toFixed(2)}°${v.lat >= 0 ? 'N' : 'S'}, ${Math.abs(v.lon).toFixed(2)}°${v.lon >= 0 ? 'E' : 'W'}`
      text(r, sub, 80, 310, 22, MUTE)

      // Phase chip
      const chipW = measure(phase.label, 17) + 36
      r.roundRect(80, 336, chipW, 40, 20, tint, 0.16)
      text(r, phase.label, 98, 363, 17, tint, true)

      // Readings
      const stat = (
        x: number,
        label: string,
        value: string,
        col: [number, number, number],
      ) => {
        text(r, label.toUpperCase(), x, 448, 14, FAINT, false, 1, 0.09)
        text(r, value, x, 504, 44, col, true)
      }
      const dayLenStr = times.alwaysUp
        ? '24h'
        : times.alwaysDown
          ? '0h'
          : `${times.dayLengthHours.toFixed(1)}h`

      if (v.sunHours !== null) {
        /*
         * When the link carries a shading result, the card leads with it.
         *
         * Sun altitude and bearing are true of everyone within a few
         * kilometres; "5h 20m of direct sun at this exact spot" is true of
         * nowhere else, and it's the thing worth putting in a share card. The
         * generic astronomy moves to the supporting line.
         */
        const SUN: [number, number, number] = [255, 209, 102]
        text(r, 'DIRECT SUN HERE', 80, 448, 14, FAINT, false, 1, 0.09)
        text(r, fmtHours(v.sunHours), 80, 512, 56, SUN, true)

        const w = measure(fmtHours(v.sunHours), 56, true)
        if (v.dappled !== null && v.dappled > 0.08) {
          const LEAF: [number, number, number] = [110, 214, 160]
          text(r, `+ ${fmtHours(v.dappled)} dappled`, 92 + w, 508, 22, LEAF)
        }

        text(
          r,
          `${dayLenStr} of daylight  ·  sun ${sun.altitude.toFixed(0)}° at ${sun.azimuth.toFixed(0)}°  ·  ` +
            `sunrise ${fmt(times.sunrise)}, sunset ${fmt(times.sunset)} UTC`,
          80,
          560,
          17,
          MUTE,
        )
      } else {
        stat(80, 'Sun altitude', `${sun.altitude.toFixed(1)}°`, tint)
        stat(340, 'Bearing', `${sun.azimuth.toFixed(0)}°`, INK)
        stat(560, 'Daylight', dayLenStr, INK)

        text(
          r,
          `Sunrise ${fmt(times.sunrise)}  ·  Sunset ${fmt(times.sunset)} UTC`,
          80,
          560,
          18,
          MUTE,
        )
      }
      text(r, `${v.t.toISOString().slice(0, 16).replace('T', ' ')} UTC`, 80, 592, 15, FAINT)

      // Sky dome, with the sun at its true altitude and bearing.
      const cx = 958
      const cy = 428
      const rad = 152
      r.arc(cx, cy, rad, Math.PI, 2 * Math.PI, [66, 74, 96], 2)
      r.line(cx - rad - 20, cy, cx + rad + 20, cy, [86, 94, 118], 2)
      text(r, 'E', cx - rad - 14, cy + 28, 15, FAINT)
      text(r, 'S', cx - 5, cy + 28, 15, FAINT)
      text(r, 'W', cx + rad + 4, cy + 28, 15, FAINT)

      const altClamp = Math.max(-12, Math.min(90, sun.altitude))
      const azRad = ((sun.azimuth - 180) * Math.PI) / 180
      const altRad = (altClamp * Math.PI) / 180
      const sx = cx + Math.sin(azRad) * rad * Math.cos(altRad)
      const sy = cy - Math.sin(altRad) * rad
      const below = sun.altitude < -0.833
      r.glow(sx, sy, 58, tint, below ? 0.18 : 0.55)
      r.disc(sx, sy, below ? 9 : 14, below ? ([27, 32, 48] as [number, number, number]) : tint)
      if (below) r.arc(sx, sy, 9, 0, Math.PI * 2, tint, 2.2)

      const png = encodePng(r)
      return new Response(png, {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(png.length),
          'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        },
      })
    }

    /* ---- agent-readable surfaces ---- */
    // AGENTS.md — the agents.md standard (agents.md, stewarded by the Linux
    // Foundation). llms.txt says what the site IS; AGENTS.md says how to work
    // on it. Both belong on the wire: an agent sent to contribute shouldn't
    // have to clone the repo to learn that the astronomy is test-verified.
    /* --------------------------------------------------------------
     * /api/buildings — an edge proxy for Overpass.
     *
     * Three problems with calling Overpass from the browser, all of which
     * showed up in testing:
     *
     *   1. It's slow. The reference mirror routinely takes 10-40s under load,
     *      and the ground scene sits on "Loading…" the whole time.
     *   2. It's rate-limited per client IP. A front-page traffic spike means
     *      every visitor gets throttled, and the feature that makes this app
     *      worth using is the first thing to break.
     *   3. Its failure mode is indistinguishable from success. An empty result
     *      means either "nothing is mapped here" or "the mirror gave up", and
     *      the shading answer is completely different in those two cases.
     *
     * Proxying through the edge fixes all three. Cloudflare's cache collapses
     * concurrent requests for the same tile into one upstream call, so a
     * thousand people looking at the same city is one Overpass query. The
     * cache key is rounded to ~100m, which is well inside the 700m scene
     * radius, so neighbours share an entry.
     * ------------------------------------------------------------------ */
    /* --------------------------------------------------------------
     * /api/canopy — global tree cover, for everywhere OSM has none.
     *
     * OpenStreetMap's 34 million mapped trees are concentrated in northern
     * Europe: Germany has 4.07M for 84 million people, India 111k for 1.4
     * billion. So the OSM vegetation layer improves the shading answer in
     * Cologne and does nothing in Lagos, which is a real hole in a tool that
     * claims to work anywhere.
     *
     * This reads Meta/WRI's global 1.19 m canopy height map, range-requested
     * out of Cloud-Optimized GeoTIFFs on Source Cooperative (CC-BY-4.0, CORS
     * enabled). A full tile is ~100 MB; we fetch the header plus the handful
     * of 512×512 blocks the scene actually overlaps — about half a megabyte.
     *
     * Cached in R2 permanently afterwards, like buildings, because canopy from
     * 2016-2020 imagery is not going to change.
     * ------------------------------------------------------------------ */
    if (url.pathname === '/api/canopy') {
      const lat = Number(url.searchParams.get('lat'))
      const lon = Number(url.searchParams.get('lon'))
      const radius = Math.min(1200, Number(url.searchParams.get('r')) || 700)
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return jsonResponse({ error: 'bad coordinates' }, 400)
      }
      // The dataset stops short of the poles.
      if (lat > 83 || lat < -56.7) {
        return jsonResponse({ error: 'outside coverage', outside: true }, 200)
      }

      const qLat = Math.round(lat * 1000) / 1000
      const qLon = Math.round(lon * 1000) / 1000
      const cache = caches.default
      const cacheKey = new Request(
        `https://cache.internal/canopy?lat=${qLat}&lon=${qLon}&r=${radius}`,
        { method: 'GET' },
      )
      const r2Key = `v1/canopy/${qLat.toFixed(3)},${qLon.toFixed(3)}/${radius}.bin`

      /*
       * The grid ships as raw bytes, not JSON.
       *
       * A 351×351 uint8 grid is 123 KB binary. The same numbers as a JSON
       * array are about 400 KB before gzip and force the client to parse a
       * six-figure array of numbers into a JS array of boxed values. Sending
       * the bytes and reading them into a Uint8Array is smaller, faster, and
       * exactly the shape the sampler wants. Metadata rides in headers.
       */
      const binHeaders = (source: string, g: { size: number; step: number; cover: number; max: number }) => ({
        'content-type': 'application/octet-stream',
        'cache-control': 'public, max-age=3600, s-maxage=604800',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-grid-size, x-grid-step, x-cover, x-max, x-cache',
        'x-grid-size': String(g.size),
        'x-grid-step': String(g.step),
        'x-cover': g.cover.toFixed(4),
        'x-max': String(g.max),
        'x-cache': source,
      })

      const hit = await cache.match(cacheKey)
      if (hit) {
        const r = new Response(hit.body, hit)
        r.headers.set('x-cache', 'edge')
        return r
      }

      if (env.BUILDINGS) {
        const stored = await env.BUILDINGS.get(r2Key)
        if (stored) {
          const meta = stored.customMetadata ?? {}
          const res = new Response(stored.body, {
            headers: binHeaders('r2', {
              size: Number(meta.size) || 0,
              step: Number(meta.step) || 4,
              cover: Number(meta.cover) || 0,
              max: Number(meta.max) || 0,
            }),
          })
          ctx.waitUntil(cache.put(cacheKey, res.clone()))
          return res
        }
      }

      try {
        const grid = await sampleCanopy(qLat, qLon, radius, 4)
        const body = grid.data
        const res = new Response(body, { headers: binHeaders('miss', grid) })
        ctx.waitUntil(cache.put(cacheKey, res.clone()))
        if (env.BUILDINGS) {
          ctx.waitUntil(
            env.BUILDINGS.put(r2Key, body, {
              httpMetadata: { contentType: 'application/octet-stream' },
              customMetadata: {
                size: String(grid.size),
                step: String(grid.step),
                cover: grid.cover.toFixed(4),
                max: String(grid.max),
              },
            }).catch(() => {
              /* the cache is an optimisation; never fail the request for it */
            }),
          )
        }
        return res
      } catch (e) {
        // A missing COG tile is ocean or a data gap, not an error worth
        // shouting about — the client treats it as "no canopy layer here".
        return jsonResponse(
          { error: 'canopy unavailable', detail: String(e).slice(0, 120) },
          503,
        )
      }
    }

    if (url.pathname === '/api/buildings' || url.pathname === '/api/vegetation') {
      const kind = url.pathname === '/api/vegetation' ? 'vegetation' : 'buildings'
      const lat = Number(url.searchParams.get('lat'))
      const lon = Number(url.searchParams.get('lon'))
      const radius = Math.min(2000, Number(url.searchParams.get('r')) || 700)
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return jsonResponse({ error: 'bad coordinates' }, 400)
      }

      // Round the key so nearby requests share an entry. 0.001° is ~111m
      // north-south — small relative to the scene, large enough to collapse
      // the traffic from everyone looking at the same landmark.
      const qLat = Math.round(lat * 1000) / 1000
      const qLon = Math.round(lon * 1000) / 1000
      const cache = caches.default

      /*
       * Cache keys are built on a FIXED synthetic host, not the request's own.
       *
       * The Cache API keys on the full request URL, hostname included. This
       * Worker now answers on both opensolar.app and the workers.dev
       * subdomain, so keying on the real host would split every entry in two —
       * halving the hit rate and orphaning the whole cache the day the old
       * hostname goes away. A constant internal host collapses them.
       */
      const keyFor = (r: number) =>
        new Request(`https://cache.internal/${kind}?lat=${qLat}&lon=${qLon}&r=${r}`, {
          method: 'GET',
        })

      const r2Key = `v1/${kind}/${qLat.toFixed(3)},${qLon.toFixed(3)}/${radius}.json`
      const cacheKey = keyFor(radius)

      const headers = (source: string) => ({
        'content-type': 'application/json; charset=utf-8',
        // s-maxage drives the edge TTL; max-age the browser. Note that
        // stale-while-revalidate and stale-if-error are documented as NOT
        // honoured by the Cache API — they're left off rather than kept as
        // decoration that implies behaviour we don't get.
        'cache-control': 'public, max-age=3600, s-maxage=86400',
        'access-control-allow-origin': '*',
        'x-cache': source,
      })

      /*
       * Three tiers, because Overpass cannot be relied on at request time.
       *
       * It rate-limits per client IP by CONCURRENCY, not by rate: ~2
       * simultaneous queries, with the overflow answered by HTTP 406 in half a
       * second. Every Worker request shares one IP. Measured under load, only
       * 2 of 8 concurrent cold cities came back at all.
       *
       * But buildings and trees don't move. So the question isn't "can
       * Overpass answer this request" — it's "has Overpass ever answered for
       * this area". R2 makes that distinction real:
       *
       *   1. Edge cache — same colo, same area, ~200ms.
       *   2. R2 — anywhere in the world has already asked. Permanent.
       *   3. Overpass — the first person ever to look at this spot.
       */
      const hit = await cache.match(cacheKey)
      if (hit) {
        const r = new Response(hit.body, hit)
        r.headers.set('x-cache', 'edge')
        return r
      }

      if (env.BUILDINGS) {
        const stored = await env.BUILDINGS.get(r2Key)
        if (stored) {
          const res = new Response(stored.body, { headers: headers('r2') })
          ctx.waitUntil(cache.put(cacheKey, res.clone()))
          return res
        }
      }

      const result = await fetchBuildingArea(qLat, qLon, radius, kind)

      if (result.ok) {
        const res = new Response(result.body, { headers: headers('miss') })
        ctx.waitUntil(cache.put(cacheKey, res.clone()))
        if (env.BUILDINGS) {
          ctx.waitUntil(
            env.BUILDINGS.put(r2Key, result.body, {
              httpMetadata: { contentType: 'application/json' },
            }).catch(() => {
              /* the cache is an optimisation; never fail the request for it */
            }),
          )
        }
        return res
      }

      /*
       * Overpass didn't answer. Before giving up, check whether R2 has a WIDER
       * radius for this spot — a 700m result contains everything a 300m one
       * would, so it's a strictly better answer, not a fallback.
       */
      if (env.BUILDINGS && radius < 700) {
        const wider = await env.BUILDINGS.get(
          `v1/${kind}/${qLat.toFixed(3)},${qLon.toFixed(3)}/700.json`,
        )
        if (wider) {
          return new Response(wider.body, { headers: headers('r2-wider') })
        }
      }

      // Distinguish "busy, try again" from "genuinely unavailable" — the
      // client retries the first and gives up on the second, and the UI says
      // something different for each.
      return jsonResponse(
        {
          error: result.rateLimited ? 'rate limited upstream' : 'upstream unavailable',
          retryable: result.rateLimited,
          elements: [],
        },
        result.rateLimited ? 429 : 503,
      )
    }

    if (url.pathname === '/AGENTS.md' || url.pathname === '/agents.md') {
      const res = await env.ASSETS.fetch(
        new Request(new URL('/AGENTS.md', url.origin), request),
      )
      if (res.ok) {
        return new Response(res.body, {
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }
    }

    if (url.pathname === '/llms.txt') {
      return new Response(LLMS_TXT, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      })
    }

    if (url.pathname === '/robots.txt') {
      return new Response(ROBOTS, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      })
    }

    if (url.pathname === '/.well-known/agent-skills/index.json') {
      return new Response(JSON.stringify(SKILLS_INDEX, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      })
    }

    /* ---- markdown content negotiation ----
       isitagentready checks whether `Accept: text/markdown` on / returns
       markdown rather than HTML. Cheap to honour and genuinely useful: an
       agent gets the readings without executing a WebGL app. */
    const wantsMarkdown = (request.headers.get('Accept') || '').includes(
      'text/markdown',
    )
    if ((url.pathname === '/' || url.pathname === '/index.html') && wantsMarkdown) {
      const v = parseView(url)
      const sun = solarPosition(v.t, v.lat, v.lon)
      const times = sunTimes(v.t, v.lat, v.lon)
      const phase = phaseFor(sun.altitude)
      const place = v.name || `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`
      const md = `# geography — ${place}

> Sunlight at ${place} on ${v.t.toISOString().slice(0, 16).replace('T', ' ')} UTC.

| Measurement | Value |
| --- | --- |
| Sun altitude | ${sun.altitude.toFixed(2)}° |
| Bearing | ${sun.azimuth.toFixed(1)}° from north |
| Light phase | ${phase.label} |
| Shadow length | ${isFinite(sun.shadowRatio) ? sun.shadowRatio.toFixed(2) + '× height' : 'no sun'} |
| Sunrise (UTC) | ${fmt(times.sunrise)} |
| Solar noon (UTC) | ${fmt(times.solarNoon)} |
| Sunset (UTC) | ${fmt(times.sunset)} |
| Daylight | ${times.alwaysUp ? '24h (midnight sun)' : times.alwaysDown ? '0h (polar night)' : times.dayLengthHours.toFixed(2) + ' hours'} |

Coordinates: ${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}

See /llms.txt for what this site is and how to query it.
`
      return new Response(md, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'x-markdown-tokens': String(Math.ceil(md.length / 4)),
        },
      })
    }

    /* ---- HTML with per-view meta ---- */
    const assetRes = await env.ASSETS.fetch(request)
    const ct = assetRes.headers.get('content-type') || ''
    if (!ct.includes('text/html')) return assetRes

    const v = parseView(url)
    const m = metaFor(v, url)

    return new HTMLRewriter()
      .on('title', {
        element(el) {
          el.setInnerContent(m.title)
        },
      })
      .on('meta[data-dynamic]', {
        element(el) {
          const key = el.getAttribute('property') || el.getAttribute('name') || ''
          if (key.endsWith('title')) el.setAttribute('content', m.title)
          else if (key.endsWith('description')) el.setAttribute('content', m.description)
          else if (key.endsWith('image') || key.endsWith('image:secure_url'))
            el.setAttribute('content', m.image)
          else if (key === 'og:url') el.setAttribute('content', m.canonical)
        },
      })
      .on('link[rel="canonical"]', {
        element(el) {
          el.setAttribute('href', m.canonical)
        },
      })
      .transform(
        new Response(assetRes.body, {
          status: assetRes.status,
          headers: assetRes.headers,
        }),
      )
  },
}

/* ------------------------------------------------------------------ */

const LLMS_TXT = `# geography

> An interactive globe that reports exactly what the sun is doing at any point
> on Earth at any moment, and remaps that place onto other planets. All solar
> positions are computed from first principles (NOAA/Meeus) and validated
> against published astronomy — 62 automated checks.

Every view is addressable. Append query parameters to the root URL:

- \`at=LAT,LON\` — the location, decimal degrees (e.g. \`at=69.6492,18.9553\`)
- \`t=ISO8601\` — the instant in UTC (e.g. \`t=2026-07-26T15:00:00Z\`)
- \`on=PLANET\` — remap onto another world: mars, venus, mercury, jupiter,
  saturn, uranus, neptune, moon
- \`ground=1\` — stand on the surface with real terrain and OSM buildings
- \`name=\`, \`in=\` — place label and country, used for share cards

Request the root with \`Accept: text/markdown\` to get the readings for a view
as a markdown table, with no JavaScript required.

## Data

- [Solar position](${SITE}/llms.txt): NOAA/Meeus low-precision sun, ~0.01°
- [Elevation](https://registry.opendata.aws/terrain-tiles/): AWS Terrain Tiles (terrarium encoding)
- [Buildings](https://www.openstreetmap.org/copyright): OpenStreetMap via Overpass, ODbL
- [Weather](https://open-meteo.com/): Open-Meteo measured shortwave radiation
- [Search](https://photon.komoot.io/): Photon and Nominatim, ODbL

## Examples

- [Tromsø under the midnight sun](${SITE}/?at=69.6492,18.9553&name=Troms%C3%B8&in=Norway)
- [Tromsø on Uranus](${SITE}/?at=69.6492,18.9553&on=uranus&name=Troms%C3%B8)
- [Standing in Reykjavík](${SITE}/?at=64.1466,-21.9426&ground=1&name=Reykjav%C3%ADk)

## Optional

- [AGENTS.md](${SITE}/AGENTS.md): how to work ON this codebase — setup, the
  verification suites, and the bugs that shaped the current design
- [Source](https://github.com/op0ai/geography)
`

const ROBOTS = `# geography — https://opensolar.app
# Content is freely readable by AI crawlers and agents.

User-agent: *
Allow: /

# Training crawlers
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: Amazonbot
Allow: /

User-agent: Bytespider
Allow: /

User-agent: meta-externalagent
Allow: /

# Search / retrieval crawlers
User-agent: OAI-SearchBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: PerplexityBot
Allow: /

# User-triggered fetches
User-agent: ChatGPT-User
Allow: /

User-agent: Claude-User
Allow: /

User-agent: Perplexity-User
Allow: /

# Content signals: this content may be used for search, AI input and training.
Content-Signal: search=yes, ai-input=yes, ai-train=yes

Sitemap: ${SITE}/sitemap.xml
`

const SKILLS_INDEX = {
  $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
  name: 'geography',
  description:
    'Query solar position, daylight hours and twilight times for any point on Earth, or remap a location onto another planet.',
  skills: [
    {
      name: 'query-sunlight',
      type: 'http',
      description:
        'Get sun altitude, bearing, shadow length, sunrise/sunset and daylight hours for a coordinate and instant. Request with Accept: text/markdown for a machine-readable table.',
      url: `${SITE}/?at={lat},{lon}&t={iso8601}`,
    },
    {
      name: 'remap-to-planet',
      type: 'http',
      description:
        "Show what the sun would do at the same latitude on another world, using that planet's real axial tilt, day length and orbital distance.",
      url: `${SITE}/?at={lat},{lon}&on={mars|venus|mercury|jupiter|saturn|uranus|neptune|moon}`,
    },
    {
      name: 'share-card',
      type: 'http',
      description:
        'A 1200x630 share image rendering the solar readings for a location and moment.',
      url: `${SITE}/og.png?at={lat},{lon}&t={iso8601}&name={place}`,
    },
  ],
}
