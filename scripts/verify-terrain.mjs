/**
 * Validate the tile math and terrarium decoding against known values.
 * The DEM drives where buildings sit; if the projection is wrong everything
 * downstream is confidently misplaced.
 */
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

mkdirSync('/tmp/tcheck', { recursive: true })
execSync(
  'npx esbuild src/lib/terrain.ts --format=esm --outfile=/tmp/tcheck/terrain.mjs',
  { stdio: 'pipe' },
)
const T = await import('/tmp/tcheck/terrain.mjs')

let pass = 0
let fail = 0
const check = (name, actual, expected, tol, unit = '') => {
  const ok = Math.abs(actual - expected) <= tol
  ok ? pass++ : fail++
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] ${name}\n         got ${actual.toFixed(4)}${unit}  want ${expected}${unit}  (±${tol})`,
  )
}
const ok = (name, cond, detail = '') => {
  cond ? pass++ : fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`)
}

console.log('\n=== 1. Mercator constant ===')
// 2*pi*R / 256
check('MERCATOR_K = 2πR/256', T.MERCATOR_K, (2 * Math.PI * 6378137) / 256, 0.001)

console.log('\n=== 2. Ground resolution vs published values ===')
// Standard reference: at z=0 equator, 156543.03 m/px. Halves each zoom.
check('z0 equator m/px', T.metresPerPixel(0, 0), 156543.034, 0.01, ' m')
check('z10 equator m/px', T.metresPerPixel(0, 10), 152.874, 0.01, ' m')
// At lat 37.77 (San Francisco), z15 — the research brief computed 3.776 m/px
check('z15 @ 37.77N m/px', T.metresPerPixel(37.77, 15), 3.776, 0.005, ' m')
check('z15 @ 37.77N tile span', T.tileSpanMetres(37.77, 15), 966.75, 1.5, ' m')
// A tile at 60N should be exactly cos(60)=0.5 of the equatorial span
check(
  'lat60 span is half of equator span',
  T.tileSpanMetres(60, 12) / T.tileSpanMetres(0, 12),
  0.5,
  0.0001,
)

console.log('\n=== 3. Known tile coordinates ===')
// Null Island at z1 sits exactly at the 4-tile junction: x=1, y=1
const nul = T.latLonToTile(0, 0, 1)
check('lat0/lon0 z1 -> x', nul.x, 1, 1e-9)
check('lat0/lon0 z1 -> y', nul.y, 1, 1e-9)
// San Francisco at z14. Cross-checked two ways rather than trusted:
// an independent Python implementation gives x=2620.5571 y=6332.7590, and
// AWS reports this tile's imagery source as
// "ned19_n38x00_w122x50_ca_sanfrancisco_topobathy_2010.tif" — it really is SF.
// (An earlier version of this test asserted 6333 and was simply wrong.)
const sf = T.latLonToTile(37.7749, -122.4194, 14)
ok(
  'SF z14 tile is 2620/6332',
  Math.floor(sf.x) === 2620 && Math.floor(sf.y) === 6332,
  `got ${Math.floor(sf.x)}/${Math.floor(sf.y)}`,
)
// Berlin z12
const ber = T.latLonToTile(52.52, 13.405, 12)
ok(
  'Berlin z12 tile is 2200/1343',
  Math.floor(ber.x) === 2200 && Math.floor(ber.y) === 1343,
  `got ${Math.floor(ber.x)}/${Math.floor(ber.y)}`,
)

console.log('\n=== 4. tile -> latlon is the inverse of latlon -> tile ===')
for (const [name, lat, lon, z] of [
  ['SF', 37.7749, -122.4194, 14],
  ['Tromso', 69.6492, 18.9553, 13],
  ['Sydney', -33.8688, 151.2093, 15],
  ['Quito', -0.1807, -78.4678, 12],
]) {
  const t = T.latLonToTile(lat, lon, z)
  const back = T.tileToLatLon(t.x, t.y, z)
  const err = Math.abs(back.lat - lat) + Math.abs(back.lon - lon)
  ok(`${name} tile round-trip`, err < 1e-9, `err ${err.toExponential(2)}`)
}

console.log('\n=== 5. Terrarium decoding ===')
// Encoding is (R*256 + G + B/256) - 32768
check('RGB(128,0,0) -> 0 m (the zero point)', T.decodeTerrarium(128, 0, 0), 0, 1e-9, ' m')
check('RGB(128,3,233) -> 3.91 m (real SF pixel)', T.decodeTerrarium(128, 3, 233), 3.910, 0.002, ' m')
check('RGB(128,100,0) -> 100 m', T.decodeTerrarium(128, 100, 0), 100, 1e-9, ' m')
check('RGB(127,246,0) -> -10 m', T.decodeTerrarium(127, 246, 0), -10, 1e-9, ' m')
// Everest ~8848 m: 8848+32768 = 41616 = 162*256 + 144
check('Everest ~8848 m encodes at R=162,G=144', T.decodeTerrarium(162, 144, 0), 8848, 1, ' m')
// The lowest possible value
check('RGB(0,0,0) -> -32768 m (floor)', T.decodeTerrarium(0, 0, 0), -32768, 1e-9, ' m')

console.log('\n=== 6. Local frame: projection round-trip ===')
const frame = T.makeFrame(37.7749, -122.4194, 15)
check('origin projects to x=0', T.project(frame, 37.7749, -122.4194)[0], 0, 1e-6, ' m')
check('origin projects to z=0', T.project(frame, 37.7749, -122.4194)[1], 0, 1e-6, ' m')

for (const [name, lat, lon] of [
  ['200m north', 37.7749 + 200 / 111320, -122.4194],
  ['500m east', 37.7749, -122.4194 + 500 / (111320 * Math.cos((37.7749 * Math.PI) / 180))],
]) {
  const [mx, mz] = T.project(frame, lat, lon)
  const back = T.unproject(frame, mx, mz)
  const err = Math.abs(back.lat - lat) + Math.abs(back.lon - lon)
  ok(`${name}: project/unproject round-trip`, err < 1e-9, `err ${err.toExponential(2)}`)
}

console.log('\n=== 7. Projection produces correct real distances ===')
// 200 m north should be ~200 m in -Z (north is negative Z)
const north = T.project(frame, 37.7749 + 200 / 111320, -122.4194)
check('200m north -> z ≈ -200', north[1], -200, 1.0, ' m')
ok('north is negative Z', north[1] < 0, `z=${north[1].toFixed(1)}`)
// 500 m east
const east = T.project(
  frame,
  37.7749,
  -122.4194 + 500 / (111320 * Math.cos((37.7749 * Math.PI) / 180)),
)
check('500m east -> x ≈ +500', east[0], 500, 2.0, ' m')
ok('east is positive X', east[0] > 0, `x=${east[0].toFixed(1)}`)

console.log('\n=== 8. Scale sanity at high latitude ===')
// The same angular offset should give a SMALLER metre distance in x at high lat
// if we did NOT correct... but our frame projects through Mercator, so a real
// 500 m east at Tromso should still measure ~500 m.
const tromso = T.makeFrame(69.6492, 18.9553, 15)
const tEast = T.project(
  tromso,
  69.6492,
  18.9553 + 500 / (111320 * Math.cos((69.6492 * Math.PI) / 180)),
)
check('Tromso 500m east -> x ≈ +500', tEast[0], 500, 3.0, ' m')

console.log(`\n${'='.repeat(58)}`)
console.log(`  ${pass} passed, ${fail} failed`)
console.log('='.repeat(58) + '\n')
process.exit(fail > 0 ? 1 : 0)
