/**
 * verify-sunhours.mjs — checks for the shading engine.
 *
 * The sun-hours number is the one people would actually plan around, so it
 * gets the same treatment as the astronomy: cases with an answer known
 * independently of the code, not a snapshot of whatever it currently returns.
 *
 * Three kinds of case here:
 *
 *   1. Degenerate geometry with an arithmetic answer — a flat plain must equal
 *      the astronomical day length exactly, and a wall of known height and
 *      distance must cut the sun at an angle you can get from atan().
 *   2. Symmetry — an east wall and a west wall must shade mirror-image halves
 *      of the day.
 *   3. Physical bounds — direct sun can never exceed daylight, exposure stays
 *      in 0..1, and a fully enclosed point gets nothing.
 */

import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'sunhours-'))
const outfile = join(dir, 'bundle.mjs')

await build({
  entryPoints: ['src/lib/sunhours.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile,
  logLevel: 'silent',
})

const m = await import(pathToFileURL(outfile).href)
const { sunHoursForDay, sunVisible, horizonProfile, formatHours } = m
const solar = await (async () => {
  const f = join(dir, 'solar.mjs')
  await build({
    entryPoints: ['src/lib/solar.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: f,
    logLevel: 'silent',
  })
  return import(pathToFileURL(f).href)
})()

let pass = 0
let fail = 0

const check = (name, got, want, tol, note = '') => {
  const ok = Math.abs(got - want) <= tol
  if (ok) pass++
  else fail++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`)
  console.log(
    `         got ${typeof got === 'number' ? got.toFixed(4) : got}  want ${want}  (±${tol})${note ? '  ' + note : ''}`,
  )
}

const assert = (name, cond, note = '') => {
  if (cond) pass++
  else fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${note ? '  — ' + note : ''}`)
}

/* ------------------------------------------------------------------ */
/* synthetic scenes                                                     */
/* ------------------------------------------------------------------ */

/**
 * A height field is a grid of metres plus the projection that maps lat/lon
 * into it. For these tests we want total control of the terrain, so we build
 * the grid by hand and supply a frame whose maths we can verify separately.
 *
 * Mirrors makeFrame() at zoom 14: the tile mosaic covers a known span and
 * sampleHeightLocal() interpolates within it.
 */
function flatScene({ elevation = 0, prisms = [], radius = 700, eyeHeight = 1.6 } = {}) {
  const W = 64
  const data = new Float32Array(W * W).fill(elevation)
  const hf = {
    data,
    width: W,
    height: W,
    tx: 0,
    ty: 0,
    z: 14,
    cols: 1,
    rows: 1,
    min: elevation,
    max: elevation,
  }
  // Matches the real LocalFrame shape from terrain.ts.
  const frame = { lat0: 0, lon0: 0, scale: 40 / 256, z: 14, tx0: 0, ty0: 0 }
  return { frame, hf, prisms, originHeight: elevation, radius, eyeHeight }
}

/** A rectangular wall, given as a prism in local metres. */
function wall({ x, z, width, depth, height, base = 0 }) {
  const hw = width / 2
  const hd = depth / 2
  return {
    poly: [
      [x - hw, z - hd],
      [x + hw, z - hd],
      [x + hw, z + hd],
      [x - hw, z + hd],
    ],
    cx: x,
    cz: z,
    r: Math.hypot(hw, hd),
    base,
    top: height,
  }
}

console.log('\n=== 1. Flat plain equals the astronomical day ===')
{
  // With no obstruction whatsoever, hours of direct sun must equal hours the
  // sun is above the horizon. Any difference is a bug in the ray march, since
  // there is nothing for it to hit.
  const scene = flatScene()
  const r = sunHoursForDay(scene, 51.5074, -0.1278, new Date('2026-06-21T12:00:00Z'), 5)
  check('London midsummer: direct == daylight', r.directHours, r.daylightHours, 1e-9)
  // Cross-check the daylight figure itself against the solar module, which is
  // independently verified against published sunrise/sunset times.
  const t = solar.sunTimes(new Date('2026-06-21T12:00:00Z'), 51.5074, -0.1278)
  const astro = (t.sunset - t.sunrise) / 3600000
  check('daylight matches sunTimes', r.daylightHours, astro, 0.15, '(5-min sampling)')
  check('exposure is total', r.exposure, 1, 1e-9)
}

console.log('\n=== 2. A wall cuts the sun at the angle atan() says ===')
{
  // A 20 m wall 20 m due south. The sun clears it when its altitude exceeds
  // atan(20/20) = 45°, so at a latitude where the sun never gets that high in
  // winter, a south wall must produce zero direct sun.
  const h = 20
  const d = 20
  const cut = (Math.atan2(h, d) * 180) / Math.PI
  check('geometric cut angle', cut, 45, 1e-9)

  const scene = flatScene({
    prisms: [wall({ x: 0, z: d, width: 400, depth: 4, height: h })],
  })
  // South is +Z in this app's convention (azimuth 180 → dz = -cos(180) = +1).
  assert(
    'sun below the cut is blocked',
    sunVisible(scene, 30, 180) === 'building',
    'alt 30° < 45°',
  )
  assert(
    'sun above the cut is visible',
    sunVisible(scene, 60, 180) === null,
    'alt 60° > 45°',
  )
  // Right at the boundary, within the march's step resolution.
  assert('just below the cut is blocked', sunVisible(scene, 44, 180) === 'building')
  assert('just above the cut is visible', sunVisible(scene, 47, 180) === null)
}

console.log('\n=== 3. Walls only shade their own bearing ===')
{
  const scene = flatScene({
    prisms: [wall({ x: 0, z: 20, width: 60, depth: 4, height: 20 })],
  })
  assert('due south blocked', sunVisible(scene, 30, 180) === 'building')
  assert('due north clear', sunVisible(scene, 30, 0) === null)
  assert('due east clear', sunVisible(scene, 30, 90) === null)
  assert('due west clear', sunVisible(scene, 30, 270) === null)
}

console.log('\n=== 4. East and west walls mirror each other ===')
{
  // Physical symmetry: an east wall takes the morning, a west wall takes the
  // afternoon, and on an equinox at the equator they must take equal amounts.
  const east = flatScene({
    prisms: [wall({ x: 30, z: 0, width: 4, depth: 200, height: 30 })],
  })
  const west = flatScene({
    prisms: [wall({ x: -30, z: 0, width: 4, depth: 200, height: 30 })],
  })
  const day = new Date('2026-03-20T12:00:00Z')
  const e = sunHoursForDay(east, 0, 0, day, 5)
  const w = sunHoursForDay(west, 0, 0, day, 5)
  check('east wall vs west wall, equinox at equator', e.directHours, w.directHours, 0.2)
  assert(
    'both lose sun to the wall',
    e.directHours < e.daylightHours && w.directHours < w.daylightHours,
    `${e.directHours.toFixed(2)}h of ${e.daylightHours.toFixed(2)}h`,
  )
  // The east wall must lose the *morning*; the west wall the afternoon.
  assert(
    'east wall delays first light',
    e.firstLight > w.firstLight,
    `east ${e.firstLight} vs west ${w.firstLight}`,
  )
  assert(
    'west wall brings last light forward',
    w.lastLight < e.lastLight,
    `west ${w.lastLight} vs east ${e.lastLight}`,
  )
}

console.log('\n=== 5. Enclosure blocks everything ===')
{
  // Ringed by tall towers on all sides: no direct sun at any altitude the sun
  // can reach in London.
  const ring = []
  for (let a = 0; a < 360; a += 30) {
    const rad = (a * Math.PI) / 180
    ring.push(
      wall({
        x: Math.sin(rad) * 12,
        z: -Math.cos(rad) * 12,
        width: 14,
        depth: 14,
        height: 80,
      }),
    )
  }
  const scene = flatScene({ prisms: ring })
  const r = sunHoursForDay(scene, 51.5074, -0.1278, new Date('2026-06-21T12:00:00Z'), 10)
  check('walled courtyard gets no sun', r.directHours, 0, 1e-9)
  assert('but daylight is still counted', r.daylightHours > 15)
  check('exposure is zero', r.exposure, 0, 1e-9)
}

console.log('\n=== 6. Polar night has no daylight to obstruct ===')
{
  const scene = flatScene()
  // Tromsø in December: the sun does not rise at all.
  const r = sunHoursForDay(scene, 69.6492, 18.9553, new Date('2026-12-21T12:00:00Z'), 10)
  check('Tromsø, winter solstice: daylight', r.daylightHours, 0, 1e-9)
  check('Tromsø, winter solstice: direct', r.directHours, 0, 1e-9)
  check('exposure defined as 0, not NaN', r.exposure, 0, 1e-9)
  assert('no windows reported', r.windows.length === 0)
}

console.log('\n=== 7. Polar day is unbroken ===')
{
  const scene = flatScene()
  const r = sunHoursForDay(scene, 69.6492, 18.9553, new Date('2026-06-21T12:00:00Z'), 10)
  check('Tromsø, midsummer: 24h daylight', r.daylightHours, 24, 1e-9)
  check('Tromsø, midsummer: 24h direct on a plain', r.directHours, 24, 1e-9)
  assert('one continuous window', r.windows.length === 1, `${r.windows.length} windows`)
}

console.log('\n=== 8. Invariants hold everywhere ===')
{
  const scene = flatScene({
    prisms: [
      wall({ x: 25, z: 25, width: 30, depth: 30, height: 40 }),
      wall({ x: -40, z: 10, width: 20, depth: 60, height: 25 }),
    ],
  })
  const sites = [
    [51.5, -0.13],
    [-33.87, 151.21],
    [1.35, 103.82],
    [64.15, -21.94],
    [-54.8, -68.3],
  ]
  const dates = ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']
  let worst = 0
  for (const [lat, lon] of sites) {
    for (const d of dates) {
      const r = sunHoursForDay(scene, lat, lon, new Date(`${d}T12:00:00Z`), 20)
      if (r.directHours > r.daylightHours + 1e-9) worst = 1
      if (r.exposure < 0 || r.exposure > 1 + 1e-9) worst = 1
      if (!isFinite(r.directHours) || !isFinite(r.exposure)) worst = 1
      // Windows must be ordered and non-overlapping.
      for (let i = 1; i < r.windows.length; i++) {
        if (r.windows[i].start < r.windows[i - 1].end) worst = 1
      }
      // The sum of the windows must equal the reported direct hours.
      const sum = r.windows.reduce((a, w) => a + (w.end - w.start), 0) / 60
      if (Math.abs(sum - r.directHours) > 1e-9) worst = 1
    }
  }
  assert('direct ≤ daylight, exposure in 0..1, windows consistent', worst === 0,
    `${sites.length * dates.length} site-days`)
}

console.log('\n=== 9. Horizon profile agrees with the ray test ===')
{
  const scene = flatScene({
    prisms: [wall({ x: 0, z: 20, width: 400, depth: 4, height: 20 })],
  })
  const prof = horizonProfile(scene, 15)
  const south = prof.find((p) => p.azimuth === 180)
  // The wall subtends atan(20/20) = 45°; the binary search should land close.
  check('south horizon height', south.altitude, 45, 2.5)
  const north = prof.find((p) => p.azimuth === 0)
  check('north horizon is open', north.altitude, 0, 1.0)
}

console.log('\n=== 10. Formatting ===')
{
  assert('5.5h reads as 5h 30m', formatHours(5.5) === '5h 30m', formatHours(5.5))
  assert('0 reads as none', formatHours(0) === 'none')
  assert('0.5h reads as 30m', formatHours(0.5) === '30m', formatHours(0.5))
  assert('3h exactly', formatHours(3) === '3h', formatHours(3))
}

console.log('\n=== 11. Canopy filters rather than blocks ===')
{
  // A tree is not a wall. The whole point of the vegetation layer is that a
  // ray through leaves still delivers light, and how much depends on season.
  const bundle = await build({
    entryPoints: ['src/lib/vegetation.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: join(dir, 'veg.mjs'),
    logLevel: 'silent',
  }).then(() => import(pathToFileURL(join(dir, 'veg.mjs')).href))

  const { transmissivity, leafOn, canopyTransmission } = bundle

  const JUL = new Date('2026-07-15T12:00:00Z')
  const JAN = new Date('2026-01-15T12:00:00Z')

  // Measured values: Konarska et al. 2014 puts leaf-on direct transmissivity
  // at 0.01-0.05 and leaf-off at 0.40-0.52. SOLWEIG defaults to 0.03 leaf-on.
  const summer = transmissivity('broadleaved', JUL, 51.5)
  const winter = transmissivity('broadleaved', JAN, 51.5)
  assert(
    'broadleaf in leaf blocks almost everything',
    summer > 0 && summer <= 0.05,
    `${summer}`,
  )
  assert(
    'bare broadleaf passes roughly half',
    winter >= 0.4 && winter <= 0.52,
    `${winter}`,
  )
  assert('season actually changes the answer', winter > summer * 5)

  // Conifers barely change through the year — that's what makes them so
  // effective at killing a low winter sun.
  const cSummer = transmissivity('needleleaved', JUL, 51.5)
  const cWinter = transmissivity('needleleaved', JAN, 51.5)
  check('conifer is season-independent', cWinter, cSummer, 1e-9)
  assert('conifer blocks heavily year round', cWinter <= 0.15, `${cWinter}`)

  // Hemispheres are mirrored: July is leaf-off in Sydney.
  assert('London is in leaf in July', leafOn(JUL, 51.5))
  assert('London is bare in January', !leafOn(JAN, 51.5))
  assert('Sydney is bare in July', !leafOn(JUL, -33.9))
  assert('Sydney is in leaf in January', leafOn(JAN, -33.9))

  // The tropics have no leaf-off season worth modelling.
  assert('Singapore is evergreen in January', leafOn(JAN, 1.35))
  assert('Singapore is evergreen in July', leafOn(JUL, 1.35))
}

console.log('\n=== 12. Canopy geometry occludes the right directions ===')
{
  const bundle = await import(pathToFileURL(join(dir, 'veg.mjs')).href)
  const { canopyTransmission } = bundle

  // One broadleaf, 10m tall, 4m crown radius, 15m due south.
  const tree = {
    x: 0,
    z: 15,
    height: 10,
    crown: 4,
    crownCentre: 7.5,
    leaf: 'broadleaved',
    estimated: true,
  }
  const veg = { trees: [tree], areas: [], tagged: 0, failed: false }
  const eye = { x: 0, y: 1.6, z: 0 }
  const JUL = new Date('2026-07-15T12:00:00Z')

  // A ray due south at the crown's elevation must pass through it.
  // atan((7.5 - 1.6) / 15) = 21.5 degrees.
  const alt = (21.5 * Math.PI) / 180
  const through = canopyTransmission(
    veg, eye,
    Math.sin(Math.PI) * Math.cos(alt), Math.sin(alt), -Math.cos(Math.PI) * Math.cos(alt),
    700, JUL, 51.5,
  )
  assert('ray into the crown is attenuated', through < 0.1, `${through.toFixed(3)}`)

  // Due north: nothing there.
  const north = canopyTransmission(veg, eye, 0, Math.sin(alt), -Math.cos(alt), 700, JUL, 51.5)
  check('ray away from the tree is unattenuated', north, 1, 1e-9)

  // Straight up clears a 10m tree standing 15m away.
  const up = canopyTransmission(veg, eye, 0, 1, 0, 700, JUL, 51.5)
  check('overhead sun clears a tree beside you', up, 1, 1e-9)

  // Two trees in a line compound.
  const two = {
    trees: [tree, { ...tree, z: 30, crown: 5 }],
    areas: [], tagged: 0, failed: false,
  }
  const both = canopyTransmission(
    two, eye,
    Math.sin(Math.PI) * Math.cos(alt), Math.sin(alt), -Math.cos(Math.PI) * Math.cos(alt),
    700, JUL, 51.5,
  )
  assert('two crowns are darker than one', both <= through, `${both} <= ${through}`)
}

console.log('\n=== 13. A garden under a tree ===')
{
  // The end-to-end case the feature exists for: same spot, same day-length,
  // completely different answer in July and January because of one tree.
  const vegMod = await import(pathToFileURL(join(dir, 'veg.mjs')).href)

  // Geometry matters here, and this test got it wrong twice — instructively.
  //
  // First attempt: three 12m trees 10m due south, checked at London midsummer.
  // But London's midsummer sun crosses south at 62 degrees and sails straight
  // over a tree subtending 40.
  //
  // Second attempt: taller trees, same southern placement. Also wrong, for a
  // subtler reason — at 51N in June the sun RISES at bearing 50 and SETS at
  // 307, both well north of east and west. It spends the low-altitude hours,
  // the only ones a 18m tree could block, in the northern half of the sky
  // where there were no trees at all.
  //
  // So this is a ring: a garden enclosed by mature trees on every side, which
  // is a real and common situation and the one where the answer is unarguable.
  // The lesson is the same one the building tests teach — work the geometry out
  // before running it, and when a test fails, check whether the sun actually
  // goes where you assumed.
  const ring = []
  for (let a = 0; a < 360; a += 40) {
    const rad = (a * Math.PI) / 180
    ring.push({
      x: Math.sin(rad) * 11,
      z: -Math.cos(rad) * 11,
      height: 18,
      crown: 6,
      crownCentre: 13.5,
      leaf: 'broadleaved',
      estimated: true,
    })
  }
  const veg = { trees: ring, areas: [], tagged: 0, failed: false }

  const withTrees = { ...flatScene(), vegetation: veg }
  const without = flatScene()

  const JUN = new Date('2026-06-21T12:00:00Z')
  const DEC = new Date('2026-12-21T12:00:00Z')

  const sJun = sunHoursForDay(withTrees, 51.5074, -0.1278, JUN, 10)
  const bJun = sunHoursForDay(without, 51.5074, -0.1278, JUN, 10)
  const sDec = sunHoursForDay(withTrees, 51.5074, -0.1278, DEC, 10)

  assert(
    'trees cost the garden summer sun',
    sJun.effectiveHours < bJun.effectiveHours,
    `${sJun.effectiveHours.toFixed(2)}h vs ${bJun.effectiveHours.toFixed(2)}h open`,
  )
  assert(
    'effective hours never exceed daylight',
    sJun.effectiveHours <= sJun.daylightHours + 1e-9 &&
      sDec.effectiveHours <= sDec.daylightHours + 1e-9,
  )
  assert(
    'dappled light is counted separately from full sun',
    sJun.dappledHours > 0 && sJun.directHours < sJun.daylightHours,
    `${sJun.dappledHours.toFixed(2)}h dappled`,
  )
  assert('the vegetation layer is reported', sJun.hadVegetation === true)
  assert('an empty scene reports no vegetation', bJun.hadVegetation === false)

  // With no vegetation the new path must reproduce the old numbers exactly.
  check('no vegetation: effective == direct', bJun.effectiveHours, bJun.directHours, 1e-9)
}

console.log('\n==========================================================')
console.log(`  ${pass} passed, ${fail} failed`)
console.log('==========================================================\n')
process.exit(fail > 0 ? 1 : 0)
