import type { ChartSeries, Reading } from "./lineSeries";
import { toPoints } from "./lineSeries";
import { metricMark, type PanelConfig, prettifyMetric } from "./metrics";
import {
  archivedThrough,
  bucketPrecip,
  chooseGranularity,
  type Granularity,
  snapToBuckets,
} from "./precip";
import type { PrecipSeries } from "./PrecipChart";
import type { DeviceColors } from "./seriesColors";
import type { ResolvedRange } from "./timeRange";

// Shapes the API's readings into what each overview panel draws. Kept out
// of Overview.tsx so that file only exports components (which React fast
// refresh requires).

export type ReadingSeries = {
  device_id: string;
  metric: string;
  readings: Reading[];
};

// Turns the API's per-device/metric series into chart series. Labels name
// only what varies within the panel: the metric when there's one device,
// the device when there's one metric, both when neither is unique.
export function toChartSeries(
  panel: PanelConfig,
  data: ReadingSeries[],
  colorFor: DeviceColors,
): ChartSeries[] {
  const devices = new Set(data.map((s) => s.device_id));
  const metrics = new Set(data.map((s) => s.metric));
  const metricOrder = (m: string) => panel.metrics.indexOf(m);

  return [...data]
    .sort(
      (a, b) =>
        a.device_id.localeCompare(b.device_id) || metricOrder(a.metric) - metricOrder(b.metric),
    )
    .map((s) => {
      const metricName = prettifyMetric(s.metric);
      const label =
        devices.size > 1 && metrics.size > 1
          ? `${metricName} · ${s.device_id}`
          : devices.size > 1
            ? s.device_id
            : metricName;
      return {
        key: `${s.device_id}::${s.metric}`,
        label,
        color: colorFor(s.device_id),
        mark: metricMark(s.metric),
        points: toPoints(s.readings),
      };
    });
}

// The bucket size is picked once, from the selected range, and used both to
// widen the fetch and to draw — picking it again from the widened window
// could tip a 72h range just past the hourly limit into daily bars.
function rangeGranularity(range: ResolvedRange): Granularity | null {
  return range.from && range.to
    ? chooseGranularity(range.to.getTime() - range.from.getTime())
    : null;
}

// Precipitation fetches whole hours/days (see snapToBuckets) so its first
// and last bars are complete.
export function snapPrecipRange(range: ResolvedRange): ResolvedRange {
  const granularity = rangeGranularity(range);
  if (!granularity) return range;
  const [from, to] = snapToBuckets([range.from!, range.to!], granularity);
  return { from, to };
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
  series: PrecipSeries[];
  granularity: Granularity;
  window: [Date, Date] | null;
  through: Date | null;
} {
  const times = data.flatMap((s) => s.readings.map((r) => new Date(r.recorded_at).getTime()));
  const extent: [Date, Date] | null =
    times.length > 0 ? [new Date(Math.min(...times)), new Date(Math.max(...times) + 1)] : null;
  const granularity =
    rangeGranularity(selectedRange) ??
    chooseGranularity(
      window
        ? window[1].getTime() - window[0].getTime()
        : extent
          ? extent[1].getTime() - extent[0].getTime()
          : 0,
    );
  const snappedWindow = window ?? (extent ? snapToBuckets(extent, granularity) : null);
  const series = [...data]
    .sort((a, b) => a.device_id.localeCompare(b.device_id))
    .map((s) => ({
      key: `${s.device_id}::${s.metric}`,
      label: s.device_id,
      color: colorFor(s.device_id),
      buckets: bucketPrecip(s.readings, granularity),
    }));
  return {
    series,
    granularity,
    window: snappedWindow,
    through: latest ? archivedThrough(latest) : null,
  };
}
