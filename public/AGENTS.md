# AGENTS.md

Guidance for AI coding agents working on **geography** — an interactive globe
that reports what the sun is doing at any point on Earth at any moment, and
remaps that place onto other worlds.

Live: https://geography-globe.op0.workers.dev
Repo: https://github.com/op0ai/geography

## Setup commands

```bash
npm install
npm run dev        # vite dev server
npm run verify     # 62 checks — RUN THIS BEFORE COMMITTING
npm run build      # production build into dist/
npx wrangler deploy
```

## The one rule that matters here

**The astronomy is verified, not vibed. Never change `src/lib/solar.ts` or
`src/lib/terrain.ts` without running `npm run verify` and getting 62/62.**

Those two suites check against published values — solstice declinations, the
equation-of-time extremes, London's sunrise to the minute, polar day and night
at Tromsø, Web Mercator ground resolution, terrarium elevation decoding. They
have already caught a real 1.3-minute sunrise error that no amount of reading
the code would have surfaced. If a change makes a test fail, the change is
wrong until proven otherwise — check the test's cited source before editing it.

A test was wrong exactly once (an asserted tile y-coordinate). It was corrected
only after an independent Python implementation *and* AWS's own imagery metadata
both disagreed with it. That's the bar for editing an assertion.

## Architecture

```
src/lib/solar.ts      NOAA/Meeus solar position. Hand-rolled, no suncalc.
src/lib/planets.ts    Real obliquity/day-length/irradiance for 8 worlds + Moon.
src/lib/terrain.ts    Web Mercator tiles + terrarium elevation decode.
src/lib/buildings.ts  Overpass client, multipolygon ring stitching.
src/lib/geocode.ts    Photon → Nominatim, both keyless.
src/lib/weather.ts    Open-Meteo measured shortwave radiation.
src/lib/motion.ts     Motion tiers. Use these, don't hand-write durations.
src/lib/urlstate.ts   Every view is a shareable URL.

src/components/Globe.tsx    Earth shader. Terminator emerges from a uniform.
src/components/Ground.tsx   Terrain mesh, extruded buildings, sky, sun disc.
src/components/Scene.tsx    Canvas, mode switching, cameras.
src/components/LookControls.tsx  Ground-mode free-look (NOT OrbitControls).
src/components/Descent.tsx  Globe→ground transition.

worker/index.ts       Edge layer: per-view OG meta, agent surfaces.
worker/png.ts         Hand-written PNG encoder + glyph rasterizer.
```

## Why things are the way they are

Each of these was a bug once. Please don't undo them.

**No `suncalc` dependency.** It shipped a v2 rewrite that flipped altitude to
degrees and azimuth from south-based to north-based. More importantly, the same
equation serves the planetary remap — `sin(alt) = sinφ·sinδ + cosφ·cosδ·cosH`
is identical on every world; only δ and day length change.

**The globe shader must keep its Lambert term.** `dayMix` saturates at 1.0 once
`sunDot > 0.22`. Without multiplying by the cosine, the whole day hemisphere
renders at identical brightness and the globe looks lit from every direction.

**The atmosphere shell is `FrontSide`, not `BackSide`.** BackSide renders the
far hemisphere, which with additive blending composites over the planet and
floods its centre with white.

**Ground mode uses `LookControls`, not `OrbitControls`.** Orbit always aims at a
fixed target, so the view can never tilt above horizontal — you physically
cannot look up at the sky. Raising `maxPolarAngle` only buries the camera.

**`gl_PointSize` constants are in scene units.** The globe has radius 1. A
constant tuned for a 300-unit scene produced 400-pixel city markers.

**Texture channels in `earth_bump_roughness_clouds_4096.jpg`:** R = bump,
G = roughness (0 ocean, 1 land), B = clouds. Reading clouds off G paints every
continent white.

**three r152+ colour management:** albedo maps (day/night/clouds) must be
`SRGBColorSpace`; data maps (normal/bump/specular) stay linear.

## Data sources — all keyless, all verified from a browser

| Layer | Source | Note |
|---|---|---|
| Elevation | AWS Terrain Tiles (terrarium) | CORS-open. `(R·256 + G + B/256) − 32768` |
| Buildings | Overpass API | ODbL. 12s per-mirror timeout, 3 mirrors |
| Search | Photon → Nominatim | ODbL |
| Weather | Open-Meteo | Measured shortwave vs clear-sky theory |
| Textures | three.js `examples/textures/planets` | MIT |

Mapbox, MapTiler, Nextzen and Google Photorealistic 3D Tiles all require keys.
**Don't introduce a keyed dependency without saying so explicitly.**

Note: Overpass returns 406/504 through some sandbox egress proxies but works
fine from a real browser. Verify network claims from the browser, not curl.

## Motion

Use the tiers in `src/lib/motion.ts`. Never hand-write a duration.

- `spring.fast` (0.08s) — icons, toggles, counters
- `spring.moderate` (0.16s) — panels, dropdowns
- `spring.slow` (0.24s, bounce 0.12) — overlays, the only tier with bounce
- Exits are one tier quicker, plain tween, no bounce
- Shared curve: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`

**Never animate keyboard-initiated actions.** The `/` search shortcut is used
often enough that motion makes it feel slow.

Camera moves are exempt from the 300ms UI budget — the descent runs 1.15s
deliberately.

## Testing

```bash
npm run verify
```

`scripts/verify-solar.mjs` (33) and `scripts/verify-terrain.mjs` (29). Both
transpile the TS with esbuild and run against published astronomical values.

Add a case whenever you touch the maths. Prefer an independently sourced
expected value over one produced by the code under test.

## Deployment

Cloudflare Workers, worker name `geography-globe`.

**Never rename the worker without checking existing scripts on the account** —
a multipart PUT to `/workers/scripts/{name}` replaces the entire bindings list.

`wrangler.jsonc` sets `assets.run_worker_first` for `/`, `/og.png`, `/llms.txt`,
`/robots.txt` and `/.well-known/*`. Without it, static assets short-circuit the
Worker and per-view OG injection silently stops working.

Cloudflare image resizing is **not** available on workers.dev, which is why
`worker/png.ts` exists.

## Agent-readable surfaces

- `/llms.txt` — what the site is and how to query it
- `/AGENTS.md` — this file
- `/robots.txt` — current 2026 AI-crawler tokens + Content-Signal
- `/.well-known/agent-skills/index.json` — skill discovery
- `Accept: text/markdown` on `/` — solar readings as a table, no JS required

```bash
curl -H "Accept: text/markdown" \
  "https://geography-globe.op0.workers.dev/?at=64.1466,-21.9426"
```

Every view is addressable: `?at=LAT,LON&t=ISO8601&on=PLANET&ground=1`.

## Code style

TypeScript strict. Tailwind v4 with `source(none)` — if you add a component
that ships, add an `@source` line in `src/styles.css` or its classes won't
compile.

Comments explain **why**, especially where the obvious approach was tried and
failed. Most comments in this codebase are load-bearing bug history.

## Attribution

Terrain: AWS Terrain Tiles (3DEP, SRTM, GMTED2010, ETOPO1, Copernicus EU-DEM,
ArcticDEM, Geoscience Australia, LINZ, Kartverket, INEGI).
Buildings and search: © OpenStreetMap contributors (ODbL).
