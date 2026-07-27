# geography

Pin any point on Earth at any moment and see exactly what the sun is doing —
then move that place to Mars, or Uranus, and watch the light change.

**Live: https://geography-globe.op0.workers.dev**

## What it does

- **How much sun does *this exact spot* get?** The headline. Every other tool
  tells you where the sun is — which is the same for everyone within a few
  kilometres. This casts a ray at the sun every ten minutes and tests it
  against the terrain and the actual OpenStreetMap buildings around you, then
  tells you how many hours of direct sun that specific point receives, when
  those hours fall, and what's taking the rest. Then the same figure for every
  week of the year, because the question is usually about February and you
  can't answer February by standing outside in July.

  Checked against real geometry at the winter solstice: Midtown Manhattan gets
  **0%** of available daylight at street level, Trafalgar Square 74%, the
  Champ de Mars 90%, open farmland 100%.

  When the building data doesn't load, the number is **withheld** rather than
  shown. A terrain-only figure in a city is barely different from raw daylight,
  and presenting it as a shading answer would be a confident lie.

- **Earth mode.** A real place, a real moment, the real sun. Altitude, bearing,
  shadow length, and the full ladder of light from astronomical dawn through
  golden hour. The day/night terminator is not drawn — it emerges from a single
  uniform (the subsolar vector) compared against each fragment's normal, so the
  curve is correct at every latitude and season.
- **Elsewhere.** The same latitude transplanted to another world, with that
  planet's axial tilt, day length, and distance from the sun. Tromsø gets polar
  night on Earth; on Uranus the sun sits 77° overhead and never sets.
- **Ground mode.** Zoom into the pin and the globe hands off to a real 3D scene
  of that location — actual terrain elevation and actual OpenStreetMap
  buildings, lit by the same sun vector, casting the shadows that place would
  really cast at that moment.

## The astronomy is verified, not vibed

95 checks against values known independently of this code.

`scripts/verify-solar.mjs` (33) checks published astronomy before any pixel is
drawn: solstice declinations, the equation-of-time extremes, perihelion and
aphelion distance, London's sunrise to the minute, polar day and night at
Tromsø, solar-noon azimuth. `scripts/verify-terrain.mjs` (29) covers the Web
Mercator tile maths and terrarium elevation decoding.

`scripts/verify-sunhours.mjs` (33) checks the shading engine using geometry
with arithmetic answers rather than snapshots of its own output:

- a flat, featureless plain must equal the astronomical day length *exactly*
- a 20 m wall 20 m away must cut the sun at `atan(20/20)` = 45°
- east and west walls must shade mirror-image halves of an equinox at the equator
- a walled courtyard must get nothing; a polar winter must not divide by zero

```bash
npm run verify        # all three suites
```

The harness has earned its keep three times over. It caught a 1.3-minute
sunrise error from sampling declination once at solar transit instead of at
each event; a refraction bug that made a flat plain report itself as shaded;
and a ray march that stepped straight over walls thinner than its own step
size — which is to say, over most garden fences.

## Data sources — all keyless

| Layer | Source | Notes |
| --- | --- | --- |
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen terrarium) | Verified CORS-open. `(R·256 + G + B/256) − 32768` |
| Buildings | [Overpass API](https://overpass-api.de/), proxied and cached at our own edge | ODbL |
| Search | [Photon](https://photon.komoot.io/) → [Nominatim](https://nominatim.openstreetmap.org/) | ODbL |
| Weather | [Open-Meteo](https://open-meteo.com/) | Measured shortwave radiation vs clear-sky theory |
| Textures | three.js `examples/textures/planets` | MIT |

Mapbox, MapTiler, Nextzen and Google Photorealistic 3D Tiles all require keys —
Google's is $6 per 1,000 tile requests with 1,000 free per month.

## How the shading works

`src/lib/sunhours.ts`. Two decisions worth knowing about:

**It doesn't use a three.js `Raycaster`.** Tying the answer to whatever the
renderer happens to have loaded is a bad property for a number someone might
plan a garden around, and it would only work while the 3D scene is mounted. The
module is pure — no WebGL, no DOM — so it runs in Node, in a Worker, and under
test.

**Buildings are solved analytically, not sampled.** The first version tested
point-in-polygon at each march step and silently missed anything thinner than
the step. `polyIntervals()` intersects the ray's ground track with each
footprint for the exact interval spent inside it; since ray height is monotonic
in distance, one overlap test against the prism's vertical extent is exact.

### What it can't see

Stated in the UI, not buried in a footnote:

- **No trees.** OpenStreetMap has building footprints, not vegetation. A tree
  next door will shade you and this won't know.
- **Estimated heights.** Where OSM has no tagged height, it's inferred from
  storey count at 3 m each. The UI reports how many of your neighbours were
  guessed.
- **700 metre radius.** A distant ridge or tower can be missed at very low sun.
- **Clear-sky geometry**, not a forecast.

## Stack

React 19 · three 0.185 · @react-three/fiber 9.6 · @react-three/drei 10.7 ·
Tailwind v4 · Vite · deployed to Cloudflare Workers.

## For AI agents

See [AGENTS.md](./AGENTS.md) — setup, the verification suites, and the design
decisions that were bugs first. Also served live at
[/AGENTS.md](https://geography-globe.op0.workers.dev/AGENTS.md).

## Development

```bash
npm install
npm run dev
npm run verify
npm run build
npx wrangler deploy
```

## Attribution

Terrain: AWS Terrain Tiles (3DEP, SRTM, GMTED2010, ETOPO1, Copernicus EU-DEM,
ArcticDEM, Geoscience Australia, LINZ, Kartverket, INEGI).
Buildings, search: © OpenStreetMap contributors (ODbL).
