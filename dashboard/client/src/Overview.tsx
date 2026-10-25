import {
  CircleShape,
  LegendOrdinal,
  LineShape,
  RectShape,
  type RenderShapeProvidedProps,
} from '@visx/legend'
import { ParentSize } from '@visx/responsive'
import { scaleOrdinal } from '@visx/scale'
import { useEffect, useMemo, useState } from 'react'
import { fetchJson } from './api'
import { type ChartSeries, LineChart, type Reading, toPoints } from './LineChart'
import { metricMark, PANELS, type PanelConfig, panelAxisLabel, prettifyMetric } from './metrics'
import {
  archivedThrough,
  bucketPrecip,
  chooseGranularity,
  formatMm,
  type Granularity,
  snapToBuckets,
  totalOf,
} from './precip'
import { PrecipChart, type PrecipSeries } from './PrecipChart'
import type { DeviceColors } from './seriesColors'
import { rangeQueryParams, type ResolvedRange } from './timeRange'
import { binWind, pairWind, SPEED_BANDS } from './windRose'
import { WindRoseChart } from './WindRoseChart'

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

// Series colors are CSS variables, which visx's shapes would put in a
// fill/stroke *attribute* where they don't resolve — so the color goes in
// via shapeStyle (a style property, where they do), along with the dash.
function legendShapeStyle(entry: LegendEntry | undefined): React.CSSProperties {
  if (!entry) return {}
  if (entry.mark === 'bar' || entry.mark === 'dots') return { fill: entry.color, background: entry.color }
  return { stroke: entry.color, strokeDasharray: entry.mark === 'dashed' ? '6,4' : undefined }
}

