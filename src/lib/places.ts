/**
 * places.ts — somewhere to start.
 *
 * A landing page with an empty search box is a worse experience than one that
 * opens somewhere interesting. These are chosen because each one says something
 * different about sunlight: the extremes of latitude, the places where the day
 * breaks the usual rules, and a few ordinary cities for reference.
 */

export interface Place {
  name: string
  country: string
  lat: number
  lon: number
  /** why this place is worth looking at */
  note?: string
}

export const PLACES: Place[] = [
  // the extremes — where sunlight stops behaving normally
  {
    name: 'Longyearbyen',
    country: 'Svalbard',
    lat: 78.2232,
    lon: 15.6469,
    note: 'The northernmost town on Earth. Four months of unbroken daylight, then four of night.',
  },
  {
    name: 'Tromsø',
    country: 'Norway',
    lat: 69.6492,
    lon: 18.9553,
    note: 'Above the Arctic Circle: midnight sun from late May, polar night from late November.',
  },
  {
    name: 'Utqiaġvik',
    country: 'Alaska',
    lat: 71.2906,
    lon: -156.7886,
    note: 'The sun sets in November and does not rise again until January.',
  },
  {
    name: 'Reykjavík',
    country: 'Iceland',
    lat: 64.1466,
    lon: -21.9426,
    note: 'Just south of the Arctic Circle — 21 hours of light in June, four in December.',
  },
  {
    name: 'Ushuaia',
    country: 'Argentina',
    lat: -54.8019,
    lon: -68.303,
    note: 'The southernmost city in the world. The same extremes, inverted.',
  },
  {
    name: 'McMurdo Station',
    country: 'Antarctica',
    lat: -77.8419,
    lon: 166.6863,
    note: 'Six months of day, six of night, at the bottom of the planet.',
  },

  // the equator — where every day is the same length
  {
    name: 'Quito',
    country: 'Ecuador',
    lat: -0.1807,
    lon: -78.4678,
    note: 'On the equator: twelve hours of daylight, every single day of the year.',
  },
  {
    name: 'Singapore',
    country: 'Singapore',
    lat: 1.3521,
    lon: 103.8198,
    note: 'One degree off the equator. Sunrise and sunset barely move all year.',
  },
  {
    name: 'Nairobi',
    country: 'Kenya',
    lat: -1.2921,
    lon: 36.8219,
  },

  // the tropics — where the sun passes directly overhead
  {
    name: 'Honolulu',
    country: 'Hawaiʻi',
    lat: 21.3069,
    lon: -157.8583,
    note: 'Inside the tropics, so the sun passes exactly overhead twice a year — no shadow at noon.',
  },
  {
    name: 'Mexico City',
    country: 'Mexico',
    lat: 19.4326,
    lon: -99.1332,
  },
  {
    name: 'Mumbai',
    country: 'India',
    lat: 19.076,
    lon: 72.8777,
  },
  {
    name: 'Rio de Janeiro',
    country: 'Brazil',
    lat: -22.9068,
    lon: -43.1729,
  },

  // ordinary cities, for reference
  { name: 'London', country: 'United Kingdom', lat: 51.5074, lon: -0.1278 },
  { name: 'New York', country: 'United States', lat: 40.7128, lon: -74.006 },
  { name: 'San Francisco', country: 'United States', lat: 37.7749, lon: -122.4194 },
  { name: 'Paris', country: 'France', lat: 48.8566, lon: 2.3522 },
  { name: 'Berlin', country: 'Germany', lat: 52.52, lon: 13.405 },
  { name: 'Tokyo', country: 'Japan', lat: 35.6762, lon: 139.6503 },
  { name: 'Sydney', country: 'Australia', lat: -33.8688, lon: 151.2093 },
  { name: 'Cape Town', country: 'South Africa', lat: -33.9249, lon: 18.4241 },
  { name: 'Cairo', country: 'Egypt', lat: 30.0444, lon: 31.2357 },
  { name: 'Moscow', country: 'Russia', lat: 55.7558, lon: 37.6173 },
  { name: 'Beijing', country: 'China', lat: 39.9042, lon: 116.4074 },
  { name: 'Delhi', country: 'India', lat: 28.6139, lon: 77.209 },
  { name: 'Dubai', country: 'UAE', lat: 25.2048, lon: 55.2708 },
  { name: 'Istanbul', country: 'Türkiye', lat: 41.0082, lon: 28.9784 },
  { name: 'Buenos Aires', country: 'Argentina', lat: -34.6037, lon: -58.3816 },
  { name: 'Lagos', country: 'Nigeria', lat: 6.5244, lon: 3.3792 },
  { name: 'Seoul', country: 'South Korea', lat: 37.5665, lon: 126.978 },
  { name: 'Bangkok', country: 'Thailand', lat: 13.7563, lon: 100.5018 },
  { name: 'Toronto', country: 'Canada', lat: 43.6532, lon: -79.3832 },
  { name: 'Anchorage', country: 'Alaska', lat: 61.2181, lon: -149.9003 },
  { name: 'Auckland', country: 'New Zealand', lat: -36.8485, lon: 174.7633 },
  { name: 'Stockholm', country: 'Sweden', lat: 59.3293, lon: 18.0686 },
  { name: 'Helsinki', country: 'Finland', lat: 60.1699, lon: 24.9384 },
  { name: 'Athens', country: 'Greece', lat: 37.9838, lon: 23.7275 },
  { name: 'Lima', country: 'Peru', lat: -12.0464, lon: -77.0428 },
  { name: 'Kathmandu', country: 'Nepal', lat: 27.7172, lon: 85.324 },
  { name: 'Marrakesh', country: 'Morocco', lat: 31.6295, lon: -7.9811 },
]

/** Default landing spot — somewhere with a story rather than 0,0. */
export const DEFAULT_PLACE = PLACES.find((p) => p.name === 'Tromsø')!

/** Simple fuzzy-ish search over name and country. */
export function searchPlaces(query: string, limit = 7): Place[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored = PLACES.map((p) => {
    const name = p.name.toLowerCase()
    const country = p.country.toLowerCase()
    let score = -1
    if (name.startsWith(q)) score = 0
    else if (name.includes(q)) score = 1
    else if (country.startsWith(q)) score = 2
    else if (country.includes(q)) score = 3
    return { p, score }
  })
    .filter((s) => s.score >= 0)
    .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
  return scored.slice(0, limit).map((s) => s.p)
}

/** Nearest known place to an arbitrary point — for labelling globe clicks. */
export function nearestPlace(lat: number, lon: number): { place: Place; km: number } {
  let best = PLACES[0]
  let bestD = Infinity
  for (const p of PLACES) {
    const dLat = ((p.lat - lat) * Math.PI) / 180
    const dLon = ((p.lon - lon) * Math.PI) / 180
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat * Math.PI) / 180) *
        Math.cos((p.lat * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2
    const d = 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)))
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return { place: best, km: bestD }
}

/** Format a coordinate the way a map would. */
export function formatCoord(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`
}
