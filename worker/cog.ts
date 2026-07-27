/**
 * cog.ts — reading canopy height out of a 22-terabyte GeoTIFF, a few kilobytes
 * at a time.
 *
 * ## Why this file exists
 *
 * OpenStreetMap knows about 34 million individual trees, which sounds like a
 * lot until you look at where they are: Germany has 4.07M for 84 million
 * people, India has 111k for 1.4 billion. So the OSM vegetation layer makes
 * the shading answer meaningfully better in Cologne and does nothing at all in
 * Lagos. That's a real hole in a tool that claims to work anywhere.
 *
 * Meta and WRI published a global canopy height map at ~1.19 m/pixel, derived
 * from satellite imagery, CC-BY-4.0. It covers every landmass except Greenland
 * and Antarctica. Taylor Geospatial mirror it on Source Cooperative as
 * Cloud-Optimized GeoTIFFs with CORS enabled and byte-range support — which is
 * the only reason this is possible without a key or a tile server.
 *
 * ## Why a hand-written reader
 *
 * `geotiff.js` would do this. It's also ~100 KB into a Worker bundle to parse
 * one very specific, entirely predictable file layout. Everything about these
 * COGs is fixed and verified: classic TIFF, little-endian, 32768², uint8,
 * 512×512 tiles, Deflate, one sample per pixel. The parser below handles
 * exactly that and refuses anything else rather than silently misreading it.
 *
 * There is already a hand-written PNG *encoder* in `worker/png.ts` for the OG
 * cards; this is the same trade for the same reason.
 *
 * ## The access pattern
 *
 * A full-resolution tile is ~100 MB. We never fetch one. Instead:
 *
 *   1. One range request for the first 128 KB — the IFD plus the tile offset
 *      and byte-count tables (4096 entries each, 16 KB apiece).
 *   2. One range request per 512×512 image tile that the scene actually
 *      overlaps — typically 4 to 9 of them, ~50 KB each compressed.
 *
 * So a 1.4 km scene costs about half a megabyte instead of a hundred, and the
 * result is cached in R2 forever afterwards because canopy doesn't move.
 *
 * Verified against the real file before any of this was written: the Vondelpark
 * in Amsterdam reads 17 m of canopy at its centre, 36 m maximum, 60% of the
 * surrounding 611 m square covered. Those are correct numbers for that park.
 */

/* ------------------------------------------------------------------ */
/* the file layout we accept                                           */
/* ------------------------------------------------------------------ */

/** Deflate. The only compression these COGs use. */
const COMPRESSION_DEFLATE = 8
/** Adobe's variant of the same, seen in some GDAL output. */
const COMPRESSION_DEFLATE_ADOBE = 32946

const TAG = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  SamplesPerPixel: 277,
  Predictor: 317,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SampleFormat: 339,
  PixelScale: 33550,
  Tiepoint: 33922,
} as const

export interface CogHeader {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
  tilesAcross: number
  compression: number
  predictor: number
  /** metres per pixel — 1.194329 for these */
  scale: number
  /** EPSG:3857 coordinate of the raster's top-left corner */
  originX: number
  originY: number
  tileOffsets: Uint32Array
  tileByteCounts: Uint32Array
}

/**
 * Parse enough of a TIFF header to locate tiles.
 *
 * Deliberately strict. A canopy height that's silently wrong is worse than an
 * error, because it feeds a number people plan around — so every assumption
 * about the format is asserted rather than hoped for.
 */
