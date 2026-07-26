/**
 * App.tsx — geography.
 *
 * Two modes on one globe:
 *   Earth  — a real place, a real moment, the real sun.
 *   Elsewhere — that same latitude transplanted to another world, with that
 *   world's tilt, day length, and distance from the sun.
 */

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Scene, type GroundState } from './components/Scene'
import { PlanetBar } from './components/PlanetBar'
import { Stat, SkyDome, DayBand, TimeRow } from './components/Readout'
import { SunOrb, FlowNumber, PhasePill, TimeScrubber } from './components/adopted'
import { spring, exit } from './lib/motion'
import {
  solarPosition,
  sunTimes,
  subsolarPoint,
  phaseFor,
  solarOffsetHours,
} from './lib/solar'
import {
  PLANETS,
  PLANET_BY_ID,
  alienSky,
  mapEarthMoment,
  formatDuration,
  seasonName,
  effectiveTilt,
  sunAngularSize,
  type Planet,
} from './lib/planets'
import {
  fetchWeather,
  sliceAt,
  skyDescription,
  weatherAvailable,
  type WeatherDay,
} from './lib/weather'
import {
  DEFAULT_PLACE,
  searchPlaces,
  nearestPlace,
  formatCoord,
  type Place,
} from './lib/places'
import { geocode, reverseGeocode, type GeoResult } from './lib/geocode'

