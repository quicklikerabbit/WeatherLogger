import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bucketPrecip } from './precip'
import { PrecipChart, type PrecipSeries } from './PrecipChart'

// See LineChart.test.tsx: without test.globals, cleanup must be registered.
afterEach(cleanup)

function reading(day: number, hour: number, value: number, quality_flag: string | null = null) {
  return { recorded_at: new Date(2024, 0, day, hour).toISOString(), value, quality_flag }
}

function seriesOf(readings: ReturnType<typeof reading>[]): PrecipSeries[] {
  return [{ key: 'dev1::precipitation_mm', label: 'dev1', color: 'blue', buckets: bucketPrecip(readings, 'day') }]
}

// Ten whole local days, as snapToBuckets would produce.
const window: [Date, Date] = [new Date(2024, 0, 10), new Date(2024, 0, 20)]

describe('PrecipChart', () => {
  it('gives every day in the window a band, and draws bars only for wet ones', () => {
    render(
      <PrecipChart
        series={seriesOf([reading(12, 1, 2.0), reading(13, 1, 0)])}
        granularity="day"
        window={window}
        width={500}
        height={300}
        through={new Date(2024, 0, 20)}
      />,
    )
    expect(screen.getAllByTestId('precip-column')).toHaveLength(10)
    expect(screen.getAllByTestId('precip-bar')).toHaveLength(1)
  })

  it('keeps every bar inside the plot area', () => {
    // Regression: daily buckets used to start at local midnight before an
    // unsnapped window's start, drawing the first bar over the y-axis.
    render(
      <PrecipChart
        series={seriesOf([reading(10, 0, 3.0), reading(19, 23, 1.0)])}
        granularity="day"
        window={window}
        width={500}
        height={300}
        through={new Date(2024, 0, 20)}
      />,
    )
    for (const bar of screen.getAllByTestId('precip-bar')) {
      const groupX = Number(bar.parentElement!.getAttribute('transform')!.match(/translate\(([-\d.]+)/)![1])
      expect(groupX + Number(bar.getAttribute('x'))).toBeGreaterThanOrEqual(0)
    }
  })

  it('shades the days past the archive lag', () => {
    render(
      <PrecipChart
        series={seriesOf([reading(12, 1, 2.0)])}
        granularity="day"
        window={window}
        width={500}
        height={300}
        through={new Date(2024, 0, 15)}
      />,
    )
    expect(screen.getByTestId('not-yet-archived')).toBeTruthy()
  })

  it('still draws the lag (not "no readings") for a window entirely inside it', () => {
    render(
      <PrecipChart
        series={seriesOf([])}
        granularity="day"
        window={window}
        width={500}
        height={300}
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
        window={window}
        width={500}
        height={300}
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
        window={window}
        width={500}
        height={300}
        through={new Date(2024, 0, 20)}
      />,
    )
    // Jan 12 is the third band in the window.
    fireEvent.mouseMove(screen.getAllByTestId('precip-column')[2])
    expect(screen.getByTestId('precip-tooltip-value').textContent).toBe('1.8 mm')
    expect(screen.getByText('(trace)')).toBeTruthy()
    expect(screen.getByText('2 of 24 h reported')).toBeTruthy()
  })
})
