import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { scaleLinear, scaleTime } from '@visx/scale'
import { LinePath } from '@visx/shape'
import { extent, max, min } from 'd3-array'

export type Reading = { recorded_at: string; value: number }

const margin = { top: 16, right: 24, bottom: 32, left: 48 }

export function LineChart({
  readings,
  width,
  height,
}: {
  readings: Reading[]
  width: number
  height: number
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

  const [minDate, maxDate] = extent(parsed, (d) => d.date) as [Date, Date]
  // A single-reading series gives extent() a zero-width [date, date] range,
  // which collapses the time scale. Pad it so the lone point renders
  // centered instead of the axis degenerating to a point.
  const xDomain: [Date, Date] =
    minDate.getTime() === maxDate.getTime()
      ? [new Date(minDate.getTime() - 30 * 60 * 1000), new Date(maxDate.getTime() + 30 * 60 * 1000)]
      : [minDate, maxDate]

  const xScale = scaleTime({
    domain: xDomain,
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
        />
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          numTicks={5}
          stroke="currentColor"
          tickStroke="currentColor"
          tickLabelProps={() => ({ fill: 'currentColor', fontSize: 11 })}
        />
      </g>
    </svg>
  )
}
