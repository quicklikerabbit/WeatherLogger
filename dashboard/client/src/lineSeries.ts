import { bisector, extent, median } from "d3-array";
import type { SeriesMark } from "./metrics";

// Data helpers for LineChart, kept out of the component's file so it only
// exports components (which React fast refresh requires).

export type Reading = { recorded_at: string; value: number; quality_flag?: string | null };

export type Point = { date: Date; value: number };

// One line (or set of dots) on the chart. `label` names it in the tooltip
// when the chart has more than one series; the legend lives with whatever
// renders the chart (see Overview.tsx), since a lone series needs none.
export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  mark: SeriesMark;
  points: Point[];
};

export function toPoints(readings: Reading[]): Point[] {
  return readings.map((r) => ({ date: new Date(r.recorded_at), value: r.value }));
}

// A single-reading series gives extent() a zero-width [date, date] range,
// which collapses the time scale. Pad it so the lone point renders
// centered instead of the axis degenerating to a point.
export function computeXDomain(dates: Date[]): [Date, Date] {
  const [minDate, maxDate] = extent(dates) as [Date, Date];
  return minDate.getTime() === maxDate.getTime()
    ? [new Date(minDate.getTime() - 30 * 60 * 1000), new Date(maxDate.getTime() + 30 * 60 * 1000)]
    : [minDate, maxDate];
}

// Points are chronological (the API orders readings by recorded_at ASC), so
// a bisection finds x0's closest point in O(log n) instead of scanning. The
// `.center` variant already picks whichever of the two straddling points is
// nearer, using each Date's valueOf() (its ms timestamp) as the distance.
const bisectDate = bisector<Point, Date>((d) => d.date).center;

export function findClosestPoint(points: Point[], x0: Date): Point {
  return points[bisectDate(points, x0)];
}

// How far apart two consecutive readings can be before the line between
// them is broken: three of the series' own typical intervals. Relative to
// the series rather than a fixed duration, so an hourly EC feed and a
// sensor reporting every few seconds both break only at genuine outages.
export function gapThresholdMs(points: Point[]): number {
  if (points.length < 2) return Infinity;
  const intervals = points.slice(1).map((p, i) => p.date.getTime() - points[i].date.getTime());
  return 3 * (median(intervals) ?? 0);
}

// Splits a series into runs with no gap wider than gapThresholdMs, so a
// line is drawn within each run but never straight across missing data —
// which would otherwise look like a measured, smoothly-changing value.
export function splitAtGaps(points: Point[]): Point[][] {
  if (points.length === 0) return [];
  const threshold = gapThresholdMs(points);
  const runs: Point[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].date.getTime() - points[i - 1].date.getTime() > threshold) runs.push([]);
    runs[runs.length - 1].push(points[i]);
  }
  return runs;
}

export type TooltipRow = { key: string; label: string; color: string; point: Point };
export type TooltipData = { date: Date; rows: TooltipRow[] };

// The hovered moment snaps to whichever series has a reading nearest the
// pointer; every other series then reports its own reading closest to
// that moment — but only if it's within that series' gap threshold, so a
// series with nothing nearby is left out rather than showing a stale value.
export function tooltipAt(series: ChartSeries[], x0: Date): TooltipData | null {
  const candidates = series
    .filter((s) => s.points.length > 0)
    .map((s) => ({ s, point: findClosestPoint(s.points, x0) }));
  if (candidates.length === 0) return null;

  const anchor = candidates.reduce((best, c) =>
    Math.abs(c.point.date.getTime() - x0.getTime()) <
    Math.abs(best.point.date.getTime() - x0.getTime())
      ? c
      : best,
  ).point.date;

  const rows: TooltipRow[] = [];
  for (const { s } of candidates) {
    const point = findClosestPoint(s.points, anchor);
    const tolerance = Math.min(gapThresholdMs(s.points), 90 * 60 * 1000);
    if (Math.abs(point.date.getTime() - anchor.getTime()) <= tolerance) {
      rows.push({ key: s.key, label: s.label, color: s.color, point });
    }
  }
  return { date: anchor, rows };
}
