import { GridRadial } from "@visx/grid";
import { scaleRadial } from "@visx/scale";
import { Arc } from "@visx/shape";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { max } from "d3-array";
import { percent, SECTOR_DEGREES, SPEED_BANDS, type WindRoseData } from "./windRose";

// Room outside the rose for the N/E/S/W labels.
const LABEL_MARGIN = 18;
// Hole in the middle for the calm percentage.
const INNER_RADIUS = 16;
const COMPASS = [
  { label: "N", angle: 0 },
  { label: "E", angle: 90 },
  { label: "S", angle: 180 },
  { label: "W", angle: 270 },
];

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

function formatPercent(value: number) {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

export function WindRoseChart({
  data,
  width,
  height,
}: {
  data: WindRoseData;
  width: number;
  height: number;
}) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<number>();

  if (width === 0 || height === 0) return null;
  if (data.total === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No readings in this range.</p>;
  }

  const radius = Math.min(width, height) / 2 - LABEL_MARGIN;
  const cx = width / 2;
  const cy = height / 2;

  const sectorTotals = data.sectors.map((s) => s.counts.reduce((a, b) => a + b, 0));
  const maxPercent = Math.max(percent(max(sectorTotals) ?? 0, data.total), 1);
  // scaleRadial makes a wedge's *area* proportional to its share, so a
  // sector twice as frequent doesn't look four times as big.
  const rScale = scaleRadial<number>({
    domain: [0, maxPercent],
    range: [INNER_RADIUS, radius],
    nice: true,
  });
  const rings = rScale.ticks(3).filter((t) => t > 0);

  // Arc's angles run clockwise from 12 o'clock, the same as a compass
  // bearing, so a sector's angle is just its bearing in radians.
  const half = toRadians(SECTOR_DEGREES / 2);

  return (
    <div style={{ position: "relative" }}>
      <svg width={width} height={height} role="img" aria-label="Wind rose">
        <g transform={`translate(${cx},${cy})`}>
          <GridRadial
            scale={rScale}
            tickValues={rings}
            stroke="currentColor"
            strokeOpacity={0.15}
          />
          {rings.map((t) => (
            // Ring values sit just clockwise of north, between N and NNE.
            <text
              key={t}
              x={rScale(t) * Math.sin(half) + 2}
              y={-rScale(t) * Math.cos(half)}
              fontSize={10}
              fill="currentColor"
              fillOpacity={0.6}
            >
              {formatPercent(t)}
            </text>
          ))}
          {data.sectors.map((sector, i) => {
            const center = toRadians(i * SECTOR_DEGREES);
            let cumulative = 0;
            return (
              <g key={sector.label} data-testid="wind-sector">
                {sector.counts.map((count, band) => {
                  if (count === 0) return null;
                  const inner = rScale(percent(cumulative, data.total));
                  cumulative += count;
                  const outer = rScale(percent(cumulative, data.total));
                  return (
                    <Arc
                      key={band}
                      data-testid="wind-arc"
                      innerRadius={inner}
                      outerRadius={outer}
                      startAngle={center - half}
                      endAngle={center + half}
                      padAngle={0.03}
                      style={{ fill: SPEED_BANDS[band].color }}
                    />
                  );
                })}
                {/* Hover target: the whole wedge out to the edge, so a short
                    or empty sector is as easy to point at as a long one. */}
                <Arc
                  data-testid="wind-sector-target"
                  innerRadius={INNER_RADIUS}
                  outerRadius={radius}
                  startAngle={center - half}
                  endAngle={center + half}
                  fill="transparent"
                  onMouseMove={() => {
                    const r = (INNER_RADIUS + radius) / 2;
                    showTooltip({
                      tooltipData: i,
                      tooltipLeft: cx + r * Math.sin(center),
                      tooltipTop: cy - r * Math.cos(center),
                    });
                  }}
                  onMouseLeave={hideTooltip}
                />
              </g>
            );
          })}
          {COMPASS.map(({ label, angle }) => {
            const r = radius + LABEL_MARGIN / 2 + 2;
            return (
              <text
                key={label}
                x={r * Math.sin(toRadians(angle))}
                y={-r * Math.cos(toRadians(angle))}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fill="currentColor"
              >
                {label}
              </text>
            );
          })}
          <text
            data-testid="wind-calm"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={10}
            fill="currentColor"
            fillOpacity={0.7}
          >
            {formatPercent(percent(data.calm, data.total))}
          </text>
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
            offsetTop={-12}
            unstyled
            applyPositionStyle
            className="pointer-events-none rounded border border-gray-300 bg-white px-2 py-1 text-xs whitespace-nowrap text-gray-700 shadow dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          >
            <div className="font-medium" data-testid="wind-tooltip-heading">
              From {data.sectors[tooltipData].label} ·{" "}
              {formatPercent(percent(sectorTotals[tooltipData], data.total))}
            </div>
            {SPEED_BANDS.map((band, i) => {
              const count = data.sectors[tooltipData].counts[i];
              if (count === 0) return null;
              return (
                <div key={band.label} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ background: band.color }}
                  />
                  <span>{band.label}</span>
                  <span className="font-medium">{formatPercent(percent(count, data.total))}</span>
                </div>
              );
            })}
            <div className="text-gray-500 dark:text-gray-400">
              {sectorTotals[tooltipData]} of {data.total} observations
            </div>
          </TooltipWithBounds>
        )}
    </div>
  );
}
