import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ChartSeries,
  computeXDomain,
  findClosestPoint,
  LineChart,
  margin,
  type Point,
  splitAtGaps,
  toPoints,
  tooltipAt,
  type Reading,
} from './LineChart'

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

  function single(rs: Reading[]): ChartSeries[] {
    return [{ key: 'dev1::temperature', label: 'Temperature', color: 'red', mark: 'line', points: toPoints(rs) }]
  }

  it('shows nothing before any pointer interaction', () => {
    render(<LineChart series={single(readings)} width={width} height={height} metric="temperature" />)

    expect(screen.queryByTestId('tooltip-value')).toBeNull()
  })

  it('shows the nearest reading on hover and hides it again on mouse leave', () => {
    render(<LineChart series={single(readings)} width={width} height={height} metric="temperature" />)
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
    render(<LineChart series={single(readings)} width={width} height={height} metric="unmapped_metric" />)
    const overlay = screen.getByTestId('line-chart-overlay')

    fireEvent.mouseMove(overlay, { clientX: clientXFor(1), clientY: 100 })

    expect(screen.getByTestId('tooltip-value').textContent).toBe('30')
  })
})

const hour = 60 * 60 * 1000
function hourly(startIso: string, values: (number | null)[]): Point[] {
  const start = new Date(startIso).getTime()
  return values.flatMap((value, i) =>
    value === null ? [] : [{ date: new Date(start + i * hour), value }],
  )
}

describe('splitAtGaps', () => {
  it('keeps a regularly spaced series as one run', () => {
    const points = hourly('2024-01-01T00:00:00Z', [1, 2, 3, 4])
    expect(splitAtGaps(points)).toEqual([points])
  })

  it('breaks the line at a gap wider than three typical intervals', () => {
    // Hourly, then a 5-hour hole, then hourly again.
    const points = hourly('2024-01-01T00:00:00Z', [1, 2, 3, null, null, null, null, 8, 9, 10])
    const runs = splitAtGaps(points)
    expect(runs.map((r) => r.map((p) => p.value))).toEqual([
      [1, 2, 3],
      [8, 9, 10],
    ])
  })

  it('does not break at a gap of up to three intervals', () => {
    const points = hourly('2024-01-01T00:00:00Z', [1, 2, 3, null, null, 6, 7])
    expect(splitAtGaps(points)).toHaveLength(1)
  })

  it('returns no runs for an empty series', () => {
    expect(splitAtGaps([])).toEqual([])
  })
})

describe('tooltipAt', () => {
  const temperature: ChartSeries = {
    key: 'dev1::temperature',
    label: 'Temperature',
    color: 'red',
    mark: 'line',
    points: hourly('2024-01-01T00:00:00Z', [5, 6, 7, 8]),
  }
  const dewpoint: ChartSeries = { ...temperature, key: 'dev1::dewpoint', label: 'Dewpoint',
    points: hourly('2024-01-01T00:00:00Z', [1, 2, 3, 4]) }

  it('reports every series at the snapped moment', () => {
    const data = tooltipAt([temperature, dewpoint], new Date('2024-01-01T01:10:00Z'))
    expect(data?.date.toISOString()).toBe('2024-01-01T01:00:00.000Z')
    expect(data?.rows.map((r) => [r.label, r.point.value])).toEqual([
      ['Temperature', 6],
      ['Dewpoint', 2],
    ])
  })

  it('leaves out a series with no reading near the snapped moment', () => {
    // Gusts are sparse: one reading, hours away from the hovered time.
    const gusts: ChartSeries = { ...temperature, key: 'dev1::wind_gust', label: 'Gust', mark: 'dots',
      points: [{ date: new Date('2024-01-01T09:00:00Z'), value: 40 }] }
    const data = tooltipAt([temperature, gusts], new Date('2024-01-01T01:00:00Z'))
    expect(data?.rows.map((r) => r.label)).toEqual(['Temperature'])
  })

  it('is null when no series has any points', () => {
    expect(tooltipAt([{ ...temperature, points: [] }], new Date())).toBeNull()
  })
})

describe('LineChart with several series', () => {
  it('draws each series and lists all of them in the tooltip with their labels', () => {
    const series: ChartSeries[] = [
      { key: 'a', label: 'Temperature', color: 'red', mark: 'line',
        points: hourly('2024-01-01T00:00:00Z', [10, 20, 30]) },
      { key: 'b', label: 'Dewpoint', color: 'blue', mark: 'dashed',
        points: hourly('2024-01-01T00:00:00Z', [1, 2, 3]) },
    ]
    render(<LineChart series={series} width={400} height={300} metric="temperature" />)
    expect(screen.getByTestId('series-a')).toBeTruthy()
    expect(screen.getByTestId('series-b')).toBeTruthy()

    const innerWidth = 400 - margin.left - margin.right
    fireEvent.mouseMove(screen.getByTestId('line-chart-overlay'), {
      clientX: margin.left + innerWidth * 0.5,
      clientY: 100,
    })
    expect(screen.getAllByTestId('tooltip-value').map((el) => el.textContent)).toEqual(['20 °C', '2 °C'])
    expect(screen.getByText('Dewpoint')).toBeTruthy()
  })

  it('shows an empty-range message when no series has readings', () => {
    render(
      <LineChart
        series={[{ key: 'a', label: 'T', color: 'red', mark: 'line', points: [] }]}
        width={400}
        height={300}
      />,
    )
    expect(screen.getByText('No readings in this range.')).toBeTruthy()
  })
})
