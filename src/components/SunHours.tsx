/**
 * SunHours.tsx — the answer, presented.
 *
 * Everything else in this app tells you where the sun is. This tells you
 * whether you'll actually see it from the spot you're standing on, which is
 * the question people have when they're choosing a flat, siting a panel,
 * planting a bed, or picking a table outside.
 *
 * Three things on screen, in the order people need them:
 *
 *   1. The headline — hours of direct sun today. One number, large.
 *   2. The day, as a bar — when those hours fall, and what's taking the rest.
 *      "5h 20m" is useful; "5h 20m, all of it before 1pm" is actionable.
 *   3. The year — the same figure for every month, because the question is
 *      usually about February, and you can't answer February by standing
 *      outside in July.
 *
 * The honesty section is not decoration. The inputs are OSM building heights
 * (often estimated from storey counts) and a 30m elevation model, with no
 * vegetation at all. A number that hides that is worse than no number, and it
 * is also the thing that separates this from the tools that charge for it.
 */

import { useMemo, useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { spring, exit } from '../lib/motion'
import {
  clockOf,
  formatHours,
  type SunHourResult,
} from '../lib/sunhours'

/* ------------------------------------------------------------------ */

export function SunHoursPanel({
  result,
  year,
  computing,
  yearComputing,
  onComputeYear,
  buildingsEstimated,
  hadBuildings,
  buildingsFailed,
  trees,
  onClose,
}: {
  result: SunHourResult | null
  year: { date: Date; directHours: number; daylightHours: number }[] | null
  computing: boolean
  yearComputing: boolean
  onComputeYear: () => void
  /** how many of the buildings had guessed heights */
  buildingsEstimated: number
  hadBuildings: boolean
  /** true when the OSM lookup errored — NOT the same as "no buildings here" */
  buildingsFailed: boolean
  /** mapped trees nearby — drives the coverage note */
  trees: number
  onClose: () => void
}) {
  return (
    <motion.aside
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, transition: exit.moderate }}
      transition={spring.moderate}
      className="pointer-events-auto w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-black/72 backdrop-blur-2xl"
      aria-label="Direct sunlight at this spot"
    >
      <header className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div>
          <h2 className="text-[13px] font-medium tracking-tight text-white">
            Direct sun here
          </h2>
          <p className="text-[11px] text-white/40">
            Ray-traced against terrain and buildings
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close sunlight panel"
          className="rounded-full p-1.5 text-white/45 transition-colors hover:bg-white/8 hover:text-white/80"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      <div className="px-4 py-4">
        {computing && !result ? (
          <Computing />
        ) : result ? (
          <>
            <Headline result={result} buildingsFailed={buildingsFailed} />
            {!buildingsFailed && (
              <>
                <DayBar result={result} />
                <Windows result={result} />
              </>
            )}
            {!buildingsFailed && (
              <YearStrip
                year={year}
                computing={yearComputing}
                onCompute={onComputeYear}
              />
            )}
            <Caveats
              buildingsEstimated={buildingsEstimated}
              hadBuildings={hadBuildings}
              trees={trees}
            />
          </>
        ) : (
          <p className="py-6 text-center text-[12px] text-white/40">
            Land at a location to measure its sunlight.
          </p>
        )}
      </div>
    </motion.aside>
  )
}

/* ------------------------------------------------------------------ */

function Computing() {
  return (
    <div className="flex items-center gap-3 py-8" role="status">
      <span className="size-2 animate-pulse rounded-full bg-amber-300" />
      <span className="text-[12px] text-white/55">
        Casting rays through the skyline…
      </span>
    </div>
  )
}

/**
 * The headline. Hours of direct sun, then how that compares to the sun that
 * was theoretically available — because 4 hours in December is excellent and
 * 4 hours in June is a courtyard.
 */
