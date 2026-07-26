/**
 * terrain.ts — Web Mercator tiles, elevation, and the local metre frame.
 *
 * Everything the ground scene needs to turn a lat/lon into something you can
 * put in a three.js scene at true physical scale.
 *
 * Data source: AWS Terrain Tiles (elevation-tiles-prod), the Mapzen/Tilezen
 * "terrarium" set. Chosen because it is the only DEM tile service I could
 * verify as BOTH keyless and CORS-open from a browser — confirmed live with
 * `Access-Control-Allow-Origin: *` on 2026-07-26. Mapbox, MapTiler and Nextzen
 * all 401/403 without a token.
 *
 * Public domain for US sources; non-US sources require attribution (see
 * ATTRIBUTION below). Data is frozen at the 2017 build, which is fine —
 * terrain does not move much.
 */

/** Equatorial circumference / 256, the Web Mercator ground-resolution constant. */
export const MERCATOR_K = 156543.03392

export const EARTH_RADIUS = 6378137

export const TERRAIN_ATTRIBUTION =
  'Terrain: AWS Terrain Tiles (Mapzen/Tilezen) · 3DEP, SRTM, GMTED2010, ETOPO1, Copernicus EU-DEM, ArcticDEM, Geoscience Australia, LINZ, Kartverket, INEGI'

export const BUILDING_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)'

/* ------------------------------------------------------------------ */
/* Tile arithmetic                                                     */
/* ------------------------------------------------------------------ */

/** Slippy-map tile x/y containing a lat/lon at a zoom level (fractional). */
export function latLonToTile(lat: number, lon: number, z: number) {
  const n = 2 ** z
  const latRad = (lat * Math.PI) / 180
  return {
    x: ((lon + 180) / 360) * n,
    y:
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n,
  }
}

/** North-west corner of a tile, in lat/lon. */
export function tileToLatLon(x: number, y: number, z: number) {
  const n = 2 ** z
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return { lat: (latRad * 180) / Math.PI, lon: (x / n) * 360 - 180 }
}

/**
 * Ground resolution in metres per pixel.
 * The cos(lat) term is the whole reason Greenland looks enormous on a map:
 * Mercator stretches horizontally with latitude, so a tile covers less real
 * ground the further you are from the equator.
 */
export const metresPerPixel = (lat: number, z: number) =>
  (MERCATOR_K * Math.cos((lat * Math.PI) / 180)) / 2 ** z

/** Physical width of one 256px tile, in metres. */
export const tileSpanMetres = (lat: number, z: number) =>
  metresPerPixel(lat, z) * 256

/* ------------------------------------------------------------------ */
/* The local metre frame                                               */
/* ------------------------------------------------------------------ */

/**
 * A tangent plane anchored at one lat/lon, so the scene has a real origin and
 * three.js units are metres.
 *
 * Deliberately projecting through the SAME Web Mercator maths the DEM tiles
 * use, rather than a generic equirectangular approximation. That guarantees
 * buildings land exactly where the terrain says they should — if the two used
 * different projections they would drift apart across the scene.
 */
export interface LocalFrame {
  lat0: number
  lon0: number
  /** metres per Mercator-pixel at the anchor latitude and zoom */
  scale: number
  z: number
  /** anchor position in fractional tile space */
  tx0: number
  ty0: number
}

export function makeFrame(lat: number, lon: number, z: number): LocalFrame {
  const { x, y } = latLonToTile(lat, lon, z)
  return {
    lat0: lat,
    lon0: lon,
    scale: metresPerPixel(lat, z),
    z,
    tx0: x,
    ty0: y,
  }
}

/**
 * lat/lon → local metres. +X east, +Z south (three.js convention with Y up,
 * so north is -Z).
 */
export function project(
  frame: LocalFrame,
  lat: number,
  lon: number,
): [number, number] {
  const { x, y } = latLonToTile(lat, lon, frame.z)
  return [
    (x - frame.tx0) * 256 * frame.scale,
    (y - frame.ty0) * 256 * frame.scale,
  ]
}

/** The inverse, for turning a scene position back into a real coordinate. */
export function unproject(
  frame: LocalFrame,
  mx: number,
  mz: number,
): { lat: number; lon: number } {
  const x = frame.tx0 + mx / (256 * frame.scale)
  const y = frame.ty0 + mz / (256 * frame.scale)
  return tileToLatLon(x, y, frame.z)
}

/* ------------------------------------------------------------------ */
/* Elevation                                                           */
/* ------------------------------------------------------------------ */

/**
 * Terrarium encoding: a 16-bit integer plus an 8-bit fraction, offset so the
 * Mariana Trench is still positive.
 *   height = (R * 256 + G + B / 256) - 32768
 * Verified against a real tile: RGB(128,3,233) decodes to 3.91 m at a
 * near-sea-level pixel in San Francisco.
 */
