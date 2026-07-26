/**
 * Descent.tsx — the fall from orbit to the ground.
 *
 * Zajno's motion principles name this exactly: "Zoom brings continuity to
 * narrative and lets us achieve a smooth transition between interface, objects
 * and destinations." The globe→ground switch was a hard cut — one frame you're
 * in orbit, the next you're standing in a field. Nothing told you that the
 * field is the pin you were just looking at, which is the whole point.
 *
 * So this is the connective tissue: a full-screen wash that plays while the
 * two scenes swap behind it. It reads as flying INTO the atmosphere rather
 * than as a loading screen, because:
 *
 *   • the wash colour is the sky colour of the place you're descending to
 *   • it scales up from the pin's screen position, not from the centre
 *   • the readout underneath survives, so the numbers never blink
 *
 * Offset and delay, also from Zajno: the label follows the wash rather than
 * arriving with it, which gives the movement layers instead of one flat pop.
 */

import { motion, AnimatePresence, useReducedMotion } from 'motion/react'

export type Phase = 'idle' | 'descending' | 'ascending'

export function Descent({
  phase,
  placeName,
  skyTint,
  /** where the pin sits on screen, 0-1, so the wash grows from the right spot */
  origin = { x: 0.5, y: 0.5 },
}: {
  phase: Phase
  placeName: string
  skyTint: string
  origin?: { x: number; y: number }
}) {
  const reduced = useReducedMotion()
  const active = phase !== 'idle'
  const down = phase === 'descending'

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="descent"
          className="fixed inset-0 z-30 pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.42, ease: [0.23, 1, 0.32, 1] } }}
          transition={{ duration: 0.18, ease: [0.4, 0, 1, 1] }}
        >
          {/* The wash. Scales from the pin outward on the way down and
              contracts back toward it on the way up, so the motion always
              points at the place you're moving between. */}
          <motion.div
            className="absolute inset-0"
            style={{
              transformOrigin: `${origin.x * 100}% ${origin.y * 100}%`,
              background: `radial-gradient(circle at ${origin.x * 100}% ${origin.y * 100}%, ${skyTint} 0%, ${skyTint} 34%, oklch(0.11 0.02 250) 100%)`,
            }}
            initial={reduced ? { scale: 1 } : { scale: down ? 0.02 : 2.6 }}
            animate={{ scale: down ? 2.6 : 0.02 }}
            transition={
              reduced
                ? { duration: 0.2 }
                : // Long, eased, one-directional: this is a camera move, not a
                  // UI affordance, so it gets a cinematic duration rather than
                  // the 160ms panel budget.
                  { duration: 1.15, ease: [0.65, 0, 0.35, 1] }
            }
          />

          {/* Streaks. Cheap radial motion-blur suggestion — reads as speed
              through atmosphere without a post-processing pass. */}
          {!reduced && (
            <motion.div
              className="absolute inset-0 mix-blend-screen"
              style={{
                background: `repeating-conic-gradient(from 0deg at ${origin.x * 100}% ${origin.y * 100}%, transparent 0deg, ${skyTint}22 1.2deg, transparent 2.6deg)`,
              }}
              initial={{ opacity: 0, scale: down ? 0.3 : 1.8 }}
              animate={{ opacity: [0, 0.5, 0], scale: down ? 1.8 : 0.3 }}
              transition={{ duration: 1.0, ease: [0.4, 0, 0.6, 1] }}
            />
          )}

          {/* Label, offset behind the wash — Zajno's offset-and-delay:
              staggering the two makes the movement feel layered rather than
              one flat pop. */}
          <motion.div
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0, y: down ? 14 : -14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={{ duration: 0.5, delay: 0.22, ease: [0.23, 1, 0.32, 1] }}
          >
            <div className="text-center">
              <div
                className="text-[13px] uppercase tracking-[0.22em] text-white/55"
                style={{ fontVariationSettings: "'wght' 500" }}
              >
                {down ? 'Descending to' : 'Returning to orbit'}
              </div>
              {down && (
                <div
                  className="text-[42px] leading-tight text-white mt-1"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {placeName}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
