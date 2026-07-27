/**
 * Scene.tsx — camera, stars, the sun, and the descent to ground level.
 *
 * Two worlds share one canvas. Zoom in past the threshold and the globe hands
 * off to a real 3D scene of the pinned location; zoom out and it hands back.
 * The sun vector is the same in both, so the light is continuous across the
 * transition — that continuity is the point.
 */

import { Suspense, useMemo, useRef, useEffect, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Stars } from '@react-three/drei'
import * as THREE from 'three'
import { deviceProfile } from '../lib/device'
import { ContextGuard, type ContextStatus } from './ContextGuard'
import { Globe } from './Globe'
import { GroundScene, loadGround, SCENE_RADIUS, type GroundData } from './Ground'
import { sampleHeightLocal, unproject } from '../lib/terrain'
import { LookControls, type LookState } from './LookControls'
import { latLonToVec3 } from '../lib/solar'

/** Camera distance (in globe radii) at which we switch to the ground scene. */
const DESCEND_AT = 1.62

interface SceneProps {
  subsolar: { lat: number; lon: number }
  marker: { lat: number; lon: number }
  onPick: (lat: number, lon: number) => void
  cloudOpacity: number
  sunAngularSize: number
  brightness: number
  surfaceTexture: string
  atmosphereTint: [number, number, number]
  hasAtmosphere: boolean
  autoRotate: boolean
  /** sun altitude at the pin, degrees — drives the ground lighting */
  sunAltitude: number
  /** sun bearing at the pin, degrees from north */
  sunAzimuth: number
  /** sky colour for the current light phase */
  skyTint: string
  /** ground mode is only meaningful on Earth */
  allowGround: boolean
  /** increment to toggle between globe and ground from the UI */
  descendSignal?: number
  /** +1 zooms in, -1 zooms out; a counter so repeat clicks always register */
  zoomNudge?: number
  /** true while the descent wash is playing — dive the camera toward the pin */
  diving?: boolean
  onModeChange?: (mode: 'globe' | 'ground') => void
  onGroundState?: (s: GroundState) => void
  /** where the viewer is looking and standing in ground mode */
  onLook?: (s: LookState) => void
  /** WebGL context health — drives the recovery notice */
  onContextStatus?: (s: ContextStatus) => void
  /** live coordinate under the cursor on the globe */
  onHover?: (c: { lat: number; lon: number } | null) => void
  /**
   * Fires as the viewer walks in ground mode, with the real-world coordinate
   * they've reached — so the sun readings follow them rather than staying
   * pinned to where they landed.
   */
  onGroundWalk?: (lat: number, lon: number) => void
}

export type GroundState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      buildings: number
      elevation: number
      empty: boolean
      buildingsFailed: boolean
      /** how many building heights were guessed from storey counts */
      estimated: number
      /** mapped trees nearby — a coverage signal, not just a count */
      trees: number
      /** the loaded scene, so the shading engine can raytrace against it */
      data: GroundData
    }
  | { status: 'error'; message: string }

/* ------------------------------------------------------------------ */

function Sun({
  subsolar,
  angularSize,
}: {
  subsolar: { lat: number; lon: number }
  angularSize: number
}) {
  const DIST = 22
  const pos = useMemo(() => {
    const [x, y, z] = latLonToVec3(subsolar.lat, subsolar.lon, DIST)
    return new THREE.Vector3(x, y, z)
  }, [subsolar.lat, subsolar.lon])

  const radius = useMemo(
    () => DIST * Math.tan((angularSize / 2) * (Math.PI / 180)),
    [angularSize],
  )
  return (
    <group position={pos}>
      <mesh>
        <sphereGeometry args={[radius, 32, 32]} />
        <meshBasicMaterial color="#fff8e7" toneMapped={false} />
      </mesh>
      {/* No corona sprite in globe mode.
          A sprite always faces the camera, so when the subsolar point rotated
          toward the viewer this additive quad sat between the camera and Earth
          and painted a large ghost disc over the continents. depthTest didn't
          save it — the sprite is genuinely in front at that angle.

          It also wasn't earning its place: at true angular size the sun is a
          few pixels here, and the atmosphere shell already communicates which
          limb is lit. The ground scene has its own sun, where a corona makes
          sense because you're actually looking at the sky. */}
    </group>
  )
}

/* ------------------------------------------------------------------ */
/* Mode switching                                                      */
/* ------------------------------------------------------------------ */

