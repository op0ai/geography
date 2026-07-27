# AGENTS.md

Guidance for AI coding agents working on **geography** — an interactive globe
that reports what the sun is doing at any point on Earth at any moment, and
remaps that place onto other worlds.

Live: https://opensolar.app
Repo: https://github.com/op0ai/geography

## Setup commands

```bash
npm install
npm run dev        # vite dev server
npm run verify     # 116 checks — RUN THIS BEFORE COMMITTING
npm run build      # production build into dist/
npx wrangler deploy
```

## The one rule that matters here

**The astronomy is verified, not vibed. Never change `src/lib/solar.ts`,
`src/lib/terrain.ts` or `src/lib/sunhours.ts` without running `npm run verify`
and getting 116/116.**

Those three suites check against published values — solstice declinations, the
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
src/lib/sunhours.ts   Ray-traced shading. THE headline feature — see below.
src/lib/vegetation.ts Trees. Canopy FILTERS light, it does not block it.
src/lib/device.ts     Texture tier + dpr, from probed GL limits.
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
src/components/SunHours.tsx     The shading answer, presented.
src/components/ContextGuard.tsx WebGL context loss recovery.

worker/index.ts       Edge layer: per-view OG meta, agent surfaces.
worker/png.ts         Hand-written PNG encoder + glyph rasterizer.
```

## The headline feature: hours of direct sun

`src/lib/sunhours.ts` answers "how much sun does *this exact spot* get?" by
casting a ray at the sun every 10 minutes and testing it against terrain and
building geometry. Everything else in the app is astronomy that's identical for
everyone within a few kilometres; this is the part that's about your balcony.

Two decisions worth preserving:

**It does not use a three.js Raycaster.** Tying the answer to whatever the
renderer happens to have loaded is a bad property for a number people might
plan a garden around, and it would only work while the 3D scene is mounted. The
module is pure — no WebGL, no DOM — so it runs in Node, in a Worker, and in the
tests.

**Buildings are solved analytically, not sampled.** The first version tested
point-in-polygon at each march step and silently missed anything thinner than
the step: walls, fences, narrow terraces — exactly the things that shade a
garden. `polyIntervals()` intersects the ray's ground track with each footprint
and gets the exact distance interval inside it. Since ray height is monotonic
in distance, one overlap test against the prism's vertical extent is exact.

**Rays are clamped at zero altitude.** The −0.833° sunrise convention means
that between −0.833° and 0° the sun is geometrically below the horizon but its
light still reaches you. Marching a downward-sloping ray in that window made a
flat, featureless plain report itself as shaded.

### Vegetation: canopy filters, it does not block

`src/lib/vegetation.ts`. The thing to get right, and the thing a naive
implementation gets wrong, is that **a tree is not a wall**:

| Canopy | Direct beam transmitted |
|---|---|
| Broadleaf in leaf | 0.05 |
| Broadleaf bare | 0.45 |
| Conifer, year-round | 0.10 |

Konarska et al. 2014 (Göteborg, measured, five species); SOLWEIG — the standard
urban radiation model — defaults to 0.03 leaf-on with a leaf season of DOY
97–300. So the engine multiplies by a fraction rather than zeroing, and a
garden under an oak has a genuinely different February from its July. Leaf
season widens toward the equator, flips in the southern hemisphere, and is
disabled inside the tropics.

**97% of OSM trees have no height and 98% no crown**, so geometry is defaulted:
8m/3m crown for broadleaf, 10m/2m for conifer, per open-grown urban allometry.
OSM2World's 0.2 × height crown ratio is too narrow for street trees.

**Tree coverage is a northern-European luxury** — Germany has 4.07M mapped trees
for 84M people, India 111k for 1.4 billion. The count near a point is reported
in the UI as a confidence signal rather than folded silently into a number.

Accuracy limits are stated in the UI, not buried: estimated tree and building
heights, 700 m scene radius, no data where OSM has none.

**When the building lookup fails, the number is withheld.** A terrain-only
result in a city is barely different from raw daylight, so showing it as a
shading figure would be a confident lie. `buildingsFailed` is threaded from the
Overpass client all the way to the headline for exactly this reason — "OSM has
nothing here" and "OSM didn't answer" are different facts and must read
differently.

Sanity-checked against real OSM geometry at the winter solstice: Midtown
Manhattan 0% of available daylight at street level, Trafalgar Square 74%,
Champ de Mars 90%, open farmland 100%.

## Mobile: the memory ceiling is the whole story

Three 4096×2048 textures decode to 134 MB of GPU memory, and iOS Safari kills
the tab somewhere around 256 MB of total canvas memory — silently, with no
catchable event. That was "crashes on iPad".

`src/lib/device.ts` probes `MAX_TEXTURE_SIZE` and the renderer string, then
picks a texture tier and a dpr cap. iPad gets 2048 (33 MB) at dpr 1.5;
iPhone gets 1024 (8 MB). MSAA is off on mobile because it multiplies every
render buffer. Together: ~200-260 MB → ~90 MB.

**iPadOS reports itself as "Macintosh".** The only reliable tell is a Mac that
reports `maxTouchPoints > 1`.

`ContextGuard` handles the recoverable case. `preventDefault()` on
`webglcontextlost` is mandatory — without it the context never comes back.

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
| Buildings | Overpass API, via our `/api/buildings` edge proxy | ODbL |
| Search | Photon → Nominatim | ODbL |
| Weather | Open-Meteo | Measured shortwave vs clear-sky theory |
| Textures | three.js `examples/textures/planets` | MIT |

Mapbox, MapTiler, Nextzen and Google Photorealistic 3D Tiles all require keys.
**Don't introduce a keyed dependency without saying so explicitly.**

**Overpass requires `Content-Type: application/x-www-form-urlencoded`.** Worker
`fetch` defaults a string body to `text/plain`, which Overpass accepts and then
fails to parse — returning a **504 that looks like a timeout** rather than the
malformed request it is. This cost a debugging cycle; the header is now explicit
in both the Worker proxy and the direct-mirror fallback.

### Buildings: three cache tiers, because Overpass allows two queries

Overpass rate-limits by **concurrency, not rate**. Its own `/api/status` says
so: `Rate limit: 2`. Every Worker request shares one IP, so the third
simultaneous cold query gets HTTP 406 in half a second. Measured under load:
**only 2 of 8 concurrent cold cities returned at all.**

That is a fair-use limit on a public good, not a bug to engineer around. The
answer is to ask once instead of asking harder:

1. **Edge cache** (`caches.default`) — same colo, ~200ms.
2. **R2** (`BUILDINGS` binding) — anywhere in the world has asked before.
   Permanent; buildings don't move.
3. **Overpass** — only the first person ever to look at this spot.

`scripts/seed-buildings.mjs` pre-populates tiers 1-2 for the curated places,
serially with a 2.5s pause. Run it before any launch or traffic event.

**Do NOT add a background prefetch.** Warming the 700m query inside
`ctx.waitUntil` after serving a 300m one is the obvious next idea and it makes
things dramatically worse — a single cold request went from ~2s to ~37s,
because the warm-up competes for the same two slots as the request that spawned
it. The comment in `worker/index.ts` says this too; please leave it there.

**The client asks for 300m first, then 700m.** The narrow query returns in ~2s
when the wide one times out. They usually agree exactly — but Berlin differed
by **90 minutes**, because a ring of tall blocks sits just past 300m. So the
wide query genuinely matters; it just shouldn't block the first answer.

**Asset routing eats `/api/_*`.** A route named `/api/_r2check` returned an
empty 404 while `/api/buildings` worked fine — underscore-prefixed paths are
treated as hidden assets regardless of `run_worker_first`. Don't prefix Worker
routes with an underscore.

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

`scripts/verify-solar.mjs` (33), `scripts/verify-terrain.mjs` (29) and
`scripts/verify-sunhours.mjs` (54). All transpile the TS with esbuild and run
against independently known values.

The shading suite uses geometry with arithmetic answers rather than snapshots:
a flat plain must equal the astronomical day length exactly; a 20 m wall 20 m
away must cut the sun at atan(20/20) = 45°; east and west walls must shade
mirror-image halves of an equinox day at the equator. Two real bugs came out of
these — the refraction clamp and the thin-wall miss.

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

## The canonical domain is opensolar.app

`workers.dev` stays **enabled** and 301s to `opensolar.app` in the Worker.
Disabling it in config would break every previously shared link, every OG card
already cached by Slack and Twitter, and every indexed URL. The redirect runs
first in `fetch`, before any cache lookup, so a 3xx can never be written into
the cache under a content URL's key.

**Cache keys use a fixed synthetic host** (`https://cache.internal/...`). The
Cache API keys on the full request URL including hostname, so serving two
hostnames would otherwise split every entry in two and orphan the whole cache
when the old name goes away.

