import { ParentSize } from '@visx/responsive'
import { useEffect, useState } from 'react'
import { fetchJson } from './api'
import { deviceLocation } from './deviceInfo'
import { LineChart, type Reading, toPoints } from './LineChart'
import { metricMark, prettifyMetric } from './metrics'
import type { ReadingSeries } from './Overview'
import type { DeviceColors } from './seriesColors'
import { rangeQueryParams, type ResolvedRange } from './timeRange'

export type SeriesInfo = {
  device_id: string
  metric: string
  count: number
  first_recorded_at: string
  last_recorded_at: string
}

export function seriesKey(s: Pick<SeriesInfo, 'device_id' | 'metric'>) {
  return `${s.device_id}::${s.metric}`
}

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

// One device/metric stream at a time, for troubleshooting a single feed —
// the overview's per-measurement panels are the main way to read the data.
export function Streams({
  series,
  range,
  colorFor,
}: {
  series: SeriesInfo[]
  range: ResolvedRange
  colorFor: DeviceColors
}) {
  const [selected, setSelected] = useState<string>(() => (series[0] ? seriesKey(series[0]) : ''))
  const [readings, setReadings] = useState<Reading[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    const [device_id, metric] = selected.split('::')
    const params = new URLSearchParams({ device_id, metric, ...rangeQueryParams(range) })
    setError(null)
    fetchJson<{ series: ReadingSeries[] }>(`/api/readings?${params}`, { signal: controller.signal })
      .then((data) => setReadings(data.series[0]?.readings ?? []))
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError(String(err))
      })
    return () => controller.abort()
  }, [selected, range])

  const [deviceId, metric] = selected ? selected.split('::') : ['', '']
  const info = series.find((s) => seriesKey(s) === selected)

  return (
    <div>
      <label className="flex items-center gap-2">
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
      {info && (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {info.count} readings in total, {dateFormat.format(new Date(info.first_recorded_at))} –{' '}
          {dateFormat.format(new Date(info.last_recorded_at))}
        </p>
      )}
      {error && <p className="mt-2 text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6 h-[400px]">
        <ParentSize>
          {({ width, height }) => (
            <LineChart
              series={[
                {
                  key: selected,
                  label: prettifyMetric(metric),
                  color: colorFor(deviceId),
                  // Gusts and other sparse metrics keep their dots here too,
                  // so a stream looks the same as it does in its panel.
                  mark: metricMark(metric) === 'dots' ? 'dots' : 'line',
                  points: toPoints(readings),
                },
              ]}
              width={width}
              height={height}
              metric={metric}
              xDomain={range.from && range.to ? [range.from, range.to] : undefined}
            />
          )}
        </ParentSize>
      </div>
    </div>
  )
}