export function parseCogHeader(buf: ArrayBuffer): CogHeader {
  const dv = new DataView(buf)

  const bo = dv.getUint16(0, false)
  if (bo !== 0x4949) throw new Error('cog: expected little-endian TIFF')
  const magic = dv.getUint16(2, true)
  if (magic !== 42) throw new Error(`cog: expected classic TIFF, got magic ${magic}`)

  const ifd = dv.getUint32(4, true)
  const count = dv.getUint16(ifd, true)

  const scalars = new Map<number, number>()
  const pointers = new Map<number, { offset: number; count: number; type: number }>()

  const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8 }

  for (let i = 0; i < count; i++) {
    const p = ifd + 2 + i * 12
    const tag = dv.getUint16(p, true)
    const type = dv.getUint16(p + 2, true)
    const n = dv.getUint32(p + 4, true)
    const size = (TYPE_SIZE[type] ?? 1) * n

    if (size <= 4) {
      // Value is inline in the entry.
      const v =
        type === 1 ? dv.getUint8(p + 8) : type === 3 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true)
      scalars.set(tag, v)
    } else {
      pointers.set(tag, { offset: dv.getUint32(p + 8, true), count: n, type })
    }
  }

  const need = (tag: number, what: string): number => {
    const v = scalars.get(tag)
    if (v === undefined) throw new Error(`cog: missing ${what}`)
    return v
  }

  const width = need(TAG.ImageWidth, 'ImageWidth')
  const height = need(TAG.ImageLength, 'ImageLength')
  const bits = need(TAG.BitsPerSample, 'BitsPerSample')
  const compression = need(TAG.Compression, 'Compression')
  const samples = scalars.get(TAG.SamplesPerPixel) ?? 1
  const tileWidth = need(TAG.TileWidth, 'TileWidth')
  const tileHeight = need(TAG.TileLength, 'TileLength')
  const predictor = scalars.get(TAG.Predictor) ?? 1

  if (bits !== 8) throw new Error(`cog: expected 8-bit samples, got ${bits}`)
  if (samples !== 1) throw new Error(`cog: expected 1 sample per pixel, got ${samples}`)
  if (compression !== COMPRESSION_DEFLATE && compression !== COMPRESSION_DEFLATE_ADOBE) {
    throw new Error(`cog: unsupported compression ${compression}`)
  }

  // Geo-referencing. ModelPixelScale is three doubles (x, y, z); ModelTiepoint
  // is six (raster i,j,k then world x,y,z). We only need the first of each.
  const scalePtr = pointers.get(TAG.PixelScale)
  const tiePtr = pointers.get(TAG.Tiepoint)
  if (!scalePtr || !tiePtr) throw new Error('cog: missing geo-referencing tags')
  const scale = dv.getFloat64(scalePtr.offset, true)
  const originX = dv.getFloat64(tiePtr.offset + 24, true)
  const originY = dv.getFloat64(tiePtr.offset + 32, true)

  const offPtr = pointers.get(TAG.TileOffsets)
  const cntPtr = pointers.get(TAG.TileByteCounts)
  if (!offPtr || !cntPtr) throw new Error('cog: missing tile tables')

  const n = offPtr.count
  const tileOffsets = new Uint32Array(n)
  const tileByteCounts = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    tileOffsets[i] = dv.getUint32(offPtr.offset + i * 4, true)
    tileByteCounts[i] = dv.getUint32(cntPtr.offset + i * 4, true)
  }

  return {
    width,
    height,
    tileWidth,
    tileHeight,
    tilesAcross: Math.ceil(width / tileWidth),
    compression,
    predictor,
    scale,
    originX,
    originY,
    tileOffsets,
    tileByteCounts,
  }
}

/* ------------------------------------------------------------------ */
/* decoding a tile                                                     */
/* ------------------------------------------------------------------ */

/**
 * Inflate one Deflate-compressed image tile.
 *
 * `DecompressionStream` is native in workerd, so no inflate implementation is
 * needed here. The horizontal predictor, if present, has to be undone by hand:
 * it stores each byte as the difference from its left neighbour, which
 * compresses better but means the raw output is a row of deltas, not values.
 */
export async function decodeTile(
  bytes: ArrayBuffer,
  header: CogHeader,
): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(
    new DecompressionStream('deflate'),
  )
  const out = new Uint8Array(await new Response(stream).arrayBuffer())

  const expected = header.tileWidth * header.tileHeight
  if (out.length !== expected) {
    throw new Error(`cog: tile decoded to ${out.length}, expected ${expected}`)
  }

  // Predictor 2 = horizontal differencing. Undo it row by row.
  if (header.predictor === 2) {
    const w = header.tileWidth
    for (let row = 0; row < header.tileHeight; row++) {
      const base = row * w
      for (let i = 1; i < w; i++) {
        out[base + i] = (out[base + i] + out[base + i - 1]) & 0xff
      }
    }
  }

  return out
}

/* ------------------------------------------------------------------ */
/* quadkeys and projection                                             */
/* ------------------------------------------------------------------ */

/**
 * Bing quadkey for a lat/lon at a zoom level.
 *
 * Meta names each full-resolution COG by its z10 quadkey, so this is how a
 * coordinate becomes a filename. The maths is the standard slippy-map tile
 * derivation, identical to what `terrain.ts` already does for elevation tiles —
 * kept separate here because the Worker can't import from `src/`.
 */
export function quadkey(lat: number, lon: number, z: number): string {
  const latRad = (lat * Math.PI) / 180
  const n = 1 << z
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  )

  let qk = ''
  for (let i = z; i > 0; i--) {
    let d = 0
    const mask = 1 << (i - 1)
    if (x & mask) d += 1
    if (y & mask) d += 2
    qk += String(d)
  }
  return qk
}

/** WGS84 lat/lon → EPSG:3857 metres. */
export function toMercator(lat: number, lon: number): { x: number; y: number } {
  const R = 6378137
  return {
    x: R * ((lon * Math.PI) / 180),
    y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  }
}

/* ------------------------------------------------------------------ */
/* the sampler                                                         */
/* ------------------------------------------------------------------ */

const MIRROR = 'https://data.source.coop/tge-labs/meta-chm-v2'

