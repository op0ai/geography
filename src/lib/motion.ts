/**
 * motion.ts — the house motion system.
 *
 * Adopted from Fluid Functionalism's spring doctrine rather than installed from
 * its registry, because the three libraries we surveyed disagree: smoothui ships
 * `motion`, fluid ships `framer-motion`, boardui ships React Aria. Pulling all
 * three would drag in three animation runtimes and three primitive layers to
 * build one app. So we take the best idea — fluid's — and own it.
 *
 * The doctrine, in one line: motion is information, not decoration. Every
 * transition here exists to make a state change legible. If it doesn't explain
 * something, it shouldn't move.
 *
 * Three rules we keep:
 *
 *   1. The bigger the thing that moves, the slower the spring. Never hand-write
 *      a duration — reach for a tier.
 *   2. Enter and exit are asymmetric. Entrances are damped springs; exits are
 *      plain tweens, one tier quicker, no bounce. A dismissal should read as
 *      crisp and final, not as the entrance played backwards.
 *   3. Critically damped by default. Only the largest tier keeps any bounce,
 *      and only a little.
 */

import type { Transition } from 'motion/react'

/** Entrance springs. Pick by the size of the thing moving. */
export const spring = {
  /** icons, toggles, counters — small things that should feel instant */
  fast: { type: 'spring', duration: 0.08, bounce: 0 },
  /** panels, dropdowns, tab indicators — the workhorse */
  moderate: { type: 'spring', duration: 0.16, bounce: 0 },
  /** full overlays, planet changes — the only tier with any bounce */
  slow: { type: 'spring', duration: 0.24, bounce: 0.12 },
} satisfies Record<string, Transition>

/** Exits. One tier quicker, no bounce, plain tween. */
export const exit = {
  fast: { duration: 0.06, ease: [0.4, 0, 1, 1] },
  moderate: { duration: 0.12, ease: [0.4, 0, 1, 1] },
  slow: { duration: 0.16, ease: [0.4, 0, 1, 1] },
} satisfies Record<string, Transition>

/**
 * The one shared easing curve for CSS transitions.
 * Emil and Jakub independently land on this same curve, which is a good sign.
 */
export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'

/**
 * Variable-font weight transitions.
 *
 * Each weight is paired with an optical-size value chosen to hold the advance
 * width nearly constant, so text can change weight without reflowing the line
 * underneath it. Animating `font-weight` alone makes text visibly jump; this
 * doesn't.
 */
export const fontWeight = {
  normal: "'wght' 400, 'opsz' 14",
  medium: "'wght' 450, 'opsz' 15",
  semibold: "'wght' 550, 'opsz' 20",
  bold: "'wght' 700, 'opsz' 25",
} as const

/** Numbers that tick should never bounce — they're read, not watched. */
export const numeric: Transition = { type: 'spring', duration: 0.12, bounce: 0 }

/**
 * Respect the user's reduced-motion setting.
 * Called at module scope in components that animate large surfaces.
 */
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