function Headline({
  result,
  buildingsFailed,
}: {
  result: SunHourResult
  buildingsFailed: boolean
}) {
  const pct = Math.round(result.exposure * 100)
  const lost = result.daylightHours - result.directHours

  // When the building lookup failed, the number is terrain-only — which in a
  // city is barely different from raw daylight, and presenting it as a shading
  // answer would be a lie. Say what happened instead of showing a confident
  // figure that quietly means nothing.
  if (buildingsFailed) {
    return (
      <div className="mb-4 rounded-lg border border-amber-400/20 bg-amber-400/[0.07] px-3 py-3">
        <p className="text-[12px] font-medium text-amber-100/90">
          Building data didn't load
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-white/55">
          OpenStreetMap's servers didn't answer, so this can only see the
          terrain. In a built-up area that makes the number meaningless — so
          it isn't shown. The sun is up for{' '}
          <span className="text-white/80">{formatHours(result.daylightHours)}</span>{' '}
          today, which is the most this spot could possibly get.
        </p>
      </div>
    )
  }

  return (
    <div className="mb-4">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[38px] leading-none tracking-tight text-white tabular-nums">
          {formatHours(result.directHours)}
        </span>
        <span className="text-[12px] text-white/45">of direct sun</span>
      </div>

      <p className="mt-2 text-[12px] leading-relaxed text-white/55">
        The sun is above the horizon for{' '}
        <span className="text-white/80">{formatHours(result.daylightHours)}</span>
        {lost > 0.05 ? (
          <>
            , but{' '}
            <span className="text-white/80">{formatHours(lost)}</span> of that is
            blocked from this exact spot — {pct}% gets through.
          </>
        ) : (
          <>, and nothing here blocks any of it.</>
        )}
      </p>

      {/* Dappled light is real and worth naming. An hour under a leafy tree is
          not an hour of sun, but it isn't shade either, and lumping it into
          one bucket or the other would misrepresent a garden. */}
      {result.dappledHours > 0.08 && (
        <p className="mt-2 rounded-lg bg-emerald-400/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-emerald-100/75">
          Plus{' '}
          <span className="font-medium text-emerald-100">
            {formatHours(result.dappledHours)}
          </span>{' '}
          of dappled light through the trees — counted at{' '}
          {formatHours(result.effectiveHours)} of full-sun equivalent overall.
        </p>
      )}
    </div>
  )
}

/**
 * The day as a horizontal bar, midnight to midnight.
 *
 * Colour carries the meaning: amber where the sun reaches you, slate where
 * it's up but blocked, near-black where it's down. The distinction between
 * "blocked" and "night" is the whole point — a bar that only showed daylight
 * would look identical for a sunny field and a shaded courtyard.
 */