/** How much of the file to grab for the header + tile tables. */
const HEADER_BYTES = 131072

async function rangeFetch(url: string, start: number, end: number): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`cog: range request returned ${res.status}`)
  }
  return res.arrayBuffer()
}

export interface CanopyGrid {
  /** heights in metres, row-major */
  data: Uint8Array
  /** samples across and down */
  size: number
  /** metres covered per sample */
  step: number
  /** centre of the grid, in local metres relative to the scene origin */
  radius: number
  /** fraction of samples with any canopy at all */
  cover: number
  /** tallest thing found */
  max: number
}

/**
 * Build a canopy height grid around a point.
 *
 * Resampled onto a regular grid in local metres rather than returned as raw
 * pixels, because that's the shape the shading engine wants — it already
 * thinks in metres east and south of where you're standing, exactly like the
 * terrain height field it walks alongside.
 *
 * `step` is 4 m rather than the native 1.19 m deliberately. At garden scale
 * the difference is invisible against building heights guessed to the nearest
 * storey, and it makes the payload 11× smaller: a 1.4 km scene becomes a
 * 351×351 grid, ~120 KB, instead of 1.4 MB.
 */
export async function sampleCanopy(
  lat: number,
  lon: number,
  radiusMetres: number,
  step = 4,
): Promise<CanopyGrid> {
  const qk = quadkey(lat, lon, 10)
  const url = `${MIRROR}/chm/${qk}.tif`

  const header = parseCogHeader(await rangeFetch(url, 0, HEADER_BYTES - 1))

  // Where the scene sits inside this COG, in its own pixel space.
  const centre = toMercator(lat, lon)

  /*
   * Web Mercator distorts with latitude: one projected metre is one real metre
   * only at the equator, and 1/cos(lat) of one everywhere else. At 52°N that's
   * a 1.6× error — a 700 m scene would read 1140 m of imagery if this were
   * ignored, and every tree would land in the wrong place.
   */
  const mercPerMetre = 1 / Math.cos((lat * Math.PI) / 180)
  const halfMerc = radiusMetres * mercPerMetre

  const size = Math.floor((radiusMetres * 2) / step) + 1

  // Which image tiles does that square touch?
  const pxOf = (mx: number) => (mx - header.originX) / header.scale
  const pyOf = (my: number) => (header.originY - my) / header.scale

  const px0 = pxOf(centre.x - halfMerc)
  const px1 = pxOf(centre.x + halfMerc)
  const py0 = pyOf(centre.y + halfMerc)
  const py1 = pyOf(centre.y - halfMerc)

  const tx0 = Math.max(0, Math.floor(px0 / header.tileWidth))
  const tx1 = Math.min(header.tilesAcross - 1, Math.floor(px1 / header.tileWidth))
  const ty0 = Math.max(0, Math.floor(py0 / header.tileHeight))
  const ty1 = Math.min(header.tilesAcross - 1, Math.floor(py1 / header.tileHeight))

  // Fetch each overlapping tile once, in parallel. Typically 4-9 tiles.
  const tiles = new Map<number, Uint8Array>()
  const jobs: Promise<void>[] = []
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const idx = ty * header.tilesAcross + tx
      const off = header.tileOffsets[idx]
      const len = header.tileByteCounts[idx]
      // A zero-length tile is a legitimate "nothing here" in a sparse COG.
      if (!len) continue
      jobs.push(
        rangeFetch(url, off, off + len - 1)
          .then((buf) => decodeTile(buf, header))
          .then((px) => {
            tiles.set(idx, px)
          })
          .catch(() => {
            /* one missing tile shouldn't fail the whole grid */
          }),
      )
    }
  }
  await Promise.all(jobs)

  // Resample onto the local-metre grid.
  const data = new Uint8Array(size * size)
  let covered = 0
  let max = 0

  for (let row = 0; row < size; row++) {
    // Grid row 0 is the northern edge; +Z is south in the scene's convention.
    const north = radiusMetres - row * step
    const my = centre.y + north * mercPerMetre
    const py = pyOf(my)
    const ty = Math.floor(py / header.tileHeight)
    const inTileY = Math.floor(py) % header.tileHeight

    for (let col = 0; col < size; col++) {
      const east = -radiusMetres + col * step
      const mx = centre.x + east * mercPerMetre
      const px = pxOf(mx)
      const tx = Math.floor(px / header.tileWidth)

      const tile = tiles.get(ty * header.tilesAcross + tx)
      if (!tile) continue

      const inTileX = Math.floor(px) % header.tileWidth
      const h = tile[inTileY * header.tileWidth + inTileX]
      if (h > 0) {
        covered++
        if (h > max) max = h
      }
      data[row * size + col] = h
    }
  }

  return {
    data,
    size,
    step,
    radius: radiusMetres,
    cover: covered / (size * size),
    max,
  }
}
