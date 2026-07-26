/**
 * geocode.ts — search anywhere, not just the 40 places I hardcoded.
 *
 * The old search only knew a curated list, so "Kathmandu" or your street
 * worked only if I'd happened to type it in. That's a demo, not a feature.
 *
 * Two keyless providers, tried in order:
 *   1. Nominatim — OSM's own geocoder. Best coverage and the most familiar
 *      naming, but it asks for ≤1 request/second and a real User-Agent.
 *   2. Photon — Komoot's OSM geocoder. Faster, built for autocomplete,
 *      no rate ceiling published. Used as fallback and when typing quickly.
 *
 * Both are ODbL. Neither needs a key.
 *
 * The local PLACES list stays as the instant-results layer: it answers before
 * a network call can, and it carries the editorial notes ("four months of
 * unbroken daylight") that a geocoder can't.
 */

export interface GeoResult {
  name: string
  /** country or region, for disambiguation */
  country: string
  lat: number
  lon: number
  /** roughly how significant the place is, for ranking */
  importance: number
  /** city / town / village / peak / building… */
  kind?: string
  /** true when this came from the built-in list rather than the network */
  local?: boolean
  note?: string
}

const cache = new Map<string, GeoResult[]>()

/* ------------------------------------------------------------------ */

/** Nominatim: best names, strictest rate limit. */
async function nominatim(q: string, signal: AbortSignal): Promise<GeoResult[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
    `&format=jsonv2&limit=8&accept-language=en&addressdetails=1`

  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`nominatim ${res.status}`)
  const json = await res.json()

  return (json as any[]).map((r) => {
    const a = r.address ?? {}
    // display_name is a long comma-separated path; the first segment is the
    // place itself and the last is the country.
    const parts: string[] = (r.display_name ?? '').split(',').map((s: string) => s.trim())
    return {
      name: r.name || parts[0] || q,
      country:
        a.country ||
        parts[parts.length - 1] ||
        [a.state, a.county].filter(Boolean).join(', '),
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      importance: typeof r.importance === 'number' ? r.importance : 0.1,
      kind: r.addresstype || r.type,
    }
  })
}

/** Photon: built for typeahead, more forgiving of rapid queries. */
async function photon(q: string, signal: AbortSignal): Promise<GeoResult[]> {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`photon ${res.status}`)
  const json = await res.json()

  return (json.features ?? []).map((f: any) => {
    const p = f.properties ?? {}
    const [lon, lat] = f.geometry?.coordinates ?? [0, 0]
    return {
      name: p.name || q,
      country: [p.state, p.country].filter(Boolean).join(', ') || p.country || '',
      lat,
      lon,
      // Photon has no importance score; approximate from place type so cities
      // outrank bus stops.
      importance:
        p.type === 'city'
          ? 0.7
          : p.type === 'state' || p.type === 'country'
            ? 0.8
            : p.osm_key === 'place'
              ? 0.5
              : 0.25,
      kind: p.osm_value || p.type,
    }
  })
}

/* ------------------------------------------------------------------ */

/**
 * Look up a place name. Returns [] rather than throwing — a failed search
 * should quietly fall back to the local list, not break the UI.
 */
export async function geocode(
  query: string,
  signal?: AbortSignal,
): Promise<GeoResult[]> {
  const q = query.trim()
  if (q.length < 2) return []

  const key = q.toLowerCase()
  const hit = cache.get(key)
  if (hit) return hit

  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  // Neither provider is fast enough to be worth waiting on forever.
  const timer = setTimeout(() => ac.abort(), 6000)

  try {
    for (const provider of [photon, nominatim]) {
      if (ac.signal.aborted) return []
      try {
        const out = await provider(q, ac.signal)
        if (out.length) {
          const ranked = out
            .filter((r) => isFinite(r.lat) && isFinite(r.lon))
            .sort((a, b) => b.importance - a.importance)
          cache.set(key, ranked)
          return ranked
        }
      } catch {
        // try the next provider
      }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  return []
}

/** Reverse: what is at this coordinate? Used when you click bare globe. */
export async function reverseGeocode(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<GeoResult | null> {
  const key = `r:${lat.toFixed(3)},${lon.toFixed(3)}`
  const hit = cache.get(key)
  if (hit) return hit[0] ?? null

  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ac.abort(), 6000)

  try {
    const url =
      `https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}` +
      `&limit=1&lang=en`
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) return null
    const json = await res.json()
    const f = json.features?.[0]
    if (!f) return null
    const p = f.properties ?? {}
    const out: GeoResult = {
      name: p.name || p.city || p.county || p.state || 'Unnamed place',
      country: [p.city, p.state, p.country].filter(Boolean).join(', '),
      lat,
      lon,
      importance: 0.5,
      kind: p.osm_value,
    }
    cache.set(key, [out])
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export const GEOCODER_ATTRIBUTION =
  'Search: Photon / Nominatim · © OpenStreetMap contributors'