function DayBar({ result }: { result: SunHourResult }) {
  const w = 100 / result.steps.length

  return (
    <div className="mb-3">
      <div
        className="flex h-9 w-full overflow-hidden rounded-md"
        role="img"
        aria-label={`Sunlight through the day: ${result.windows
          .map((v) => `${clockOf(v.start)} to ${clockOf(v.end)}`)
          .join(', ')}`}
      >
        {result.steps.map((s, i) => (
          <div
            key={i}
            style={{ width: `${w}%` }}
            className={
              s.sunlit
                ? 'bg-amber-300'
                : s.up
                  ? s.blockedBy === 'canopy'
                    ? // Dappled: green, and lighter the more light gets through,
                      // so a bare February tree reads differently from a leafy
                      // July one at a glance.
                      s.fraction > 0.25
                      ? 'bg-emerald-400/60'
                      : 'bg-emerald-500/40'
                    : s.blockedBy === 'building'
                      ? 'bg-slate-500/70'
                      : 'bg-slate-600/50'
                  : 'bg-white/[0.06]'
            }
          />
        ))}
      </div>

      <div className="mt-1.5 flex justify-between font-mono text-[9px] text-white/30 tabular-nums">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-white/45">
        <Key className="bg-amber-300" label="direct sun" />
        {result.hadVegetation && (
          <Key className="bg-emerald-400/60" label="dappled, through trees" />
        )}
        <Key className="bg-slate-500/70" label="blocked by a building" />
        <Key className="bg-slate-600/50" label="blocked by terrain" />
        <Key className="bg-white/[0.06]" label="below the horizon" />
      </div>
    </div>
  )
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2 rounded-[2px] ${className}`} aria-hidden />
      {label}
    </span>
  )
}

/** When the sun actually reaches you. The times, spelled out. */
function Windows({ result }: { result: SunHourResult }) {
  if (result.windows.length === 0) {
    return (
      <p className="mb-3 rounded-lg bg-white/[0.04] px-3 py-2 text-[12px] text-white/55">
        No direct sun reaches this spot today.
      </p>
    )
  }

  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {result.windows.map((w, i) => (
        <span
          key={i}
          className="rounded-md bg-amber-300/12 px-2 py-1 font-mono text-[11px] text-amber-200/90 tabular-nums"
        >
          {clockOf(w.start)} – {clockOf(w.end)}
        </span>
      ))}
    </div>
  )
}

/**
 * The year, one column per sample.
 *
 * Deferred behind a button because it's ~5,000 rays and takes a moment. The
 * daily number is the hook; the year is the thing you come back for, and it's
 * worth waiting two seconds for. Height is direct hours; the ghost behind it
 * is the daylight that was available, so the gap between them *is* the
 * shading, visible at a glance across the seasons.
 */
function YearStrip({
  year,
  computing,
  onCompute,
}: {
  year: { date: Date; directHours: number; daylightHours: number }[] | null
  computing: boolean
  onCompute: () => void
}) {
  if (!year && !computing) {
    return (
      <button
        onClick={onCompute}
        className="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[12px] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
      >
        Measure the whole year →
      </button>
    )
  }

  if (computing) {
    return (
      <div
        className="mb-4 flex h-[74px] items-center justify-center rounded-lg bg-white/[0.03] text-[11px] text-white/45"
        role="status"
      >
        Tracing 365 days…
      </div>
    )
  }

  const max = Math.max(...year!.map((d) => d.daylightHours), 1)

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11px] text-white/55">Across the year</span>
        <span className="font-mono text-[10px] text-white/35 tabular-nums">
          {formatHours(Math.min(...year!.map((d) => d.directHours)))} –{' '}
          {formatHours(Math.max(...year!.map((d) => d.directHours)))}
        </span>
      </div>

      <div className="flex h-[54px] items-end gap-px" role="img"
        aria-label={`Direct sun by month, ranging from ${formatHours(
          Math.min(...year!.map((d) => d.directHours)),
        )} to ${formatHours(Math.max(...year!.map((d) => d.directHours)))}`}
      >
        {year!.map((d, i) => (
          <div key={i} className="relative flex-1" style={{ height: '100%' }}>
            {/* available daylight, ghosted */}
            <div
              className="absolute bottom-0 w-full rounded-t-[1px] bg-white/[0.07]"
              style={{ height: `${(d.daylightHours / max) * 100}%` }}
            />
            {/* what actually reaches this spot */}
            <div
              className="absolute bottom-0 w-full rounded-t-[1px] bg-amber-300/85"
              style={{ height: `${(d.directHours / max) * 100}%` }}
            />
          </div>
        ))}
      </div>

      <div className="mt-1 flex justify-between font-mono text-[9px] text-white/30">
        <span>Jan</span>
        <span>Apr</span>
        <span>Jul</span>
        <span>Oct</span>
        <span>Dec</span>
      </div>
    </div>
  )
}

/**
 * What this number does and doesn't know.
 *
 * Collapsed by default so it doesn't crowd the answer, but present, and
 * specific. Vegetation is listed first because a tree next door is the single
 * most common reason a real garden is shadier than this says.
 */
function Caveats({
  buildingsEstimated,
  hadBuildings,
  trees,
}: {
  buildingsEstimated: number
  hadBuildings: boolean
  trees: number
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-t border-white/8 pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-[11px] text-white/45 transition-colors hover:text-white/70"
      >
        <span>What this can and can't see</span>
        <motion.svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          animate={{ rotate: open ? 180 : 0 }}
          transition={spring.fast}
          aria-hidden
        >
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </motion.svg>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: exit.fast }}
            transition={spring.moderate}
            className="overflow-hidden text-[11px] leading-relaxed text-white/45"
          >
            <li className="mt-2">
              <strong className="font-medium text-white/65">
                {trees > 0
                  ? `${trees} mapped ${trees === 1 ? 'tree' : 'trees'} nearby.`
                  : 'No mapped trees here.'}
              </strong>{' '}
              {trees > 0 ? (
                <>
                  Canopy is modelled as filtering light rather than blocking it —
                  about 5% of direct sun passes a leafy broadleaf and 45% passes
                  the same tree bare in winter, so the seasonal answer differs.
                  Heights are almost always estimated: only ~3% of trees in
                  OpenStreetMap carry one.
                </>
              ) : (
                <>
                  OpenStreetMap tree coverage is excellent in northern Europe and
                  thin across most of the world, so vegetation isn't part of this
                  number here. A tree next door will shade you and this won't
                  know.
                </>
              )}
            </li>
            <li className="mt-1.5">
              <strong className="font-medium text-white/65">
                {hadBuildings
                  ? buildingsEstimated > 0
                    ? `${buildingsEstimated} nearby building heights are estimated`
                    : 'Building heights are tagged'
                  : 'No building data here'}
                .
              </strong>{' '}
              {hadBuildings
                ? 'OSM heights come from storey counts where a real height is missing — three metres per floor.'
                : 'Nothing is mapped nearby, so this is terrain only.'}
            </li>
            <li className="mt-1.5">
              <strong className="font-medium text-white/65">700 metres.</strong>{' '}
              Anything beyond that isn't loaded, so a distant ridge or tower can
              be missed at very low sun.
            </li>
            <li className="mt-1.5">
              <strong className="font-medium text-white/65">
                Clear-sky geometry.
              </strong>{' '}
              This is whether the sun's path is unobstructed, not whether it'll
              be cloudy.
            </li>
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * The entry point from the ground view — a button that reads as an answer
 * waiting to happen rather than a generic "analyse".
 */
export function SunHoursButton({
  hours,
  loading,
  degraded,
  onClick,
}: {
  hours: number | null
  loading: boolean
  /** building data missing — the number would be terrain-only and misleading */
  degraded: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-amber-300/25 bg-amber-300/10 px-3.5 py-2 text-[12px] text-amber-100 backdrop-blur-xl transition-colors hover:border-amber-300/40 hover:bg-amber-300/16"
    >
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
        <circle cx="6.5" cy="6.5" r="3" fill="currentColor" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <line
            key={a}
            x1="6.5"
            y1="1"
            x2="6.5"
            y2="2.6"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
            transform={`rotate(${a} 6.5 6.5)`}
          />
        ))}
      </svg>
      {loading ? (
        <span className="tabular-nums">measuring…</span>
      ) : degraded ? (
        <span>Sunlight — building data unavailable</span>
      ) : hours !== null ? (
        <span className="tabular-nums">
          <strong className="font-medium">{formatHours(hours)}</strong> of sun here
        </span>
      ) : (
        <span>How much sun does this spot get?</span>
      )}
    </button>
  )
}

/**
 * Runs the calculation off the main thread's critical path.
 *
 * The day is fast enough to run inline, but the year is thousands of rays and
 * would visibly stall the render loop. Rather than reaching for a Worker (and
 * the bundling that entails), this yields between chunks — the calculation is
 * already broken into independent days, so cooperative scheduling is enough to
 * keep the globe spinning.
 */
export function useChunkedYear() {
  const [running, setRunning] = useState(false)
  const cancel = useRef(false)

  useEffect(() => () => { cancel.current = true }, [])

  const run = async <T,>(
    items: number[],
    each: (i: number) => T,
    chunk = 8,
  ): Promise<T[]> => {
    setRunning(true)
    cancel.current = false
    const out: T[] = []
    for (let i = 0; i < items.length; i += chunk) {
      if (cancel.current) break
      for (let j = i; j < Math.min(i + chunk, items.length); j++) {
        out.push(each(items[j]))
      }
      // Hand the frame back so the scene keeps animating.
      await new Promise((r) => setTimeout(r, 0))
    }
    setRunning(false)
    return out
  }

  return { run, running }
}
