import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SELECTION,
  rangeQueryParams,
  resolveRange,
  searchWithSelection,
  selectionFromSearch,
} from './timeRange'

const anchor = new Date('2026-10-24T06:00:00Z')

describe('resolveRange', () => {
  it('counts a preset back from the anchor, keeping the anchor reading itself', () => {
    const { from, to } = resolveRange({ kind: 'preset', preset: '24h' }, anchor)
    expect(from?.toISOString()).toBe('2026-10-23T06:00:00.000Z')
    expect(to!.getTime()).toBeGreaterThan(anchor.getTime())
  })

  it('leaves "all" and a not-yet-known anchor unbounded', () => {
    expect(resolveRange({ kind: 'preset', preset: 'all' }, anchor)).toEqual({})
    expect(resolveRange({ kind: 'preset', preset: '7d' }, null)).toEqual({})
  })

  it('treats a custom range as local calendar days with an inclusive end date', () => {
    const { from, to } = resolveRange({ kind: 'custom', from: '2026-10-01', to: '2026-10-03' }, anchor)
    expect(from).toEqual(new Date(2026, 9, 1))
    expect(to).toEqual(new Date(2026, 9, 4))
  })
})

describe('URL round-trip', () => {
  it('reads back what it writes, for presets and custom ranges', () => {
    for (const selection of [
      { kind: 'preset', preset: '30d' } as const,
      { kind: 'custom', from: '2026-09-01', to: '2026-09-15' } as const,
    ]) {
      expect(selectionFromSearch(searchWithSelection('', selection))).toEqual(selection)
    }
  })

  it('replaces only the range params, keeping others', () => {
    const search = searchWithSelection('?from=2026-01-01&to=2026-01-02&foo=bar', {
      kind: 'preset',
      preset: '3d',
    })
    expect(new URLSearchParams(search).get('foo')).toBe('bar')
    expect(new URLSearchParams(search).has('from')).toBe(false)
  })

  it('falls back to the default for missing or malformed params', () => {
    expect(selectionFromSearch('')).toEqual(DEFAULT_SELECTION)
    expect(selectionFromSearch('?range=1y')).toEqual(DEFAULT_SELECTION)
    expect(selectionFromSearch('?from=2026-10-05&to=2026-10-01')).toEqual(DEFAULT_SELECTION)
  })
})

describe('rangeQueryParams', () => {
  it('omits unbounded ends', () => {
    expect(rangeQueryParams({})).toEqual({})
    expect(rangeQueryParams({ from: anchor })).toEqual({ from: '2026-10-24T06:00:00.000Z' })
  })
})
