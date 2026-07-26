/**
 * Readout.tsx — the instrument panel.
 *
 * Everything here is a measured number. No decoration that doesn't carry
 * information; the only colour is the one that tells you what the light is
 * doing right now.
 */

import { motion } from 'motion/react'
import { numeric, spring } from '../lib/motion'
import { FlowNumber } from './adopted'
import type { SolarPosition, SunTimes, Phase } from '../lib/solar'

/* ------------------------------------------------------------------ */

export function Stat({
  label,
  value,
  unit,
  hint,
  accent,
}: {
  label: string
  value: string
  unit?: string
  hint?: string
  accent?: string
}) {
  // If the value is a plain number, roll the digits (adopted number-flow).
  // Anything else — "stretched", "endless", "24h 40m" — stays static, because
  // rolling letters is noise rather than information.
  const asNumber = Number(value)
  const isNumeric = value.trim() !== '' && Number.isFinite(asNumber)
  const decimals = value.includes('.') ? value.split('.')[1].length : 0
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] w-medium">
        {label}
      </div>
      <div className="flex items-baseline gap-1 mt-1">
        {isNumeric ? (
          <FlowNumber
            value={asNumber}
            decimals={decimals}
            className="tabular text-[19px] leading-none w-semi"
            style={{ color: accent ?? 'var(--color-ink)' }}
          />
        ) : (
          <motion.span
            layout
            transition={numeric}
            className="tabular text-[19px] leading-none w-semi truncate"
            style={{ color: accent ?? 'var(--color-ink)' }}
          >
            {value}
          </motion.span>
        )}
        {unit && (
          <span className="text-[11px] text-[var(--color-ink-mute)] w-normal">
            {unit}
          </span>
        )}
      </div>
      {hint && (
        <div className="text-[10px] text-[var(--color-ink-faint)] mt-1 leading-tight">
          {hint}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* The sun's position drawn as a dome — altitude and bearing at once   */
/* ------------------------------------------------------------------ */

export function SkyDome({
  altitude,
  azimuth,
  phase,
  width = 236,
}: {
  altitude: number
  azimuth: number
  phase: Phase
  width?: number
}) {
  const W = width
  const H = Math.round(width * 0.5)
  const cx = W / 2
  const cy = H - 14
  const r = W * 0.407

  // Project altitude/azimuth onto a side-on dome. Azimuth maps to horizontal
  // position (E on the left, W on the right, as if facing south), altitude to
  // the arc.
  const azRad = ((azimuth - 180) * Math.PI) / 180
  const altClamped = Math.max(-12, Math.min(90, altitude))
  const altRad = (altClamped * Math.PI) / 180

  const x = cx + Math.sin(azRad) * r * Math.cos(altRad)
  const y = cy - Math.sin(altRad) * r

  const belowHorizon = altitude < -0.833

  return (
    <svg width={W} height={H} className="overflow-visible">
      <defs>
        <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={phase.tint} stopOpacity="0.22" />
          <stop offset="100%" stopColor={phase.tint} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* the dome */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`}
        fill="url(#skyGrad)"
      />
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none"
        stroke="var(--color-line)"
        strokeWidth="1"
      />

      {/* altitude gridlines at 30 and 60 degrees */}
      {[30, 60].map((a) => {
        const rr = r * Math.cos((a * Math.PI) / 180)
        const yy = cy - r * Math.sin((a * Math.PI) / 180)
        return (
          <g key={a}>
            <line
              x1={cx - rr}
              y1={yy}
              x2={cx + rr}
              y2={yy}
              stroke="var(--color-line)"
              strokeWidth="0.5"
              strokeDasharray="2 4"
              opacity="0.5"
            />
            <text
              x={cx + rr + 4}
              y={yy + 3}
              className="tabular"
              fontSize="8"
              fill="var(--color-ink-faint)"
            >
              {a}°
            </text>
          </g>
        )
      })}

      {/* horizon */}
      <line
        x1={cx - r - 8}
        y1={cy}
        x2={cx + r + 8}
        y2={cy}
        stroke="var(--color-line-bright)"
        strokeWidth="1"
      />

      {/* compass */}
      <text x={cx - r - 4} y={cy + 12} fontSize="9" fill="var(--color-ink-faint)">
        E
      </text>
      <text x={cx - 3} y={cy + 12} fontSize="9" fill="var(--color-ink-faint)">
        S
      </text>
      <text x={cx + r - 4} y={cy + 12} fontSize="9" fill="var(--color-ink-faint)">
        W
      </text>

      {/* the sun */}
      <motion.g
        animate={{ x, y }}
        initial={false}
        transition={spring.moderate}
        style={{ x, y }}
      >
        <circle
          r="13"
          fill={phase.tint}
          opacity={belowHorizon ? 0.14 : 0.3}
          style={{ filter: 'blur(6px)' }}
        />
        <circle
          r="5.5"
          fill={belowHorizon ? 'var(--color-panel)' : phase.tint}
          stroke={phase.tint}
          strokeWidth="1.5"
          strokeDasharray={belowHorizon ? '2 2' : undefined}
        />
      </motion.g>
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* The day as a horizontal band of light                               */
/* ------------------------------------------------------------------ */

export function DayBand({
  times,
  now,
  onScrub,
}: {
  times: SunTimes
  now: Date
  onScrub: (d: Date) => void
}) {
  const dayStart = new Date(now)
  dayStart.setUTCHours(0, 0, 0, 0)
  const pct = (d: Date | null) => {
    if (!d) return null
    return ((d.getTime() - dayStart.getTime()) / 86400000) * 100
  }

  const nowPct = pct(now) ?? 0

  // Build the gradient from the actual event times, so the band is a true
  // record of that day at that latitude rather than a generic sunrise graphic.
  const stops: { at: number; color: string }[] = []
  const push = (d: Date | null, color: string) => {
    const p = pct(d)
    if (p !== null && p >= 0 && p <= 100) stops.push({ at: p, color })
  }

  if (times.alwaysUp) {
    stops.push({ at: 0, color: 'var(--color-day)' }, { at: 100, color: 'var(--color-day)' })
  } else if (times.alwaysDown) {
    stops.push({ at: 0, color: 'var(--color-night)' }, { at: 100, color: 'var(--color-night)' })
  } else {
    stops.push({ at: 0, color: 'var(--color-night)' })
    push(times.astronomicalDawn, 'var(--color-astro)')
    push(times.nauticalDawn, 'var(--color-nautical)')
    push(times.civilDawn, 'var(--color-blue-hour)')
    push(times.sunrise, 'var(--color-civil)')
    push(times.goldenHourEnd, 'var(--color-day)')
    push(times.goldenHourStart, 'var(--color-golden)')
    push(times.sunset, 'var(--color-civil)')
    push(times.civilDusk, 'var(--color-blue-hour)')
    push(times.nauticalDusk, 'var(--color-nautical)')
    push(times.astronomicalDusk, 'var(--color-astro)')
    stops.push({ at: 100, color: 'var(--color-night)' })
  }
  stops.sort((a, b) => a.at - b.at)

  const gradient = `linear-gradient(to right, ${stops
    .map((s) => `${s.color} ${s.at.toFixed(2)}%`)
    .join(', ')})`

  const handle = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onScrub(new Date(dayStart.getTime() + f * 86400000))
  }

  return (
    <div className="select-none">
      <div
        className="relative h-9 r-inner overflow-hidden cursor-ew-resize hairline border"
        style={{ background: gradient }}
        onMouseDown={handle}
        onMouseMove={(e) => e.buttons === 1 && handle(e)}
        role="slider"
        aria-label="Time of day"
        aria-valuenow={Math.round(nowPct)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
      >
        {/* hour ticks */}
        {[6, 12, 18].map((h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 w-px bg-white/15"
            style={{ left: `${(h / 24) * 100}%` }}
          />
        ))}

        {/* now */}
        <motion.div
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]"
          style={{ left: `${nowPct}%` }}
          layout
          transition={numeric}
        />
      </div>

      <div className="flex justify-between mt-1.5 text-[9px] tabular text-[var(--color-ink-faint)]">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

export function TimeRow({
  label,
  time,
  tint,
  /** the day this row belongs to, so we can flag events on the far side of midnight */
  refDate,
  /** shown instead of a dash when the event simply never happens */
  absentLabel = 'never',
}: {
  label: string
  time: Date | null
  tint?: string
  refDate?: Date
  absentLabel?: string
}) {
  // An event can land on the previous or next UTC day — at high latitude in
  // summer, sunrise is genuinely yesterday. Saying "23:04" with no marker is a
  // lie by omission, so flag the day offset.
  let dayTag = ''
  if (time && refDate) {
    const d0 = Date.UTC(
      refDate.getUTCFullYear(),
      refDate.getUTCMonth(),
      refDate.getUTCDate(),
    )
    const d1 = Date.UTC(
      time.getUTCFullYear(),
      time.getUTCMonth(),
      time.getUTCDate(),
    )
    const diff = Math.round((d1 - d0) / 86400000)
    if (diff < 0) dayTag = '−1d'
    else if (diff > 0) dayTag = '+1d'
  }

  return (
    <div className="flex items-center justify-between py-1 gap-3">
      <div className="flex items-center gap-2 min-w-0">
        {tint && (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: tint }}
          />
        )}
        <span className="text-[11px] text-[var(--color-ink-mute)] truncate w-normal">
          {label}
        </span>
      </div>
      <span className="shrink-0 flex items-baseline gap-1">
        {time ? (
          <>
            <span className="text-[11px] tabular text-[var(--color-ink-soft)] w-medium">
              {time.toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'UTC',
              })}
            </span>
            {dayTag && (
              <span className="text-[9px] tabular text-[var(--color-ink-faint)]">
                {dayTag}
              </span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-[var(--color-ink-faint)] italic">
            {absentLabel}
          </span>
        )}
      </span>
    </div>
  )
}
