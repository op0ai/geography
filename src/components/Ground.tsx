/**
 * Ground.tsx — the place itself.
 *
 * Real terrain from the AWS DEM, real buildings from OpenStreetMap, lit by the
 * same sun vector that drives the globe. Everything is at true metre scale, so
 * the shadows on the ground are the shadows that place would actually cast at
 * that moment.
 *
 * This is the payoff of owning the solar maths: the light here isn't art
 * direction, it's the same computation, pointed at a smaller area.
 */

import { useMemo, useRef, useEffect, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  makeFrame,
  loadHeightField,
  sampleHeight,
  project,
  type HeightField,
  type LocalFrame,
} from '../lib/terrain'
import {
  fetchBuildings,
  lastFetchFailed,
  centroid,
  footprintArea,
  type Building,
} from '../lib/buildings'

/** How much ground to render, in metres from the pin. */
const SCENE_RADIUS = 700
/** Terrain mesh resolution. 192 is the point where more detail stops showing. */
const GRID = 192

/**
 * The DEM mosaic covers ~3 km but the scene is 1.4 km, so the far corners of
 * the height field include terrain well outside the visible area — around
 * Reykjavík that's Mount Esja at 916 m, four kilometres away. Sampling it at
 * the mesh edge produced a single vertex spiking most of a kilometre into the
 * sky: correct data, wrong place to read it.
 *
 * Clamping relative elevation keeps a real hillside readable while refusing to
 * let a distant mountain get smeared across two grid cells. 320 m of relief
 * across a 700 m radius is already a very steep site.
 */
const MAX_RELIEF = 320

export interface GroundData {
  frame: LocalFrame
  heightField: HeightField
  buildings: Building[]
  /** ground elevation at the pin, metres */
  originHeight: number
  /** true when OSM genuinely has nothing here — countryside, ocean, data gap */
  empty: boolean
  /** true when the building lookup timed out or errored, which is not the same thing */
  buildingsFailed: boolean
}

/** Load terrain and buildings for a location. Both in parallel. */
export async function loadGround(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<GroundData> {
  const z = 14
  const frame = makeFrame(lat, lon, z)

  // Terrain resolves in well under a second; Overpass can take ten. Waiting on
  // both means the fast one is held hostage by the slow one. Buildings degrade
  // to an empty list rather than failing the whole scene — bare terrain is a
  // legitimate result anyway (countryside, ocean, unmapped areas).
  const [heightField, buildings] = await Promise.all([
    loadHeightField(lat, lon, z, 1, signal),
    fetchBuildings(lat, lon, SCENE_RADIUS, signal).catch(() => []),
  ])

  return {
    frame,
    heightField,
    buildings,
    originHeight: sampleHeight(heightField, lat, lon),
    empty: buildings.length === 0 && !lastFetchFailed,
    buildingsFailed: lastFetchFailed,
  }
}

/* ------------------------------------------------------------------ */
/* Terrain                                                             */
/* ------------------------------------------------------------------ */

function Terrain({
  data,
  sunDir,
}: {
  data: GroundData
  sunDir: THREE.Vector3
}) {
  const geometry = useMemo(() => {
    const { frame, heightField, originHeight } = data
    const size = SCENE_RADIUS * 2
    const geo = new THREE.PlaneGeometry(size, size, GRID, GRID)
    geo.rotateX(-Math.PI / 2) // lay flat, Y up

    const pos = geo.attributes.position as THREE.BufferAttribute
    // Elevations are relative to the pin, so the scene sits around y=0 rather
    // than floating hundreds of metres up in world space.
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const { lat, lon } = unprojectLocal(frame, x, z)
      let rel = sampleHeight(heightField, lat, lon) - originHeight

      // Clamp: see MAX_RELIEF. Real slopes survive, distant peaks don't spike.
      rel = Math.max(-MAX_RELIEF, Math.min(MAX_RELIEF, rel))

      // Feather the outer margin down toward the pin's own elevation. Without
      // this the mesh ends on a hard edge wherever terrain outside the scene
      // was climbing — which read as a wall standing on the horizon. The fog
      // hides the flattened rim, so the eye only sees the terrain settle.
      const d = Math.max(Math.abs(x), Math.abs(z)) / SCENE_RADIUS
      if (d > 0.72) {
        const t = Math.min(1, (d - 0.72) / 0.28)
        rel *= 1 - t * t * (3 - 2 * t) // smoothstep
      }

      pos.setY(i, rel)
    }
    pos.needsUpdate = true
    geo.computeVertexNormals()
    return geo
  }, [data])

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <mesh geometry={geometry} receiveShadow castShadow>
      <meshStandardMaterial
        color="#5c6b52"
        roughness={0.95}
        metalness={0}
        flatShading={false}
      />
    </mesh>
  )
}

