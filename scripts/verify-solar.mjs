/**
 * Validate the solar core against independently known values.
 * Run: node scripts/verify-solar.mjs
 *
 * If the math is wrong, everything downstream is a pretty lie — so this runs
 * before any pixels get drawn.
 */
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'

// transpile the TS core to plain JS so we can import it without a bundler
mkdirSync('/tmp/solarcheck', { recursive: true })
execSync(
  'npx esbuild src/lib/solar.ts --format=esm --outfile=/tmp/solarcheck/solar.mjs',
  { stdio: 'pipe' },
)
const S = await import('/tmp/solarcheck/solar.mjs')

let pass = 0
let fail = 0
const check = (name, actual, expected, tol, unit = '') => {
  const ok = Math.abs(actual - expected) <= tol
  ok ? pass++ : fail++
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(
    `  [${mark}] ${name}\n         got ${actual.toFixed(4)}${unit}  expected ${expected}${unit}  (±${tol})`,
  )
}

console.log('\n=== 1. Solstices and equinoxes: declination ===')
// The sun's declination is the single most checkable number in the system.
check(
  'Jun solstice 2026 declination ≈ +23.44',
  S.sunState(S.toJulian(new Date('2026-06-21T09:00:00Z'))).declination,
  23.44,
  0.05,
  '°',
)
check(
  'Dec solstice 2026 declination ≈ -23.44',
  S.sunState(S.toJulian(new Date('2026-12-21T15:00:00Z'))).declination,
  -23.44,
  0.05,
  '°',
)
check(
  'Mar equinox 2026 declination ≈ 0',
  S.sunState(S.toJulian(new Date('2026-03-20T14:46:00Z'))).declination,
  0,
  0.05,
  '°',
)
check(
  'Sep equinox 2026 declination ≈ 0',
  S.sunState(S.toJulian(new Date('2026-09-23T00:05:00Z'))).declination,
  0,
  0.05,
  '°',
)

console.log('\n=== 2. Obliquity of the ecliptic (current epoch) ===')
check(
  'obliquity 2026 ≈ 23.436',
  S.sunState(S.toJulian(new Date('2026-01-01T00:00:00Z'))).epsilon,
  23.436,
  0.01,
  '°',
)

console.log('\n=== 3. Equation of time — the analemma extremes ===')
// EoT peaks around +16.4 min in early Nov and -14.2 min in mid Feb.
check(
  'EoT ~3 Nov ≈ +16.4 min',
  S.sunState(S.toJulian(new Date('2026-11-03T12:00:00Z'))).equationOfTime,
  16.4,
  0.4,
  ' min',
)
check(
  'EoT ~11 Feb ≈ -14.2 min',
  S.sunState(S.toJulian(new Date('2026-02-11T12:00:00Z'))).equationOfTime,
  -14.2,
  0.4,
  ' min',
)

console.log('\n=== 4. Earth-Sun distance: perihelion / aphelion ===')
check(
  'perihelion early Jan ≈ 0.9833 AU',
  S.sunState(S.toJulian(new Date('2026-01-03T00:00:00Z'))).distanceAU,
  0.9833,
  0.0006,
  ' AU',
)
check(
  'aphelion early Jul ≈ 1.0167 AU',
  S.sunState(S.toJulian(new Date('2026-07-05T00:00:00Z'))).distanceAU,
  1.0167,
  0.0006,
  ' AU',
)

console.log('\n=== 5. Subsolar point at a known instant ===')
// At the June solstice the sun is overhead at the Tropic of Cancer.
const sub = S.subsolarPoint(new Date('2026-06-21T12:00:00Z'))
check('solstice subsolar lat ≈ 23.44', sub.lat, 23.44, 0.05, '°')
// At 12:00 UTC the subsolar longitude should sit near Greenwich, offset only
// by the equation of time (~ -1.7 min → ~ -0.4°).
check('solstice subsolar lon ≈ 0 at 12:00 UTC', sub.lon, 0, 1.0, '°')

console.log('\n=== 6. Sunrise / sunset vs published times ===')
// London, 2026-06-21. Published (timeanddate): sunrise 04:43 BST = 03:43 UTC,
// sunset 21:22 BST = 20:22 UTC.
const london = S.sunTimes(new Date('2026-06-21T12:00:00Z'), 51.5074, -0.1278)
const utcMin = (d) => d.getUTCHours() * 60 + d.getUTCMinutes()
check('London midsummer sunrise ≈ 03:43 UTC', utcMin(london.sunrise), 223, 4, ' min')
check('London midsummer sunset ≈ 20:22 UTC', utcMin(london.sunset), 1222, 4, ' min')
check('London midsummer day length ≈ 16.6 h', london.dayLengthHours, 16.63, 0.12, ' h')

// Sydney, southern winter, 2026-06-21. Sunrise 07:00 AEST = 21:00 UTC prev day,
// sunset 16:54 AEST = 06:54 UTC. Day length ~9.9 h.
const sydney = S.sunTimes(new Date('2026-06-21T02:00:00Z'), -33.8688, 151.2093)
check('Sydney midwinter day length ≈ 9.9 h', sydney.dayLengthHours, 9.9, 0.12, ' h')

