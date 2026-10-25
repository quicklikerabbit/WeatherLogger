import { ParentSize } from '@visx/responsive'
import { useEffect, useMemo, useState } from 'react'
import { fetchJson } from './api'
import { deviceLocation } from './deviceInfo'
import { LineChart, type Reading } from './LineChart'
import {
  rangeQueryParams,
  resolveRange,
  searchWithSelection,
  selectionFromSearch,
  type RangeSelection,
} from './timeRange'
import { TimeRangePicker } from './TimeRangePicker'

type SeriesInfo = {
  device_id: string
  metric: string
  count: number
  first_recorded_at: string
  last_recorded_at: string
}

type ReadingSeries = {
  device_id: string
  metric: string
  readings: Reading[]
}

function seriesKey(s: Pick<SeriesInfo, 'device_id' | 'metric'>) {
  return `${s.device_id}::${s.metric}`
}

// Latest reading across every series — the point the range presets count
// back from (see resolveRange).
function latestRecordedAt(series: SeriesInfo[]): Date | null {
  if (series.length === 0) return null
  const latest = series.reduce((a, s) => (s.last_recorded_at > a ? s.last_recorded_at : a), '')
  return new Date(latest)
}

function App() {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [series, setSeries] = useState<SeriesInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [readings, setReadings] = useState<Reading[]>([])
  const [error, setError] = useState<string | null>(null)
  const [rangeSelection, setRangeSelection] = useState<RangeSelection>(() =>
    selectionFromSearch(window.location.search),
  )

  const anchor = useMemo(() => latestRecordedAt(series), [series])
  const range = useMemo(() => resolveRange(rangeSelection, anchor), [rangeSelection, anchor])

  function changeRange(selection: RangeSelection) {
    setRangeSelection(selection)
    const search = searchWithSelection(window.location.search, selection)
    window.history.replaceState(null, '', `${window.location.pathname}${search}`)
  }

  useEffect(() => {
    fetchJson<{ snapshot: string; series: SeriesInfo[] }>('/api/series')
      .then((data) => {
        setSnapshot(data.snapshot)
        setSeries(data.series)
        if (data.series.length > 0) {
          setSelected(seriesKey(data.series[0]))
        }
      })
      .catch((err) => setError(String(err)))
  }, [])

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    const [device_id, metric] = selected.split('::')
    const params = new URLSearchParams({ device_id, metric, ...rangeQueryParams(range) })
    fetchJson<{ series: ReadingSeries[] }>(`/api/readings?${params}`, { signal: controller.signal })
      .then((data) => setReadings(data.series[0]?.readings ?? []))
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError(String(err))
      })
    return () => controller.abort()
  }, [selected, range])

  const [selectedDeviceId, selectedMetric] = selected ? selected.split('::') : ['', '']
  const selectedLocation = deviceLocation(selectedDeviceId)

  return (
    <main className="min-h-screen bg-white p-8 text-gray-700 dark:bg-gray-900 dark:text-gray-300">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Weather Dashboard</h1>
      {snapshot && <p className="mt-1 text-sm">Snapshot: {snapshot}</p>}
      {selectedLocation && <p className="text-sm text-gray-500 dark:text-gray-400">{selectedLocation}</p>}
      {error && <p className="mt-2 text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6">
        <TimeRangePicker selection={rangeSelection} onChange={changeRange} anchor={anchor} />
      </div>

      <label className="mt-4 flex items-center gap-2">
        <span>Series:</span>
        <select
          className="rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-800"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {series.map((s) => {
            const location = deviceLocation(s.device_id)
            return (
              <option key={seriesKey(s)} value={seriesKey(s)}>
                {s.device_id} / {s.metric} ({s.count} readings)
                {location ? ` — ${location}` : ''}
              </option>
            )
          })}
        </select>
      </label>

      <div className="mt-6 h-[400px]">
        <ParentSize>
          {({ width, height }) => (
            <LineChart
              readings={readings}
              width={width}
              height={height}
              metric={selectedMetric}
              xDomain={range.from && range.to ? [range.from, range.to] : undefined}
            />
          )}
        </ParentSize>
      </div>
    </main>
  )
}

export default App
