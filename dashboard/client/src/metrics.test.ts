import { describe, expect, it } from 'vitest'
import {
  metricFirmMax,
  metricInitialMax,
  metricStartAtZero,
  metricTickStep,
  metricUnit,
  yAxisLabel,
} from './metrics'

describe('metricStartAtZero', () => {
  it('defaults to true for a metric with no explicit setting', () => {
    expect(metricStartAtZero('temperature')).toBe(true)
  })

  it('defaults to true for a metric not in the config at all', () => {
    expect(metricStartAtZero('totally_unknown')).toBe(true)
  })

  it('is false for pressure, whose meaningful range sits far from 0', () => {
    expect(metricStartAtZero('pressure')).toBe(false)
  })
})

describe('metricInitialMax / metricFirmMax / metricTickStep', () => {
  it('are unset for a metric with no configured max behavior', () => {
    expect(metricInitialMax('temperature')).toBeUndefined()
    expect(metricFirmMax('temperature')).toBe(false)
    expect(metricTickStep('temperature')).toBeUndefined()
  })

  it('give wind_bearing a 0-360 compass axis: floored at 360, not niced past it, ticked every 90', () => {
    expect(metricInitialMax('wind_bearing')).toBe(360)
    expect(metricFirmMax('wind_bearing')).toBe(true)
    expect(metricTickStep('wind_bearing')).toBe(90)
  })
})

describe('metricUnit', () => {
  it('returns the configured unit', () => {
    expect(metricUnit('pm25')).toBe('µg/m³')
  })

  it('is undefined for a metric not in the config', () => {
    expect(metricUnit('totally_unknown')).toBeUndefined()
  })
})

describe('yAxisLabel', () => {
  it('combines the configured label override and unit', () => {
    expect(yAxisLabel('pm25')).toBe('PM2.5 (µg/m³)')
  })

  it('prettifies an un-overridden snake_case metric name', () => {
    expect(yAxisLabel('wind_bearing')).toBe('Wind Bearing (°)')
  })

  it('omits the unit suffix for a unitless metric', () => {
    expect(yAxisLabel('totally_unknown')).toBe('Totally Unknown')
  })

  it('returns an empty string for no metric selected', () => {
    expect(yAxisLabel('')).toBe('')
  })
})
