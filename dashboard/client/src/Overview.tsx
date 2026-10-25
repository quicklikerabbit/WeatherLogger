import { ParentSize } from '@visx/responsive'
import { useEffect, useState } from 'react'
import { fetchJson } from './api'
import { type ChartSeries, LineChart, type Reading, toPoints } from './LineChart'
import { metricMark, PANELS, type PanelConfig, panelAxisLabel, prettifyMetric } from './metrics'
import {
  archivedThrough,
  bucketPrecip,
  chooseGranularity,
  formatMm,
  type Granularity,
  totalOf,
} from './precip'
import { PrecipChart, type PrecipSeries } from './PrecipChart'
import type { DeviceColors } from './seriesColors'
import { rangeQueryParams, type ResolvedRange } from './timeRange'

export type ReadingSeries = {
  device_id: string
  metric: string
  readings: Reading[]
}

// Turns the API's per-device/metric series into chart series. Labels name
// only what varies within the panel: the metric when there's one device,
// the device when there's one metric, both when neither is unique.
export function toChartSeries(
  panel: PanelConfig,
  data: ReadingSeries[],
  colorFor: DeviceColors,
): ChartSeries[] {
  const devices = new Set(data.map((s) => s.device_id))
  const metrics = new Set(data.map((s) => s.metric))
  const metricOrder = (m: string) => panel.metrics.indexOf(m)

  return [...data]
    .sort(
      (a, b) =>
        a.device_id.localeCompare(b.device_id) || metricOrder(a.metric) - metricOrder(b.metric),
    )
    .map((s) => {
      const metricName = prettifyMetric(s.metric)
      const label =
        devices.size > 1 && metrics.size > 1
          ? `${metricName} · ${s.device_id}`
          : devices.size > 1
            ? s.device_id
            : metricName
      return {
        key: `${s.device_id}::${s.metric}`,
        label,
        color: colorFor(s.device_id),
        mark: metricMark(s.metric),
        points: toPoints(s.readings),
      }
    })
}

type LegendEntry = Pick<ChartSeries, 'key' | 'label' | 'color' | 'mark'>

function LegendKey({ series }: { series: LegendEntry }) {
  if (series.mark === 'bar') {
    return (
      <svg width={10} height={10} aria-hidden>
        <rect width={10} height={10} rx={2} style={{ fill: series.color }} />
      </svg>
    )
  }
  if (series.mark === 'dots') {
    return (
      <svg width={16} height={10} aria-hidden>
        <circle cx={8} cy={5} r={4} style={{ fill: series.color }} />
      </svg>
    )
  }
  return (
    <svg width={20} height={10} aria-hidden>
      <line
        x1={1}
        x2={19}
        y1={5}
        y2={5}
        style={{ stroke: series.color }}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={series.mark === 'dashed' ? '6,4' : undefined}
      />
    </svg>
  )
}

export function Legend({ series }: { series: LegendEntry[] }) {
  // A lone series is already named by the panel title.
  if (series.length < 2) return null
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <LegendKey series={s} />
          {s.label}
        </li>
      ))}
    </ul>
  )
}

function latestOf(panel: PanelConfig, latestByMetric: Map<string, string>): string | null {
  const times = panel.metrics.flatMap((m) => latestByMetric.get(m) ?? [])
  return times.length > 0 ? times.reduce((a, t) => (t > a ? t : a)) : null
}

