/**
 * urlstate.ts — every view is a link.
 *
 * Without this, "look at Tromsø at midnight" is a sentence you have to type out
 * for someone. With it, it's a URL. The querystring carries place, coordinate,
 * moment, world and mode, so a shared link reopens exactly what the sender saw.
 *
 * Kept deliberately short and human-legible — ?at=69.65,18.96&t=... reads like
 * a coordinate, not an opaque blob. That matters because these get pasted into
 * chat windows where people see them.
 */

export interface ShareState {
  lat: number
  lon: number
  /** ISO instant */
  t: string
  /** planet id */
  planet: string
  /** 'globe' | 'ground' */
  mode: string
  /** place name, so the OG card can title itself without a geocoder round-trip */
  name?: string
  country?: string
}

export function encodeState(s: ShareState): string {
  const p = new URLSearchParams()
  p.set('at', `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`)
  p.set('t', s.t)
  if (s.planet && s.planet !== 'earth') p.set('on', s.planet)
  if (s.mode === 'ground') p.set('ground', '1')
  if (s.name) p.set('name', s.name)
  if (s.country) p.set('in', s.country)
  return p.toString()
}

export function decodeState(search: string): Partial<ShareState> {
  const p = new URLSearchParams(search)
  const out: Partial<ShareState> = {}

  const at = p.get('at')
  if (at) {
    const [la, lo] = at.split(',').map(Number)
    if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
      out.lat = la
      out.lon = lo
    }
  }

  const t = p.get('t')
  if (t) {
    const d = new Date(t)
    if (!isNaN(d.getTime())) out.t = d.toISOString()
  }

  const on = p.get('on')
  if (on) out.planet = on

  if (p.has('ground')) out.mode = 'ground'

  const name = p.get('name')
  if (name) out.name = name.slice(0, 60)
  const country = p.get('in')
  if (country) out.country = country.slice(0, 60)

  return out
}

/**
 * Write state into the address bar without adding a history entry.
 *
 * replaceState, not pushState: scrubbing time would otherwise stack up hundreds
 * of entries and make the back button useless.
 */
export function syncUrl(s: ShareState) {
  if (typeof window === 'undefined') return
  const qs = encodeState(s)
  const url = `${window.location.pathname}?${qs}`
  window.history.replaceState(null, '', url)
}

/** The absolute URL to share. */
export function shareUrl(s: ShareState): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}${window.location.pathname}?${encodeState(s)}`
}
