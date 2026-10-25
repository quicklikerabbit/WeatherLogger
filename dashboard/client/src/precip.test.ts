import { describe, expect, it } from 'vitest'
import type { Reading } from './LineChart'
import {
  archivedThrough,
  bucketPrecip,
  chooseGranularity,
  describeFlags,
  formatMm,
  totalOf,
} from './precip'

// Built from local-time components so bucketing (which is local-time by
// design) is checked the same way whatever zone the test machine is in.
function at(day: number, hour: number, value: number, quality_flag: string | null = null): Reading {
  return { recorded_at: new Date(2024, 0, day, hour).toISOString(), value, quality_flag }
}

describe('chooseGranularity', () => {
  const hour = 60 * 60 * 1000
  it('uses hourly bars up to three days and daily bars beyond', () => {
    expect(chooseGranularity(24 * hour)).toBe('hour')
    expect(chooseGranularity(72 * hour)).toBe('hour')
    expect(chooseGranularity(73 * hour)).toBe('day')
  })
})

describe('bucketPrecip', () => {
  it('sums the hours of each local day, in order, with coverage counts', () => {
    const buckets = bucketPrecip([at(16, 1, 0.5), at(15, 23, 1.0), at(15, 2, 0.2), at(16, 2, 0.1)], 'day')
    expect(buckets.map((b) => b.start)).toEqual([new Date(2024, 0, 15), new Date(2024, 0, 16)])
    expect(buckets.map((b) => Math.round(b.total * 10) / 10)).toEqual([1.2, 0.6])
    expect(buckets.map((b) => b.hoursReported)).toEqual([2, 2])
    expect(buckets[0].hoursInBucket).toBe(24)
    expect(buckets[0].end).toEqual(new Date(2024, 0, 16))
  })

  it('makes one bucket per hour at hourly granularity', () => {
    const buckets = bucketPrecip([at(15, 2, 0.2), at(15, 3, 0.4)], 'hour')
    expect(buckets.map((b) => b.total)).toEqual([0.2, 0.4])
    expect(buckets.every((b) => b.hoursInBucket === 1)).toBe(true)
  })

  it('collects each distinct QC flag once', () => {
    const [bucket] = bucketPrecip([at(15, 1, 0.1, 'T'), at(15, 2, 0.1, 'T'), at(15, 3, 0.4, 'E')], 'day')
    expect(bucket.flags).toEqual(['T', 'E'])
    expect(describeFlags(bucket.flags)).toBe('trace, estimated')
  })

  it('totals across buckets', () => {
    expect(totalOf(bucketPrecip([at(15, 1, 1.25), at(17, 1, 2)], 'day'))).toBe(3.25)
  })
})

describe('archivedThrough', () => {
  it('is the end of the last archived hour', () => {
    expect(archivedThrough('2024-01-15T06:00:00Z').toISOString()).toBe('2024-01-15T07:00:00.000Z')
  })
})

describe('formatMm', () => {
  it('always shows one decimal', () => {
    expect(formatMm(3)).toBe('3.0 mm')
    expect(formatMm(0.04)).toBe('0.0 mm')
  })
})