function Panel({
  panel,
  range,
  colorFor,
  latest,
}: {
  panel: PanelConfig
  range: ResolvedRange
  colorFor: DeviceColors
  // This panel's latest reading in the whole snapshot — for precipitation,
  // how far the archive has caught up, which a window inside the lag
  // can't tell from its own (empty) readings.
  latest: string | null
}) {
  const [data, setData] = useState<ReadingSeries[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(rangeQueryParams(range))
    for (const metric of panel.metrics) params.append('metric', metric)
    setError(null)
    fetchJson<{ series: ReadingSeries[] }>(`/api/readings?${params}`, { signal: controller.signal })
      .then((res) => setData(res.series))
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError(String(err))
      })
    return () => controller.abort()
  }, [panel, range])

  const xDomain: [Date, Date] | undefined = range.from && range.to ? [range.from, range.to] : undefined

  if (panel.kind === 'precip') {
    const precip = data ? toPrecipView(data, colorFor, xDomain, latest) : null
    return (
      <PanelShell
        panel={panel}
        aside={precip && <PrecipSummary series={precip.series} through={precip.through} />}
        legend={precip?.series.map((s) => ({ ...s, mark: 'bar' as const })) ?? []}
        error={error}
      >
        {precip && (
          <ParentSize>
            {({ width, height }) => (
              <PrecipChart
                series={precip.series}
                granularity={precip.granularity}
                width={width}
                height={height}
                xDomain={xDomain}
                through={precip.through}
              />
            )}
          </ParentSize>
        )}
      </PanelShell>
    )
  }

  const series = data ? toChartSeries(panel, data, colorFor) : []
  return (
    <PanelShell panel={panel} legend={series} error={error}>
      {data && (
        <ParentSize>
          {({ width, height }) => (
            <LineChart
              series={series}
              width={width}
              height={height}
              metric={panel.metrics[0]}
              yLabel={panelAxisLabel(panel)}
              xDomain={xDomain}
            />
          )}
        </ParentSize>
      )}
    </PanelShell>
  )
}

function PanelShell({
  panel,
  aside,
  legend,
  error,
  children,
}: {
  panel: PanelConfig
  // Shown at the right of the title row, e.g. precipitation's total.
  aside?: React.ReactNode
  legend: LegendEntry[]
  error: string | null
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={`panel-${panel.id}`}
      className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`panel-${panel.id}`} className="font-medium text-gray-900 dark:text-gray-100">
          {panel.title}
        </h2>
        {aside}
      </div>
      <div className="mt-1 min-h-4">
        <Legend series={legend} />
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-2 h-64">{children}</div>
    </section>
  )
}

// The bucket size follows the window being shown: the selected range if
// it's bounded, otherwise ("All") the data's own span.
export function toPrecipView(
  data: ReadingSeries[],
  colorFor: DeviceColors,
  xDomain: [Date, Date] | undefined,
  latest: string | null,
): { series: PrecipSeries[]; granularity: Granularity; through: Date | null } {
  const readings = data.flatMap((s) => s.readings)
  const times = readings.map((r) => new Date(r.recorded_at).getTime())
  const spanMs = xDomain
    ? xDomain[1].getTime() - xDomain[0].getTime()
    : times.length > 0
      ? Math.max(...times) - Math.min(...times)
      : 0
  const granularity = chooseGranularity(spanMs)
  const series = [...data]
    .sort((a, b) => a.device_id.localeCompare(b.device_id))
    .map((s) => ({
      key: `${s.device_id}::${s.metric}`,
      label: s.device_id,
      color: colorFor(s.device_id),
      buckets: bucketPrecip(s.readings, granularity),
    }))
  return { series, granularity, through: latest ? archivedThrough(latest) : null }
}

const throughFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
})

function PrecipSummary({ series, through }: { series: PrecipSeries[]; through: Date | null }) {
  const flagged = series.some((s) => s.buckets.some((b) => b.flags.length > 0))
  return (
    <div className="text-right text-sm">
      <p data-testid="precip-total">
        {series.length === 1 ? (
          <>
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {formatMm(totalOf(series[0].buckets))}
            </span>{' '}
            total
          </>
        ) : (
          series.map((s, i) => (
            <span key={s.key}>
              {i > 0 && ' · '}
              {s.label}{' '}
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {formatMm(totalOf(s.buckets))}
              </span>
            </span>
          ))
        )}
        {flagged && <span className="text-gray-500 dark:text-gray-400"> (incl. trace/estimated)</span>}
      </p>
      {through && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Archived through {throughFormat.format(through)}
        </p>
      )}
    </div>
  )
}

export function Overview({
  latestByMetric,
  range,
  colorFor,
}: {
  // Each metric's latest recorded_at anywhere in the snapshot (not just
  // the selected range), from /api/series. A panel none of whose metrics
  // has ever reported is hidden entirely.
  latestByMetric: Map<string, string>
  range: ResolvedRange
  colorFor: DeviceColors
}) {
  const panels = PANELS.filter((p) => p.metrics.some((m) => latestByMetric.has(m)))

  if (panels.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No data in this snapshot yet.</p>
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {panels.map((panel) => (
        <Panel
          key={panel.id}
          panel={panel}
          range={range}
          colorFor={colorFor}
          latest={latestOf(panel, latestByMetric)}
        />
      ))}
    </div>
  )
}
