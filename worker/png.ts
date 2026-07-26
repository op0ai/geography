/**
 * png.ts — a minimal PNG encoder, written from scratch.
 *
 * Why this exists: social platforms reject SVG OG images outright (verified
 * across Twitter, Slack, Discord, iMessage, WhatsApp, LinkedIn, Facebook), so
 * /og.png must return a genuine raster. The usual routes were both closed:
 *
 *   • Cloudflare image resizing — not available on workers.dev subdomains
 *     (verified: /cdn-cgi/image/... returns 404 here).
 *   • resvg / Satori WASM — ~2MB into the Worker bundle, plus workerd's
 *     restriction that WASM must be a statically-imported WebAssembly.Module.
 *
 * So the card is drawn with a tiny software rasterizer instead. It only needs
 * to do what the card actually uses: filled rectangles, circles, arcs, lines,
 * and text from a compact built-in vector font. That fits in a few KB.
 *
 * PNG output is a valid non-interlaced RGB8 image using stored (uncompressed)
 * DEFLATE blocks, so no zlib is required — just the CRC32 and Adler32 that
 * the format mandates.
 */

/* ------------------------------------------------------------------ */
/* Canvas                                                              */
/* ------------------------------------------------------------------ */

export class Raster {
  readonly w: number
  readonly h: number
  /** RGB, row-major, 3 bytes per pixel */
  readonly px: Uint8Array

