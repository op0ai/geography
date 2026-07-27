/**
 * ContextGuard.tsx — surviving the moment the GPU takes the canvas away.
 *
 * Browsers can revoke a WebGL context at any time: memory pressure, the tab
 * going to the background, the GPU process restarting, a driver reset. iOS
 * Safari does it aggressively and silently. Without handling, the canvas turns
 * black and stays black — which is exactly what "crashes on iPad" looked like.
 *
 * Two things matter here, and both are easy to get wrong:
 *
 * 1. `preventDefault()` on `webglcontextlost` is *mandatory*. It is not a
 *    nicety — the browser only attempts restoration if the default is
 *    prevented. three's WebGLRenderer already does this internally, but we
 *    attach our own listener to drive UI, and a listener that forgets it will
 *    fight the one that doesn't.
 *
 * 2. On restore, three lazily re-uploads anything reachable from the scene
 *    graph, so meshes and textures come back on their own. Render targets and
 *    cube maps do not. This scene has neither, so a plain re-render suffices —
 *    but the frameloop must be kicked, because R3F stops rendering while the
 *    context is gone.
 *
 * The visible half is a small notice rather than a silent recovery. A globe
 * that blinks and comes back unexplained reads as a bug; a globe that says
 * "the browser reset the 3D view, restoring…" reads as a machine handling
 * something. If restoration doesn't arrive within a few seconds, we offer the
 * reload rather than leaving a spinner forever.
 */

import { useEffect, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'

export type ContextStatus = 'ok' | 'lost' | 'restoring' | 'failed'

export function ContextGuard({
  onStatus,
}: {
  onStatus?: (s: ContextStatus) => void
}) {
  const { gl, invalidate } = useThree()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const canvas = gl.domElement

    const lost = (e: Event) => {
      // Without this the context is gone permanently.
      e.preventDefault()
      onStatus?.('lost')
      if (timer.current) clearTimeout(timer.current)
      // Browsers that are going to restore generally do it fast. If nothing
      // has happened in 8s it isn't coming back on its own.
      timer.current = setTimeout(() => onStatus?.('failed'), 8000)
    }

    const restored = () => {
      if (timer.current) clearTimeout(timer.current)
      onStatus?.('restoring')
      // three re-uploads scene-graph resources on the next render; R3F needs
      // to be told to produce one.
      invalidate()
      requestAnimationFrame(() => {
        invalidate()
        onStatus?.('ok')
      })
    }

    canvas.addEventListener('webglcontextlost', lost as EventListener, false)
    canvas.addEventListener('webglcontextrestored', restored, false)
    return () => {
      if (timer.current) clearTimeout(timer.current)
      canvas.removeEventListener('webglcontextlost', lost as EventListener)
      canvas.removeEventListener('webglcontextrestored', restored)
    }
  }, [gl, invalidate, onStatus])

  return null
}

/**
 * The user-facing half. Deliberately not a modal: the canvas underneath may
 * still be showing the last good frame, and covering it would make a recovery
 * look worse than it is.
 */
export function ContextNotice({ status }: { status: ContextStatus }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (status === 'ok') {
      // Let a successful recovery linger just long enough to be noticed, then
      // get out of the way.
      const id = setTimeout(() => setVisible(false), 900)
      return () => clearTimeout(id)
    }
    setVisible(true)
  }, [status])

  if (!visible || status === 'ok') return null

  const failed = status === 'failed'

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute left-1/2 top-6 z-50 -translate-x-1/2"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/12 bg-black/80 px-4 py-2 text-[12px] text-white/85 backdrop-blur-xl">
        {!failed && (
          <span className="size-2 animate-pulse rounded-full bg-amber-400" />
        )}
        <span>
          {failed
            ? 'The browser dropped the 3D view and could not restore it.'
            : 'The browser reset the 3D view — restoring…'}
        </span>
        {failed && (
          <button
            onClick={() => window.location.reload()}
            className="rounded-full bg-white/12 px-3 py-1 font-medium text-white transition-colors hover:bg-white/20"
          >
            Reload
          </button>
        )}
      </div>
    </div>
  )
}
