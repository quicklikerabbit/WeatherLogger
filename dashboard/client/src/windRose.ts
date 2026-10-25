import type { ReadingSeries } from './Overview'

// A wind rose: how often the wind blew from each of 16 compass sectors over
// the selected window, each sector stacked by speed band. Built from
// wind_bearing joined to wind_speed on recorded_at — citypage reports both
// in one payload, so a device's two readings share an exact timestamp.

export const SECTOR_LABELS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]
export const SECTOR_DEGREES = 360 / SECTOR_LABELS.length

// Below this the wind is calm, and its bearing means nothing — calm
// observations are counted (they're part of the window) but not placed in
// any sector.
const CALM_BELOW_KMH = 1

export type SpeedBand = { label: string; min: number; color: string }

export const SPEED_BANDS: SpeedBand[] = [
  { label: '1–10 km/h', min: CALM_BELOW_KMH, color: 'var(--wind-1)' },
  { label: '10–20 km/h', min: 10, color: 'var(--wind-2)' },
  { label: '20–30 km/h', min: 20, color: 'var(--wind-3)' },
  { label: '30+ km/h', min: 30, color: 'var(--wind-4)' },
]

export type WindObservation = { bearing: number; speed: number }

export type WindRoseData = {
  // Every paired observation in the window, calm included — the base the
  // sector percentages are taken against, so all sectors plus calm sum to 100%.
  total: number
  calm: number
  // One per sector, in compass order; counts[i] is SPEED_BANDS[i]'s count.
  sectors: { label: string; counts: number[] }[]
}

// One list of paired observations per device; a bearing with no speed at
// the same timestamp (or vice versa) is dropped rather than guessed at.
export function pairWind(data: ReadingSeries[]): Map<string, WindObservation[]> {
  const speeds = new Map<string, Map<string, number>>()
  for (const s of data) {
    if (s.metric !== 'wind_speed') continue
    speeds.set(s.device_id, new Map(s.readings.map((r) => [r.recorded_at, r.value])))
  }

  const paired = new Map<string, WindObservation[]>()
  for (const s of data) {
    if (s.metric !== 'wind_bearing') continue
    const deviceSpeeds = speeds.get(s.device_id)
    const observations: WindObservation[] = []
    for (const r of s.readings) {
      const speed = deviceSpeeds?.get(r.recorded_at)
      if (speed !== undefined) observations.push({ bearing: r.value, speed })
    }
    paired.set(s.device_id, observations)
  }
  return paired
}

// Sectors are centered on their compass point: N covers 348.75°–11.25°.
export function sectorIndex(bearing: number): number {
  const normalized = ((bearing % 360) + 360) % 360
  return Math.floor((normalized + SECTOR_DEGREES / 2) / SECTOR_DEGREES) % SECTOR_LABELS.length
}

export function speedBandIndex(speed: number): number {
  let index = 0
  for (let i = 0; i < SPEED_BANDS.length; i++) if (speed >= SPEED_BANDS[i].min) index = i
  return index
}

export function binWind(observations: WindObservation[]): WindRoseData {
  const sectors = SECTOR_LABELS.map((label) => ({ label, counts: SPEED_BANDS.map(() => 0) }))
  let calm = 0
  for (const { bearing, speed } of observations) {
    if (speed < CALM_BELOW_KMH) {
      calm += 1
      continue
    }
    sectors[sectorIndex(bearing)].counts[speedBandIndex(speed)] += 1
  }
  return { total: observations.length, calm, sectors }
}

export function percent(count: number, total: number): number {
  return total === 0 ? 0 : (count / total) * 100
}