const hexToRgb01 = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export default function App() {
  const [place, setPlace] = useState<Place | null>(DEFAULT_PLACE)
  const [coord, setCoord] = useState({
    lat: DEFAULT_PLACE.lat,
    lon: DEFAULT_PLACE.lon,
  })
  const [date, setDate] = useState(() => new Date())
  const [planet, setPlanet] = useState<Planet>(PLANET_BY_ID.earth)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(600)
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [weather, setWeather] = useState<WeatherDay | null>(null)
  const [viewMode, setViewMode] = useState<'globe' | 'ground'>('globe')
  const [groundState, setGroundState] = useState<GroundState>({ status: 'idle' })
  // Bumped to request a mode flip — zooming works too, but a button is
  // discoverable in a way that "keep scrolling" is not.
  const [descend, setDescend] = useState(0)

  const isEarth = planet.id === 'earth'

  /* ---------------- time playback ---------------- */
  const raf = useRef<number>(0)
  const last = useRef<number>(0)
  useEffect(() => {
    if (!playing) return
    last.current = performance.now()
    const tick = (t: number) => {
      const dt = t - last.current
      last.current = t
      setDate((d) => new Date(d.getTime() + dt * speed))
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, speed])

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      if (e.key === '/' && !inField) {
        e.preventDefault()
        setShowSearch(true)
      }
      if (e.key === 'Escape') {
        setShowSearch(false)
        ;(document.activeElement as HTMLElement)?.blur()
      }
      if (inField) return
      // Space toggles playback. Deliberately NOT animated on the button —
      // keyboard-initiated actions shouldn't play a press animation.
      if (e.key === ' ') {
        e.preventDefault()
        setPlaying((p) => !p)
      }
      if (e.key === 'ArrowLeft')
        setDate((d) => new Date(d.getTime() - (e.shiftKey ? 3600000 : 600000)))
      if (e.key === 'ArrowRight')
        setDate((d) => new Date(d.getTime() + (e.shiftKey ? 3600000 : 600000)))
      if (e.key === 't') setDate(new Date())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---------------- the numbers ---------------- */
  const sun = useMemo(
    () => solarPosition(date, coord.lat, coord.lon),
    [date, coord],
  )
  const times = useMemo(
    () => sunTimes(date, coord.lat, coord.lon),
    [date, coord],
  )
  const subsolar = useMemo(() => subsolarPoint(date), [date])
  const phase = useMemo(() => phaseFor(sun.altitude), [sun.altitude])

  const alien = useMemo(() => {
    if (isEarth) return null
    const { Ls, dayFraction } = mapEarthMoment(planet, date, coord.lon)
    return alienSky(planet, coord.lat, Ls, dayFraction)
  }, [isEarth, planet, date, coord])

  // On another world the "subsolar point" is synthetic — we place it from that
  // planet's declination and hour angle so the globe lights correctly.
  const displaySubsolar = useMemo(() => {
    if (!alien) return subsolar
    let lon = coord.lon - alien.hourAngle
    lon = ((((lon + 180) % 360) + 360) % 360) - 180
    return { lat: alien.declination, lon }
  }, [alien, subsolar, coord.lon])

  // Real sky conditions, when the date is inside the forecast window.
  // Debounced so scrubbing the timeline doesn't hammer the API.
  const dayKey = date.toISOString().slice(0, 10)
  useEffect(() => {
    let cancelled = false
    if (!weatherAvailable(date)) {
      setWeather(null)
      return
    }
    const id = setTimeout(() => {
      fetchWeather(coord.lat, coord.lon, date).then((w) => {
        if (!cancelled) setWeather(w)
      })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coord.lat, coord.lon, dayKey])

  const sky = useMemo(
    () => (weather ? sliceAt(weather, date) : null),
    [weather, date],
  )

  // The next thing the sun is going to do — feeds the phase pill's expansion.
  const nextEvent = useMemo(() => {
    const candidates: { label: string; t: Date | null }[] = [
      { label: 'Sunrise', t: times.sunrise },
      { label: 'Golden hour', t: times.goldenHourStart },
      { label: 'Sunset', t: times.sunset },
      { label: 'Dusk', t: times.civilDusk },
      { label: 'Night', t: times.astronomicalDusk },
      { label: 'Solar noon', t: times.solarNoon },
    ]
    const future = candidates
      .filter((c): c is { label: string; t: Date } => !!c.t && c.t > date)
      .sort((a, b) => a.t.getTime() - b.t.getTime())
    if (!future.length) return null
    return {
      label: future[0].label,
      at: future[0].t.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }),
    }
  }, [times, date])

  // Hours since UTC midnight — the scrubber's unit.
  const hoursOfDay = useMemo(
    () =>
      date.getUTCHours() +
      date.getUTCMinutes() / 60 +
      date.getUTCSeconds() / 3600,
    [date],
  )

  const setHoursOfDay = useCallback(
    (h: number) => {
      setDate((d) => {
        const next = new Date(d)
        next.setUTCHours(0, 0, 0, 0)
        return new Date(next.getTime() + h * 3600000)
      })
    },
    [],
  )

  /**
   * Search results: local list instantly, then the geocoder.
   *
   * The old version only searched 40 hardcoded places, so most of the planet
   * was simply unreachable. Now the curated list answers immediately (it also
   * carries the editorial notes) and a real geocoder fills in everything else
   * a moment later, deduped against the local hits.
   */
  const localResults = useMemo(() => searchPlaces(query, 4), [query])
  const [remote, setRemote] = useState<GeoResult[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setRemote([])
      setSearching(false)
      return
    }
    const ac = new AbortController()
    setSearching(true)
    // 220ms: long enough to skip most keystrokes, short enough that the
    // results feel like they're keeping up with typing.
    const id = setTimeout(() => {
      geocode(q, ac.signal)
        .then((r) => {
          if (!ac.signal.aborted) setRemote(r)
        })
        .finally(() => {
          if (!ac.signal.aborted) setSearching(false)
        })
    }, 220)
    return () => {
      ac.abort()
      clearTimeout(id)
      setSearching(false)
    }
  }, [query])

  const results = useMemo(() => {
    const local: GeoResult[] = localResults.map((p) => ({
      name: p.name,
      country: p.country,
      lat: p.lat,
      lon: p.lon,
      importance: 1, // curated entries always outrank geocoder hits
      local: true,
      note: p.note,
    }))
    // Drop geocoder rows that duplicate a curated place (same name, ~same spot).
    const seen = new Set(local.map((l) => l.name.toLowerCase()))
    const extra = remote.filter((r) => {
      const k = r.name.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    return [...local, ...extra].slice(0, 8)
  }, [localResults, remote])

  const localSolarTime = useMemo(() => {
    const offset = solarOffsetHours(coord.lon)
    const local = new Date(date.getTime() + offset * 3600000)
    return local.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    })
  }, [date, coord.lon])

  const pick = useCallback((lat: number, lon: number) => {
    setCoord({ lat, lon })
    const { place: near, km } = nearestPlace(lat, lon)
    setPlace(km < 220 ? near : null)
  }, [])

  const choose = useCallback((r: GeoResult) => {
    setPlace({
      name: r.name,
      country: r.country,
      lat: r.lat,
      lon: r.lon,
      note: r.note,
    })
    setCoord({ lat: r.lat, lon: r.lon })
    setQuery('')
    setRemote([])
    setShowSearch(false)
  }, [])

  const label = place ? place.name : 'Somewhere'
  const sublabel = place ? place.country : formatCoord(coord.lat, coord.lon)

  return (
    <div className="fixed inset-0 bg-[var(--color-void)] text-[var(--color-ink)]">
      {/* ---------------- the globe ----------------
          Inset to match the panels: the sphere should sit in the gap between
          them, not behind them. */}
      <div className="absolute inset-0 lg:left-[300px] lg:right-[260px]">
        <Scene
          subsolar={displaySubsolar}
          marker={coord}
          onPick={pick}
          cloudOpacity={isEarth ? 1 : 0}
          sunAngularSize={alien ? alien.sunSize : 0.533}
          brightness={alien ? alien.brightnessVsEarth : 1}
          surfaceTexture={planet.texture ?? '/textures/earth_day_4096.jpg'}
          atmosphereTint={hexToRgb01(planet.color)}
          hasAtmosphere={planet.id !== 'moon' && planet.id !== 'mercury'}
          autoRotate={follow}
          sunAltitude={alien ? alien.altitude : sun.altitude}
          sunAzimuth={alien ? alien.azimuth : sun.azimuth}
          skyTint={phase.tint}
          allowGround={isEarth}
          descendSignal={descend}
          onModeChange={setViewMode}
          onGroundState={setGroundState}
        />
      </div>

      {/* gradient scrim so panels stay legible over bright ocean */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 50% 50%, transparent 40%, oklch(0.14 0.012 265 / 0.55) 100%)',
        }}
      />

      {/* ---------------- masthead ---------------- */}
      <header className="absolute top-0 left-0 right-0 p-5 pointer-events-none">
        <div className="flex items-start justify-between gap-4">
          <div className="pointer-events-auto">
            <h1
              className="text-[26px] leading-none tracking-[-0.01em]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              geography
            </h1>
            <p className="text-[11px] text-[var(--color-ink-faint)] mt-1 w-normal">
              where the light falls
            </p>
          </div>

          <div className="pointer-events-auto flex items-center gap-2">
            {isEarth && (
              <button
                onClick={() => setDescend((d) => d + 1)}
                className="px-3 py-2 r-inner press text-[11px] w-medium border panel text-[var(--color-ink-mute)] hover:text-[var(--color-ink)]"
              >
                {viewMode === 'ground' ? 'Back to orbit' : 'Land here'}
              </button>
            )}
            <button
              onClick={() => setFollow((f) => !f)}
              className={`px-3 py-2 r-inner press text-[11px] w-medium border ${
                follow
                  ? 'bg-[var(--color-sun)]/18 border-[var(--color-sun)]/45 text-[var(--color-sun)]'
                  : 'panel text-[var(--color-ink-mute)] hover:text-[var(--color-ink)]'
              }`}
              aria-pressed={follow}
            >
              {follow ? 'Following' : 'Follow pin'}
            </button>
            <button
              onClick={() => setShowSearch(true)}
              className="px-3 py-2 r-inner press text-[11px] w-medium panel text-[var(--color-ink-mute)] hover:text-[var(--color-ink)] flex items-center gap-2"
            >
              Search
              <kbd className="text-[9px] px-1 py-0.5 rounded bg-white/8 text-[var(--color-ink-faint)]">
                /
              </kbd>
            </button>
          </div>
        </div>
      </header>

      {/* ---------------- left: the place ---------------- */}
      <aside className="absolute left-3 right-3 top-[88px] bottom-[188px] lg:left-5 lg:right-auto lg:top-24 lg:bottom-5 lg:w-[292px] flex flex-col gap-3 pointer-events-none max-lg:hidden">
        <motion.div
          layout
          transition={spring.moderate}
          className="panel r-outer p-4 pointer-events-auto"
        >
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              {/* The place name is the one thing that identifies everything
                  else on this panel. Swapping it instantly reads as a glitch;
                  a short cross-fade says "this is now about somewhere else".
                  Purpose: preventing a jarring change. Occasional frequency. */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={label}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3, transition: exit.fast }}
                  transition={spring.moderate}
                  className="text-[21px] leading-tight truncate"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {label}
                </motion.div>
              </AnimatePresence>
              <div className="text-[11px] text-[var(--color-ink-mute)] mt-0.5 tabular truncate">
                {sublabel}
              </div>
            </div>
            {isEarth ? (
              <PhasePill phase={phase} next={nextEvent} />
            ) : (
              <div
                className="text-[10px] px-2 py-1 r-inner shrink-0 w-medium"
                style={{
                  background: `color-mix(in oklch, ${planet.color} 20%, transparent)`,
                  color: planet.color,
                }}
              >
                {planet.name}
              </div>
            )}
          </div>

          {/* SunOrb + dome: the orb is the sun's current state as an object,
              the dome is where it sits in the sky. */}
          <div className="mt-4 flex items-center gap-3">
            <SunOrb
              phase={phase}
              altitude={alien ? alien.altitude : sun.altitude}
              size={54}
            />
            <SkyDome
              altitude={alien ? alien.altitude : sun.altitude}
              azimuth={alien ? alien.azimuth : sun.azimuth}
              phase={phase}
              width={186}
            />
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-4 mt-5">
            <Stat
              label="Sun altitude"
              value={(alien ? alien.altitude : sun.altitude).toFixed(1)}
              unit="°"
              accent={phase.tint}
              hint={
                (alien ? alien.altitude : sun.altitude) < -0.833
                  ? 'below the horizon'
                  : 'above the horizon'
              }
            />
            <Stat
              label="Bearing"
              value={(alien ? alien.azimuth : sun.azimuth).toFixed(0)}
              unit="°"
              hint={compass(alien ? alien.azimuth : sun.azimuth)}
            />
            {(() => {
              const r = alien ? alien.shadowRatio : sun.shadowRatio
              // Past ~50x the sun is on the horizon and the number stops
              // meaning anything — say so rather than print 216.31.
              const huge = r > 50
              return (
                <Stat
                  label="Shadow length"
                  value={r === Infinity ? '—' : huge ? 'stretched' : r.toFixed(2)}
                  unit={r === Infinity || huge ? undefined : '× height'}
                  hint={
                    r === Infinity
                      ? 'sun is down'
                      : huge
                        ? 'sun on the horizon'
                        : 'of anything standing'
                  }
                />
              )
            })()}
            <Stat
              label={isEarth ? 'Local solar time' : 'Sun overhead at'}
              value={
                isEarth ? localSolarTime : `${alien!.declination.toFixed(1)}°`
              }
              hint={isEarth ? 'true sun, not the clock' : 'subsolar latitude'}
            />
          </div>
        </motion.div>

        {/* Earth: the day's events. Elsewhere: what that world is like. */}
        <div className="panel r-outer p-4 pointer-events-auto overflow-y-auto scrollbar-thin flex-1 min-h-0">
          <AnimatePresence mode="wait" initial={false}>
            {isEarth ? (
              <motion.div
                key="earth-times"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: exit.moderate }}
                transition={spring.moderate}
              >
                <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] w-medium mb-2">
                  Today, in UTC
                </div>

                {times.alwaysUp && (
                  <Note>
                    The sun does not set here today. It circles the sky without
                    touching the horizon.
                  </Note>
                )}
                {times.alwaysDown && (
                  <Note>
                    The sun does not rise here today. At best the southern sky
                    turns grey around noon.
                  </Note>
                )}

                <TimeRow
                  label="Astronomical dawn"
                  time={times.astronomicalDawn}
                  tint="var(--color-astro)"
                  refDate={date}
                  absentLabel="never fully dark"
                />
                <TimeRow
                  label="Nautical dawn"
                  time={times.nauticalDawn}
                  tint="var(--color-nautical)"
                  refDate={date}
                  absentLabel="never reached"
                />
                <TimeRow
                  label="Blue hour"
                  time={times.civilDawn}
                  tint="var(--color-blue-hour)"
                  refDate={date}
                  absentLabel="never reached"
                />
                <TimeRow
                  label="Sunrise"
                  time={times.sunrise}
                  tint="var(--color-civil)"
                  refDate={date}
                  absentLabel={times.alwaysUp ? 'already up' : 'never rises'}
                />
                <TimeRow
                  label="Golden hour ends"
                  time={times.goldenHourEnd}
                  tint="var(--color-golden)"
                  refDate={date}
                />
                <TimeRow
                  label="Solar noon"
                  time={times.solarNoon}
                  tint="var(--color-sun)"
                  refDate={date}
                />
                <TimeRow
                  label="Golden hour begins"
                  time={times.goldenHourStart}
                  tint="var(--color-golden)"
                  refDate={date}
                />
                <TimeRow
                  label="Sunset"
                  time={times.sunset}
                  tint="var(--color-civil)"
                  refDate={date}
                  absentLabel={times.alwaysUp ? 'never sets' : 'already down'}
                />
                <TimeRow
                  label="Blue hour ends"
                  time={times.civilDusk}
                  tint="var(--color-blue-hour)"
                  refDate={date}
                  absentLabel="never reached"
                />
                <TimeRow
                  label="Night begins"
                  time={times.astronomicalDusk}
                  tint="var(--color-astro)"
                  refDate={date}
                  absentLabel="never fully dark"
                />

                <div className="mt-3 pt-3 border-t hairline border-t-[1px]">
                  <Stat
                    label="Daylight"
                    value={
                      times.alwaysUp
                        ? '24'
                        : times.alwaysDown
                          ? '0'
                          : times.dayLengthHours.toFixed(2)
                    }
                    unit="hours"
                    hint={dayLengthNote(times.dayLengthHours, coord.lat)}
                  />
                </div>

                {/* Clear-sky theory vs what the sky is actually doing. The
                    gap between these two numbers is the interesting part. */}
                {sky && (
                  <div className="mt-3 pt-3 border-t hairline border-t-[1px]">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] w-medium mb-2">
                      Actual sky
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                      <Stat
                        label="Cloud cover"
                        value={sky.cloudCover.toFixed(0)}
                        unit="%"
                        hint={skyDescription(sky.cloudCover)}
                      />
                      <Stat
                        label="Temperature"
                        value={sky.temperature.toFixed(1)}
                        unit="°C"
                      />
                    </div>
                    <div className="mt-3">
                      <div className="flex items-baseline justify-between text-[10px] mb-1.5">
                        <span className="text-[var(--color-ink-faint)] uppercase tracking-[0.14em] w-medium">
                          Sunlight reaching the ground
                        </span>
                      </div>
                      {(() => {
                        const clear = sun.irradianceFactor * 1361
                        const actual = sky.shortwave
                        const frac = clear > 1 ? Math.min(1, actual / clear) : 0
                        return (
                          <>
                            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                              <motion.div
                                className="h-full rounded-full"
                                style={{
                                  background: 'var(--color-sun)',
                                  width: `${frac * 100}%`,
                                }}
                                layout
                                transition={{
                                  type: 'spring',
                                  duration: 0.16,
                                  bounce: 0,
                                }}
                              />
                            </div>
                            <div className="flex justify-between mt-1.5 text-[10px] tabular">
                              <span className="text-[var(--color-sun)]">
                                {actual.toFixed(0)} W/m² measured
                              </span>
                              <span className="text-[var(--color-ink-faint)]">
                                {clear.toFixed(0)} clear sky
                              </span>
                            </div>
                            {clear > 20 && (
                              <p className="text-[10px] text-[var(--color-ink-mute)] mt-1.5 leading-relaxed">
                                Cloud is taking {(100 - frac * 100).toFixed(0)}% of
                                the available light.
                              </p>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  </div>
                )}

                {/* Street view, aimed at the sun.
                    The brief asked for street-level imagery. Rather than
                    require an API key, hand off to Google's pano viewer with
                    the heading set to the sun's current bearing and the pitch
                    to its altitude — so it opens looking straight at the sun
                    from that spot, at that moment. */}
                <a
                  href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${coord.lat.toFixed(
                    6,
                  )},${coord.lon.toFixed(6)}&heading=${sun.azimuth.toFixed(
                    1,
                  )}&pitch=${Math.max(-30, Math.min(60, sun.altitude)).toFixed(1)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 flex items-center justify-between gap-2 px-3 py-2.5 r-inner press border hairline hover:bg-white/6 group"
                >
                  <span className="min-w-0">
                    <span className="block text-[11px] w-medium text-[var(--color-ink-soft)]">
                      Look at the sun from here
                    </span>
                    <span className="block text-[10px] text-[var(--color-ink-faint)] mt-0.5">
                      Street View, facing {compass(sun.azimuth)}
                    </span>
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="shrink-0 text-[var(--color-ink-faint)] group-hover:text-[var(--color-ink)] transition-colors duration-[120ms]"
                  >
                    <path d="M3 9L9 3M9 3H4.5M9 3v4.5" strokeLinecap="round" />
                  </svg>
                </a>

                {place?.note && (
                  <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-mute)]">
                    {place.note}
                  </p>
                )}
              </motion.div>
            ) : (
              <motion.div
                key={`alien-${planet.id}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: exit.moderate }}
                transition={spring.moderate}
              >
                <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] w-medium mb-2">
                  {label} at {Math.abs(coord.lat).toFixed(1)}°
                  {coord.lat >= 0 ? 'N' : 'S'}, on {planet.name}
                </div>

                <p
                  className="text-[13px] leading-relaxed mb-3"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {planet.hook}
                </p>

                <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                  <Stat
                    label="A day here"
                    value={formatDuration(planet.solarDay)}
                    hint={planet.retrograde ? 'sun rises in the west' : 'sunrise to sunrise'}
                  />
                  <Stat
                    label="Daylight"
                    value={
                      alien!.polarDay
                        ? 'endless'
                        : alien!.polarNight
                          ? 'none'
                          : formatDuration(alien!.daylightHours)
                    }
                    hint={
                      alien!.polarDay
                        ? 'sun never sets'
                        : alien!.polarNight
                          ? 'sun never rises'
                          : 'at this latitude'
                    }
                  />
                  <Stat
                    label="Sunlight"
                    value={alien!.peakIrradiance.toFixed(
                      alien!.peakIrradiance < 10 ? 1 : 0,
                    )}
                    unit="W/m²"
                    hint={`${(alien!.brightnessVsEarth * 100).toFixed(alien!.brightnessVsEarth < 0.1 ? 2 : 0)}% of Earth, at this point in its orbit`}
                    accent={planet.color}
                  />
                  <Stat
                    label="Size of the sun"
                    value={alien!.sunSizeVsEarth.toFixed(2)}
                    unit="× Earth's"
                    hint={`${alien!.sunSize.toFixed(3)}° across`}
                  />
                  <Stat
                    label="Axial tilt"
                    value={effectiveTilt(planet).toFixed(1)}
                    unit="°"
                    hint={
                      effectiveTilt(planet) < 4
                        ? 'effectively no seasons'
                        : effectiveTilt(planet) > 50
                          ? 'extreme seasons'
                          : 'Earth-like seasons'
                    }
                  />
                  <Stat
                    label="Season"
                    value={seasonName(alien!.Ls).replace('Northern ', '')}
                    hint={`Ls ${alien!.Ls.toFixed(0)}°`}
                  />
                  <Stat
                    label="A year here"
                    value={formatDuration(planet.yearDays * 24)}
                    hint="one orbit"
                  />
                  <Stat
                    label="Gravity"
                    value={planet.gravity.toFixed(2)}
                    unit="× Earth"
                    hint="what you'd weigh"
                  />
                </div>

                <p className="mt-4 text-[11px] leading-relaxed text-[var(--color-ink-mute)]">
                  {planet.note}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </aside>

      {/* ---------------- ground-mode status ----------------
          When you're standing on the surface, say where the pixels came from
          and how trustworthy the heights are. */}
      <AnimatePresence>
        {viewMode === 'ground' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6, transition: exit.moderate }}
            transition={spring.moderate}
            className="absolute left-1/2 -translate-x-1/2 top-5 pointer-events-auto z-10"
          >
            <div className="panel r-outer px-4 py-2.5 flex items-center gap-3">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  background:
                    groundState.status === 'loading'
                      ? 'var(--color-ink-mute)'
                      : groundState.status === 'error'
                        ? 'var(--color-civil)'
                        : phase.tint,
                }}
              />
              <span className="text-[11px] w-medium whitespace-nowrap">
                {groundState.status === 'loading' && 'Loading terrain and buildings…'}
                {groundState.status === 'error' && 'Could not load this location'}
                {groundState.status === 'ready' && (
                  <>
                    {label}
                    <span className="text-[var(--color-ink-faint)]">
                      {' · '}
                      {groundState.elevation.toFixed(0)} m elevation
                      {groundState.buildingsFailed
                        ? ' · buildings unavailable (OSM timed out)'
                        : groundState.empty
                          ? ' · no mapped buildings here'
                          : ` · ${groundState.buildings} buildings`}
                    </span>
                  </>
                )}
                {groundState.status === 'idle' && 'Descending…'}
              </span>
              {groundState.status === 'ready' && (
                <span className="text-[9px] text-[var(--color-ink-faint)] border-l hairline pl-3 whitespace-nowrap">
                  AWS Terrain Tiles · © OpenStreetMap
                </span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------------- right: worlds ---------------- */}
      <div className="absolute right-5 top-24 w-[248px] pointer-events-auto max-h-[calc(100vh-230px)] overflow-y-auto scrollbar-thin max-lg:hidden">
        <PlanetBar selected={planet} onSelect={setPlanet} />
      </div>

      {/* Small screens: the essentials only — the readout as a compact strip
          and the worlds as a horizontal scroller. The globe stays the hero. */}
      <div className="lg:hidden absolute left-3 right-3 top-[88px] pointer-events-auto">
        <div className="panel r-outer px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[17px] leading-tight truncate" style={{ fontFamily: 'var(--font-display)' }}>
                {label}
              </div>
              <div className="text-[10px] text-[var(--color-ink-mute)] tabular truncate">
                {sublabel}
              </div>
            </div>
            <div
              className="text-[10px] px-2 py-1 r-inner shrink-0 w-medium"
              style={{
                background: `color-mix(in oklch, ${phase.tint} 20%, transparent)`,
                color: phase.tint,
              }}
            >
              {isEarth ? phase.label : planet.name}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3">
            <Stat
              label="Altitude"
              value={(alien ? alien.altitude : sun.altitude).toFixed(1)}
              unit="°"
              accent={phase.tint}
            />
            <Stat
              label="Bearing"
              value={(alien ? alien.azimuth : sun.azimuth).toFixed(0)}
              unit="°"
            />
            <Stat
              label={isEarth ? 'Daylight' : 'A day'}
              value={
                isEarth
                  ? times.alwaysUp
                    ? '24h'
                    : times.alwaysDown
                      ? '0h'
                      : `${times.dayLengthHours.toFixed(1)}h`
                  : formatDuration(planet.solarDay)
              }
            />
          </div>
        </div>

        <div className="mt-2 flex gap-1.5 overflow-x-auto scrollbar-thin pb-1">
          {PLANETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPlanet(p)}
              className={`shrink-0 px-3 py-2 r-inner press text-[11px] border flex items-center gap-1.5 ${
                p.id === planet.id
                  ? 'w-semi text-[var(--color-ink)]'
                  : 'panel w-normal text-[var(--color-ink-mute)]'
              }`}
              style={
                p.id === planet.id
                  ? {
                      background: `color-mix(in oklch, ${p.color} 22%, transparent)`,
                      borderColor: `color-mix(in oklch, ${p.color} 45%, transparent)`,
                    }
                  : undefined
              }
            >
              <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- bottom: time ---------------- */}
      <div className="absolute bottom-3 lg:bottom-5 left-1/2 -translate-x-1/2 w-[min(660px,calc(100vw-24px))] pointer-events-auto">
        <div className="panel r-outer p-4">
          <div className="flex items-center justify-between mb-3 gap-3">
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="w-9 h-9 r-inner press bg-white/10 hover:bg-white/16 flex items-center justify-center border hairline"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {/* Cross-fade the glyph rather than hard-swapping it.
                    Purpose: state indication. The button is clicked
                    occasionally, so a 0.08s fade is within budget and stays
                    imperceptible — it just stops the icon from popping. */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={playing ? 'pause' : 'play'}
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85, transition: exit.fast }}
                    transition={spring.fast}
                    className="flex"
                  >
                    {playing ? (
                      <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor">
                        <rect width="3.4" height="12" rx="1" />
                        <rect x="7" width="3.4" height="12" rx="1" />
                      </svg>
                    ) : (
                      <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor">
                        <path d="M1 1.2c0-.9 1-1.5 1.8-1L10 4.9c.7.5.7 1.6 0 2L2.8 11.8c-.8.5-1.8-.1-1.8-1V1.2z" />
                      </svg>
                    )}
                  </motion.span>
                </AnimatePresence>
              </button>

              <div className="tabular text-[13px] w-medium">
                {date.toLocaleString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'UTC',
                })}
                <span className="text-[var(--color-ink-faint)] ml-1.5 text-[10px]">
                  UTC
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {[
                { v: 60, l: '1m' },
                { v: 600, l: '10m' },
                { v: 3600, l: '1h' },
                { v: 43200, l: '12h' },
              ].map((s) => (
                <button
                  key={s.v}
                  onClick={() => setSpeed(s.v)}
                  className={`px-2 py-1 r-inner press text-[10px] tabular border ${
                    speed === s.v
                      ? 'bg-white/14 border-white/22 text-[var(--color-ink)] w-semi'
                      : 'border-transparent text-[var(--color-ink-faint)] hover:text-[var(--color-ink-mute)] w-normal'
                  }`}
                  aria-pressed={speed === s.v}
                >
                  {s.l}
                </button>
              ))}
              <button
                onClick={() => setDate(new Date())}
                className="ml-1 px-2.5 py-1 r-inner press text-[10px] w-medium border hairline text-[var(--color-ink-mute)] hover:text-[var(--color-ink)]"
              >
                Now
              </button>
            </div>
          </div>

          {isEarth ? (
            <DayBand times={times} now={date} onScrub={setDate} />
          ) : (
            <AlienBand
              planet={planet}
              dayFraction={alien!.dayFraction}
              daylightFraction={alien!.daylightFraction as number}
              polarDay={alien!.polarDay}
              polarNight={alien!.polarNight}
            />
          )}

          {/* Adopted smoothui scrubber, wired to hours-of-day. */}
          <div className="mt-3">
            <TimeScrubber
              hours={hoursOfDay}
              onChange={setHoursOfDay}
              tint={isEarth ? phase.tint : planet.color}
            />
          </div>

          <div className="flex items-center gap-3 mt-3">
            <label className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] w-medium shrink-0">
              Day of year
            </label>
            <input
              type="range"
              min={0}
              max={364}
              value={dayOfYear(date)}
              onChange={(e) => setDate(setDayOfYear(date, +e.target.value))}
              className="flex-1 h-1 rounded-full bg-white/14 accent-white"
              aria-label="Day of year"
            />
            <span className="text-[10px] tabular text-[var(--color-ink-mute)] w-[68px] text-right shrink-0">
              {date.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                timeZone: 'UTC',
              })}
            </span>
          </div>
        </div>

        <p className="text-center text-[10px] text-[var(--color-ink-faint)] mt-2.5">
          {viewMode === 'ground'
            ? 'Real terrain and OpenStreetMap buildings · drag to look · zoom out to leave'
            : 'Click the globe to move the pin · zoom in to land · space to play · t for now'}
        </p>
      </div>

      {/* ---------------- search ---------------- */}
      <AnimatePresence>
        {showSearch && (
          <>
            {/* Scrim. Dim-to-focus: this is a modal task, so the background
                gets pushed back rather than staying live. */}
            <motion.div
              className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: exit.moderate }}
              transition={spring.moderate}
              onClick={() => setShowSearch(false)}
            />
            <motion.div
              className="absolute top-[22%] left-1/2 -translate-x-1/2 w-[min(460px,calc(100vw-40px))]"
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.99, transition: exit.slow }}
              transition={spring.slow}
            >
              <div className="panel r-outer overflow-hidden">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && results[0]) choose(results[0])
                  }}
                  placeholder="Search a place…"
                  className="w-full px-4 py-3.5 bg-transparent outline-none text-[15px] placeholder:text-[var(--color-ink-faint)]"
                />
                {(results.length > 0 || query.trim().length >= 2) && (
                  <div className="border-t hairline max-h-[300px] overflow-y-auto scrollbar-thin">
                    {/* Rows fade in with a small stagger. Purpose: preventing
                        a jarring change — geocoder results arrive a beat after
                        the local ones, and a block of text materialising all at
                        once reads as a flash. 22ms apart, opacity only, so it
                        never delays clicking the first row. */}
                    {results.map((p, i) => (
                      <motion.button
                        key={`${p.name}-${p.lat.toFixed(4)}-${p.lon.toFixed(4)}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.14, delay: Math.min(i, 5) * 0.022, ease: [0.23, 1, 0.32, 1] }}
                        onClick={() => choose(p)}
                        className="w-full px-4 py-2.5 flex items-baseline justify-between gap-3 hover:bg-white/6 text-left transition-colors duration-[120ms]"
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] w-medium truncate flex items-center gap-1.5">
                            {p.name}
                            {p.kind && !p.local && (
                              <span className="text-[9px] px-1 py-px rounded bg-white/8 text-[var(--color-ink-faint)] shrink-0">
                                {p.kind}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-[var(--color-ink-faint)] truncate">
                            {p.country}
                          </div>
                        </div>
                        <div className="text-[10px] tabular text-[var(--color-ink-faint)] shrink-0">
                          {formatCoord(p.lat, p.lon)}
                        </div>
                      </motion.button>
                    ))}

                    {results.length === 0 && !searching && (
                      <div className="px-4 py-4 text-[11px] text-[var(--color-ink-faint)]">
                        Nothing found. Try a city, a country, or a landmark —
                        or click anywhere on the globe.
                      </div>
                    )}
                  </div>
                )}

                {query.trim().length >= 2 && (
                  <div className="px-4 py-2 border-t hairline flex items-center justify-between">
                    <span className="text-[9px] text-[var(--color-ink-faint)]">
                      Photon / Nominatim · © OpenStreetMap
                    </span>
                    {/* A quiet, indeterminate pulse rather than a spinner: the
                        results below are already usable, this only says more
                        may still arrive. */}
                    <motion.span
                      className="text-[9px] text-[var(--color-ink-faint)]"
                      animate={{ opacity: searching ? [0.35, 1, 0.35] : 0 }}
                      transition={
                        searching
                          ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' }
                          : { duration: 0.12 }
                      }
                    >
                      searching
                    </motion.span>
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * The day, on another world.
 *
 * Reusing the Earth band here would be a lie: it's marked 00–24 and a day on
 * Uranus is 17h14m. This one is scaled to that planet's own solar day, and
 * labelled in its own hours.
 */
function AlienBand({
  planet,
  dayFraction,
  daylightFraction,
  polarDay,
  polarNight,
}: {
  planet: Planet
  dayFraction: number
  daylightFraction: number
  polarDay: boolean
  polarNight: boolean
}) {
  // Daylight is centred on local noon (fraction 0.5).
  const half = daylightFraction / 2
  const riseAt = (0.5 - half) * 100
  const setAt = (0.5 + half) * 100

  const gradient = polarDay
    ? `linear-gradient(to right, ${planet.color}, ${planet.color})`
    : polarNight
      ? 'linear-gradient(to right, var(--color-night), var(--color-night))'
      : `linear-gradient(to right,
          var(--color-night) 0%,
          var(--color-astro) ${Math.max(0, riseAt - 6).toFixed(1)}%,
          var(--color-civil) ${riseAt.toFixed(1)}%,
          ${planet.color} ${Math.min(50, riseAt + 8).toFixed(1)}%,
          ${planet.color} ${Math.max(50, setAt - 8).toFixed(1)}%,
          var(--color-civil) ${setAt.toFixed(1)}%,
          var(--color-astro) ${Math.min(100, setAt + 6).toFixed(1)}%,
          var(--color-night) 100%)`

  return (
    <div className="select-none">
      <div
        className="relative h-9 r-inner overflow-hidden hairline border"
        style={{ background: gradient }}
      >
        <motion.div
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]"
          style={{ left: `${dayFraction * 100}%` }}
          layout
          transition={{ type: 'spring', duration: 0.12, bounce: 0 }}
        />
      </div>
      <div className="flex justify-between mt-1.5 text-[9px] tabular text-[var(--color-ink-faint)]">
        <span>sunrise-to-sunrise</span>
        <span>
          one {planet.name} day · {formatDuration(planet.solarDay)}
        </span>
      </div>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] leading-relaxed text-[var(--color-sun)] bg-[var(--color-sun)]/10 border border-[var(--color-sun)]/25 r-inner px-3 py-2 mb-3">
      {children}
    </p>
  )
}

const compass = (az: number) => {
  const dirs = [
    'due north',
    'north-east',
    'due east',
    'south-east',
    'due south',
    'south-west',
    'due west',
    'north-west',
  ]
  return dirs[Math.round((((az % 360) + 360) % 360) / 45) % 8]
}

function dayLengthNote(hours: number, lat: number) {
  if (hours >= 23.9) return 'the sun never sets'
  if (hours <= 0.1) return 'the sun never rises'
  if (Math.abs(hours - 12) < 0.3) return 'almost exactly twelve hours'
  const diff = hours - 12
  return `${Math.abs(diff).toFixed(1)}h ${diff > 0 ? 'more' : 'less'} than an equinox`
}

function dayOfYear(d: Date) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  return Math.floor((d.getTime() - start) / 86400000) - 1
}

function setDayOfYear(d: Date, doy: number) {
  const next = new Date(d)
  next.setUTCMonth(0, 1)
  next.setUTCDate(doy + 1)
  return next
}