/** Local metres → lat/lon. Inlined to avoid a per-vertex import round-trip. */
function unprojectLocal(frame: LocalFrame, mx: number, mz: number) {
  const x = frame.tx0 + mx / (256 * frame.scale)
  const y = frame.ty0 + mz / (256 * frame.scale)
  const n = 2 ** frame.z
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return { lat: (latRad * 180) / Math.PI, lon: (x / n) * 360 - 180 }
}

/* ------------------------------------------------------------------ */
/* Buildings                                                           */
/* ------------------------------------------------------------------ */

function Buildings({ data }: { data: GroundData }) {
  const { tagged, guessed } = useMemo(() => {
    const { frame, heightField, buildings, originHeight } = data

    const taggedGeos: THREE.BufferGeometry[] = []
    const guessedGeos: THREE.BufferGeometry[] = []

    for (const b of buildings) {
      if (b.outer.length < 4) continue
      if (footprintArea(b.outer) < 12) continue // sheds and map noise

      // Belt and braces after the ring-stitching fix: refuse anything with an
      // absurd aspect ratio or a height OSM clearly got wrong. A sliver
      // extruded 200 m becomes a spike, and one spike ruins the whole scene.
      const area = footprintArea(b.outer)
      if (area > 400_000) continue // bigger than a city block: bad geometry
      if (b.height > 350 || b.height <= 0) continue // taller than any building here

      // Outer ring in local metres.
      const pts = b.outer.map((p) => {
        const [x, z] = project(frame, p.lat, p.lon)
        return new THREE.Vector2(x, z)
      })
      // Shape wants an open ring; the OSM ring repeats its first point.
      if (
        pts.length > 1 &&
        pts[0].distanceTo(pts[pts.length - 1]) < 1e-6
      ) {
        pts.pop()
      }
      if (pts.length < 3) continue

      const shape = new THREE.Shape(pts)

      for (const hole of b.inner) {
        const hpts = hole.map((p) => {
          const [x, z] = project(frame, p.lat, p.lon)
          return new THREE.Vector2(x, z)
        })
        if (hpts.length > 1 && hpts[0].distanceTo(hpts[hpts.length - 1]) < 1e-6) {
          hpts.pop()
        }
        if (hpts.length >= 3) shape.holes.push(new THREE.Path(hpts))
      }

      const depth = Math.max(1, b.height - b.minHeight)

      let geo: THREE.ExtrudeGeometry
      try {
        geo = new THREE.ExtrudeGeometry(shape, {
          depth,
          bevelEnabled: false,
          curveSegments: 1,
        })
      } catch {
        continue // degenerate polygon — OSM has a few
      }

      // ExtrudeGeometry builds in XY extruding along +Z. Rotate so it stands up.
      geo.rotateX(-Math.PI / 2)

      // Sit it on the terrain. Sampling at the centroid keeps each building's
      // base flat; sinking it slightly stops it hovering on a slope.
      const c = centroid(b.outer)
      const rawGround = sampleHeight(heightField, c.lat, c.lon) - originHeight
      const ground = Math.max(-MAX_RELIEF, Math.min(MAX_RELIEF, rawGround))
      geo.translate(0, ground + b.minHeight - 0.5, 0)

      ;(b.estimated ? guessedGeos : taggedGeos).push(geo)
    }

    const merge = (list: THREE.BufferGeometry[]) => {
      if (!list.length) return null
      const m = mergeGeometries(list, false)
      list.forEach((g) => g.dispose())
      return m
    }

    return { tagged: merge(taggedGeos), guessed: merge(guessedGeos) }
  }, [data])

  useEffect(
    () => () => {
      tagged?.dispose()
      guessed?.dispose()
    },
    [tagged, guessed],
  )

  return (
    <group>
      {/* Buildings with a real tagged height. */}
      {tagged && (
        <mesh geometry={tagged} castShadow receiveShadow>
          <meshStandardMaterial color="#c8c4bd" roughness={0.78} metalness={0.02} />
        </mesh>
      )}
      {/* Buildings whose height we inferred from storey count, or defaulted.
          Rendered slightly cooler and duller so the guess is visible rather
          than passed off as measurement. */}
      {guessed && (
        <mesh geometry={guessed} castShadow receiveShadow>
          <meshStandardMaterial color="#9aa0a6" roughness={0.9} metalness={0} />
        </mesh>
      )}
    </group>
  )
}

