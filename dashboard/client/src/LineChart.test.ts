import { describe, expect, it } from 'vitest'
import { computeXDomain } from './LineChart'

describe('computeXDomain', () => {
  it('returns the min/max of a multi-point range unchanged', () => {
    const early = new Date('2024-01-01T00:00:00Z')
    const late = new Date('2024-01-02T00:00:00Z')

    expect(computeXDomain([late, early])).toEqual([early, late])
  })

  it('pads a single-reading series into a centered, non-zero-width range', () => {
    const only = new Date('2024-01-01T12:00:00Z')

    const [start, end] = computeXDomain([only])

    expect(start.getTime()).toBeLessThan(only.getTime())
    expect(end.getTime()).toBeGreaterThan(only.getTime())
    // Centered: the point sits at the midpoint of the padded range.
    expect(only.getTime() - start.getTime()).toBe(end.getTime() - only.getTime())
  })
})
