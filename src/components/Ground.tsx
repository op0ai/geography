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
/* A sky you can actually see the sun in                               */
/* ------------------------------------------------------------------ */

/**
 * The dome.
 *
 * Ground mode used to render into a black void: a DirectionalLight with no
 * visible source, no horizon, and no sky. You could see shadows but had to
 * guess what was casting them, which is the opposite of the point of this app.
 *
 * This is an inside-out sphere whose gradient is driven by the same sun
 * altitude everything else uses — so the sky goes orange at golden hour and
 * deep blue at night because the sun is low, not because someone picked a
 * colour.
 */
const skyVertex = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const skyFragment = /* glsl */ `
  uniform vec3  sunDir;
  uniform float sunAlt;      // degrees
  uniform vec3  zenith;
  uniform vec3  horizonCol;
  uniform vec3  groundCol;
  varying vec3 vWorldPos;

  void main() {
    vec3 dir = normalize(vWorldPos);
    float h = dir.y;                       // -1 down, +1 up

    // Sky above, dark haze below the horizon line.
    vec3 col = mix(horizonCol, zenith, pow(max(h, 0.0), 0.55));
    col = mix(groundCol, col, smoothstep(-0.06, 0.02, h));

    // Warm bloom around the sun itself, strongest when it is near the horizon
    // — that is when the light travels through the most atmosphere.
    float d = max(dot(dir, sunDir), 0.0);
    float lowSun = 1.0 - smoothstep(0.0, 35.0, sunAlt);
    col += vec3(1.0, 0.55, 0.22) * pow(d, 6.0) * (0.35 + lowSun * 0.75);
    col += vec3(1.0, 0.85, 0.6)  * pow(d, 220.0) * 1.4;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

function Sky({ altitude, azimuth }: { altitude: number; azimuth: number }) {
  const matRef = useRef<THREE.ShaderMaterial>(null)

  const sunDir = useMemo(() => {
    const alt = (altitude * Math.PI) / 180
    const az = (azimuth * Math.PI) / 180
    return new THREE.Vector3(
      Math.cos(alt) * Math.sin(az),
      Math.sin(alt),
      -Math.cos(alt) * Math.cos(az),
    ).normalize()
  }, [altitude, azimuth])

  // Palette interpolated on altitude, matching the phase colours used
  // everywhere else in the app.
  const { zenith, horizonCol, groundCol } = useMemo(() => {
    const a = altitude
    const lerp = (x: number[], y: number[], t: number) =>
      new THREE.Color(
        x[0] + (y[0] - x[0]) * t,
        x[1] + (y[1] - x[1]) * t,
        x[2] + (y[2] - x[2]) * t,
      )
    if (a > 18) {
      const t = Math.min(1, (a - 18) / 45)
      return {
        zenith: lerp([0.13, 0.3, 0.62], [0.09, 0.29, 0.72], t),
        horizonCol: lerp([0.55, 0.68, 0.86], [0.62, 0.76, 0.93], t),
        groundCol: new THREE.Color(0.05, 0.06, 0.09),
      }
    }
    if (a > 0) {
      const t = a / 18 // 0 at horizon, 1 at 18°
      return {
        zenith: lerp([0.1, 0.16, 0.36], [0.13, 0.3, 0.62], t),
        horizonCol: lerp([0.95, 0.45, 0.18], [0.55, 0.68, 0.86], t),
        groundCol: new THREE.Color(0.04, 0.04, 0.06),
      }
    }
    // Below the horizon: twilight bleeding into night.
    const t = Math.min(1, -a / 18)
    return {
      zenith: lerp([0.1, 0.16, 0.36], [0.02, 0.03, 0.08], t),
      horizonCol: lerp([0.72, 0.33, 0.16], [0.05, 0.07, 0.16], t),
      groundCol: new THREE.Color(0.015, 0.02, 0.035),
    }
  }, [altitude])

  const uniforms = useMemo(
    () => ({
      sunDir: { value: sunDir.clone() },
      sunAlt: { value: altitude },
      zenith: { value: zenith.clone() },
      horizonCol: { value: horizonCol.clone() },
      groundCol: { value: groundCol.clone() },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useFrame(() => {
    const u = matRef.current?.uniforms
    if (!u) return
    u.sunDir.value.copy(sunDir)
    u.sunAlt.value = altitude
    u.zenith.value.copy(zenith)
    u.horizonCol.value.copy(horizonCol)
    u.groundCol.value.copy(groundCol)
  })

  return (
    <mesh scale={[-1, 1, 1]} renderOrder={-1}>
      <sphereGeometry args={[SCENE_RADIUS * 7, 32, 24]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={skyVertex}
        fragmentShader={skyFragment}
        uniforms={uniforms}
        depthWrite={false}
        side={THREE.BackSide}
      />
    </mesh>
  )
}

/**
 * The sun as a visible disc.
 *
 * Placed at its true altitude and bearing, at the correct angular size
 * (0.53° from Earth). Below the horizon it is not drawn at all — which is
 * itself the information: if you can't find the sun, it has set.
 */
function SunDisc({ altitude, azimuth }: { altitude: number; azimuth: number }) {
  const DIST = SCENE_RADIUS * 5
  const below = altitude < -0.833

  const pos = useMemo(() => {
    const alt = (altitude * Math.PI) / 180
    const az = (azimuth * Math.PI) / 180
    return new THREE.Vector3(
      DIST * Math.cos(alt) * Math.sin(az),
      DIST * Math.sin(alt),
      -DIST * Math.cos(alt) * Math.cos(az),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [altitude, azimuth])

  // True angular size: 0.53°. Rendered a little larger so it reads at a
  // glance — an honest 0.53° disc is only a few pixels across.
  const radius = DIST * Math.tan((1.6 * Math.PI) / 360)

  const glow = useMemo(() => {
    const size = 128
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,247,225,0.95)')
    g.addColorStop(0.15, 'rgba(255,226,160,0.45)')
    g.addColorStop(0.4, 'rgba(255,190,110,0.14)')
    g.addColorStop(1, 'rgba(255,170,90,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])

  if (below) return null

  // Low sun reddens, high sun runs white.
  const warm = Math.max(0, Math.min(1, altitude / 25))
  const disc = new THREE.Color().setHSL(
    0.09 - warm * 0.02,
    0.85 - warm * 0.55,
    0.62 + warm * 0.33,
  )

  return (
    <group position={pos}>
      <mesh>
        <sphereGeometry args={[radius, 24, 24]} />
        <meshBasicMaterial color={disc} toneMapped={false} />
      </mesh>
      <sprite scale={[radius * 14, radius * 14, 1]}>
        <spriteMaterial
          map={glow}
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
    </group>
  )
}

/**
 * Cardinal markers on the ground plane.
 *
 * Without these there is no way to tell which way you are facing, so "the sun
 * is at bearing 262°" is unusable information. N/E/S/W sit at the scene edge
 * and always face the camera.
 */
function Compass({ altitude, azimuth }: { altitude: number; azimuth: number }) {
  const r = SCENE_RADIUS * 0.92
  const marks: [string, number][] = [
    ['N', 0],
    ['E', 90],
    ['S', 180],
    ['W', 270],
  ]

  const texts = useMemo(() => {
    return marks.map(([label, bearing]) => {
      const c = document.createElement('canvas')
      c.width = c.height = 128
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, 128, 128)
      ctx.fillStyle = 'rgba(255,255,255,0.82)'
      ctx.font = '600 74px Inter, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, 64, 68)
      const t = new THREE.CanvasTexture(c)
      t.colorSpace = THREE.SRGBColorSpace
      const rad = (bearing * Math.PI) / 180
      return {
        label,
        tex: t,
        pos: new THREE.Vector3(r * Math.sin(rad), 26, -r * Math.cos(rad)),
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A line on the ground pointing at the sun's bearing — the shadow direction
  // made explicit, so the reading and the render agree.
  const sunBearingEnd = useMemo(() => {
    const rad = (azimuth * Math.PI) / 180
    return new THREE.Vector3(r * Math.sin(rad), 2, -r * Math.cos(rad))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [azimuth])

  const above = altitude > -0.833

  return (
    <group>
      {texts.map((t) => (
        <sprite key={t.label} position={t.pos} scale={[44, 44, 1]}>
          <spriteMaterial map={t.tex} transparent opacity={0.55} depthWrite={false} />
        </sprite>
      ))}
      {above && (
        <line>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[
                new Float32Array([0, 2, 0, sunBearingEnd.x, sunBearingEnd.y, sunBearingEnd.z]),
                3,
              ]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#ffcc66" transparent opacity={0.35} />
        </line>
      )}
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

      {/* Sky first — everything else is lit against it. */}
      <Sky altitude={altitude} azimuth={azimuth} />
      <SunDisc altitude={altitude} azimuth={azimuth} />

      <Terrain data={data} sunDir={sunDir} />
      <Buildings data={data} />
      <GroundPin lit={!below} />
      <Compass altitude={altitude} azimuth={azimuth} />

      {/* Haze that fades the terrain edge into the sky's horizon colour rather
          than ending on a visible cliff. Starts further out now that there's
          an actual sky to blend into. */}
      <fog
        attach="fog"
        args={[
          below ? '#0d1120' : altitude < 12 ? '#8a6a52' : '#93aec9',
          SCENE_RADIUS * 1.1,
          SCENE_RADIUS * 3.2,
        ]}
      />
    </group>
  )
}

export { SCENE_RADIUS }