**`stale-while-revalidate` and `stale-if-error` are NOT honoured by the Cache
API** — documented, verified. They were removed rather than left in as
decoration implying behaviour we don't get. `s-maxage` drives edge TTL and
`max-age` the browser; both work as expected.

The Cache API needs no configuration and works on every plan and on
workers.dev. The widespread belief that it no-ops there is about `fetch()`'s
`cf: { cacheEverything, cacheKey }` options, which are zone-scoped and partly
Enterprise-gated — a different feature.

## URL state, and the rate limit that bites

Every view is a link, and state is mirrored with `replaceState` — never
`pushState`, which would stack an entry per animation frame.

**But the mirror is throttled to 500ms, and must stay that way.** Every engine
rate-limits history writes far lower than you'd guess: Safari **100 per 30s and
it THROWS**, Firefox and Chromium 200 per 10s. The play loop advances time each
frame, so an unthrottled mirror spends Safari's entire budget in 1.7 seconds and
then raises an uncaught SecurityError; elsewhere the address bar silently stops
updating and shared links go stale. The Copy-link button builds its URL fresh
from live state, so it's exact regardless.

## Deliberately not used

**Cloudflare Sandbox / Containers.** Evaluated and rejected. Sandbox exists to
run untrusted or agent-authored code and full dev environments, per session.
This app's heaviest computation is ~5,300 ray tests for a whole year of sun
hours — milliseconds of float math over typed arrays. Paying a 1-3s container
cold start and per-second billing to run arithmetic that workerd handles
natively would be architecture theatre. Containers also have no GPU as of
mid-2026, so "render the OG card with real three.js" isn't on the table either.

The one latent server-side feature — precomputing sun hours for popular
locations into KV — is a plain Cron Worker job. Its only prerequisite is a pure
PNG decoder to replace the `document.createElement('canvas')` in `terrain.ts`
(~150 lines, mirroring the encoder already in `worker/png.ts`). No container.

## Agent-readable surfaces

- `/llms.txt` — what the site is and how to query it
- `/AGENTS.md` — this file
- `/robots.txt` — current 2026 AI-crawler tokens + Content-Signal
- `/.well-known/agent-skills/index.json` — skill discovery
- `Accept: text/markdown` on `/` — solar readings as a table, no JS required

```bash
curl -H "Accept: text/markdown" \
  "https://opensolar.app/?at=64.1466,-21.9426"
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