/* ------------------------------------------------------------------ */
/* The pin, restated at ground level                                   */
/* ------------------------------------------------------------------ */

function GroundPin({ lit }: { lit: boolean }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame((s) => {
    if (!ref.current) return
    const t = s.clock.elapsedTime
    ref.current.scale.setScalar(1 + Math.sin(t * 2) * 0.12)
    ;(ref.current.material as THREE.MeshBasicMaterial).opacity =
      0.5 - Math.sin(t * 2) * 0.18
  })
  const color = lit ? '#ffcc4d' : '#7dd3fc'
  return (
    <group>
      <mesh position={[0, 22, 0]}>
        <sphereGeometry args={[2.2, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={[0, 11, 0]}>
        <cylinderGeometry args={[0.35, 0.35, 22, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.75} />
      </mesh>
      <mesh ref={ref} position={[0, 0.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[6, 8, 40]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  )
}

/* ------------------------------------------------------------------ */
/* The sun, as an actual light                                         */
/* ------------------------------------------------------------------ */

function SunLight({
  altitude,
  azimuth,
  intensity,
}: {
  altitude: number
  azimuth: number
  intensity: number
}) {
  const ref = useRef<THREE.DirectionalLight>(null)

  useEffect(() => {
    const l = ref.current
    if (!l) return
    // Frustum sized to the scene. Tight bounds keep the shadow map's
    // resolution where it matters — an oversized frustum is the usual reason
    // shadows look blocky.
    const c = l.shadow.camera as THREE.OrthographicCamera
    const r = SCENE_RADIUS * 1.25
    c.left = -r
    c.right = r
    c.top = r
    c.bottom = -r
    c.near = 1
    c.far = SCENE_RADIUS * 8
    c.updateProjectionMatrix()
  }, [])

  const pos = useMemo(() => {
    const alt = (altitude * Math.PI) / 180
    const az = (azimuth * Math.PI) / 180
    const d = SCENE_RADIUS * 3
    // Azimuth is measured clockwise from north; north is -Z, east is +X.
    return new THREE.Vector3(
      d * Math.cos(alt) * Math.sin(az),
      d * Math.sin(alt),
      -d * Math.cos(alt) * Math.cos(az),
    )
  }, [altitude, azimuth])

  const below = altitude < -0.833

  return (
    <directionalLight
      ref={ref}
      position={pos}
      intensity={below ? 0 : intensity}
      color="#fff4e0"
      castShadow
      shadow-mapSize-width={2048}
      shadow-mapSize-height={2048}
      shadow-bias={-0.0006}
      shadow-normalBias={0.9}
    />
  )
}

/* ------------------------------------------------------------------ */

export function GroundScene({
  data,
  altitude,
  azimuth,
  skyTint,
}: {
  data: GroundData
  altitude: number
  azimuth: number
  skyTint: string
}) {
  const sunDir = useMemo(() => {
    const alt = (altitude * Math.PI) / 180
    const az = (azimuth * Math.PI) / 180
    return new THREE.Vector3(
      Math.cos(alt) * Math.sin(az),
      Math.sin(alt),
      -Math.cos(alt) * Math.cos(az),
    ).normalize()
  }, [altitude, azimuth])

  const below = altitude < -0.833
  // Direct sun weakens as it drops; ambient stands in for skylight, which is
  // what actually lights the shadows on a real overcast-free day.
  const direct = below ? 0 : 0.6 + Math.min(2.4, (altitude / 60) * 2.4)
  const ambient = below ? 0.07 : 0.16 + Math.min(0.3, altitude / 200)

  return (
    <group>
      <hemisphereLight
        args={[skyTint, '#3a3226', below ? 0.12 : 0.45]}
        position={[0, 100, 0]}
      />
      <ambientLight intensity={ambient} />
      <SunLight altitude={altitude} azimuth={azimuth} intensity={direct} />

      <Terrain data={data} sunDir={sunDir} />
      <Buildings data={data} />
      <GroundPin lit={!below} />

      {/* Distance fog matched to the sky so the scene edge dissolves rather
          than ending in a visible cliff. */}
      <fog attach="fog" args={[below ? '#0b0e18' : skyTint, SCENE_RADIUS * 0.9, SCENE_RADIUS * 2.6]} />
    </group>
  )
}

export { SCENE_RADIUS }