  constructor(w: number, h: number, bg: [number, number, number] = [0, 0, 0]) {
    this.w = w
    this.h = h
    this.px = new Uint8Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      this.px[i * 3] = bg[0]
      this.px[i * 3 + 1] = bg[1]
      this.px[i * 3 + 2] = bg[2]
    }
  }

  /** Alpha-blend a single pixel. */
  blend(x: number, y: number, c: [number, number, number], a = 1) {
    if (a <= 0) return
    const xi = x | 0
    const yi = y | 0
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return
    const i = (yi * this.w + xi) * 3
    const t = a > 1 ? 1 : a
    this.px[i] += (c[0] - this.px[i]) * t
    this.px[i + 1] += (c[1] - this.px[i + 1]) * t
    this.px[i + 2] += (c[2] - this.px[i + 2]) * t
  }

  rect(x: number, y: number, w: number, h: number, c: [number, number, number], a = 1) {
    const x0 = Math.max(0, x | 0)
    const y0 = Math.max(0, y | 0)
    const x1 = Math.min(this.w, (x + w) | 0)
    const y1 = Math.min(this.h, (y + h) | 0)
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c, a)
  }

  /** Rounded rect — used for the phase chip. */
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    c: [number, number, number],
    a = 1,
  ) {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const dx = Math.min(xx, w - 1 - xx)
        const dy = Math.min(yy, h - 1 - yy)
        if (dx < r && dy < r) {
          const d = Math.hypot(r - dx, r - dy)
          if (d > r) continue
          const edge = Math.max(0, Math.min(1, r - d + 0.5))
          this.blend(x + xx, y + yy, c, a * edge)
        } else {
          this.blend(x + xx, y + yy, c, a)
        }
      }
    }
  }

  /** Anti-aliased filled disc. */
  disc(cx: number, cy: number, r: number, c: [number, number, number], a = 1) {
    const x0 = Math.max(0, Math.floor(cx - r - 1))
    const x1 = Math.min(this.w, Math.ceil(cx + r + 1))
    const y0 = Math.max(0, Math.floor(cy - r - 1))
    const y1 = Math.min(this.h, Math.ceil(cy + r + 1))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        const cov = Math.max(0, Math.min(1, r - d + 0.5))
        if (cov > 0) this.blend(x, y, c, a * cov)
      }
    }
  }

  /** Radial glow, alpha falling off with a soft power curve. */
  glow(cx: number, cy: number, r: number, c: [number, number, number], peak = 0.5) {
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(this.w, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(this.h, Math.ceil(cy + r))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / r
        if (d >= 1) continue
        this.blend(x, y, c, peak * Math.pow(1 - d, 2.2))
      }
    }
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    c: [number, number, number],
    width = 1,
    a = 1,
  ) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = x0 + (x1 - x0) * t
      const y = y0 + (y1 - y0) * t
      if (width <= 1) this.blend(x, y, c, a)
      else this.disc(x, y, width / 2, c, a)
    }
  }

  /** Upper semicircle outline — the sky dome on the card. */
  arc(
    cx: number,
    cy: number,
    r: number,
    from: number,
    to: number,
    c: [number, number, number],
    width = 1,
    a = 1,
  ) {
    const steps = Math.ceil(Math.abs(to - from) * r)
    for (let i = 0; i <= steps; i++) {
      const th = from + ((to - from) * i) / steps
      this.disc(cx + Math.cos(th) * r, cy + Math.sin(th) * r, width / 2, c, a)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/**
 * Real glyph outlines, subset from DejaVu Sans.
 *
 * The first version used a hand-drawn stroke font, which couldn't render 'ø'
 * — so "Tromsø" came out as "TROMS". Place names are exactly the content this
 * card exists to show, and most of the interesting ones outside English carry
 * a diacritic. Latin-1 + Latin Extended-A covers essentially all of Europe.
 *
 * Filled with a scanline even-odd fill and 3x vertical supersampling, which is
 * enough anti-aliasing at card sizes.
 */
import FONT from './font-data.json'

type Glyph = { a: number; c: number[][][] }
type Face = Record<string, Glyph>

const FACES: Record<'regular' | 'bold', Face> = FONT as any

function glyph(ch: string, bold: boolean): Glyph | undefined {
  const face = FACES[bold ? 'bold' : 'regular']
  return face[ch] ?? FACES.regular[ch]
}

export function measure(s: string, size: number, bold = false) {
  let w = 0
  for (const ch of s) w += (glyph(ch, bold)?.a ?? 0.5) * size
  return w
}

/**
 * Draw a string. `size` is the em size in pixels, `y` the baseline.
 * Letter-spacing is in em units.
 */
export function text(
  r: Raster,
  s: string,
  x: number,
  y: number,
  size: number,
  c: [number, number, number],
  bold = false,
  a = 1,
  tracking = 0,
) {
  let cx = x
  for (const ch of s) {
    const g = glyph(ch, bold)
    if (!g) continue
    if (g.c.length) fillGlyph(r, g, cx, y, size, c, a)
    cx += g.a * size + tracking * size
  }
  return cx - x
}

/**
 * Scanline fill of a glyph's contours, NONZERO winding.
 *
 * Even-odd looked right for simple letters but shredded anything with a
 * counter — 'o', 'e', 'g', '0' came out as torn fragments. TrueType contours
 * are wound deliberately: outer paths one direction, holes the other, and the
 * format expects nonzero. Counting crossing direction instead of parity fixes
 * the holes and the tearing at once.
 */
function fillGlyph(
  r: Raster,
  g: Glyph,
  ox: number,
  baseline: number,
  size: number,
  c: [number, number, number],
  alpha: number,
) {
  // Font Y is up, raster Y is down.
  const polys: [number, number][][] = g.c.map((contour) =>
    contour.map((p) => [ox + p[0] * size, baseline - p[1] * size] as [number, number]),
  )

  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  for (const poly of polys)
    for (const [px, py] of poly) {
      if (py < minY) minY = py
      if (py > maxY) maxY = py
      if (px < minX) minX = px
      if (px > maxX) maxX = px
    }
  if (!isFinite(minY)) return

  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(r.h - 1, Math.ceil(maxY))
  const bx = Math.max(0, Math.floor(minX) - 1)
  const width = Math.min(r.w, Math.ceil(maxX) + 2) - bx
  if (width <= 0) return

  const SS = 4 // vertical supersamples per row
  const cov = new Float32Array(width)

  // Reused per scanline: x position paired with winding direction.
  const xs: { x: number; w: number }[] = []

  for (let py = y0; py <= y1; py++) {
    cov.fill(0)
    for (let sub = 0; sub < SS; sub++) {
      const sy = py + (sub + 0.5) / SS
      xs.length = 0
      for (const poly of polys) {
        for (let i = 0; i < poly.length; i++) {
          const [ax, ay] = poly[i]
          const [bx2, by] = poly[(i + 1) % poly.length]
          if (ay === by) continue
          if (sy >= Math.min(ay, by) && sy < Math.max(ay, by)) {
            xs.push({
              x: ax + ((sy - ay) / (by - ay)) * (bx2 - ax),
              w: by > ay ? 1 : -1,
            })
          }
        }
      }
      if (xs.length < 2) continue
      xs.sort((p, q) => p.x - q.x)

      // Nonzero: a span is inside wherever the running winding count != 0.
      let wind = 0
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i].w
        if (wind === 0) continue
        const sx = xs[i].x
        const ex = xs[i + 1].x
        if (ex <= sx) continue
        const from = Math.max(bx, Math.floor(sx))
        const to = Math.min(bx + width - 1, Math.ceil(ex))
        for (let px = from; px <= to; px++) {
          const l = Math.max(sx, px)
          const rr = Math.min(ex, px + 1)
          if (rr > l) cov[px - bx] += (rr - l) / SS
        }
      }
    }
    for (let i = 0; i < width; i++) {
      const v = cov[i]
      if (v > 0.003) r.blend(bx + i, py, c, alpha * Math.min(1, v))
    }
  }
}