export function Legend({ series }: { series: LegendEntry[] }) {
  // A lone series is already named by the panel title.
  if (series.length < 2) return null
  const byKey = new Map(series.map((s) => [s.key, s]))
  const scale = scaleOrdinal({ domain: series.map((s) => s.key), range: series.map((s) => s.color) })

  // Each series' key matches how it's drawn: a line (solid or dashed) for
  // a line, a dot for intermittent dots, a swatch for bars.
  function Shape(props: RenderShapeProvidedProps<string, string>) {
    const mark = byKey.get(props.item)?.mark
    if (mark === 'bar') return <RectShape {...props} width={10} height={10} />
    if (mark === 'dots') return <CircleShape {...props} width={8} height={8} />
    return <LineShape {...props} />
  }

  return (
    <LegendOrdinal
      scale={scale}
      direction="row"
      shape={Shape}
      shapeWidth={20}
      shapeHeight={10}
      shapeStyle={(label) => legendShapeStyle(byKey.get(label.datum))}
      labelFormat={(key) => byKey.get(key)?.label ?? key}
      itemMargin="0 16px 0 0"
      labelMargin="0 0 0 6px"
      // No `style` prop: it would replace visx's default ({ display: 'flex' })
      // rather than merge with it. Wrapping has no prop of its own, so it
      // goes on className.
      className="flex-wrap gap-y-1 text-xs text-gray-600 dark:text-gray-400"
    />
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

  // Precipitation fetches whole hours/days (see snapToBuckets) so its
  // first and last bars are complete; line panels use the range as-is.
  const fetchRange = useMemo(
    () => (panel.kind === 'precip' ? snapPrecipRange(range) : range),
    [panel, range],
  )

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(rangeQueryParams(fetchRange))
    for (const metric of panel.metrics) params.append('metric', metric)
    setError(null)
    fetchJson<{ series: ReadingSeries[] }>(`/api/readings?${params}`, { signal: controller.signal })
      .then((res) => setData(res.series))
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError(String(err))
      })
    return () => controller.abort()
  }, [panel, fetchRange])

  const xDomain: [Date, Date] | undefined =
    fetchRange.from && fetchRange.to ? [fetchRange.from, fetchRange.to] : undefined

  if (panel.kind === 'precip') {
    const precip = data ? toPrecipView(data, colorFor, xDomain, latest, range) : null
    return (
      <PanelShell
        panel={panel}
        aside={precip && <PrecipSummary series={precip.series} through={precip.through} />}
        legend={precip?.series.map((s) => ({ ...s, mark: 'bar' as const })) ?? []}
        error={error}
      >
        {precip &&
          (precip.window ? (
            <ParentSize>
              {({ width, height }) => (
                <PrecipChart
                  series={precip.series}
                  granularity={precip.granularity}
                  window={precip.window!}
                  width={width}
                  height={height}
                  through={precip.through}
                />
              )}
            </ParentSize>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">No readings in this range.</p>
          ))}
      </PanelShell>
    )
  }

  if (panel.kind === 'wind_rose') {
    // One rose per device: frequencies from different stations don't add
    // up to anything meaningful when stacked together.
    const roses = data
      ? [...pairWind(data)].sort(([a], [b]) => a.localeCompare(b)).map(([device, obs]) => ({
          device,
          rose: binWind(obs),
        }))
      : []
    const observations = roses.reduce((sum, r) => sum + r.rose.total, 0)
    return (
      <PanelShell
        panel={panel}
        aside={
          data && (
            <p className="text-right text-xs text-gray-500 dark:text-gray-400">
              {observations} observations · center: % calm
            </p>
          )
        }
        legend={SPEED_BANDS.map((b) => ({ key: b.label, label: b.label, color: b.color, mark: 'bar' as const }))}
        error={error}
      >
        {data &&
          (roses.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No readings in this range.</p>
          ) : (
            <div className="flex h-full gap-4">
              {roses.map(({ device, rose }) => (
                <div key={device} className="flex min-w-0 flex-1 flex-col">
                  {roses.length > 1 && <p className="text-center text-xs">{device}</p>}
                  <div className="min-h-0 flex-1">
                    <ParentSize>
                      {({ width, height }) => <WindRoseChart data={rose} width={width} height={height} />}
                    </ParentSize>
                  </div>
                </div>
              ))}
            </div>
          ))}
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
// The bucket size is picked once, from the selected range, and used both to
// widen the fetch and to draw — picking it again from the widened window
// could tip a 72h range just past the hourly limit into daily bars.
function rangeGranularity(range: ResolvedRange): Granularity | null {
  return range.from && range.to ? chooseGranularity(range.to.getTime() - range.from.getTime()) : null
}

function snapPrecipRange(range: ResolvedRange): ResolvedRange {
  const granularity = rangeGranularity(range)
  if (!granularity) return range
  const [from, to] = snapToBuckets([range.from!, range.to!], granularity)
  return { from, to }
}

// For a bounded range, `window` is the already-snapped fetch range; for
// "All" it's undefined and the window comes from the data's own extent.
export function toPrecipView(
  data: ReadingSeries[],
  colorFor: DeviceColors,
  window: [Date, Date] | undefined,
  latest: string | null,
  selectedRange: ResolvedRange = {},
): {
  series: PrecipSeries[]
  granularity: Granularity
  window: [Date, Date] | null
  through: Date | null
} {
  const times = data.flatMap((s) => s.readings.map((r) => new Date(r.recorded_at).getTime()))
  const extent: [Date, Date] | null =
    times.length > 0 ? [new Date(Math.min(...times)), new Date(Math.max(...times) + 1)] : null
  const granularity =
    rangeGranularity(selectedRange) ??
    chooseGranularity(window ? window[1].getTime() - window[0].getTime() : extent ? extent[1].getTime() - extent[0].getTime() : 0)
  const snappedWindow = window ?? (extent ? snapToBuckets(extent, granularity) : null)
  const series = [...data]
    .sort((a, b) => a.device_id.localeCompare(b.device_id))
    .map((s) => ({
      key: `${s.device_id}::${s.metric}`,
      label: s.device_id,
      color: colorFor(s.device_id),
      buckets: bucketPrecip(s.readings, granularity),
    }))
  return {
    series,
    granularity,
    window: snappedWindow,
    through: latest ? archivedThrough(latest) : null,
  }
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
