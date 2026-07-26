# geography

Pin any point on Earth at any moment and see exactly what the sun is doing —
then move that place to Mars, or Uranus, and watch the light change.

**Live: https://geography-globe.op0.workers.dev**

## What it does

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

`scripts/verify-solar.mjs` checks 33 values against published astronomy before
any pixel is drawn: solstice declinations, the equation-of-time extremes,
perihelion/aphelion distance, London's sunrise to the minute, polar day and
night at Tromsø, solar-noon azimuth. `scripts/verify-terrain.mjs` adds 29 more
for the Web Mercator tile maths and terrarium elevation decoding.

```bash
npm run verify        # both suites
```

The harness has earned its keep: it caught a 1.3-minute sunrise error caused by
sampling declination once at solar transit instead of at each event.

## Data sources — all keyless

| Layer | Source | Notes |
| --- | --- | --- |
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen terrarium) | Verified CORS-open. `(R·256 + G + B/256) − 32768` |
| Buildings | [Overpass API](https://overpass-api.de/) | ODbL. 12s per-mirror timeout, three mirrors |
| Search | [Photon](https://photon.komoot.io/) → [Nominatim](https://nominatim.openstreetmap.org/) | ODbL |
| Weather | [Open-Meteo](https://open-meteo.com/) | Measured shortwave radiation vs clear-sky theory |
| Textures | three.js `examples/textures/planets` | MIT |

Mapbox, MapTiler, Nextzen and Google Photorealistic 3D Tiles all require keys —
Google's is $6 per 1,000 tile requests with 1,000 free per month.

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
