/**
 * LookControls.tsx — standing somewhere and looking around.
 *
 * Ground mode used OrbitControls, which always aims the camera at a fixed
 * target point. That's the right model for inspecting an object — you circle
 * the globe and it stays centred. It's the wrong model for standing in a
 * place, because the view can never tilt above the horizon: raising
 * maxPolarAngle just puts the camera underground, still looking down at the
 * target. You physically could not look up at the sky, which in an app about
 * where the sun is happens to be the only thing worth looking at.
 *
 * This is the other model: the camera stays put and rotates in place. Yaw and
 * pitch, like turning your head. Pitch clamps just shy of straight up and
 * straight down, so you can find the sun at any altitude and still look at
 * your own feet.
 *
 * Movement follows Apple's fluid-interface rules — track the pointer 1:1 while
 * dragging, then carry the release velocity into a decaying glide rather than
 * stopping dead. Interruptible at any moment: grabbing again cancels the glide
 * immediately instead of fighting it.
 */

import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

const DEG = Math.PI / 180

/** Just shy of vertical, so the view never flips through the pole. */
const PITCH_LIMIT = 88 * DEG

export interface LookState {
  /** compass bearing the camera faces, degrees from north */
  yaw: number
  /** vertical angle, degrees; positive is up */
  pitch: number
}

export function LookControls({
  active,
  /** initial bearing to face, degrees from north */
  initialYaw,
  /** initial vertical angle, degrees */
  initialPitch,
  /** re-aim when this changes (e.g. a new location) */
  resetKey,
  fovRef,
  onChange,
}: {
  active: boolean
  initialYaw: number
  initialPitch: number
  resetKey: string
  fovRef?: React.MutableRefObject<number>
  onChange?: (s: LookState) => void
}) {
  const { camera, gl } = useThree()

  const yaw = useRef(initialYaw * DEG)
  const pitch = useRef(initialPitch * DEG)
  const vYaw = useRef(0)
  const vPitch = useRef(0)
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const lastT = useRef(0)

  // Re-aim on arrival, or whenever the destination changes.
  useEffect(() => {
    if (!active) return
    yaw.current = initialYaw * DEG
    pitch.current = initialPitch * DEG
    vYaw.current = 0
    vPitch.current = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resetKey])

  useEffect(() => {
    if (!active) return
    const el = gl.domElement

    const down = (e: PointerEvent) => {
      // Left button (or touch) only — let right-click through for context menus.
      if (e.button !== 0) return
      dragging.current = true
      // Grabbing mid-glide must stop it dead. Anything else feels like the
      // interface is arguing with you.
      vYaw.current = 0
      vPitch.current = 0
      lastPos.current = { x: e.clientX, y: e.clientY }
      lastT.current = performance.now()
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
    }

    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      const dx = e.clientX - lastPos.current.x
      const dy = e.clientY - lastPos.current.y
      lastPos.current = { x: e.clientX, y: e.clientY }

      const now = performance.now()
      const dt = Math.max(1, now - lastT.current)
      lastT.current = now

      // Sensitivity scales with field of view: zoomed in, the same drag should
      // sweep a smaller arc, or aiming becomes impossible.
      const fov = fovRef?.current ?? 55
      const sens = (fov / 55) * 0.0022

      // Drag right → look right. Drag up → look up. Both match grabbing the
      // world and pulling it, which is the direction people expect outdoors.
      yaw.current -= dx * sens * 1.6
      pitch.current = clamp(pitch.current + dy * sens * 1.6, -PITCH_LIMIT, PITCH_LIMIT)

      // Track velocity for the release glide (deg per ms).
      vYaw.current = (-dx * sens * 1.6) / dt
      vPitch.current = (dy * sens * 1.6) / dt
    }

    const up = (e: PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already gone */
      }
      el.style.cursor = 'grab'
    }

    el.style.cursor = 'grab'
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)

    return () => {
      el.style.cursor = ''
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
  }, [active, gl, fovRef])

  // Keyboard: arrows nudge the view. Not everyone can drag, and this is the
  // only way to reach the sky without a pointer.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      if (inField) return
      const step = (e.shiftKey ? 12 : 4) * DEG
      if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault()
        pitch.current = clamp(pitch.current + step, -PITCH_LIMIT, PITCH_LIMIT)
      } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault()
        pitch.current = clamp(pitch.current - step, -PITCH_LIMIT, PITCH_LIMIT)
      } else if (e.key === 'ArrowLeft' && e.altKey) {
        e.preventDefault()
        yaw.current += step
      } else if (e.key === 'ArrowRight' && e.altKey) {
        e.preventDefault()
        yaw.current -= step
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const target = useRef(new THREE.Vector3())

  useFrame((_, delta) => {
    if (!active) return

    // Momentum glide. Decays fast enough to feel controlled rather than
    // floaty, and is cancelled outright on the next grab.
    if (!dragging.current) {
      const decay = Math.pow(0.0016, delta)
      yaw.current += vYaw.current * delta * 1000
      pitch.current = clamp(
        pitch.current + vPitch.current * delta * 1000,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      )
      vYaw.current *= decay
      vPitch.current *= decay
      if (Math.abs(vYaw.current) < 1e-6) vYaw.current = 0
      if (Math.abs(vPitch.current) < 1e-6) vPitch.current = 0
    }

    // Yaw is a compass bearing: 0 = north = -Z, increasing clockwise toward
    // east = +X. Same convention as every other angle in this app.
    const cp = Math.cos(pitch.current)
    target.current.set(
      camera.position.x + Math.sin(yaw.current) * cp,
      camera.position.y + Math.sin(pitch.current),
      camera.position.z - Math.cos(yaw.current) * cp,
    )
    camera.lookAt(target.current)

    onChange?.({
      yaw: ((((yaw.current / DEG) % 360) + 360) % 360),
      pitch: pitch.current / DEG,
    })
  })

  return null
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
