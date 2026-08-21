import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { scaleLinear, scaleTime } from '@visx/scale'
import { LinePath } from '@visx/shape'
import { extent, max, min } from 'd3-array'

export type Reading = { recorded_at: string; value: number }

const margin = { top: 16, right: 24, bottom: 48, left: 56 }

// Units for the metrics this project actually publishes (see logger.py,
// fake_publisher.py, ec_publisher.py). Metrics with no known unit just
// get their prettified name with no suffix.
const UNITS: Record<string, string> = {
  temperature: '°C',
  dewpoint: '°C',
  humidity: '%',
  pressure: 'hPa',
  visibility: 'km',
  wind_speed: 'km/h',
  wind_gust: 'km/h',
  wind_bearing: '°',
  pm25: 'µg/m³',
  pm10: 'µg/m³',
}

const METRIC_LABELS: Record<string, string> = {
  pm25: 'PM2.5',
  pm10: 'PM10',
}

function prettifyMetric(metric: string): string {
  if (METRIC_LABELS[metric]) return METRIC_LABELS[metric]
  return metric
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function yAxisLabel(metric: string): string {
  if (!metric) return ''
  const unit = UNITS[metric]
  const name = prettifyMetric(metric)
  return unit ? `${name} (${unit})` : name
}

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

  const yScale = scaleLinear({
    domain: [min(parsed, (d) => d.value) ?? 0, max(parsed, (d) => d.value) ?? 1],
    range: [innerHeight, 0],
    nice: true,
  })

  return (
    <svg width={width} height={height}>
      <g transform={`translate(${margin.left},${margin.top})`}>
        <GridRows scale={yScale} width={innerWidth} stroke="currentColor" strokeOpacity={0.15} />
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
          tickLabelProps={() => ({ fill: 'currentColor', fontSize: 11 })}
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
