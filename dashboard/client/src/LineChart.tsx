import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { scaleLinear, scaleTime } from '@visx/scale'
import { LinePath } from '@visx/shape'
import { extent, max, min } from 'd3-array'
import { metricFirmMax, metricInitialMax, metricStartAtZero, metricTickStep, yAxisLabel } from './metrics'

export type Reading = { recorded_at: string; value: number }

const margin = { top: 16, right: 24, bottom: 48, left: 56 }

// A single-reading series gives extent() a zero-width [date, date] range,
// which collapses the time scale. Pad it so the lone point renders
// centered instead of the axis degenerating to a point.
export function computeXDomain(dates: Date[]): [Date, Date] {
  const [minDate, maxDate] = extent(dates) as [Date, Date]
  return minDate.getTime() === maxDate.getTime()
    ? [new Date(minDate.getTime() - 30 * 60 * 1000), new Date(maxDate.getTime() + 30 * 60 * 1000)]
    : [minDate, maxDate]
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
  if (width === 0 || height === 0) return null

  const innerWidth = width - margin.left - margin.right
  const innerHeight = height - margin.top - margin.bottom

  const parsed = readings.map((r) => ({
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

  return (
    <svg width={width} height={height}>
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
      </g>
    </svg>
  )
}
