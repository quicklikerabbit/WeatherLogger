import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bucketPrecip } from './precip'
import { barPath, PrecipChart, type PrecipSeries } from './PrecipChart'

// See LineChart.test.tsx: without test.globals, cleanup must be registered.
afterEach(cleanup)

function reading(day: number, hour: number, value: number, quality_flag: string | null = null) {
  return { recorded_at: new Date(2024, 0, day, hour).toISOString(), value, quality_flag }
}

function seriesOf(readings: ReturnType<typeof reading>[]): PrecipSeries[] {
  return [{ key: 'dev1::precipitation_mm', label: 'dev1', color: 'blue', buckets: bucketPrecip(readings, 'day') }]
}

const domain: [Date, Date] = [new Date(2024, 0, 10), new Date(2024, 0, 20)]

describe('barPath', () => {
  it('rounds the top corners and keeps the base square', () => {
    const d = barPath(0, 10, 20, 50)
    expect(d.startsWith('M0,60')).toBe(true) // square bottom-left corner on the baseline
    expect(d).toContain('Q0,10 4,10') // rounded top-left
  })

  it('shrinks the radius for a bar shorter than it', () => {
    expect(barPath(0, 58, 20, 2)).toContain('Q0,58 2,58')
  })
})

describe('PrecipChart', () => {
  it('draws a bar per wet day and none for a dry one', () => {
    render(
      <PrecipChart
        series={seriesOf([reading(12, 1, 2.0), reading(13, 1, 0)])}
        granularity="day"
        width={500}
        height={300}
        xDomain={domain}
        through={new Date(2024, 0, 20)}
      />,
    )
    expect(screen.getAllByTestId('precip-bar')).toHaveLength(1)
    expect(screen.getAllByTestId('precip-column')).toHaveLength(2)
  })

  it('shades the window past the archive lag', () => {
    render(
      <PrecipChart
        series={seriesOf([reading(12, 1, 2.0)])}
        granularity="day"
        width={500}
        height={300}
        xDomain={domain}
        through={new Date(2024, 0, 15)}
      />,
    )
    expect(screen.getByTestId('not-yet-archived')).toBeTruthy()
  })

  it('still draws the lag (not "no readings") for a window entirely inside it', () => {
    render(
      <PrecipChart
        series={seriesOf([])}
        granularity="hour"
        width={500}
        height={300}
        xDomain={domain}
        through={new Date(2024, 0, 9)}
      />,
    )
    expect(screen.getByTestId('not-yet-archived')).toBeTruthy()
    expect(screen.queryByText('No readings in this range.')).toBeNull()
  })

  it('says "no readings" for an empty window the archive has already covered', () => {
    render(
      <PrecipChart
        series={seriesOf([])}
        granularity="day"
        width={500}
        height={300}
        xDomain={domain}
        through={new Date(2024, 0, 25)}
      />,
    )
    expect(screen.getByText('No readings in this range.')).toBeTruthy()
  })

  it('reports the total, flags, and incomplete coverage on hover', () => {
    render(
      <PrecipChart
        series={seriesOf([reading(12, 1, 1.5, 'T'), reading(12, 2, 0.25)])}
        granularity="day"
        width={500}
        height={300}
        xDomain={domain}
        through={new Date(2024, 0, 20)}
      />,
    )
    fireEvent.mouseMove(screen.getByTestId('precip-column'))
    expect(screen.getByTestId('precip-tooltip-value').textContent).toBe('1.8 mm')
    expect(screen.getByText('(trace)')).toBeTruthy()
    expect(screen.getByText('2 of 24 h reported')).toBeTruthy()
  })
})
