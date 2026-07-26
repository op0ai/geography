/**
 * PlanetBar.tsx — the world switcher.
 *
 * Vertical, because nine worlds in a horizontal strip means a scrollbar, and a
 * scrollbar means you can't see the options. The whole point is comparison.
 *
 * The selected indicator is a shared layout element rather than a per-item
 * background, so it physically slides between worlds. That movement is the
 * information: it says these are the same kind of thing, and you moved.
 */

import { motion } from 'motion/react'
import {
  PLANETS,
  meanIrradiance,
  formatDuration,
  type Planet,
} from '../lib/planets'
import { spring } from '../lib/motion'

export function PlanetBar({
  selected,
  onSelect,
}: {
  selected: Planet
  onSelect: (p: Planet) => void
}) {
  return (
    <div className="panel r-outer p-1.5" role="tablist" aria-label="Choose a world">
      <div className="px-2.5 pt-1.5 pb-2 text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] w-medium">
        Put this place on
      </div>

      {PLANETS.map((p) => {
        const active = p.id === selected.id
        const rel = meanIrradiance(p) / 1361
        return (
          <button
            key={p.id}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(p)}
            className="relative w-full px-2.5 py-2 r-inner press outline-none group text-left"
          >
            {active && (
              <motion.div
                layoutId="planet-pill"
                className="absolute inset-0 r-inner"
                style={{
                  background: `color-mix(in oklch, ${p.color} 20%, transparent)`,
                  border: `1px solid color-mix(in oklch, ${p.color} 42%, transparent)`,
                }}
                transition={spring.moderate}
              />
            )}

            <span className="relative flex items-center gap-2.5">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0 transition-transform duration-[160ms] group-hover:scale-110"
                style={{
                  background: p.color,
                  boxShadow: active
                    ? `0 0 10px color-mix(in oklch, ${p.color} 70%, transparent)`
                    : 'none',
                }}
              />

              <span className="min-w-0 flex-1">
                <span
                  className={`block text-[12px] weight-shift truncate ${
                    active
                      ? 'w-semi text-[var(--color-ink)]'
                      : 'w-normal text-[var(--color-ink-mute)]'
                  }`}
                >
                  {p.name}
                </span>
              </span>

              {/* A day here, and how much light — the two numbers that make
                  the comparison land without opening anything. */}
              <span className="shrink-0 text-right">
                <span className="block text-[9px] tabular text-[var(--color-ink-faint)] leading-tight">
                  {formatDuration(p.solarDay)}
                </span>
                <span
                  className="block text-[9px] tabular leading-tight"
                  style={{ color: active ? p.color : 'var(--color-ink-faint)' }}
                >
                  {rel >= 1
                    ? `${rel.toFixed(1)}×`
                    : rel >= 0.01
                      ? `${(rel * 100).toFixed(0)}%`
                      : `${(rel * 100).toFixed(2)}%`}
                </span>
              </span>
            </span>
          </button>
        )
      })}

      <div className="px-2.5 pt-2 pb-1 text-[9px] text-[var(--color-ink-faint)] leading-relaxed">
        Day length · sunlight vs Earth
      </div>
    </div>
  )
}
