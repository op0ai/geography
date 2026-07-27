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
 *
 * ## Walking
 *
 * Looking around from one fixed spot is a diorama, not a place. You can see
 * that the building opposite blocks your sun, but you can't go and stand where
 * it doesn't. So: WASD and arrows to walk, double-tap to travel somewhere.
 *
 * The camera stays glued to the terrain — it walks up the hill rather than
 * through it — because the whole point is standing where a person could stand.
 * Eye height is 1.6m above whatever ground is beneath you.
 */

import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

const DEG = Math.PI / 180

/** Just shy of vertical, so the view never flips through the pole. */
const PITCH_LIMIT = 88 * DEG

/**
 * Standing eye height, metres. Matches the observer height the shading engine
 * uses (`sunhours.ts`), so what you see and what the number says agree.
 */
const EYE_HEIGHT = 1.6

/** Walking pace, metres per second. Shift runs. */
const WALK_SPEED = 34
const RUN_SPEED = 110

/**
 * How quickly velocity converges on its target. Higher is snappier; this is
 * tuned so a keypress has a little weight without feeling like ice.
 */
const ACCEL = 9

export interface LookState {
  /** compass bearing the camera faces, degrees from north */
  yaw: number
  /** vertical angle, degrees; positive is up */
  pitch: number
  /** metres east of the landing point — where you've walked to */
  x: number
  /** metres south of the landing point */
  z: number
  /** true while the viewer is moving under their own power */
  moving: boolean
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
  groundAt,
  roamRadius = 600,
  onMove,
}: {
  active: boolean
  initialYaw: number
  initialPitch: number
  resetKey: string
  fovRef?: React.MutableRefObject<number>
  onChange?: (s: LookState) => void
  /**
   * Ground height at a local (x, z), in metres. Supplied by the scene so the
   * walker follows the terrain instead of floating through it.
   */
  groundAt?: (x: number, z: number) => number
  /** How far you may wander from the landing point before the scene runs out. */
  roamRadius?: number
  /** Fires when the viewer walks somewhere — used to re-anchor the sun maths. */
  onMove?: (x: number, z: number) => void
}) {
  const { camera, gl } = useThree()

  const yaw = useRef(initialYaw * DEG)
  const pitch = useRef(initialPitch * DEG)
  const vYaw = useRef(0)
  const vPitch = useRef(0)
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const lastT = useRef(0)

  /* ---- walking ---- */
  // Which movement keys are held. A Set rather than booleans so diagonal
  // movement composes without a combinatorial mess of flags.
  const keys = useRef(new Set<string>())
  // Current horizontal velocity in metres/second, smoothed toward the target
  // so starting and stopping have weight rather than snapping.
  const vel = useRef({ x: 0, z: 0 })
  // A double-tap destination. Null when not travelling.
  const travel = useRef<{ x: number; z: number; t: number } | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number }>({ t: 0, x: 0, y: 0 })
  // Read inside the pointer handler, which closes over its own scope.
  const eyeHeightRef = useRef(EYE_HEIGHT)
  // Shift is a modifier, not a direction — tracked separately so releasing it
  // mid-stride slows you down rather than stopping you.
  const runRef = useRef(false)

  // Re-aim on arrival, or whenever the destination changes.
  useEffect(() => {
    if (!active) return
    yaw.current = initialYaw * DEG
    pitch.current = initialPitch * DEG
    vYaw.current = 0
    vPitch.current = 0
    // A new location means a new origin — don't arrive already walking, and
    // don't carry the previous place's position into this one.
    keys.current.clear()
    vel.current = { x: 0, z: 0 }
    travel.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resetKey])

  useEffect(() => {
    if (!active) return
    const el = gl.domElement

    const down = (e: PointerEvent) => {
      // Left button (or touch) only — let right-click through for context menus.
      if (e.button !== 0) return

      /*
       * Double-tap to travel there.
       *
       * Looking around from one spot tells you what blocks your sun; it doesn't
       * let you go and stand where it doesn't. Walking with keys covers that,
       * but "get me over there" is a single gesture on every map people have
       * ever used, and it's the only one available on a touchscreen.
       *
       * 350ms and 24px are the usual double-tap thresholds — generous enough
       * for a fingertip, tight enough that two deliberate separate taps don't
       * trigger it.
       */
      const now = performance.now()
      const isDouble =
        now - lastTap.current.t < 350 &&
        Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 24
      lastTap.current = { t: now, x: e.clientX, y: e.clientY }

      if (isDouble) {
        const dest = groundPointUnder(e)
        if (dest) {
          travel.current = { x: dest.x, z: dest.z, t: now }
          // Cancel any keyboard walk so the two don't fight over the camera.
          keys.current.clear()
          return
        }
      }

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

    /**
     * Where on the ground did this tap land?
     *
     * Rather than raycasting against the terrain mesh — which means reaching
     * into the scene graph and depends on what's loaded — this intersects the
     * view ray with the horizontal plane at the viewer's feet. The terrain is
     * gently sloped at this scale, so the error is small, and the height is
     * corrected on arrival anyway by the ground-follow in useFrame.
     *
     * Returns null when the tap is above the horizon, where the ray never
     * meets the ground and "travel there" is meaningless.
     */
    const groundPointUnder = (e: PointerEvent): { x: number; z: number } | null => {
      const rect = el.getBoundingClientRect()
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1

      const ray = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize()

      // Looking up, or level: no ground intersection.
      if (ray.y > -1e-3) return null

      const feet = camera.position.y - eyeHeightRef.current
      const dist = (camera.position.y - feet) / -ray.y
      if (!isFinite(dist) || dist <= 0) return null

      const x = camera.position.x + ray.x * dist
      const z = camera.position.z + ray.z * dist

      // Don't let a tap at the horizon fling the viewer past the loaded scene.
      const r = Math.hypot(x, z)
      if (r > roamRadius) {
        const k = roamRadius / r
        return { x: x * k, z: z * k }
      }
      return { x, z }
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
  }, [active, gl, camera, fovRef, roamRadius])

  /*
   * Keyboard.
   *
   * Three overlapping jobs on one keyboard, so the mapping has to be
   * unambiguous:
   *
   *   WASD / plain arrows  — walk. The verb people already have for 3D space.
   *   Alt + arrows         — look. Kept from before; the only pointer-free way
   *                          to reach the sky, which matters in a sun app.
   *   Escape               — stop moving, immediately.
   *
   * Walking is tracked as held keys rather than per-keypress steps, because a
   * step-per-event walk moves at the OS key-repeat rate — which is jerky, and
   * differs per machine.
   */
  useEffect(() => {
    if (!active) return

    const WALK_KEYS: Record<string, string> = {
      KeyW: 'f',
      KeyS: 'b',
      KeyA: 'l',
      KeyD: 'r',
      ArrowUp: 'f',
      ArrowDown: 'b',
      ArrowLeft: 'l',
      ArrowRight: 'r',
    }

    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      if (inField) return

      // Alt + arrows still look around, so check that before walking.
      if (e.altKey) {
        const step = (e.shiftKey ? 12 : 4) * DEG
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          pitch.current = clamp(pitch.current + step, -PITCH_LIMIT, PITCH_LIMIT)
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          pitch.current = clamp(pitch.current - step, -PITCH_LIMIT, PITCH_LIMIT)
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          yaw.current += step
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          yaw.current -= step
        }
        return
      }

      if (e.key === 'Escape') {
        keys.current.clear()
        vel.current = { x: 0, z: 0 }
        travel.current = null
        return
      }

      runRef.current = e.shiftKey

      const dir = WALK_KEYS[e.code]
      if (dir) {
        // Arrow keys scroll the page by default, which fights the walk.
        e.preventDefault()
        keys.current.add(dir)
        // Pressing a key takes manual control back from an in-progress travel.
        travel.current = null
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      runRef.current = e.shiftKey
      const dir = WALK_KEYS[e.code]
      if (dir) keys.current.delete(dir)
    }

    // Losing focus mid-stride would otherwise leave the viewer walking forever.
    const onBlur = () => {
      keys.current.clear()
      vel.current = { x: 0, z: 0 }
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [active])

  const target = useRef(new THREE.Vector3())

  useFrame((_, delta) => {
    if (!active) return

    // Cap the step. A backgrounded tab resumes with a huge delta, which would
    // teleport the viewer across the scene in a single frame.
    const dt = Math.min(delta, 0.05)

    /* ---------------- looking ---------------- */

    // Momentum glide. Decays fast enough to feel controlled rather than
    // floaty, and is cancelled outright on the next grab.
    if (!dragging.current) {
      const decay = Math.pow(0.0016, dt)
      yaw.current += vYaw.current * dt * 1000
      pitch.current = clamp(
        pitch.current + vPitch.current * dt * 1000,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      )
      vYaw.current *= decay
      vPitch.current *= decay
      if (Math.abs(vYaw.current) < 1e-6) vYaw.current = 0
      if (Math.abs(vPitch.current) < 1e-6) vPitch.current = 0
    }

    /* ---------------- walking ---------------- */

    // Target velocity from held keys, in the direction the viewer is facing.
    // Movement is horizontal regardless of pitch — looking at the sky and
    // walking forward should not launch you into it.
    let tx = 0
    let tz = 0
    const held = keys.current
    if (held.size) {
      const sin = Math.sin(yaw.current)
      const cos = Math.cos(yaw.current)
      // Forward is the compass bearing; strafe is 90° to its right.
      let f = 0
      let r = 0
      if (held.has('f')) f += 1
      if (held.has('b')) f -= 1
      if (held.has('r')) r += 1
      if (held.has('l')) r -= 1
      // Normalise so diagonals aren't faster than the cardinals.
      const mag = Math.hypot(f, r)
      if (mag > 0) {
        f /= mag
        r /= mag
        const speed = runRef.current ? RUN_SPEED : WALK_SPEED
        tx = (sin * f + cos * r) * speed
        tz = (-cos * f + sin * r) * speed
      }
    } else if (travel.current) {
      // Travelling to a double-tapped point. Ease out on approach rather than
      // stopping dead, and give up when close enough that another step would
      // overshoot.
      const dx = travel.current.x - camera.position.x
      const dz = travel.current.z - camera.position.z
      const dist = Math.hypot(dx, dz)
      if (dist < 1.5) {
        travel.current = null
      } else {
        // Slow into the destination over the last 40 metres.
        const speed = Math.min(RUN_SPEED, Math.max(12, dist * 1.6))
        tx = (dx / dist) * speed
        tz = (dz / dist) * speed
      }
    }

    // Smooth toward the target so starting and stopping have weight. An
    // exponential approach is frame-rate independent, unlike a fixed lerp.
    const k = 1 - Math.exp(-ACCEL * dt)
    vel.current.x += (tx - vel.current.x) * k
    vel.current.z += (tz - vel.current.z) * k

    const speed2 = vel.current.x * vel.current.x + vel.current.z * vel.current.z
    if (speed2 > 1e-4) {
      let nx = camera.position.x + vel.current.x * dt
      let nz = camera.position.z + vel.current.z * dt

      // Stay inside the loaded scene. Beyond this the terrain mesh and the
      // buildings simply don't exist, and walking into the void looks broken.
      const r = Math.hypot(nx, nz)
      if (r > roamRadius) {
        const clampK = roamRadius / r
        nx *= clampK
        nz *= clampK
        // Kill the outward component so we slide along the boundary rather
        // than juddering against it.
        vel.current.x *= 0.5
        vel.current.z *= 0.5
      }

      camera.position.x = nx
      camera.position.z = nz
      onMove?.(nx, nz)
    } else {
      vel.current.x = 0
      vel.current.z = 0
    }

    /* ---------------- standing on the ground ---------------- */

    // Follow the terrain rather than floating at a fixed altitude. Without
    // this, walking uphill puts you inside the hill and downhill leaves you in
    // mid-air — and the sun answer is about where a person could actually
    // stand.
    if (groundAt) {
      const want = groundAt(camera.position.x, camera.position.z) + EYE_HEIGHT
      if (isFinite(want)) {
        // Ease vertically so a kerb doesn't jolt the whole view.
        const vk = 1 - Math.exp(-14 * dt)
        camera.position.y += (want - camera.position.y) * vk
      }
    }

    /* ---------------- aim ---------------- */

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
      yaw: (((yaw.current / DEG) % 360) + 360) % 360,
      pitch: pitch.current / DEG,
      x: camera.position.x,
      z: camera.position.z,
      moving: speed2 > 1e-4,
    })
  })

  return null
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
