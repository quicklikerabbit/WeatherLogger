import { describe, expect, it } from 'vitest'
import { PANELS } from './metrics'
import { type ReadingSeries, toChartSeries, toPrecipView } from './Overview'
import { deviceColors } from './seriesColors'

const temperaturePanel = PANELS.find((p) => p.id === 'temperature')!
const reading = [{ recorded_at: '2024-01-01T00:00:00Z', value: 1 }]

function series(device_id: string, metric: string): ReadingSeries {
  return { device_id, metric, readings: reading }
}

describe('toChartSeries', () => {
  const colorFor = deviceColors(['dev-a', 'dev-b'])

  it('labels by metric when the panel has one device, in the panel metric order', () => {
    const result = toChartSeries(
      temperaturePanel,
      [series('dev-a', 'dewpoint'), series('dev-a', 'temperature')],
      colorFor,
    )
    expect(result.map((s) => s.label)).toEqual(['Temperature', 'Dewpoint'])
    expect(result.map((s) => s.mark)).toEqual(['line', 'dashed'])
  })

  it('labels by device when the panel has one metric across several devices', () => {
    const result = toChartSeries(
      temperaturePanel,
      [series('dev-b', 'temperature'), series('dev-a', 'temperature')],
      colorFor,
    )
    expect(result.map((s) => s.label)).toEqual(['dev-a', 'dev-b'])
  })

  it('labels by both when devices and metrics both vary, colored by device', () => {
    const result = toChartSeries(
      temperaturePanel,
      [series('dev-a', 'temperature'), series('dev-b', 'dewpoint')],
      colorFor,
    )
    expect(result.map((s) => s.label)).toEqual(['Temperature · dev-a', 'Dewpoint · dev-b'])
    expect(result.map((s) => s.color)).toEqual(['var(--series-1)', 'var(--series-2)'])
  })
})

describe('toPrecipView', () => {
  const colorFor = deviceColors(['dev-a'])
  const data = [series('dev-a', 'precipitation_mm')]
  const day = 24 * 60 * 60 * 1000

  it('picks hourly bars for a short window and daily for a long one', () => {
    const start = new Date('2024-01-01T00:00:00Z')
    const short: [Date, Date] = [start, new Date(start.getTime() + day)]
    const long: [Date, Date] = [start, new Date(start.getTime() + 7 * day)]
    expect(toPrecipView(data, colorFor, short, null).granularity).toBe('hour')
    expect(toPrecipView(data, colorFor, long, null).granularity).toBe('day')
  })

  it('keeps the bucket size chosen from the selected range, not the widened fetch window', () => {
    // Regression: a 3-day preset starts mid-hour, so snapping it to whole
    // hours widens it just past 72h. Re-picking the size from that widened
    // window flipped it to daily bars over an hour-snapped fetch, bringing
    // back partial first/last days that overflowed the axis.
    const anchor = new Date('2024-01-10T06:42:00Z')
    const selected = { from: new Date(anchor.getTime() - 3 * day), to: new Date(anchor.getTime() + 1000) }
    const widened: [Date, Date] = [
      new Date('2024-01-07T06:00:00Z'),
      new Date('2024-01-10T07:00:00Z'),
    ]
    expect(widened[1].getTime() - widened[0].getTime()).toBeGreaterThan(3 * day)

    expect(toPrecipView(data, colorFor, widened, null, selected).granularity).toBe('hour')
  })

  it('takes "archived through" from the snapshot-wide latest, not the window', () => {
    const view = toPrecipView([], colorFor, undefined, '2024-01-05T06:00:00Z')
    expect(view.through?.toISOString()).toBe('2024-01-05T07:00:00.000Z')
  })
})

describe('deviceColors', () => {
  it('assigns slots by sorted device id, independent of input order', () => {
    const colorFor = deviceColors(['zeta', 'alpha'])
    expect(colorFor('alpha')).toBe('var(--series-1)')
    expect(colorFor('zeta')).toBe('var(--series-2)')
  })

  it('folds a ninth device into "other" rather than reusing slot 1', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `dev-${i}`)
    expect(deviceColors(ids)('dev-8')).toBe('var(--series-other)')
  })
})
