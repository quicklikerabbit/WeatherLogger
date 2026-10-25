import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { scaleLinear, scaleTime } from '@visx/scale'
import { TooltipWithBounds, useTooltip } from '@visx/tooltip'
import { max } from 'd3-array'
import { useId } from 'react'
import { margin } from './LineChart'
import { describeFlags, formatMm, type Granularity, type PrecipBucket } from './precip'

export type PrecipSeries = {
  key: string
  label: string
  color: string
  buckets: PrecipBucket[]
}

const BAR_MAX_WIDTH = 24
const BAR_GAP = 2
const BAR_RADIUS = 4

const hourFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })
const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

// A column with a rounded data-end and a square base, so every bar grows
// from the same flat baseline.
export function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(BAR_RADIUS, width / 2, height)
  const bottom = y + height
  return [
    `M${x},${bottom}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + width - r}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `V${bottom}`,
    'Z',
  ].join(' ')
}

type Column = { start: Date; end: Date; entries: { series: PrecipSeries; bucket: PrecipBucket }[] }

// One hover column per bucket that any series has data for, holding each
// series' bucket for that slot — the unit the tooltip reports on.
function columnsOf(series: PrecipSeries[]): Column[] {
  const columns = new Map<number, Column>()
  for (const s of series) {
    for (const bucket of s.buckets) {
      const key = bucket.start.getTime()
      if (!columns.has(key)) columns.set(key, { start: bucket.start, end: bucket.end, entries: [] })
      columns.get(key)!.entries.push({ series: s, bucket })
    }
  }
  return [...columns.values()].sort((a, b) => a.start.getTime() - b.start.getTime())
}

export function PrecipChart({
  series,
  granularity,
  width,
  height,
  xDomain,
  through,
}: {
  series: PrecipSeries[]
  granularity: Granularity
  width: number
  height: number
  xDomain?: [Date, Date]
  // End of the last archived hour; the window past it is shaded as "not
  // yet archived" so the archive's ~1 day lag doesn't read as a dry spell.
  through: Date | null
}) {
  const patternId = useId()
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<Column>()

  if (width === 0 || height === 0) return null

  const columns = columnsOf(series)
  const domain: [Date, Date] | null =
    xDomain ?? (columns.length > 0 ? [columns[0].start, columns[columns.length - 1].end] : null)
  // A window with no readings still gets drawn when it falls in the
  // archive's lag, so it shows as "not yet archived" rather than as a
  // blank "no readings" — the two mean very different things for rain.
  if (!domain || (columns.length === 0 && !(through && through < domain[1]))) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No readings in this range.</p>
  }

  const innerWidth = width - margin.left - margin.right
  const innerHeight = height - margin.top - margin.bottom

  const xScale = scaleTime({ domain, range: [0, innerWidth] })
  const yMax = max(columns, (c) => max(c.entries, (e) => e.bucket.total)) ?? 0
  const yScale = scaleLinear({
    // A dry window still gets a readable 0-1 mm axis instead of a
    // zero-height domain.
    domain: [0, Math.max(yMax, 1)],
    range: [innerHeight, 0],
    nice: true,
  })

  const seriesIndex = new Map(series.map((s, i) => [s.key, i]))
  const lagStart = through && through < domain[1] ? Math.max(0, xScale(through)) : null

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height}>
        <defs>
          {/* Hatching for flagged (trace/estimated) bars: surface-colored
              diagonals over the bar's own fill, so the bar keeps its
              series color but reads as qualified. */}
          <pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={6} style={{ stroke: 'var(--chart-surface)' }} strokeWidth={2} />
          </pattern>
        </defs>
        <g transform={`translate(${margin.left},${margin.top})`}>
          <GridRows scale={yScale} width={innerWidth} stroke="currentColor" strokeOpacity={0.15} numTicks={4} />
          {lagStart !== null && (
            <g data-testid="not-yet-archived" pointerEvents="none">
              <rect
                x={lagStart}
                y={0}
                width={innerWidth - lagStart}
                height={innerHeight}
                fill="currentColor"
                fillOpacity={0.06}
              />
              {innerWidth - lagStart > 80 && (
                <text x={lagStart + 6} y={12} fontSize={11} fill="currentColor" fillOpacity={0.7}>
                  Not yet archived
                </text>
              )}
            </g>
          )}
          {columns.map((column) => {
            const x0 = xScale(column.start)
            const slot = Math.max(1, xScale(column.end) - x0)
            const barWidth = Math.max(
              1,
              Math.min(BAR_MAX_WIDTH, (slot - BAR_GAP) / series.length - (series.length > 1 ? BAR_GAP : 0)),
            )
            const groupWidth = barWidth * series.length + BAR_GAP * (series.length - 1)
            const groupX = x0 + (slot - groupWidth) / 2
            return (
              <g key={column.start.getTime()}>
                {column.entries.map(({ series: s, bucket }) => {
                  if (bucket.total <= 0) return null
                  const i = seriesIndex.get(s.key) ?? 0
                  const x = groupX + i * (barWidth + BAR_GAP)
                  const y = yScale(bucket.total)
                  const d = barPath(x, y, barWidth, innerHeight - y)
                  return (
                    <g key={s.key} data-testid="precip-bar">
                      <path d={d} style={{ fill: s.color }} />
                      {bucket.flags.length > 0 && <path d={d} fill={`url(#${patternId})`} />}
                    </g>
                  )
                })}
                {/* Hover target: the whole column, full height — a thin or
                    zero-height bar is still easy to point at. */}
                <rect
                  data-testid="precip-column"
                  x={x0}
                  y={0}
                  width={slot}
                  height={innerHeight}
                  fill="transparent"
                  onMouseMove={() =>
                    showTooltip({
                      tooltipData: column,
                      tooltipLeft: x0 + slot / 2 + margin.left,
                      tooltipTop: margin.top + 8,
                    })
                  }
                  onMouseLeave={hideTooltip}
                  onTouchStart={() =>
                    showTooltip({
                      tooltipData: column,
                      tooltipLeft: x0 + slot / 2 + margin.left,
                      tooltipTop: margin.top + 8,
                    })
                  }
                  onTouchEnd={hideTooltip}
                />
              </g>
            )
          })}
          <AxisLeft
            scale={yScale}
            numTicks={4}
            stroke="currentColor"
            tickStroke="currentColor"
            tickLabelProps={() => ({ fill: 'currentColor', fontSize: 11, dx: '-2em' })}
            label={`Precipitation (mm per ${granularity})`}
            labelProps={{ fill: 'currentColor', fontSize: 12, textAnchor: 'middle' }}
            labelOffset={36}
          />
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={5}
            label="Time"
            labelProps={{ fill: 'currentColor', fontSize: 12, textAnchor: 'middle' }}
            labelOffset={12}
            stroke="currentColor"
            tickStroke="currentColor"
            tickLabelProps={() => ({ fill: 'currentColor', fontSize: 11 })}
          />
        </g>
      </svg>
      {tooltipOpen && tooltipData && tooltipLeft !== undefined && tooltipTop !== undefined && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          offsetLeft={12}
          offsetTop={0}
          unstyled
          applyPositionStyle
          className="pointer-events-none rounded border border-gray-300 bg-white px-2 py-1 text-xs whitespace-nowrap text-gray-700 shadow dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
        >
          <div className="text-gray-500 dark:text-gray-400">
            {(granularity === 'hour' ? hourFormat : dayFormat).format(tooltipData.start)}
          </div>
          {tooltipData.entries.map(({ series: s, bucket }) => {
            const flags = describeFlags(bucket.flags)
            const partial = bucket.hoursReported < bucket.hoursInBucket
            return (
              <div key={s.key}>
                <div className="flex items-center gap-1.5">
                  {series.length > 1 && (
                    <>
                      <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
                      <span>{s.label}</span>
                    </>
                  )}
                  <span data-testid="precip-tooltip-value" className="font-medium">
                    {formatMm(bucket.total)}
                  </span>
                  {flags && <span className="text-gray-500 dark:text-gray-400">({flags})</span>}
                </div>
                {partial && granularity === 'day' && (
                  <div className="text-gray-500 dark:text-gray-400">
                    {bucket.hoursReported} of {bucket.hoursInBucket} h reported
                  </div>
                )}
              </div>
            )
          })}
        </TooltipWithBounds>
      )}
    </div>
  )
}
