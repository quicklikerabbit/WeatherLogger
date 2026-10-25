import { useEffect, useMemo, useState } from 'react'
import { fetchJson } from './api'
import { deviceLocation } from './deviceInfo'
import { Overview } from './Overview'
import { deviceColors } from './seriesColors'
import { type SeriesInfo, Streams } from './Streams'
import {
  resolveRange,
  searchWithSelection,
  selectionFromSearch,
  type RangeSelection,
} from './timeRange'
import { TimeRangePicker } from './TimeRangePicker'

type View = 'overview' | 'streams'

const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'streams', label: 'Streams' },
]

// Kept in the URL alongside the time range (?view=streams); the overview
// is the default and carries no param.
function viewFromSearch(search: string): View {
  return new URLSearchParams(search).get('view') === 'streams' ? 'streams' : 'overview'
}

function searchWithView(search: string, view: View): string {
  const params = new URLSearchParams(search)
  if (view === 'overview') params.delete('view')
  else params.set('view', view)
  const query = params.toString()
  return query ? `?${query}` : ''
}

function replaceSearch(search: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${search}`)
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
  const [series, setSeries] = useState<SeriesInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>(() => viewFromSearch(window.location.search))
  const [rangeSelection, setRangeSelection] = useState<RangeSelection>(() =>
    selectionFromSearch(window.location.search),
  )

  useEffect(() => {
    fetchJson<{ snapshot: string; series: SeriesInfo[] }>('/api/series')
      .then((data) => {
        setSnapshot(data.snapshot)
        setSeries(data.series)
      })
      .catch((err) => setError(String(err)))
  }, [])

  const anchor = useMemo(() => latestRecordedAt(series ?? []), [series])
  const range = useMemo(() => resolveRange(rangeSelection, anchor), [rangeSelection, anchor])
  const deviceIds = useMemo(() => [...new Set((series ?? []).map((s) => s.device_id))], [series])
  const colorFor = useMemo(() => deviceColors(deviceIds), [deviceIds])
  const latestByMetric = useMemo(() => {
    const latest = new Map<string, string>()
    for (const s of series ?? []) {
      const current = latest.get(s.metric)
      if (!current || s.last_recorded_at > current) latest.set(s.metric, s.last_recorded_at)
    }
    return latest
  }, [series])

  function changeRange(selection: RangeSelection) {
    setRangeSelection(selection)
    replaceSearch(searchWithSelection(window.location.search, selection))
  }

  function changeView(next: View) {
    setView(next)
    replaceSearch(searchWithView(window.location.search, next))
  }

  const locations = deviceIds.map(deviceLocation).filter((l): l is string => l !== null)

  return (
    <main className="min-h-screen bg-white p-4 text-gray-700 sm:p-8 dark:bg-gray-900 dark:text-gray-300">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Weather Dashboard</h1>
      {snapshot && <p className="mt-1 text-sm">Snapshot: {snapshot}</p>}
      {locations.map((location) => (
        <p key={location} className="text-sm text-gray-500 dark:text-gray-400">
          {location}
        </p>
      ))}
      {error && <p className="mt-2 text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <nav aria-label="View" className="flex gap-1">
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-current={view === id ? 'page' : undefined}
              className={`rounded px-3 py-1 text-sm ${
                view === id
                  ? 'bg-gray-200 font-medium text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
              onClick={() => changeView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <TimeRangePicker selection={rangeSelection} onChange={changeRange} anchor={anchor} />
      </div>

      <div className="mt-6">
        {series &&
          (view === 'overview' ? (
            <Overview latestByMetric={latestByMetric} range={range} colorFor={colorFor} />
          ) : (
            <Streams series={series} range={range} colorFor={colorFor} />
          ))}
      </div>
    </main>
  )
}

export default App