/**
 * Watches camera distance and flips between globe and ground.
 *
 * Hysteresis matters here: descending and ascending use different thresholds,
 * so the scene can't flicker back and forth when the camera sits right on the
 * boundary.
 */
function ModeWatcher({
  enabled,
  mode,
  onChange,
}: {
  enabled: boolean
  mode: 'globe' | 'ground'
  onChange: (m: 'globe' | 'ground') => void
}) {
  const { camera } = useThree()

  /*
   * A mode change repositions the camera, but not until the next effect runs —
   * and this watcher polls every frame. Without a lockout it can observe the
   * camera still holding the OLD mode's coordinates and immediately flip back,
   * which is how a single scroll could ping-pong between globe and ground.
   *
   * A few frames of quiet after each change is all it takes: by then
   * GroundCamera has written the new position and the reading is meaningful.
   */
  const settle = useRef(0)
  const lastMode = useRef(mode)
  if (lastMode.current !== mode) {
    lastMode.current = mode
    settle.current = 6
  }

  useFrame(() => {
    if (settle.current > 0) {
      settle.current--
      return
    }

    if (!enabled) {
      if (mode === 'ground') onChange('globe')
      return
    }
    const d = camera.position.length()
    if (!isFinite(d)) return

    // The two modes measure distance in completely different units — globe
    // radii (~1.5-7) versus metres (~40-2100). Comparing a ground-mode camera
    // against the globe threshold instantly reads as "way too far out" and
    // bounces you back to orbit the moment you land. Each mode gets its own
    // exit test, in its own units.
    if (mode === 'globe') {
      // Only descend from a plausible orbit distance. A camera still carrying
      // ground-mode metres is not "very close to the globe", it's nonsense.
      if (d < DESCEND_AT && d > 0.5) onChange('ground')
    } else {
      // Pulling back past ~2.4 km means you've zoomed out of the scene.
      if (d > SCENE_RADIUS * 3.4) onChange('globe')
    }
  })
  return null
}

/**
 * Camera rig for the ground scene, in metres rather than globe radii.
 *
 * Crucially, it arrives FACING THE SUN. The first version dropped you at a
 * fixed bearing regardless of where the light was, so on a westerly afternoon
 * the sun sat behind your head and the whole scene became a guessing game
 * about the light source. Landing with the sun in frame is the entire point of
 * standing here.
 */
function GroundCamera({
  active,
  sunAzimuth,
  sunAltitude,
  fovRef,
}: {
  active: boolean
  sunAzimuth: number
  sunAltitude: number
  fovRef: React.MutableRefObject<number>
}) {
  const { camera } = useThree()

  useEffect(() => {
    if (!active) return

    // Stand back from the pin on the far side from the sun, at a height that
    // reads as a low vantage point rather than a drone. The camera no longer
    // orbits — LookControls rotates it in place from here — so this is a
    // standing position, not an orbit radius.
    const az = (sunAzimuth * Math.PI) / 180
    const back = 420
    camera.position.set(-back * Math.sin(az), 95, back * Math.cos(az))
    camera.near = 1
    camera.far = SCENE_RADIUS * 12
    ;(camera as THREE.PerspectiveCamera).fov = 55
    fovRef.current = 55
    camera.updateProjectionMatrix()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, camera])

  useEffect(() => {
    if (active) return

    /*
     * Coming back up to the globe.
     *
     * The two modes measure space in incompatible units: the globe has radius
     * 1 and the camera orbits at 1.5–7, while the ground scene is in metres
     * and the camera sits ~430 out and 95 up. So the position left behind by
     * ground mode is meaningless as a globe position and MUST be replaced.
     *
     * The original guard only rescued a camera that was too CLOSE (`< 3`),
     * which handled the descent but not the ascent — a returning ground camera
     * is at ~431, sails through the check untouched, and leaves you staring at
     * a tiny Earth from 431 radii away with no way back in. That's the
     * "just keep getting zoomed out" bug: zoom did nothing visible because
     * OrbitControls clamps to maxDistance 7 while the camera was two orders of
     * magnitude beyond it.
     *
     * Now anything outside the orbit range is pulled back to a sane distance,
     * preserving only the DIRECTION so you return facing the place you left.
     */
    camera.near = 0.1
    camera.far = 100
    ;(camera as THREE.PerspectiveCamera).fov = 36

    const d = camera.position.length()
    if (d < 3 || d > 7 || !isFinite(d)) {
      // A zero-length position can't be normalised; fall back to the default
      // vantage rather than producing NaNs.
      if (d < 1e-6 || !isFinite(d)) camera.position.set(0, 1.2, 4.1)
      else camera.position.normalize().multiplyScalar(4.1)
    }
    camera.updateProjectionMatrix()
  }, [active, camera])

  return null
}

