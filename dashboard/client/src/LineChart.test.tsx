import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { computeXDomain, findClosestPoint, LineChart, margin, type Point, type Reading } from './LineChart'

// @testing-library/react's auto-cleanup only registers itself when it finds
// a *global* afterEach at import time; this project's vitest config doesn't
// set `test.globals`, so each render here would otherwise leak into the next
// test's DOM (e.g. two matching line-chart-overlay elements).
afterEach(cleanup)

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

describe('findClosestPoint', () => {
  const points: Point[] = [
    { date: new Date('2024-01-01T00:00:00Z'), value: 1 },
    { date: new Date('2024-01-01T02:00:00Z'), value: 2 },
    { date: new Date('2024-01-01T04:00:00Z'), value: 3 },
  ]

  it('returns the exact point when x0 matches a reading', () => {
    expect(findClosestPoint(points, points[1].date)).toBe(points[1])
  })

  it('picks whichever neighbor is nearer when x0 falls between two readings', () => {
    expect(findClosestPoint(points, new Date('2024-01-01T00:30:00Z'))).toBe(points[0])
    expect(findClosestPoint(points, new Date('2024-01-01T01:45:00Z'))).toBe(points[1])
  })

  it('breaks an exact tie in favor of the later point', () => {
    // Exactly halfway between points[0] and points[1].
    expect(findClosestPoint(points, new Date('2024-01-01T01:00:00Z'))).toBe(points[1])
  })

  it('clamps to the first point when x0 is before the series starts', () => {
    expect(findClosestPoint(points, new Date('2023-12-31T00:00:00Z'))).toBe(points[0])
  })

  it('clamps to the last point when x0 is after the series ends', () => {
    expect(findClosestPoint(points, new Date('2024-01-02T00:00:00Z'))).toBe(points[2])
  })
})

describe('LineChart tooltip', () => {
  // Evenly spaced over a 2-hour span so each point sits at a known fraction
  // (0, 0.5, 1) of the plotted x-range, making hover targets exact rather
  // than approximate.
  const readings: Reading[] = [
    { recorded_at: '2024-01-01T00:00:00Z', value: 10 },
    { recorded_at: '2024-01-01T01:00:00Z', value: 20 },
    { recorded_at: '2024-01-01T02:00:00Z', value: 30 },
  ]
  const width = 400
  const height = 300
  const innerWidth = width - margin.left - margin.right

  // jsdom's getBoundingClientRect() on the svg is all-zero, so clientX is
  // directly the coordinate the component's own pointer math will compute.
  function clientXFor(fraction: number) {
    return margin.left + innerWidth * fraction
  }

  it('shows nothing before any pointer interaction', () => {
    render(<LineChart readings={readings} width={width} height={height} metric="temperature" />)

    expect(screen.queryByTestId('tooltip-value')).toBeNull()
  })

  it('shows the nearest reading on hover and hides it again on mouse leave', () => {
    render(<LineChart readings={readings} width={width} height={height} metric="temperature" />)
    const overlay = screen.getByTestId('line-chart-overlay')

    fireEvent.mouseMove(overlay, { clientX: clientXFor(0.5), clientY: 100 })
    expect(screen.getByTestId('tooltip-value').textContent).toBe('20 °C')

    fireEvent.mouseMove(overlay, { clientX: clientXFor(0), clientY: 100 })
    expect(screen.getByTestId('tooltip-value').textContent).toBe('10 °C')

    fireEvent.mouseMove(overlay, { clientX: clientXFor(1), clientY: 100 })
    expect(screen.getByTestId('tooltip-value').textContent).toBe('30 °C')

    fireEvent.mouseLeave(overlay)
    expect(screen.queryByTestId('tooltip-value')).toBeNull()
  })

  it('renders the value without a trailing unit for a metric with none configured', () => {
    render(<LineChart readings={readings} width={width} height={height} metric="unmapped_metric" />)
    const overlay = screen.getByTestId('line-chart-overlay')

    fireEvent.mouseMove(overlay, { clientX: clientXFor(1), clientY: 100 })

    expect(screen.getByTestId('tooltip-value').textContent).toBe('30')
  })
})