export const decodeTerrarium = (r: number, g: number, b: number) =>
  r * 256 + g + b / 256 - 32768

export const TERRAIN_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

/** Terrarium tops out at z15; past that the service 404s. */
export const MAX_TERRAIN_ZOOM = 15

export interface HeightField {
  /** decoded metres, row-major, width x height samples */
  data: Float32Array
  width: number
  height: number
  /** tile coords of the top-left tile in the mosaic */
  tx: number
  ty: number
  z: number
  /** how many tiles across and down */
  cols: number
  rows: number
  min: number
  max: number
}

/**
 * Fetch a mosaic of terrain tiles around a point and decode to metres.
 *
 * `radius` is in tiles: 0 fetches 1 tile, 1 fetches 3x3, 2 fetches 5x5.
 * A 3x3 at z14 is roughly 3km across at mid-latitude, which is the right
 * order for a scene you can walk around in.
 */
export async function loadHeightField(
  lat: number,
  lon: number,
  z: number,
  radius = 1,
  signal?: AbortSignal,
): Promise<HeightField> {
  const zz = Math.min(z, MAX_TERRAIN_ZOOM)
  const t = latLonToTile(lat, lon, zz)
  const cx = Math.floor(t.x)
  const cy = Math.floor(t.y)
  const n = 2 ** zz

  const cols = radius * 2 + 1
  const rows = cols
  const tx = cx - radius
  const ty = cy - radius

  const width = cols * 256
  const height = rows * 256
  const data = new Float32Array(width * height)

  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  let min = Infinity
  let max = -Infinity

  const jobs: Promise<void>[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const X = tx + col
      const Y = ty + row
      // Wrap in X, clamp in Y — the poles have no tiles beyond the edge.
      const wx = ((X % n) + n) % n
      if (Y < 0 || Y >= n) continue

      jobs.push(
        (async () => {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          const url = TERRAIN_URL(zz, wx, Y)
          const ok = await new Promise<boolean>((resolve) => {
            img.onload = () => resolve(true)
            img.onerror = () => resolve(false)
            img.src = url
          })
          if (!ok || signal?.aborted) return

          ctx.clearRect(0, 0, 256, 256)
          ctx.drawImage(img, 0, 0)
          const px = ctx.getImageData(0, 0, 256, 256).data

          for (let py = 0; py < 256; py++) {
            for (let pxi = 0; pxi < 256; pxi++) {
              const o = (py * 256 + pxi) * 4
              const h = decodeTerrarium(px[o], px[o + 1], px[o + 2])
              const gx = col * 256 + pxi
              const gy = row * 256 + py
              data[gy * width + gx] = h
              if (h < min) min = h
              if (h > max) max = h
            }
          }
        })(),
      )
    }
  }

  await Promise.all(jobs)

  return {
    data,
    width,
    height,
    tx,
    ty,
    z: zz,
    cols,
    rows,
    min: isFinite(min) ? min : 0,
    max: isFinite(max) ? max : 0,
  }
}

/**
 * Bilinearly sample the height field at a lat/lon.
 * Bilinear rather than nearest because buildings sit on this: nearest-neighbour
 * sampling makes them visibly step between DEM pixels on a slope.
 */
export function sampleHeight(hf: HeightField, lat: number, lon: number): number {
  const t = latLonToTile(lat, lon, hf.z)
  const fx = (t.x - hf.tx) * 256
  const fy = (t.y - hf.ty) * 256

  if (fx < 0 || fy < 0 || fx >= hf.width - 1 || fy >= hf.height - 1) {
    const cx = Math.max(0, Math.min(hf.width - 1, Math.round(fx)))
    const cy = Math.max(0, Math.min(hf.height - 1, Math.round(fy)))
    return hf.data[cy * hf.width + cx] ?? 0
  }

  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const dx = fx - x0
  const dy = fy - y0

  const h00 = hf.data[y0 * hf.width + x0]
  const h10 = hf.data[y0 * hf.width + x0 + 1]
  const h01 = hf.data[(y0 + 1) * hf.width + x0]
  const h11 = hf.data[(y0 + 1) * hf.width + x0 + 1]

  return (
    h00 * (1 - dx) * (1 - dy) +
    h10 * dx * (1 - dy) +
    h01 * (1 - dx) * dy +
    h11 * dx * dy
  )
}

/** Sample directly in the local metre frame — used when building the mesh. */
export function sampleHeightLocal(
  hf: HeightField,
  frame: LocalFrame,
  mx: number,
  mz: number,
): number {
  const { lat, lon } = unproject(frame, mx, mz)
  return sampleHeight(hf, lat, lon)
}
