/**
 * weather.ts — what the sky was actually doing.
 *
 * The solar core computes how much sunlight *should* reach the ground under a
 * clear sky. Reality has clouds. Open-Meteo publishes measured/modelled
 * shortwave radiation at the surface, so we can show both numbers and let the
 * gap between them be the point: a 900 W/m² clear-sky noon delivering 210 W/m²
 * because it's overcast is a more interesting fact than either number alone.
 *
 * Keyless, CORS-open, free for non-commercial use, no attribution required for
 * the API itself (data is CC-BY-4.0 from the underlying weather services).
 */

export interface WeatherSlice {
  /** cloud cover, percent */
  cloudCover: number
  /** air temperature, °C */
  temperature: number
  /** measured shortwave radiation reaching the ground, W/m² */
  shortwave: number
  /** the hour this sample belongs to */
  time: Date
}

export interface WeatherDay {
  /** hourly samples for the requested day, UTC */
  hours: WeatherSlice[]
  /** true when the date is outside the forecast/archive window */
  unavailable: boolean
}

const cache = new Map<string, WeatherDay>()

/** Open-Meteo covers roughly 3 months back and 16 days forward. */
export function weatherAvailable(date: Date): boolean {
  const now = Date.now()
  const t = date.getTime()
  return t > now - 86400000 * 80 && t < now + 86400000 * 15
}

export async function fetchWeather(
  lat: number,
  lon: number,
  date: Date,
): Promise<WeatherDay> {
  const day = date.toISOString().slice(0, 10)
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${day}`
  const hit = cache.get(key)
  if (hit) return hit

  if (!weatherAvailable(date)) {
    const miss = { hours: [], unavailable: true }
    cache.set(key, miss)
    return miss
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
    `&longitude=${lon.toFixed(4)}` +
    `&hourly=cloud_cover,temperature_2m,shortwave_radiation` +
    `&start_date=${day}&end_date=${day}&timezone=GMT`

  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    const j = await res.json()

    const hours: WeatherSlice[] = (j.hourly?.time ?? []).map(
      (t: string, i: number) => ({
        time: new Date(t + 'Z'),
        cloudCover: j.hourly.cloud_cover?.[i] ?? 0,
        temperature: j.hourly.temperature_2m?.[i] ?? 0,
        shortwave: j.hourly.shortwave_radiation?.[i] ?? 0,
      }),
    )

    const out = { hours, unavailable: hours.length === 0 }
    cache.set(key, out)
    return out
  } catch {
    const fail = { hours: [], unavailable: true }
    cache.set(key, fail)
    return fail
  }
}

/** The sample nearest a given instant. */
export function sliceAt(day: WeatherDay, date: Date): WeatherSlice | null {
  if (!day.hours.length) return null
  let best = day.hours[0]
  let bestD = Infinity
  for (const h of day.hours) {
    const d = Math.abs(h.time.getTime() - date.getTime())
    if (d < bestD) {
      bestD = d
      best = h
    }
  }
  return bestD < 3600000 * 2 ? best : null
}

/** Plain-language sky description from cloud cover. */
export function skyDescription(cloudCover: number): string {
  if (cloudCover < 10) return 'clear'
  if (cloudCover < 30) return 'mostly clear'
  if (cloudCover < 60) return 'partly cloudy'
  if (cloudCover < 85) return 'mostly cloudy'
  return 'overcast'
}