// Equator: always close to 12 h.
const quito = S.sunTimes(new Date('2026-06-21T12:00:00Z'), -0.1807, -78.4678)
check('Quito day length ≈ 12.1 h', quito.dayLengthHours, 12.1, 0.15, ' h')

console.log('\n=== 7. Polar day / polar night ===')
const tromsoJun = S.sunTimes(new Date('2026-06-21T12:00:00Z'), 69.6492, 18.9553)
console.log(
  `  [${tromsoJun.alwaysUp ? 'PASS' : 'FAIL'}] Tromsø in June: midnight sun (alwaysUp=${tromsoJun.alwaysUp}, dayLength=${tromsoJun.dayLengthHours})`,
)
tromsoJun.alwaysUp && tromsoJun.dayLengthHours === 24 ? pass++ : fail++

const tromsoDec = S.sunTimes(new Date('2026-12-21T12:00:00Z'), 69.6492, 18.9553)
console.log(
  `  [${tromsoDec.alwaysDown ? 'PASS' : 'FAIL'}] Tromsø in December: polar night (alwaysDown=${tromsoDec.alwaysDown}, dayLength=${tromsoDec.dayLengthHours})`,
)
tromsoDec.alwaysDown && tromsoDec.dayLengthHours === 0 ? pass++ : fail++

const southPoleDec = S.sunTimes(new Date('2026-12-21T12:00:00Z'), -89.9, 0)
console.log(
  `  [${southPoleDec.alwaysUp ? 'PASS' : 'FAIL'}] South Pole in December: 24h sun (alwaysUp=${southPoleDec.alwaysUp})`,
)
southPoleDec.alwaysUp ? pass++ : fail++

console.log('\n=== 8. Solar noon: sun due south in the north, north in the south ===')
const noonLon = S.solarPosition(london.solarNoon, 51.5074, -0.1278)
check('London solar noon azimuth ≈ 180 (due S)', noonLon.azimuth, 180, 0.6, '°')
check(
  'London solar noon altitude ≈ 62.0',
  noonLon.altitude,
  90 - 51.5074 + 23.44,
  0.3,
  '°',
)
const sydNoon = S.solarPosition(sydney.solarNoon, -33.8688, 151.2093)
check('Sydney solar noon azimuth ≈ 0/360 (due N)', Math.min(sydNoon.azimuth, 360 - sydNoon.azimuth), 0, 0.6, '°')

console.log('\n=== 9. Sun rises in the east, sets in the west ===')
const riseAz = S.solarPosition(london.sunrise, 51.5074, -0.1278).azimuth
const setAz = S.solarPosition(london.sunset, 51.5074, -0.1278).azimuth
console.log(`  [${riseAz > 0 && riseAz < 180 ? 'PASS' : 'FAIL'}] sunrise azimuth ${riseAz.toFixed(1)}° is easterly (0-180)`)
riseAz > 0 && riseAz < 180 ? pass++ : fail++
console.log(`  [${setAz > 180 && setAz < 360 ? 'PASS' : 'FAIL'}] sunset azimuth ${setAz.toFixed(1)}° is westerly (180-360)`)
setAz > 180 && setAz < 360 ? pass++ : fail++
// At midsummer in London the sun rises well north of due east.
console.log(`  [INFO] midsummer sunrise bearing ${riseAz.toFixed(1)}° (expect ~49°, well N of E)`)

console.log('\n=== 10. Altitude at sunrise is ~the sunrise threshold ===')
check(
  'altitude at computed sunrise ≈ -0.833',
  S.solarPosition(london.sunrise, 51.5074, -0.1278).altitude,
  -0.833,
  0.15,
  '°',
)

console.log('\n=== 11. Geometry round-trip: latLon → vec3 → latLon ===')
const places = [
  ['Null Island', 0, 0],
  ['Sumatra 0,90E', 0, 90],
  ['London', 51.5074, -0.1278],
  ['Sydney', -33.8688, 151.2093],
  ['Anchorage', 61.2181, -149.9003],
  ['Ushuaia', -54.8019, -68.303],
]
for (const [name, lat, lon] of places) {
  const [x, y, z] = S.latLonToVec3(lat, lon, 1)
  const back = S.vec3ToLatLon(x, y, z)
  const err = Math.abs(back.lat - lat) + Math.abs(back.lon - lon)
  console.log(
    `  [${err < 1e-9 ? 'PASS' : 'FAIL'}] ${name}: round-trip error ${err.toExponential(2)}`,
  )
  err < 1e-9 ? pass++ : fail++
}

console.log('\n=== 12. Haversine sanity ===')
check(
  'London→Paris ≈ 344 km',
  S.haversine({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 }),
  344,
  6,
  ' km',
)
check(
  'London→NYC ≈ 5570 km',
  S.haversine({ lat: 51.5074, lon: -0.1278 }, { lat: 40.7128, lon: -74.006 }),
  5570,
  30,
  ' km',
)

console.log(`\n${'='.repeat(58)}`)
console.log(`  ${pass} passed, ${fail} failed`)
console.log('='.repeat(58) + '\n')
process.exit(fail > 0 ? 1 : 0)
