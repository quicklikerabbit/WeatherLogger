import { ParentSize } from '@visx/responsive'
import { useEffect, useState } from 'react'
import { LineChart, type Reading } from './LineChart'

type SeriesInfo = {
  device_id: string
  metric: string
  count: number
  first_recorded_at: string
  last_recorded_at: string
}

function seriesKey(s: Pick<SeriesInfo, 'device_id' | 'metric'>) {
  return `${s.device_id}::${s.metric}`
}

// fetch() only rejects on network failure, not HTTP error status — without
// this, a 503/400 body like { ok: false, error: "..." } gets treated as
// success data and crashes downstream code expecting the real shape.
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed: ${res.status}`)
  }
  return data as T
}

function App() {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [series, setSeries] = useState<SeriesInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [readings, setReadings] = useState<Reading[]>([])
  const [error, setError] = useState<string | null>(null)

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
    const params = new URLSearchParams({ device_id, metric })
    fetchJson<{ readings: Reading[] }>(`/api/readings?${params}`, { signal: controller.signal })
      .then((data) => setReadings(data.readings))
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError(String(err))
      })
    return () => controller.abort()
  }, [selected])

  return (
    <main className="min-h-screen bg-white p-8 text-gray-700 dark:bg-gray-900 dark:text-gray-300">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Weather Dashboard</h1>
      {snapshot && <p className="mt-1 text-sm">Snapshot: {snapshot}</p>}
      {error && <p className="mt-2 text-red-600 dark:text-red-400">{error}</p>}

      <label className="mt-6 flex items-center gap-2">
        <span>Series:</span>
        <select
          className="rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-800"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {series.map((s) => (
            <option key={seriesKey(s)} value={seriesKey(s)}>
              {s.device_id} / {s.metric} ({s.count} readings)
            </option>
          ))}
        </select>
      </label>

      <div className="mt-6 h-[400px]">
        <ParentSize>
          {({ width, height }) => <LineChart readings={readings} width={width} height={height} />}
        </ParentSize>
      </div>
    </main>
  )
}

export default App
