import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { scaleBand, scaleLinear } from "@visx/scale";
import { Bar, BarGroup } from "@visx/shape";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { max } from "d3-array";
import { margin } from "./chartLayout";
import {
  bucketStartsIn,
  describeFlags,
  formatMm,
  type Granularity,
  type PrecipBucket,
} from "./precip";

export type PrecipSeries = {
  key: string;
  label: string;
  color: string;
  buckets: PrecipBucket[];
};

// One row per bucket in the window, with each series' total under its
// key — the shape BarGroup lays out.
type Row = { start: number } & Record<string, number>;

const hourFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
});
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dayLongFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});

const TARGET_TICKS = 6;

export function PrecipChart({
  series,
  granularity,
  window,
  width,
  height,
  through,
}: {
  series: PrecipSeries[];
  granularity: Granularity;
  // Already snapped to whole buckets (see snapToBuckets).
  window: [Date, Date];
  width: number;
  height: number;
  // End of the last archived hour; buckets from there on are shaded as
  // "not yet archived" so the archive's ~1 day lag doesn't read as dry.
  through: Date | null;
}) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<number>();

  if (width === 0 || height === 0) return null;

  const hasReadings = series.some((s) => s.buckets.length > 0);
  const inLag = through !== null && through < window[1];
  // A window with no readings still gets drawn when it falls in the
  // archive's lag, so it shows as "not yet archived" rather than as a
  // blank "no readings" — the two mean very different things for rain.
  if (!hasReadings && !inLag) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No readings in this range.</p>;
  }

  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const bucketsByKey = new Map(
    series.map((s) => [s.key, new Map(s.buckets.map((b) => [b.start.getTime(), b]))]),
  );
  const starts = bucketStartsIn(window, granularity).map((d) => d.getTime());
  const rows: Row[] = starts.map((start) => {
    const row = { start } as Row;
    for (const s of series) row[s.key] = bucketsByKey.get(s.key)?.get(start)?.total ?? 0;
    return row;
  });
  const keys = series.map((s) => s.key);
  const colorByKey = new Map(series.map((s) => [s.key, s.color]));

  const x0Scale = scaleBand<number>({ domain: starts, range: [0, innerWidth], paddingInner: 0.2 });
  const x1Scale = scaleBand<string>({
    domain: keys,
    range: [0, x0Scale.bandwidth()],
    padding: 0.1,
  });
  const yMax = max(series, (s) => max(s.buckets, (b) => b.total)) ?? 0;
  const yScale = scaleLinear<number>({
    // A dry window still gets a readable 0-1 mm axis instead of a
    // zero-height domain.
    domain: [0, Math.max(yMax, 1)],
    range: [innerHeight, 0],
    nice: true,
  });

  // A band scale ticks every band by default; thin that to a readable count.
  const tickEvery = Math.max(1, Math.ceil(starts.length / TARGET_TICKS));
  const tickValues = starts.filter((_, i) => i % tickEvery === 0);
  const tickFormat = granularity === "hour" ? hourFormat : dayFormat;

  const lagFrom = inLag ? starts.find((t) => t >= through!.getTime()) : undefined;
  const lagX =
    lagFrom !== undefined
      ? Math.max(0, (x0Scale(lagFrom) ?? 0) - (x0Scale.step() * x0Scale.paddingInner()) / 2)
      : null;

  function showColumn(start: number) {
    showTooltip({
      tooltipData: start,
      tooltipLeft: (x0Scale(start) ?? 0) + x0Scale.bandwidth() / 2 + margin.left,
      tooltipTop: margin.top + 8,
    });
  }

  return (
    <div style={{ position: "relative" }}>
      <svg width={width} height={height}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke="currentColor"
            strokeOpacity={0.15}
            numTicks={4}
          />
          {lagX !== null && (
            <g data-testid="not-yet-archived" pointerEvents="none">
              <rect
                x={lagX}
                y={0}
                width={innerWidth - lagX}
                height={innerHeight}
                fill="currentColor"
                fillOpacity={0.06}
              />
              {innerWidth - lagX > 80 && (
                <text x={lagX + 6} y={12} fontSize={11} fill="currentColor" fillOpacity={0.7}>
                  Not yet archived
                </text>
              )}
            </g>
          )}
          <BarGroup
            data={rows}
            keys={keys}
            height={innerHeight}
            x0={(r) => r.start}
            x0Scale={x0Scale}
            x1Scale={x1Scale}
            yScale={yScale}
            color={(key) => colorByKey.get(key) ?? "currentColor"}
          >
            {(groups) =>
              groups.map((group) => (
                <g key={rows[group.index].start} transform={`translate(${group.x0},0)`}>
                  {group.bars.map(
                    (bar) =>
                      bar.value > 0 && (
                        <Bar
                          key={bar.key}
                          data-testid="precip-bar"
                          x={bar.x}
                          y={bar.y}
                          width={bar.width}
                          height={bar.height}
                          // style rather than fill: the color is a CSS
                          // variable, which the fill attribute won't resolve.
                          style={{ fill: bar.color }}
                        />
                      ),
                  )}
                  {/* Hover target: the whole band, full height — a thin or
                      zero-height bar is still easy to point at. */}
                  <rect
                    data-testid="precip-column"
                    width={x0Scale.bandwidth()}
                    height={innerHeight}
                    fill="transparent"
                    onMouseMove={() => showColumn(rows[group.index].start)}
                    onMouseLeave={hideTooltip}
                    onTouchStart={() => showColumn(rows[group.index].start)}
                    onTouchEnd={hideTooltip}
                  />
                </g>
              ))
            }
          </BarGroup>
          <AxisLeft
            scale={yScale}
            numTicks={4}
            stroke="currentColor"
            tickStroke="currentColor"
            tickLabelProps={() => ({ fill: "currentColor", fontSize: 11, dx: "-2em" })}
            label={`Precipitation (mm per ${granularity})`}
            labelProps={{ fill: "currentColor", fontSize: 12, textAnchor: "middle" }}
            labelOffset={36}
          />
          <AxisBottom
            top={innerHeight}
            scale={x0Scale}
            tickValues={tickValues}
            tickFormat={(t) => tickFormat.format(new Date(t))}
            stroke="currentColor"
            tickStroke="currentColor"
            tickLabelProps={() => ({ fill: "currentColor", fontSize: 11, textAnchor: "middle" })}
          />
        </g>
      </svg>
      {tooltipOpen &&
        tooltipData !== undefined &&
        tooltipLeft !== undefined &&
        tooltipTop !== undefined && (
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
              {(granularity === "hour" ? hourFormat : dayLongFormat).format(new Date(tooltipData))}
            </div>
            {series.map((s) => {
              const bucket = bucketsByKey.get(s.key)?.get(tooltipData);
              const flags = bucket ? describeFlags(bucket.flags) : null;
              return (
                <div key={s.key}>
                  <div className="flex items-center gap-1.5">
                    {series.length > 1 && (
                      <>
                        <span
                          aria-hidden
                          className="inline-block h-2 w-2 rounded-sm"
                          style={{ background: s.color }}
                        />
                        <span>{s.label}</span>
                      </>
                    )}
                    <span data-testid="precip-tooltip-value" className="font-medium">
                      {bucket ? formatMm(bucket.total) : "No data"}
                    </span>
                    {flags && <span className="text-gray-500 dark:text-gray-400">({flags})</span>}
                  </div>
                  {bucket &&
                    bucket.hoursReported < bucket.hoursInBucket &&
                    granularity === "day" && (
                      <div className="text-gray-500 dark:text-gray-400">
                        {bucket.hoursReported} of {bucket.hoursInBucket} h reported
                      </div>
                    )}
                </div>
              );
            })}
          </TooltipWithBounds>
        )}
    </div>
  );
}
