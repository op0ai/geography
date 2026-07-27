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
  /**
   * Hours of direct sun at this exact point, when it's been measured.
   *
   * The trace needs terrain tiles and building geometry, which only the
   * browser has — so the answer travels in the link and the Worker renders it
   * into the share card. Without this a shared shading result arrives as a
   * generic sun-position readout, which is the least interesting thing the app
   * knows.
   */
  sunHours?: number
  /** hours of dappled light through canopy */
  dappled?: number
}

export function encodeState(s: ShareState): string {
  const p = new URLSearchParams()
  p.set('at', `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`)
  p.set('t', s.t)
  if (s.planet && s.planet !== 'earth') p.set('on', s.planet)
  if (s.mode === 'ground') p.set('ground', '1')
  if (s.name) p.set('name', s.name)
  if (s.country) p.set('in', s.country)
  // Two decimals is ~36 seconds — finer than the 10-minute sampling the trace
  // actually uses, so no precision is lost and the URL stays readable.
  if (s.sunHours !== undefined) p.set('sun', s.sunHours.toFixed(2))
  if (s.dappled !== undefined && s.dappled > 0.05) p.set('dap', s.dappled.toFixed(2))
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

  // Read back but not trusted for anything but display — the live app
  // recomputes the shading itself as soon as the terrain loads.
  const sun = parseFloat(p.get('sun') ?? '')
  if (isFinite(sun) && sun >= 0 && sun <= 24) out.sunHours = sun
  const dap = parseFloat(p.get('dap') ?? '')
  if (isFinite(dap) && dap >= 0 && dap <= 24) out.dappled = dap

  return out
}

/**
 * Write state into the address bar without adding a history entry.
 *
 * ## Why replaceState
 *
 * pushState would stack an entry per change — playing the timeline for thirty
 * seconds would bury the back button under a thousand of them. replaceState
 * overwrites the current entry, so "back" still means "the page before this
 * one", which is what everyone expects. Google Maps does the same thing with
 * its `/@lat,lng,zoom`; YouTube goes further and doesn't touch the URL while
 * a video plays at all.
 *
 * ## Why it's throttled
 *
 * Every engine rate-limits history writes, and the limits are lower than you
 * would guess:
 *
 *   Safari / WebKit   100 calls per 30s  — and it THROWS a SecurityError
 *   Firefox           200 calls per 10s
 *   Chromium          200 calls per 10s  — silently no-ops, logs a warning
 *
 * The play loop advances time on every animation frame, so mirroring each one
 * meant ~60 writes a second. That spends Safari's entire budget in 1.7 seconds
 * and then throws; on the others the address bar silently stops updating for
 * the rest of the window, so a link copied mid-playback is quietly wrong.
 *
 * Throttling to one write per 500ms is two per second — comfortably under
 * Safari's sustainable 3.3/s, with room for anything else on the page that
 * touches history. The trailing write matters as much as the leading one: it
 * guarantees the bar settles on the true final state when motion stops, rather
 * than freezing wherever the last permitted write happened to land.
 *
 * The Copy-link button doesn't go through here — it builds the URL fresh from
 * live state — so a shared link is always exact regardless of this throttle.
 */
const THROTTLE_MS = 500

let lastWrite = 0
let pending: ReturnType<typeof setTimeout> | undefined
let pendingState: ShareState | null = null

function write(s: ShareState) {
  const url = `${window.location.pathname}?${encodeState(s)}`
  try {
    window.history.replaceState(null, '', url)
    lastWrite = performance.now()
  } catch {
    // Safari throws once its budget is spent. Swallow it — a stale address bar
    // is a cosmetic problem, and an uncaught exception inside a render effect
    // is not.
  }
}

export function syncUrl(s: ShareState, immediate = false) {
  if (typeof window === 'undefined') return

  if (immediate) {
    if (pending) {
      clearTimeout(pending)
      pending = undefined
      pendingState = null
    }
    write(s)
    return
  }

  const since = performance.now() - lastWrite
  if (since >= THROTTLE_MS && !pending) {
    write(s)
    return
  }

  // Inside the window: remember the newest state and make sure exactly one
  // trailing write is queued for when the window closes.
  pendingState = s
  if (!pending) {
    pending = setTimeout(
      () => {
        pending = undefined
        if (pendingState) {
          write(pendingState)
          pendingState = null
        }
      },
      Math.max(0, THROTTLE_MS - since),
    )
  }
}

/** The absolute URL to share. */
export function shareUrl(s: ShareState): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}${window.location.pathname}?${encodeState(s)}`
}