/**
 * Wheel zoom for ground mode.
 *
 * Standing still, "zoom" can't mean moving closer — that would walk you across
 * the terrain. It means narrowing the field of view, the way binoculars do.
 * Also keeps the pointer-drag sensitivity honest: LookControls scales its
 * response by fov, so a zoomed-in view turns proportionally slower.
 */
function FovZoom({ fovRef }: { fovRef: React.MutableRefObject<number> }) {
  const { camera, gl } = useThree()
  const target = useRef(fovRef.current)

  useEffect(() => {
    const el = gl.domElement
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // 20° is a tight telephoto; 78° is a wide field that still avoids the
      // fisheye distortion you get past ~85.
      target.current = Math.max(20, Math.min(78, target.current + e.deltaY * 0.045))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [gl])

  useFrame((_, delta) => {
    const cam = camera as THREE.PerspectiveCamera
    if (Math.abs(cam.fov - target.current) < 0.01) return
    cam.fov = THREE.MathUtils.damp(cam.fov, target.current, 10, delta)
    fovRef.current = cam.fov
    cam.updateProjectionMatrix()
  })

  return null
}

/**
 * Flies the globe camera toward the pin while the descent wash plays.
 *
 * Zajno's zoom-continuity point: the transition should carry you between
 * destinations, not blink you there. The wash hides the actual scene swap,
 * but its first ~600ms are still translucent — so the camera really does
 * accelerate at the pin underneath. That's what makes the arrival read as
 * having travelled somewhere.
 */
function DiveIn({ target }: { target: { lat: number; lon: number } }) {
  const { camera } = useThree()
  const dest = useRef(new THREE.Vector3())

  useFrame((_, delta) => {
    const [x, y, z] = latLonToVec3(target.lat, target.lon, 1.12)
    dest.current.set(x, y, z)
    // Accelerating, not linear — the whole point of easing.
    camera.position.lerp(dest.current, 1 - Math.pow(0.02, delta))
    camera.lookAt(0, 0, 0)
  })

  return null
}

/** Applies the zoom buttons' nudges to the camera. */
function ZoomControl({ nudge }: { nudge: number }) {
  const { camera } = useThree()
  const last = useRef(nudge)
  const target = useRef<number | null>(null)

  if (nudge !== last.current) {
    const dir = Math.sign(nudge - last.current)
    last.current = nudge
    const d = camera.position.length()
    // 22% per click — enough to feel like progress, small enough to aim with.
    target.current = THREE.MathUtils.clamp(d * (dir > 0 ? 0.78 : 1.28), 1.45, 7)
  }

  useFrame((_, delta) => {
    if (target.current === null) return
    const d = camera.position.length()
    const next = THREE.MathUtils.damp(d, target.current, 9, delta)
    camera.position.setLength(next)
    if (Math.abs(next - target.current) < 0.005) target.current = null
  })

  return null
}

/* ------------------------------------------------------------------ */

export function Scene({
  subsolar,
  marker,
  onPick,
  cloudOpacity,
  sunAngularSize,
  brightness,
  surfaceTexture,
  atmosphereTint,
  hasAtmosphere,
  autoRotate,
  sunAltitude,
  sunAzimuth,
  skyTint,
  allowGround,
  descendSignal = 0,
  zoomNudge = 0,
  diving = false,
  onModeChange,
  onGroundState,
  onLook,
  onContextStatus,
  onHover,
  onGroundWalk,
}: SceneProps) {
  // Read once — the answer can't change mid-session, and probing creates a
  // throwaway GL context we don't want to make on every render.
  const dev = useMemo(() => deviceProfile(), [])
  const controlsRef = useRef<any>(null)
  // Field of view is the ground-mode zoom, and LookControls reads it to scale
  // drag sensitivity.
  const fovRef = useRef(55)
  const [mode, setMode] = useState<'globe' | 'ground'>(() =>
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('ground')
      ? 'ground'
      : 'globe',
  )
  const [ground, setGround] = useState<GroundData | null>(null)

  // Leaving Earth, or moving the pin, invalidates the loaded ground.
  useEffect(() => {
    setGround(null)
  }, [marker.lat, marker.lon])

  useEffect(() => {
    if (!allowGround && mode === 'ground') setMode('globe')
  }, [allowGround, mode])

  useEffect(() => {
    onModeChange?.(mode)
  }, [mode, onModeChange])

  // The "Land here" button toggles modes directly. Zooming still works; this
  // just makes the capability findable.
  const firstSignal = useRef(true)
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false
      return
    }
    if (!allowGround) return
    setMode((m) => (m === 'ground' ? 'globe' : 'ground'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descendSignal])

  // Fetch terrain + buildings when we descend.
  useEffect(() => {
    if (mode !== 'ground' || ground) return
    const ac = new AbortController()
    onGroundState?.({ status: 'loading' })
    loadGround(marker.lat, marker.lon, ac.signal)
      .then((g) => {
        if (ac.signal.aborted) return
        setGround(g)
        onGroundState?.({
          status: 'ready',
          buildings: g.buildings.length,
          elevation: g.originHeight,
          empty: g.empty,
          buildingsFailed: g.buildingsFailed,
          estimated: g.buildings.filter((b) => b.estimated).length,
          trees: g.vegetation.trees.length,
          data: g,
        })
      })
      .catch((e) => {
        if (ac.signal.aborted) return
        onGroundState?.({ status: 'error', message: String(e?.message ?? e) })
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ground, marker.lat, marker.lon])

  /**
   * Ground height at a local (x, z), for the walker to stand on.
   *
   * Heights are relative to the landing point, matching the terrain mesh the
   * renderer builds — so "0" is the elevation where you touched down, not sea
   * level. Returns 0 before the terrain arrives, which keeps the camera at a
   * sane height during the descent rather than dropping it to the origin.
   */
  const groundAt = useMemo(() => {
    if (!ground) return undefined
    const { heightField, frame, originHeight } = ground
    return (x: number, z: number) =>
      sampleHeightLocal(heightField, frame, x, z) - originHeight
  }, [ground])

  /**
   * Turn a walked-to scene position back into a latitude and longitude.
   *
   * Throttled hard: the solar maths and the shading trace both key off the
   * coordinate, and recomputing them at 60fps while someone strolls down a
   * street would make walking feel like wading. A quarter second is well
   * inside the distance at which the sun's position meaningfully changes.
   */
  const lastWalk = useRef(0)
  const onWalk = useMemo(() => {
    if (!ground || !onGroundWalk) return undefined
    const { frame } = ground
    return (x: number, z: number) => {
      const now = performance.now()
      if (now - lastWalk.current < 250) return
      lastWalk.current = now
      const { lat, lon } = unproject(frame, x, z)
      onGroundWalk(lat, lon)
    }
  }, [ground, onGroundWalk])

  const isGround = mode === 'ground'

  return (
    <Canvas
      camera={{ position: [0, 1.2, 4.1], fov: 36, near: 0.1, far: 100 }}
      gl={{
        // MSAA is off on mobile: it multiplies the size of every render buffer
        // at exactly the moment we're trying to stay under a memory ceiling.
        antialias: dev.antialias,
        alpha: true,
        // On mobile, asking for the high-performance GPU asks for the one that
        // drains the battery and runs hot — and thermal throttling on iOS
        // manifests as the context being taken away. A desktop with a discrete
        // GPU genuinely benefits, so this is split rather than picked once.
        powerPreference: dev.isAppleMobile ? 'low-power' : 'high-performance',
        failIfMajorPerformanceCaveat: false,
        toneMapping: THREE.ACESFilmicToneMapping,
        // Exposure was compounding with the shader's own brightness, blowing
        // the day side to pure white. The shader already scales by irradiance;
        // this only needs to lift the very dim outer planets.
        toneMappingExposure: 0.92 + Math.min(0.22, (1 - Math.min(1, brightness)) * 0.22),
      }}
      shadows={dev.tier > 1024}
      // Was [1, 2] on every device. On a 3x phone that renders 9 pixels for
      // every CSS pixel, on top of the texture cost, which is what pushed iOS
      // over its limit.
      dpr={[1, dev.maxDpr]}
      onCreated={({ gl }) => {
        // A lost context that isn't preventDefault()ed is gone for good. three
        // handles this internally, but only from the moment it's listening.
        gl.domElement.addEventListener(
          'webglcontextlost',
          (e) => e.preventDefault(),
          false,
        )
      }}
    >
      <ContextGuard onStatus={onContextStatus} />
      <ambientLight intensity={isGround ? 0 : 0.055} />

      {!isGround && (
        <>
          <Stars radius={60} depth={30} count={3500} factor={3.5} saturation={0} fade speed={0.4} />
          <Sun subsolar={subsolar} angularSize={sunAngularSize} />
          <Suspense fallback={null}>
            <Globe
              subsolar={subsolar}
              marker={marker}
              onPick={onPick}
              cloudOpacity={cloudOpacity}
              lightScale={brightness}
              surfaceTexture={surfaceTexture}
              onHover={onHover}
              atmosphereTint={atmosphereTint}
              hasAtmosphere={hasAtmosphere}
            />
          </Suspense>
        </>
      )}

      {isGround && ground && (
        <GroundScene
          data={ground}
          altitude={sunAltitude}
          azimuth={sunAzimuth}
          skyTint={skyTint}
        />
      )}

      {!isGround && <ZoomControl nudge={zoomNudge} />}
      {!isGround && diving && <DiveIn target={marker} />}
      <ModeWatcher enabled={allowGround} mode={mode} onChange={setMode} />
      <GroundCamera active={isGround} sunAzimuth={sunAzimuth} sunAltitude={sunAltitude} fovRef={fovRef} />

      {!isGround && <GlobeCamera target={marker} enabled={autoRotate} controls={controlsRef} />}

      {/* Two different control models, because the two modes are two
          different verbs.

          GLOBE — you're inspecting an object, so orbit around it.

          GROUND — you're standing in a place, so look around from it.
          OrbitControls can't do this: it always aims at a fixed target, which
          means the view can never tilt above the horizon. Raising
          maxPolarAngle only buries the camera underground, still looking down.
          In an app about where the sun is, being unable to look up at the sky
          is close to the worst possible limitation. */}
      {isGround ? (
        <LookControls
          active
          initialYaw={sunAzimuth}
          initialPitch={Math.max(6, Math.min(50, sunAltitude * 0.75))}
          resetKey={`${marker.lat.toFixed(3)},${marker.lon.toFixed(3)}`}
          fovRef={fovRef}
          onChange={onLook}
          groundAt={groundAt}
          roamRadius={SCENE_RADIUS * 0.85}
          onMove={onWalk}
        />
      ) : (
        <OrbitControls
          ref={controlsRef}
          enablePan={false}
          enableDamping
          dampingFactor={0.06}
          rotateSpeed={0.45}
          zoomSpeed={0.7}
          // Must sit BELOW DESCEND_AT (1.62) with room to spare, or the wheel
          // stops at the clamp just short of the threshold and the descent
          // never fires — you scroll and scroll and nothing happens. Damping
          // means the camera approaches this floor asymptotically, so the gap
          // has to be generous rather than marginal.
          minDistance={1.35}
          maxDistance={7}
          target={[0, 0, 0]}
          enabled={!autoRotate}
        />
      )}
      {isGround && <FovZoom fovRef={fovRef} />}
    </Canvas>
  )
}

/* ------------------------------------------------------------------ */

function GlobeCamera({
  target,
  enabled,
  controls,
}: {
  target: { lat: number; lon: number }
  enabled: boolean
  controls: React.RefObject<any>
}) {
  const { camera } = useThree()
  const desired = useRef(new THREE.Vector3())
  const settling = useRef(true)
  const lastTarget = useRef(`${target.lat},${target.lon}`)

  const key = `${target.lat},${target.lon}`
  if (key !== lastTarget.current) {
    lastTarget.current = key
    settling.current = true
  }

  useFrame((_, delta) => {
    const active = enabled || settling.current
    if (!active) return

    const dist = camera.position.length()
    const [x, y, z] = latLonToVec3(
      target.lat * 0.82,
      target.lon,
      THREE.MathUtils.clamp(dist, 3.8, 4.4),
    )
    desired.current.set(x, y, z)

    const rate = enabled ? 0.001 : 0.06
    camera.position.lerp(desired.current, 1 - Math.pow(rate, delta))
    camera.lookAt(0, 0, 0)
    controls.current?.update?.()

    if (!enabled && camera.position.distanceTo(desired.current) < 0.02) {
      settling.current = false
    }
  })

  return null
}