/* ------------------------------------------------------------------ */
/* PNG encoding                                                        */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(buf: Uint8Array) {
  let a = 1
  let b = 0
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crcInput = out.subarray(4, 8 + data.length)
  dv.setUint32(8 + data.length, crc32(crcInput))
  return out
}

/**
 * Encode as PNG using stored (uncompressed) DEFLATE blocks.
 * Larger than a compressed PNG, but it needs no zlib and a 1200x630 card
 * lands around 2.3MB — well inside every platform's OG size limit, and it
 * gets cached at the edge anyway.
 */
export function encodePng(r: Raster): Uint8Array {
  const { w, h, px } = r

  // raw scanlines, each prefixed with filter type 0
  const raw = new Uint8Array(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3)
    raw[o] = 0
    raw.set(px.subarray(y * w * 3, (y + 1) * w * 3), o + 1)
  }

  // zlib container with stored deflate blocks (max 65535 bytes each)
  const blocks: Uint8Array[] = []
  blocks.push(new Uint8Array([0x78, 0x01])) // CMF/FLG, no compression
  for (let off = 0; off < raw.length; off += 65535) {
    const len = Math.min(65535, raw.length - off)
    const last = off + len >= raw.length ? 1 : 0
    const head = new Uint8Array(5)
    head[0] = last
    head[1] = len & 0xff
    head[2] = (len >> 8) & 0xff
    head[3] = ~len & 0xff
    head[4] = (~len >> 8) & 0xff
    blocks.push(head, raw.subarray(off, off + len))
  }
  const ad = new Uint8Array(4)
  new DataView(ad.buffer).setUint32(0, adler32(raw))
  blocks.push(ad)

  let zlen = 0
  for (const b of blocks) zlen += b.length
  const z = new Uint8Array(zlen)
  let zo = 0
  for (const b of blocks) {
    z.set(b, zo)
    zo += b.length
  }

  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const cIhdr = chunk('IHDR', ihdr)
  const cIdat = chunk('IDAT', z)
  const cIend = chunk('IEND', new Uint8Array(0))

  const out = new Uint8Array(
    sig.length + cIhdr.length + cIdat.length + cIend.length,
  )
  let o = 0
  for (const part of [sig, cIhdr, cIdat, cIend]) {
    out.set(part, o)
    o += part.length
  }
  return out
}

/** #rrggbb → [r,g,b] */
export function hex(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
