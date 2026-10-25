import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { scaleLinear, scaleTime } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { max, min } from "d3-array";
import { useRef } from "react";
import { margin } from "./chartLayout";
import {
  type ChartSeries,
  computeXDomain,
  splitAtGaps,
  type TooltipData,
  tooltipAt,
} from "./lineSeries";
import {
  metricFirmMax,
  metricInitialMax,
  metricStartAtZero,
  metricTickStep,
  metricUnit,
  yAxisLabel,
} from "./metrics";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function formatValue(value: number, unit: string | undefined) {
  return `${Math.round(value * 10) / 10}${unit ? ` ${unit}` : ""}`;
}

export function LineChart({
  series,
  width,
  height,
  metric,
  yLabel,
  xDomain,
}: {
  series: ChartSeries[];
  width: number;
  height: number;
  // Drives the y-axis scale config (startAtZero, initialMax...) and unit;
  // for a multi-metric panel, its first metric.
  metric?: string;
  // Overrides the y-axis label derived from `metric`.
  yLabel?: string;
  // The selected time window. When given, the axis spans the whole window
  // instead of shrinking to the data's extent, so a gap at either end
  // (e.g. precipitation's archive lag) shows as a gap.
  xDomain?: [Date, Date];
}) {
  // Hooks must run unconditionally, ahead of the early returns below.
  const svgRef = useRef<SVGSVGElement>(null);
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  if (width === 0 || height === 0) return null;

  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No readings in this range.</p>;
  }

  const xScale = scaleTime({
    domain: xDomain ?? computeXDomain(allPoints.map((d) => d.date)),
    range: [0, innerWidth],
  });

  // Anchoring the domain at 0 keeps the axis from exaggerating small
  // fluctuations by auto-scaling to the data's tight range — but not every
  // metric wants that (see metrics.ts for exceptions like pressure).
  const dataMin = min(allPoints, (d) => d.value) ?? 0;
  const dataMax = max(allPoints, (d) => d.value) ?? 1;
  const startAtZero = metric ? metricStartAtZero(metric) : true;
  const initialMax = metric ? metricInitialMax(metric) : undefined;
  const domainMax = initialMax !== undefined ? Math.max(dataMax, initialMax) : dataMax;
  const domainMin = startAtZero ? Math.min(0, dataMin) : dataMin;
  const firmMax = metric ? metricFirmMax(metric) : false;
  const yScale = scaleLinear({
    domain: [domainMin, domainMax],
    range: [innerHeight, 0],
    // "nice" rounds the domain out to cleaner tick boundaries, but for a
    // firmMax metric the resolved max is already exact (e.g. 360° for wind
    // bearing) — niceing it would just round a correct bound into a wrong one.
    nice: !firmMax,
  });

  // d3's automatic tick step targets a tick *count*, not the domain's exact
  // endpoints, so it can stop short of a firmMax (see metrics.ts). A metric
  // with an explicit tickStep gets its ticks built by hand instead, walking
  // from the domain min to max so the max always gets a tick of its own.
  const tickStep = metric ? metricTickStep(metric) : undefined;
  const tickValues = tickStep
    ? Array.from(
        { length: Math.round((domainMax - domainMin) / tickStep) + 1 },
        (_, i) => domainMin + i * tickStep,
      )
    : undefined;

  const unit = metric ? metricUnit(metric) : undefined;
  const multiSeries = series.length > 1;

  function handlePointerMove(
    event: React.MouseEvent<SVGRectElement> | React.TouchEvent<SVGRectElement>,
  ) {
    const svg = svgRef.current;
    const source = "touches" in event ? event.touches[0] : event;
    if (!svg || !source) return;

    const { left, top } = svg.getBoundingClientRect();
    const x = source.clientX - left - margin.left;
    const data = tooltipAt(series, xScale.invert(x));
    if (!data || data.rows.length === 0) {
      hideTooltip();
      return;
    }

    showTooltip({
      tooltipData: data,
      tooltipLeft: xScale(data.date) + margin.left,
      // A lone series anchors the tooltip to its point; several share one
      // tooltip, so it follows the pointer instead of any one line.
      tooltipTop: multiSeries
        ? source.clientY - top
        : yScale(data.rows[0].point.value) + margin.top,
    });
  }

  return (
    <div style={{ position: "relative" }}>
      <svg ref={svgRef} width={width} height={height}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            tickValues={tickValues}
            stroke="currentColor"
            strokeOpacity={0.15}
          />
          {series.map((s) => (
            <g key={s.key} data-testid={`series-${s.key}`}>
              {s.mark === "dots"
                ? s.points.map((p) => (
                    <circle
                      key={p.date.getTime()}
                      cx={xScale(p.date)}
                      cy={yScale(p.value)}
                      r={4}
                      style={{ fill: s.color, stroke: "var(--chart-surface)" }}
                      strokeWidth={2}
                    />
                  ))
                : splitAtGaps(s.points).map((run) =>
                    // A run of one has no neighbor to draw a line to; a dot
                    // keeps an isolated reading visible instead of dropping it.
                    run.length === 1 ? (
                      <circle
                        key={run[0].date.getTime()}
                        cx={xScale(run[0].date)}
                        cy={yScale(run[0].value)}
                        r={2.5}
                        style={{ fill: s.color }}
                      />
                    ) : (
                      <LinePath
                        key={run[0].date.getTime()}
                        data={run}
                        x={(d) => xScale(d.date) ?? 0}
                        y={(d) => yScale(d.value) ?? 0}
                        style={{ stroke: s.color }}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        strokeDasharray={s.mark === "dashed" ? "6,4" : undefined}
                      />
                    ),
                  )}
            </g>
          ))}
          <AxisLeft
            scale={yScale}
            stroke="currentColor"
            tickStroke="currentColor"
            tickValues={tickValues}
            tickLabelProps={() => ({ fill: "currentColor", fontSize: 11, dx: "-2em" })}
            label={yLabel ?? (metric ? yAxisLabel(metric) : undefined)}
            labelProps={{ fill: "currentColor", fontSize: 12, textAnchor: "middle" }}
            labelOffset={36}
          />
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={5}
            label="Time"
            labelProps={{ fill: "currentColor", fontSize: 12, textAnchor: "middle" }}
            labelOffset={12}
            stroke="currentColor"
            tickStroke="currentColor"
            tickLabelProps={() => ({ fill: "currentColor", fontSize: 11 })}
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
              />
              {tooltipData.rows.map((row) => (
                <circle
                  key={row.key}
                  cx={xScale(row.point.date)}
                  cy={yScale(row.point.value)}
                  r={4}
                  style={{ fill: row.color, stroke: "var(--chart-surface)" }}
                  strokeWidth={2}
                />
              ))}
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
          {tooltipData.rows.map((row) => (
            <div key={row.key} className="flex items-center gap-1.5">
              {multiSeries && (
                <>
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: row.color }}
                  />
                  <span>{row.label}</span>
                </>
              )}
              <span data-testid="tooltip-value" className="font-medium">
                {formatValue(row.point.value, unit)}
              </span>
            </div>
          ))}
          <div className="text-gray-500 dark:text-gray-400">
            {dateFormat.format(tooltipData.date)}
          </div>
        </TooltipWithBounds>
      )}
    </div>
  );
}
