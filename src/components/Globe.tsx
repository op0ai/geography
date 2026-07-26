/**
 * Globe.tsx — the Earth, and the light falling on it.
 *
 * The terminator is not drawn as a line. It emerges from a single uniform: the
 * subsolar unit vector. Every fragment compares its own normal against that
 * vector, and the day/night mix falls out of the dot product. That's why the
 * curve is always right at every latitude and season — nobody computed it.
 */

import { useRef, useMemo, useEffect, useLayoutEffect } from 'react'
import { useFrame, useLoader, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { latLonToVec3, vec3ToLatLon } from '../lib/solar'
import { PLACES } from '../lib/places'

const GLOBE_RADIUS = 1

/* ------------------------------------------------------------------ */
/* Earth surface shader                                                */
/* ------------------------------------------------------------------ */

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPositionW;

  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vPositionW = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const earthFragment = /* glsl */ `
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform sampler2D bumpRoughnessClouds;
  uniform vec3  sunDirection;
  uniform vec3  cameraPos;
  uniform float atmosphereStrength;
  uniform vec3  twilightColor;
  uniform vec3  atmosphereColor;
  uniform float cloudOpacity;
  uniform float nightLightStrength;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPositionW;

  void main() {
    vec3 normal   = normalize(vNormalW);
    vec3 viewDir  = normalize(cameraPos - vPositionW);
    float sunDot  = dot(normal, sunDirection);

    // --- day / night ------------------------------------------------
    // A soft band rather than a hard edge. Real twilight on Earth spans
    // roughly 18 degrees of arc, which at this scale is about 0.3 in dot space.
    float dayMix = smoothstep(-0.18, 0.22, sunDot);

    vec3 dayColor   = texture2D(dayTexture,   vUv).rgb;
    vec3 nightColor = texture2D(nightTexture, vUv).rgb;

    // City lights only make sense where it's actually dark, and they shouldn't
    // linger through twilight — fade them out as the sky brightens.
    float nightFade = 1.0 - smoothstep(-0.25, 0.05, sunDot);
    vec3 color = mix(vec3(0.0), nightColor * nightLightStrength, nightFade);

    // LAMBERT. This is the bit that was missing, and it's why the globe looked
    // lit from everywhere at once: dayMix saturates at 1.0 as soon as sunDot
    // passes 0.22, so the whole day hemisphere rendered at identical full
    // brightness — a flat disc of daylight with a soft edge, no direction.
    //
    // Real illumination falls off as the cosine of the angle between the
    // surface normal and the sun. That cosine IS sunDot. Applying it makes the
    // subsolar point the obvious bright spot and the limb fall away, which is
    // what tells your eye where the light is coming from.
    float lambert = max(sunDot, 0.0);
    // Slight lift off pure cosine so the terminator doesn't crush to black
    // before the twilight band takes over.
    float diffuse = pow(lambert, 0.75);
    color = mix(color, dayColor * (0.12 + 0.88 * diffuse), dayMix);

    // --- the twilight band ------------------------------------------
    // Warm light hugging the terminator. This is the detail that makes the
    // globe read as lit rather than masked.
    float terminator = 1.0 - abs(sunDot);
    float glow = smoothstep(0.82, 1.0, terminator);
    color += twilightColor * glow * 0.22;

    // --- clouds ------------------------------------------------------
    // Packed texture channels, verified by sampling the actual file:
    //   R = bump/elevation, G = roughness (0 ocean, 1 land), B = cloud cover.
    // Reading clouds off G instead of B paints every continent solid white.
    vec4 packed = texture2D(bumpRoughnessClouds, vUv);
    float clouds = smoothstep(0.22, 0.85, packed.b) * cloudOpacity;
    // Clouds catch the light slightly beyond the terminator — they're above
    // the surface, so they're still lit when the ground below has gone dark.
    // Clouds catch the sun by the same cosine law. Without this they read as
    // a flat white overlay pasted on the day side.
    float cloudLight = smoothstep(-0.28, 0.32, sunDot);
    float cloudLambert = pow(max(sunDot, 0.0), 0.7);
    vec3 cloudLit = vec3(1.0) * (0.08 + 0.92 * cloudLambert);
    color = mix(color, cloudLit, clouds * 0.8 * cloudLight);

    // --- specular on water -------------------------------------------
    // G is roughness: near zero over ocean, saturated over land.
    float water = 1.0 - smoothstep(0.15, 0.45, packed.g);
    vec3 halfVec = normalize(sunDirection + viewDir);
    float spec = pow(max(dot(normal, halfVec), 0.0), 90.0);
    color += vec3(1.0, 0.96, 0.88) * spec * water * lambert * 0.6 * (1.0 - clouds);

    // --- atmosphere rim ----------------------------------------------
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.6);
    // Only the lit limb should glow; the night limb stays dark.
    float rimLight = smoothstep(-0.35, 0.45, sunDot);
    // Kept subtle: the atmosphere shell already draws the limb glow, and
    // stacking two additive rim terms is what over-brightened the edge.
    color += atmosphereColor * fresnel * rimLight * atmosphereStrength * 0.45 * (0.25 + 0.75 * lambert);

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`

/* ------------------------------------------------------------------ */
/* Atmosphere shell                                                    */
/* ------------------------------------------------------------------ */

const atmosphereVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  void main() {
    vNormalW   = normalize(mat3(modelMatrix) * normal);
    vPositionW = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const atmosphereFragment = /* glsl */ `
  uniform vec3  sunDirection;
  uniform vec3  cameraPos;
  uniform vec3  dayColor;
  uniform vec3  twilightColor;
  uniform float intensity;

  varying vec3 vNormalW;
  varying vec3 vPositionW;

  void main() {
    vec3 normal  = normalize(vNormalW);
    vec3 viewDir = normalize(cameraPos - vPositionW);
    float sunDot = dot(normal, sunDirection);

    // FRONT-side shell now. It used to render BackSide, which draws the far
    // half of the sphere — geometry that sits behind the planet but, with
    // additive blending and depthWrite off, still composited straight over it.
    // Worse, on a back face the fresnel peaks in the MIDDLE of the disc rather
    // than at the limb, so it flooded the centre of Earth with white haze.
    //
    // On the front face the correct rim term is the usual one: bright where
    // the surface turns away from the camera, i.e. at the edge.
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);

    // Sunset reddening: the atmosphere goes warm exactly where the sun is
    // grazing, which is what makes the limb look like a real horizon.
    float warm = smoothstep(0.35, -0.15, sunDot) * smoothstep(-0.5, -0.1, sunDot);
    vec3 color = mix(dayColor, twilightColor, warm);

    // The shell used a wide smoothstep, so it haloed the ENTIRE limb — including
    // the night side — which is a large part of why the light looked
    // omnidirectional. Scattering is strongest where the sun actually is, so
    // weight it by the cosine and let the night limb go dark.
    float lit = smoothstep(-0.35, 0.25, sunDot);
    float facing = pow(max(sunDot, 0.0), 0.6);
    float alpha = fresnel * lit * intensity * (0.18 + 0.82 * facing);

    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`

/* ------------------------------------------------------------------ */

interface GlobeProps {
  /** subsolar point, degrees */
  subsolar: { lat: number; lon: number }
  /** the pinned location */
  marker: { lat: number; lon: number }
  onPick: (lat: number, lon: number) => void
  /** 0 = no clouds, 1 = full */
  cloudOpacity?: number
  /** dim the whole globe when the sun is far away (other planets) */
  lightScale?: number
  /** swap the surface texture when standing on another world */
  surfaceTexture?: string
  /** tint for airless or alien worlds */
  atmosphereTint?: [number, number, number]
  /** airless worlds get no rim glow and no twilight band */
  hasAtmosphere?: boolean
}

export function Globe({
  subsolar,
  marker,
  onPick,
  cloudOpacity = 1,
  lightScale = 1,
  surfaceTexture = '/textures/earth_day_4096.jpg',
  atmosphereTint = [0.24, 0.55, 1.0],
  hasAtmosphere = true,
}: GlobeProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const matRef = useRef<THREE.ShaderMaterial>(null)
  const atmoRef = useRef<THREE.ShaderMaterial>(null)

  const [dayMap, nightMap, packedMap] = useLoader(THREE.TextureLoader, [
    surfaceTexture,
    '/textures/earth_night_4096.jpg',
    '/textures/earth_bump_roughness_clouds_4096.jpg',
  ])

  // three r152+ is colour-managed. Albedo maps must be tagged sRGB; data maps
  // must stay linear. Getting this backwards is the classic washed-out globe.
  useLayoutEffect(() => {
    dayMap.colorSpace = THREE.SRGBColorSpace
    nightMap.colorSpace = THREE.SRGBColorSpace
    packedMap.colorSpace = THREE.NoColorSpace
    for (const t of [dayMap, nightMap, packedMap]) {
      t.anisotropy = 8
      t.needsUpdate = true
    }
  }, [dayMap, nightMap, packedMap])

  const uniforms = useMemo(
    () => ({
      dayTexture: { value: dayMap },
      nightTexture: { value: nightMap },
      bumpRoughnessClouds: { value: packedMap },
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      cameraPos: { value: new THREE.Vector3() },
      atmosphereStrength: { value: 0.5 },
      twilightColor: { value: new THREE.Color('#ff7a3d') },
      atmosphereColor: { value: new THREE.Color(...atmosphereTint) },
      cloudOpacity: { value: cloudOpacity },
      nightLightStrength: { value: 1 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dayMap, nightMap, packedMap],
  )

  const atmoUniforms = useMemo(
    () => ({
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      cameraPos: { value: new THREE.Vector3() },
      dayColor: { value: new THREE.Color(...atmosphereTint) },
      twilightColor: { value: new THREE.Color('#ff6b35') },
      intensity: { value: 1 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // The sun direction in world space, straight from the subsolar point.
  const sunVec = useMemo(() => {
    const [x, y, z] = latLonToVec3(subsolar.lat, subsolar.lon, 1)
    return new THREE.Vector3(x, y, z).normalize()
  }, [subsolar.lat, subsolar.lon])

  const markerPos = useMemo(() => {
    const [x, y, z] = latLonToVec3(marker.lat, marker.lon, GLOBE_RADIUS)
    return new THREE.Vector3(x, y, z)
  }, [marker.lat, marker.lon])

  // Is the pinned point currently in daylight? Drives the marker colour.
  const markerLit = useMemo(
    () => markerPos.clone().normalize().dot(sunVec) > -0.0145,
    [markerPos, sunVec],
  )

  useFrame((state) => {
    if (matRef.current) {
      const u = matRef.current.uniforms
      u.sunDirection.value.copy(sunVec)
      u.cameraPos.value.copy(state.camera.position)
      u.cloudOpacity.value = cloudOpacity
      u.nightLightStrength.value = lightScale >= 0.9 ? 1 : 0
      u.atmosphereStrength.value = hasAtmosphere ? 0.5 : 0
      u.atmosphereColor.value.setRGB(...atmosphereTint)
    }
    if (atmoRef.current) {
      const u = atmoRef.current.uniforms
      u.sunDirection.value.copy(sunVec)
      u.cameraPos.value.copy(state.camera.position)
      u.intensity.value = hasAtmosphere ? 1 : 0
      u.dayColor.value.setRGB(...atmosphereTint)
    }
  })

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (!meshRef.current) return
    // Convert the world-space hit into the mesh's own frame first, so any
    // rotation on the globe doesn't corrupt the coordinate.
    const local = meshRef.current.worldToLocal(e.point.clone())
    const { lat, lon } = vec3ToLatLon(local.x, local.y, local.z)
    onPick(lat, lon)
  }

  return (
    <group>
      {/* the planet */}
      <mesh ref={meshRef} onPointerDown={handleClick}>
        <sphereGeometry args={[GLOBE_RADIUS, 128, 128]} />
        <shaderMaterial
          ref={matRef}
          vertexShader={earthVertex}
          fragmentShader={earthFragment}
          uniforms={uniforms}
        />
      </mesh>

      {/* atmosphere shell */}
      <mesh scale={1.022}>
        <sphereGeometry args={[GLOBE_RADIUS, 64, 64]} />
        <shaderMaterial
          ref={atmoRef}
          vertexShader={atmosphereVertex}
          fragmentShader={atmosphereFragment}
          uniforms={atmoUniforms}
          transparent
          side={THREE.FrontSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <CityMarkers sunVec={sunVec} />
      <LocationMarker position={markerPos} lit={markerLit} />
      <SubsolarMarker subsolar={subsolar} />
    </group>
  )
}

/* ------------------------------------------------------------------ */
/* Cities                                                              */
/* ------------------------------------------------------------------ */

/**
 * Dots for the curated places.
 *
 * The globe was a bare sphere: nothing to aim at, no sense of where anything
 * is, and no hint that clicking does anything. These give it landmarks — and
 * they brighten on the night side, because that's where a city is actually
 * visible from orbit.
 */
function CityMarkers({ sunVec }: { sunVec: THREE.Vector3 }) {
  const geometry = useMemo(() => {
    const positions: number[] = []
    for (const p of PLACES) {
      const [x, y, z] = latLonToVec3(p.lat, p.lon, GLOBE_RADIUS * 1.002)
      positions.push(x, y, z)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(positions), 3),
    )
    return g
  }, [])

  useEffect(() => () => geometry.dispose(), [geometry])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { sunDir: { value: sunVec.clone() } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          uniform vec3 sunDir;
          varying float vLit;
          varying float vFacing;
          void main() {
            vec3 n = normalize(position);
            vLit = dot(n, sunDir);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            // Fade markers on the far limb so the back of the globe doesn't
            // show through as a haze of dots.
            vec3 nWorld = normalize(mat3(modelMatrix) * n);
            vec3 toCam = normalize(cameraPosition - (modelMatrix * vec4(position,1.0)).xyz);
            vFacing = dot(nWorld, toCam);
            // Perspective point size. The constant here has to be in the
            // scene's own units — the globe has radius 1, so a factor tuned
            // for a 300-unit scene produced ~400px sprites that stacked into
            // a giant ghost disc over the continents. 3.5 gives a ~3px dot at
            // the default camera distance and grows sensibly as you zoom in.
            gl_PointSize = clamp(3.5 / -mv.z * 4.0, 1.5, 9.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          varying float vLit;
          varying float vFacing;
          void main() {
            vec2 c = gl_PointCoord - vec2(0.5);
            float d = length(c);
            if (d > 0.5) discard;
            float soft = 1.0 - smoothstep(0.18, 0.5, d);
            if (vFacing < 0.08) discard;
            float edge = smoothstep(0.08, 0.35, vFacing);
            // Warm on the day side, city-light amber at night.
            vec3 day   = vec3(0.85, 0.92, 1.0);
            vec3 night = vec3(1.0, 0.78, 0.42);
            float t = smoothstep(-0.15, 0.15, vLit);
            vec3 col = mix(night, day, t);
            float strength = mix(0.95, 0.42, t);
            gl_FragColor = vec4(col, soft * strength * edge);
          }
        `,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useFrame(() => {
    material.uniforms.sunDir.value.copy(sunVec)
  })

  useEffect(() => () => material.dispose(), [material])

  return <points geometry={geometry} material={material} />
}

/* ------------------------------------------------------------------ */
/* The pin                                                             */
/* ------------------------------------------------------------------ */

function LocationMarker({
  position,
  lit,
}: {
  position: THREE.Vector3
  lit: boolean
}) {
  const ringRef = useRef<THREE.Mesh>(null)
  const groupRef = useRef<THREE.Group>(null)

  // Orient the marker so it stands off the surface rather than through it.
  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), position.clone().normalize())
    return q
  }, [position])

  useFrame((state) => {
    if (!ringRef.current) return
    // A slow pulse — enough to find the pin, not enough to nag.
    const t = state.clock.elapsedTime
    const pulse = 1 + Math.sin(t * 2) * 0.14
    ringRef.current.scale.setScalar(pulse)
    const mat = ringRef.current.material as THREE.MeshBasicMaterial
    mat.opacity = 0.55 - Math.sin(t * 2) * 0.2
  })

  const color = lit ? '#ffcc4d' : '#7dd3fc'

  return (
    <group ref={groupRef} position={position} quaternion={quaternion}>
      {/* stem out from the surface */}
      <mesh position={[0, 0, 0.03]}>
        <cylinderGeometry args={[0.0025, 0.0025, 0.06, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {/* the head */}
      <mesh position={[0, 0, 0.07]}>
        <sphereGeometry args={[0.014, 20, 20]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {/* ground ring */}
      <mesh ref={ringRef} position={[0, 0, 0.004]}>
        <ringGeometry args={[0.022, 0.03, 40]} />
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
/* Where the sun is directly overhead                                  */
/* ------------------------------------------------------------------ */

function SubsolarMarker({ subsolar }: { subsolar: { lat: number; lon: number } }) {
  const pos = useMemo(() => {
    const [x, y, z] = latLonToVec3(subsolar.lat, subsolar.lon, GLOBE_RADIUS * 1.008)
    return new THREE.Vector3(x, y, z)
  }, [subsolar.lat, subsolar.lon])

  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pos.clone().normalize())
    return q
  }, [pos])

  return (
    <group position={pos} quaternion={quaternion}>
      <mesh>
        <ringGeometry args={[0.028, 0.034, 48]} />
        <meshBasicMaterial
          color="#fff3c4"
          transparent
          opacity={0.75}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh>
        <circleGeometry args={[0.012, 24]} />
        <meshBasicMaterial color="#fffbe8" transparent opacity={0.9} />
      </mesh>
    </group>
  )
}

export { GLOBE_RADIUS }
