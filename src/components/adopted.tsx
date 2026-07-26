/**
 * adopted.tsx — smoothui components, adapted to this app's standard.
 *
 * All 29 requested components are installed under components/smoothui/. Four
 * of them have a real job here. This file is the adaptation layer: it fixes
 * what was broken upstream, translates the shadcn token vocabulary into ours,
 * and gives each one an actual purpose rather than a demo slot.
 *
 * What needed fixing, per component:
 *
 *   siri-orb        Ships clean and themeable — used nearly as-is. Only the
 *                   colours are swapped, driven live by the sun's phase.
 *
 *   number-flow     Shipped BROKEN: it toggles CSS classes (slide-in-up etc.)
 *                   whose @keyframes don't exist in the package, so nothing
 *                   animates. It's also integer-only with three fixed digit
 *                   boxes and +/- stepper buttons — wrong for a signed decimal
 *                   like "-12.4°". Kept the digit-column *idea*, rebuilt the
 *                   mechanism on motion's spring so it actually moves and can
 *                   carry a sign and a decimal.
 *
 *   scrubber        Good bones, wrong defaults (0-1, 2 decimals, "Value").
 *                   Wired to real time-of-day and given our motion tiers.
 *
 *   dynamic-island  Hardcoded to a phone demo — incoming calls, music, a timer.
 *                   Kept only the morph-between-states behaviour, which is the
 *                   actually-good part, and repointed it at sun phase.
 */

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import SiriOrb from './smoothui/siri-orb'
import { spring, exit } from '../lib/motion'
import type { Phase } from '../lib/solar'

/* ══════════════════════════════════════════════════════════════════
   1. SiriOrb → the sun
   ══════════════════════════════════════════════════════════════════
   The orb's slow conic-gradient churn reads like a star's surface, which
   is a better fit than the flat disc it replaces. Its three colours are
   driven by the current light phase, so it goes molten at golden hour and
   cold blue below the horizon — the orb itself becomes the readout.
*/

