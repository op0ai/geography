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

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

const SITE = 'https://geography-globe.op0.workers.dev'

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

function parseView(url: URL) {
  const at = url.searchParams.get('at')
  let lat = 69.6492
  let lon = 18.9553
  if (at) {
    const [la, lo] = at.split(',').map(Number)
    if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
      lat = la
      lon = lo
    }
  }
  const tRaw = url.searchParams.get('t')
  const t = tRaw && !isNaN(Date.parse(tRaw)) ? new Date(tRaw) : new Date()
  const name = (url.searchParams.get('name') || '').slice(0, 60)
  const country = (url.searchParams.get('in') || '').slice(0, 60)
  const planet = (url.searchParams.get('on') || 'earth').slice(0, 20)
  const ground = url.searchParams.has('ground')
  return { lat, lon, t, name, country, planet, ground }
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

  const title = `${place}${onPlanet} — ${phase.label} · geography`

  const dayLen = times.alwaysUp
    ? 'the sun never sets today'
    : times.alwaysDown
      ? 'the sun never rises today'
      : `${times.dayLengthHours.toFixed(1)} hours of daylight`

  const description =
    `The sun is ${sun.altitude.toFixed(1)}° above the horizon at bearing ` +
    `${sun.azimuth.toFixed(0)}° — ${dayLen}. ` +
    `Sunrise ${fmt(times.sunrise)}, sunset ${fmt(times.sunset)} UTC.`

  // The OG image mirrors the view's own parameters so the card matches the page.
  const og = new URL('/og.png', SITE)
  og.searchParams.set('at', `${v.lat.toFixed(4)},${v.lon.toFixed(4)}`)
  og.searchParams.set('t', v.t.toISOString())
  if (v.name) og.searchParams.set('name', v.name)
  if (v.country) og.searchParams.set('in', v.country)

  const canonical = `${SITE}${url.pathname}${url.search}`

  return { title, description, image: og.toString(), canonical }
}

/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

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
      stat(80, 'Sun altitude', `${sun.altitude.toFixed(1)}°`, tint)
      stat(340, 'Bearing', `${sun.azimuth.toFixed(0)}°`, INK)
      stat(560, 'Daylight',
        times.alwaysUp ? '24h' : times.alwaysDown ? '0h' : `${times.dayLengthHours.toFixed(1)}h`,
        INK)

      text(
        r,
        `Sunrise ${fmt(times.sunrise)}  ·  Sunset ${fmt(times.sunset)} UTC`,
        80,
        560,
        18,
        MUTE,
      )
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

- [Source](https://github.com/arthtyagi/geography)
`

const ROBOTS = `# geography — https://geography-globe.op0.workers.dev
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
