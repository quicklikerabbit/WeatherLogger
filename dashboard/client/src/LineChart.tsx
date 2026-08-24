import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { scaleLinear, scaleTime } from '@visx/scale'
import { LinePath } from '@visx/shape'
import { TooltipWithBounds, useTooltip } from '@visx/tooltip'
import { bisector, extent, max, min } from 'd3-array'
import { useRef } from 'react'
import {
  metricFirmMax,
  metricInitialMax,
  metricStartAtZero,
  metricTickStep,
  metricUnit,
  yAxisLabel,
} from './metrics'

export type Reading = { recorded_at: string; value: number }

export type Point = { date: Date; value: number }

// Exported so tests can translate a target data point into the client
// coordinates a real pointer event would carry, without duplicating this
// component's internal layout math.
export const margin = { top: 16, right: 24, bottom: 48, left: 56 }

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

// A single-reading series gives extent() a zero-width [date, date] range,
// which collapses the time scale. Pad it so the lone point renders
// centered instead of the axis degenerating to a point.
export function computeXDomain(dates: Date[]): [Date, Date] {
  const [minDate, maxDate] = extent(dates) as [Date, Date]
  return minDate.getTime() === maxDate.getTime()
    ? [new Date(minDate.getTime() - 30 * 60 * 1000), new Date(maxDate.getTime() + 30 * 60 * 1000)]
    : [minDate, maxDate]
}

// Points are chronological (the API orders readings by recorded_at ASC), so
// a bisection finds x0's closest point in O(log n) instead of scanning. The
// `.center` variant already picks whichever of the two straddling points is
// nearer, using each Date's valueOf() (its ms timestamp) as the distance.
const bisectDate = bisector<Point, Date>((d) => d.date).center

export function findClosestPoint(points: Point[], x0: Date): Point {
  return points[bisectDate(points, x0)]
}

export function LineChart({
  readings,
  width,
  height,
  metric,
}: {
  readings: Reading[]
  width: number
  height: number
  metric?: string
}) {
  // Hooks must run unconditionally, ahead of the early returns below.
  const svgRef = useRef<SVGSVGElement>(null)
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<Point>()

  if (width === 0 || height === 0) return null

  const innerWidth = width - margin.left - margin.right
  const innerHeight = height - margin.top - margin.bottom

  const parsed: Point[] = readings.map((r) => ({
    date: new Date(r.recorded_at),
    value: r.value,
  }))

  if (parsed.length === 0) {
    return <p>No readings for this selection.</p>
  }

  const xScale = scaleTime({
    domain: computeXDomain(parsed.map((d) => d.date)),
    range: [0, innerWidth],
  })

  // Anchoring the domain at 0 keeps the axis from exaggerating small
  // fluctuations by auto-scaling to the data's tight range — but not every
  // metric wants that (see metrics.ts for exceptions like pressure).
  const dataMin = min(parsed, (d) => d.value) ?? 0
  const dataMax = max(parsed, (d) => d.value) ?? 1
  const startAtZero = metric ? metricStartAtZero(metric) : true
  const initialMax = metric ? metricInitialMax(metric) : undefined
  const domainMax = initialMax !== undefined ? Math.max(dataMax, initialMax) : dataMax
  const domainMin = startAtZero ? Math.min(0, dataMin) : dataMin
  const firmMax = metric ? metricFirmMax(metric) : false
  const yScale = scaleLinear({
    domain: [domainMin, domainMax],
    range: [innerHeight, 0],
    // "nice" rounds the domain out to cleaner tick boundaries, but for a
    // firmMax metric the resolved max is already exact (e.g. 360° for wind
    // bearing) — niceing it would just round a correct bound into a wrong one.
    nice: !firmMax,
  })

  // d3's automatic tick step targets a tick *count*, not the domain's exact
  // endpoints, so it can stop short of a firmMax (see metrics.ts). A metric
  // with an explicit tickStep gets its ticks built by hand instead, walking
  // from the domain min to max so the max always gets a tick of its own.
  const tickStep = metric ? metricTickStep(metric) : undefined
  const tickValues = tickStep
    ? Array.from(
        { length: Math.round((domainMax - domainMin) / tickStep) + 1 },
        (_, i) => domainMin + i * tickStep,
      )
    : undefined

  const unit = metric ? metricUnit(metric) : undefined

  function handlePointerMove(
    event: React.MouseEvent<SVGRectElement> | React.TouchEvent<SVGRectElement>,
  ) {
    const svg = svgRef.current
    const source = 'touches' in event ? event.touches[0] : event
    if (!svg || !source) return

    const { left } = svg.getBoundingClientRect()
    const x = source.clientX - left - margin.left
    const closest = findClosestPoint(parsed, xScale.invert(x))

    showTooltip({
      tooltipData: closest,
      tooltipLeft: xScale(closest.date) + margin.left,
      tooltipTop: yScale(closest.value) + margin.top,
    })
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={svgRef} width={width} height={height}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            tickValues={tickValues}
            stroke="currentColor"
            strokeOpacity={0.15}
          />
          <LinePath
            data={parsed}
            x={(d) => xScale(d.date) ?? 0}
            y={(d) => yScale(d.value) ?? 0}
            stroke="#2563eb"
            strokeWidth={2}
          />
          <AxisLeft
            scale={yScale}
            stroke="currentColor"
            tickStroke="currentColor"
            tickValues={tickValues}
            tickLabelProps={() => ({ fill: 'currentColor', fontSize: 11, dx: '-2em' })}
            label={metric ? yAxisLabel(metric) : undefined}
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
          {tooltipOpen && tooltipData && (
            <g pointerEvents="none">
              <line
                x1={xScale(tooltipData.date)}
                x2={xScale(tooltipData.date)}
                y1={0}
                y2={innerHeight}
                stroke="currentColor"
                strokeOpacity={0.3}
                strokeDasharray="4,2"
              />
              <circle
                cx={xScale(tooltipData.date)}
                cy={yScale(tooltipData.value)}
                r={4}
                fill="#2563eb"
                stroke="white"
                strokeWidth={1.5}
              />
            </g>
          )}
          {/* Transparent hit-target for the tooltip, on top so it always
              receives the pointer events instead of the line/gridlines. */}
          <rect
            data-testid="line-chart-overlay"
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handlePointerMove}
            onMouseLeave={hideTooltip}
            onTouchStart={handlePointerMove}
            onTouchMove={handlePointerMove}
            onTouchEnd={hideTooltip}
          />
        </g>
      </svg>
      {tooltipOpen && tooltipData && tooltipLeft !== undefined && tooltipTop !== undefined && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          offsetLeft={12}
          offsetTop={-12}
          unstyled
          applyPositionStyle
          className="pointer-events-none rounded border border-gray-300 bg-white px-2 py-1 text-xs whitespace-nowrap text-gray-700 shadow dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
        >
          <div data-testid="tooltip-value" className="font-medium">
            {Math.round(tooltipData.value * 10) / 10}
            {unit ? ` ${unit}` : ''}
          </div>
          <div className="text-gray-500 dark:text-gray-400">{dateFormat.format(tooltipData.date)}</div>
        </TooltipWithBounds>
      )}
    </div>
  )
}