export function SunOrb({
  phase,
  altitude,
  size = 56,
}: {
  phase: Phase
  altitude: number
  size?: number
}) {
  const below = altitude < -0.833

  // Rotation speed tracks how fast the sun is apparently moving: slow and
  // heavy when it's high, quicker near the horizon where things change fast.
  const duration = below ? 34 : 20 - Math.min(8, Math.abs(altitude) / 11)

  // The sun is not the colour of the sky.
  //
  // phase.tint describes what the SKY looks like — sky-blue at midday, which
  // is right for the dome behind it. Feeding that to the orb painted the sun
  // cyan at noon. The star itself runs white-hot when high and reddens as it
  // sinks through more atmosphere, so the orb interpolates on ALTITUDE, and
  // only borrows phase.tint once the sun is low enough for the sky's colour
  // and the sun's colour to actually converge.
  const warmth = Math.max(0, Math.min(1, altitude / 32)) // 0 at horizon → 1 high

  const colors = below
    ? // below the horizon: cold, dim, residual glow
      {
        // Same rule below the horizon: bg must be the brightest value or the
        // orb hollows out. Cold and dim, but still a disc.
        bg: 'oklch(58% 0.09 255)',
        c1: 'oklch(46% 0.10 258)',
        c2: 'oklch(36% 0.07 280)',
        c3: 'oklch(52% 0.11 250)',
      }
    : {
        // `bg` is not a background — siri-orb uses it for an inset shadow AND
        // as the colour of the dot-matrix overlay punched through the middle.
        // Setting it dark (as the component's own default does, for a light
        // page) hollowed the sun out into a black hole against our dark UI.
        // It has to stay bright so the orb reads as a solid disc.
        bg: `oklch(${(93 + warmth * 5).toFixed(0)}% ${(0.07 - warmth * 0.03).toFixed(3)} ${(62 + warmth * 26).toFixed(0)})`,
        // core: near-white at altitude, deep amber at the horizon
        c1: `oklch(${(88 + warmth * 8).toFixed(0)}% ${(0.13 - warmth * 0.05).toFixed(3)} ${(58 + warmth * 32).toFixed(0)})`,
        // mid: the classic solar yellow
        c2: `oklch(${(82 + warmth * 6).toFixed(0)}% ${(0.16 - warmth * 0.04).toFixed(3)} ${(52 + warmth * 30).toFixed(0)})`,
        // rim: picks up the sky's own colour, which only matters when low
        c3: warmth > 0.55 ? 'oklch(90% 0.10 92)' : phase.tint,
      }

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <SiriOrb size={`${size}px`} colors={colors} animationDuration={duration} />
      {/* Halo — scales with how high the sun is, so it reads as intensity.
          Warm like the star, not blue like the sky. */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-full pointer-events-none transition-opacity duration-500"
        style={{
          boxShadow: `0 0 ${size * 0.5}px ${size * 0.14}px ${
            below ? 'oklch(46% 0.10 258)' : `oklch(85% 0.15 ${(56 + warmth * 28).toFixed(0)})`
          }`,
          opacity: below ? 0.1 : 0.2 + Math.min(0.42, Math.max(0, altitude) / 90),
        }}
      />
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   2. number-flow → the readouts
   ══════════════════════════════════════════════════════════════════
   Upstream animates by adding classes with no keyframes behind them, so it
   sits still. It also can't render "-12.4" — three integer boxes only.
   This is the same visual idea (digits on rolling columns) rebuilt so it
   works: each glyph is a spring-driven column, direction follows whether the
   value rose or fell, and the sign and decimal point are static so only the
   digits that actually change will move.
*/

function DigitColumn({
  digit,
  direction,
  reduced,
}: {
  digit: string
  direction: 1 | -1
  reduced: boolean
}) {
  // Non-digits (sign, decimal point) never roll — rolling a "." is noise.
  if (!/\d/.test(digit)) {
    return <span className="inline-block">{digit}</span>
  }

  return (
    <span
      className="relative inline-block overflow-hidden align-baseline"
      style={{ width: '0.62em', height: '1.05em' }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={digit}
          className="absolute inset-0 flex items-center justify-center tabular"
          initial={reduced ? { opacity: 0 } : { y: `${direction * 100}%`, opacity: 0 }}
          animate={{ y: '0%', opacity: 1 }}
          exit={
            reduced
              ? { opacity: 0, transition: exit.fast }
              : { y: `${direction * -100}%`, opacity: 0, transition: exit.fast }
          }
          transition={spring.fast}
        >
          {digit}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

export function FlowNumber({
  value,
  decimals = 1,
  className,
  style,
}: {
  value: number
  decimals?: number
  className?: string
  style?: React.CSSProperties
}) {
  const reduced = !!useReducedMotion()
  const prev = useRef(value)
  const [direction, setDirection] = useState<1 | -1>(1)

  useEffect(() => {
    if (value !== prev.current) {
      setDirection(value > prev.current ? 1 : -1)
      prev.current = value
    }
  }, [value])

  const text = isFinite(value) ? value.toFixed(decimals) : '—'

  return (
    <span className={className} style={style} aria-label={text}>
      {text.split('').map((ch, i) => (
        <DigitColumn key={`${i}-${ch}`} digit={ch} direction={direction} reduced={reduced} />
      ))}
    </span>
  )
}

/* ══════════════════════════════════════════════════════════════════
   3. dynamic-island → the phase indicator
   ══════════════════════════════════════════════════════════════════
   Upstream is a phone simulator: incoming calls, a music player, a countdown.
   None of that is reusable. What IS good is the morph — the pill physically
   resizes as its contents change, so a state change reads as one object
   transforming rather than two things swapping.
   Rebuilt around that single behaviour, showing the current light phase and
   expanding on hover to say what's coming next.
*/

export function PhasePill({
  phase,
  next,
}: {
  phase: Phase
  /** what happens next, and when — e.g. { label: 'Sunset', at: '22:13' } */
  next: { label: string; at: string } | null
}) {
  const [open, setOpen] = useState(false)
  const reduced = !!useReducedMotion()

  return (
    <motion.div
      layout
      onHoverStart={() => setOpen(true)}
      onHoverEnd={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
      // The pill is the biggest thing that moves here, so it takes the slow
      // tier — the one tier that keeps a little bounce.
      transition={reduced ? { duration: 0 } : spring.slow}
      className="relative flex items-center gap-2 rounded-full pl-2 pr-2.5 py-1 cursor-default outline-none"
      style={{
        background: `color-mix(in oklch, ${phase.tint} 18%, transparent)`,
        border: `1px solid color-mix(in oklch, ${phase.tint} 40%, transparent)`,
      }}
    >
      <motion.span
        layout="position"
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: phase.tint, boxShadow: `0 0 6px ${phase.tint}` }}
      />
      <motion.span
        layout="position"
        className="text-[10px] w-medium whitespace-nowrap"
        style={{ color: phase.tint }}
      >
        {phase.label}
      </motion.span>

      <AnimatePresence initial={false}>
        {open && next && (
          <motion.span
            key="next"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 'auto' }}
            exit={{ opacity: 0, width: 0, transition: exit.moderate }}
            transition={spring.moderate}
            className="overflow-hidden whitespace-nowrap text-[10px] tabular text-[var(--color-ink-mute)]"
          >
            <span className="pl-1.5 border-l border-white/15 ml-0.5">
              {next.label} {next.at}
            </span>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   4. scrubber → the time-of-day control
   ══════════════════════════════════════════════════════════════════
   Nearly right out of the box. The upstream defaults (0-1 range, 2 decimals,
   label "Value") are demo values; the interaction — grow-on-hover, tick
   marks, pointer capture — is genuinely good and worth keeping.
   Re-skinned to our tokens and wired to hours-of-day, and the label slot is
   used to show the actual clock time rather than a raw number.
*/

export function TimeScrubber({
  hours,
  onChange,
  tint,
}: {
  /** hours since UTC midnight, 0-24 */
  hours: number
  onChange: (h: number) => void
  tint: string
}) {
  const reduced = !!useReducedMotion()
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [hovering, setHovering] = useState(false)
  const active = dragging || hovering

  const pct = (hours / 24) * 100

  const fromPointer = (clientX: number) => {
    const el = trackRef.current
    if (!el) return hours
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 24
  }

  const hh = Math.floor(hours)
  const mm = Math.floor((hours - hh) * 60)
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`

  return (
    <div
      className="select-none"
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] w-medium">
          Time of day
        </span>
        <span className="text-[10px] tabular w-medium" style={{ color: tint }}>
          {clock} UTC
        </span>
      </div>

      <motion.div
        ref={trackRef}
        // Grow on engagement — the target gets bigger exactly when you're
        // aiming at it. This is the good idea in the upstream component.
        animate={{ height: active && !reduced ? 22 : 14 }}
        transition={spring.moderate}
        className="relative w-full rounded-full cursor-ew-resize overflow-hidden bg-white/8 border hairline"
        onPointerDown={(e) => {
          e.preventDefault()
          trackRef.current?.setPointerCapture(e.pointerId)
          setDragging(true)
          onChange(fromPointer(e.clientX))
        }}
        onPointerMove={(e) => dragging && onChange(fromPointer(e.clientX))}
        onPointerUp={(e) => {
          trackRef.current?.releasePointerCapture(e.pointerId)
          setDragging(false)
        }}
        onPointerCancel={() => setDragging(false)}
        role="slider"
        aria-label="Time of day"
        aria-valuemin={0}
        aria-valuemax={24}
        aria-valuenow={Number(hours.toFixed(2))}
        aria-valuetext={`${clock} UTC`}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1 : 1 / 6
          if (e.key === 'ArrowLeft') onChange(Math.max(0, hours - step))
          if (e.key === 'ArrowRight') onChange(Math.min(24, hours + step))
        }}
      >
        {/* six-hour ticks */}
        {[6, 12, 18].map((h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 w-px bg-white/12"
            style={{ left: `${(h / 24) * 100}%` }}
          />
        ))}

        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ background: tint, opacity: 0.32, width: `${pct}%` }}
          transition={spring.fast}
        />

        <motion.div
          className="absolute top-0 bottom-0 w-[3px] -ml-[1.5px] rounded-full bg-white"
          style={{ left: `${pct}%`, boxShadow: '0 0 8px rgba(255,255,255,0.85)' }}
          transition={spring.fast}
        />
      </motion.div>
    </div>
  )
}
