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
import { Globe } from './Globe'
import { GroundScene, loadGround, SCENE_RADIUS, type GroundData } from './Ground'
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
  onModeChange?: (mode: 'globe' | 'ground') => void
  onGroundState?: (s: GroundState) => void
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
    }
  | { status: 'error'; message: string }

/* ------------------------------------------------------------------ */

function Sun({
  subsolar,
  angularSize,
  brightness,
}: {
  subsolar: { lat: number; lon: number }
  angularSize: number
  brightness: number
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
  const glowScale = 1 + Math.min(3.2, 0.55 / Math.max(0.06, angularSize))
  const glow = useGlowTexture()

  return (
    <group position={pos}>
      <mesh>
        <sphereGeometry args={[radius, 32, 32]} />
        <meshBasicMaterial color="#fff8e7" toneMapped={false} />
      </mesh>
      <sprite scale={[radius * 9 * glowScale, radius * 9 * glowScale, 1]}>
        <spriteMaterial
          map={glow}
          transparent
          opacity={Math.min(0.85, 0.28 + brightness * 0.4)}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
      <pointLight intensity={2.2} distance={0} decay={0} color="#fff6e0" />
    </group>
  )
}

function useGlowTexture() {
  return useMemo(() => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,248,231,1)')
    g.addColorStop(0.18, 'rgba(255,236,190,0.55)')
    g.addColorStop(0.45, 'rgba(255,214,140,0.16)')
    g.addColorStop(1, 'rgba(255,200,120,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [])
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
  useFrame(() => {
    if (!enabled) {
      if (mode === 'ground') onChange('globe')
      return
    }
    const d = camera.position.length()

    // The two modes measure distance in completely different units — globe
    // radii (~1.5-7) versus metres (~40-2100). Comparing a ground-mode camera
    // against the globe threshold instantly reads as "way too far out" and
    // bounces you back to orbit the moment you land. Each mode gets its own
    // exit test, in its own units.
    if (mode === 'globe') {
      if (d < DESCEND_AT) onChange('ground')
    } else {
      // Pulling back past ~2.4 km means you've zoomed out of the scene.
      if (d > SCENE_RADIUS * 3.4) onChange('globe')
    }
  })
  return null
}

/** Camera rig for the ground scene, in metres rather than globe radii. */
function GroundCamera({ active }: { active: boolean }) {
  const { camera } = useThree()
  const done = useRef(false)

  useEffect(() => {
    if (!active) {
      done.current = false
      return
    }
    // Arrive looking across the scene at a low angle — that's the view where
    // shadows read, and the reason to be down here at all.
    camera.position.set(0, 190, 470)
    camera.lookAt(0, 30, 0)
    camera.near = 1
    camera.far = SCENE_RADIUS * 12
    camera.updateProjectionMatrix()
    done.current = true
  }, [active, camera])

  useEffect(() => {
    if (active) return
    // Restore the globe camera's clipping planes on the way out, and place it
    // clear of the descend threshold so we don't immediately fall back down.
    camera.near = 0.1
    camera.far = 100
    if (camera.position.length() < 3) {
      camera.position.normalize().multiplyScalar(4.1)
    }
    camera.updateProjectionMatrix()
  }, [active, camera])

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
  onModeChange,
  onGroundState,
}: SceneProps) {
  const controlsRef = useRef<any>(null)
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
        })
      })
      .catch((e) => {
        if (ac.signal.aborted) return
        onGroundState?.({ status: 'error', message: String(e?.message ?? e) })
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ground, marker.lat, marker.lon])

  const isGround = mode === 'ground'

  return (
    <Canvas
      camera={{ position: [0, 1.2, 4.1], fov: 36, near: 0.1, far: 100 }}
      gl={{
        antialias: true,
        alpha: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 0.85 + Math.min(0.5, brightness * 0.3),
      }}
      shadows
      dpr={[1, 2]}
    >
      <ambientLight intensity={isGround ? 0 : 0.055} />

      {!isGround && (
        <>
          <Stars radius={60} depth={30} count={3500} factor={3.5} saturation={0} fade speed={0.4} />
          <Sun subsolar={subsolar} angularSize={sunAngularSize} brightness={brightness} />
          <Suspense fallback={null}>
            <Globe
              subsolar={subsolar}
              marker={marker}
              onPick={onPick}
              cloudOpacity={cloudOpacity}
              lightScale={brightness}
              surfaceTexture={surfaceTexture}
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

      <ModeWatcher enabled={allowGround} mode={mode} onChange={setMode} />
      <GroundCamera active={isGround} />

      {!isGround && <GlobeCamera target={marker} enabled={autoRotate} controls={controlsRef} />}

      <OrbitControls
        ref={controlsRef}
        enablePan={false}
        enableDamping
        dampingFactor={0.06}
        rotateSpeed={0.45}
        zoomSpeed={0.7}
        // In ground mode the units are metres, so the limits change entirely.
        minDistance={isGround ? 40 : 1.5}
        maxDistance={isGround ? SCENE_RADIUS * 3 : 7}
        // Don't let the camera go under the terrain.
        maxPolarAngle={isGround ? Math.PI * 0.495 : Math.PI}
        target={isGround ? [0, 30, 0] : [0, 0, 0]}
        enabled={!autoRotate || isGround}
      />
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
