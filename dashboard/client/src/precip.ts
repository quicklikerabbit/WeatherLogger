import type { Reading } from './LineChart'

// precipitation_mm readings are hourly amounts (Environment Canada's
// climate-hourly archive), so a bar is the sum of the hours that fall in
// its bucket: one bar per hour for a short window, one per day for longer
// ones, where 72+ hourly bars would be too thin to read.
export type Granularity = 'hour' | 'day'

const HOUR_MS = 60 * 60 * 1000
const HOURLY_MAX_SPAN_MS = 3 * 24 * HOUR_MS

export function chooseGranularity(spanMs: number): Granularity {
  return spanMs <= HOURLY_MAX_SPAN_MS ? 'hour' : 'day'
}

export type PrecipBucket = {
  start: Date
  end: Date
  total: number
  // How many hourly readings landed in the bucket, against how many hours
  // the bucket spans — a day with archive gaps under-reports its total,
  // and the tooltip says so rather than passing it off as complete.
  hoursReported: number
  hoursInBucket: number
  // Distinct QC flags among the bucket's readings (e.g. 'T' trace,
  // 'E' estimated); empty for clean data.
  flags: string[]
}

// Buckets are the viewer's local hours/days: a "day" of rain should run
// midnight to midnight where the viewer is, not in UTC. Using the Date
// setters (rather than adding 24h) also makes a DST-change day 23 or 25
// hours long, as it really is.
export function bucketStart(date: Date, granularity: Granularity): Date {
  const start = new Date(date)
  if (granularity === 'hour') start.setMinutes(0, 0, 0)
  else start.setHours(0, 0, 0, 0)
  return start
}

export function bucketEnd(start: Date, granularity: Granularity): Date {
  const end = new Date(start)
  if (granularity === 'hour') end.setHours(end.getHours() + 1)
  else end.setDate(end.getDate() + 1)
  return end
}

export function bucketPrecip(readings: Reading[], granularity: Granularity): PrecipBucket[] {
  const buckets = new Map<number, PrecipBucket>()
  for (const r of readings) {
    const start = bucketStart(new Date(r.recorded_at), granularity)
    let bucket = buckets.get(start.getTime())
    if (!bucket) {
      const end = bucketEnd(start, granularity)
      bucket = {
        start,
        end,
        total: 0,
        hoursReported: 0,
        hoursInBucket: Math.round((end.getTime() - start.getTime()) / HOUR_MS),
        flags: [],
      }
      buckets.set(start.getTime(), bucket)
    }
    bucket.total += r.value
    bucket.hoursReported += 1
    if (r.quality_flag && !bucket.flags.includes(r.quality_flag)) bucket.flags.push(r.quality_flag)
  }
  return [...buckets.values()].sort((a, b) => a.start.getTime() - b.start.getTime())
}

export function totalOf(buckets: PrecipBucket[]): number {
  return buckets.reduce((sum, b) => sum + b.total, 0)
}

// The end of the last archived hour, given that hour's recorded_at:
// everything after it is "not yet archived" (the archive lags by about a
// day), which is different from "no rain" and is drawn differently.
export function archivedThrough(lastRecordedAt: string): Date {
  return new Date(new Date(lastRecordedAt).getTime() + HOUR_MS)
}

const FLAG_NAMES: Record<string, string> = { T: 'trace', E: 'estimated' }

export function describeFlags(flags: string[]): string | null {
  if (flags.length === 0) return null
  return flags.map((f) => FLAG_NAMES[f] ?? f).join(', ')
}

export function formatMm(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1)} mm`
}
