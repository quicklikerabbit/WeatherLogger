// Per-metric display config for the metrics this project actually publishes
// (see logger.py, fake_publisher.py, ec_publisher.py). Add a new metric here
// and every chart picks it up — this is the one place to edit.
export type MetricConfig = {
  // Shown in the y-axis label as "Name (unit)". Omit for a unitless metric.
  unit?: string
  // Overrides the auto-prettified name (snake_case -> Title Case) when that
  // doesn't read well, e.g. "pm25" -> "PM2.5" instead of "Pm25".
  label?: string
  // Whether the y-axis domain should include 0. True is the right default
  // for most metrics (precipitation, humidity, wind...) since they can't go
  // negative and a 0 baseline avoids exaggerating small fluctuations. Set to
  // false for a metric whose meaningful range sits far from 0, where forcing
  // a 0 baseline would flatten the chart into an unreadable sliver.
  startAtZero?: boolean
  // Floor for the axis's max on first load: the chart shows at least this
  // much range even if the loaded data doesn't reach it (e.g. wind bearing
  // is 0-360° regardless of what the last few readings happened to hit).
  // The axis still grows past it if the data's own max is larger.
  initialMax?: number
  // If true, don't let d3's "nice" rounding round the axis max up past
  // initialMax/the data max to a rounder-looking number (e.g. 360 -> 400).
  // Only relevant when the resolved max is already a meaningful, exact
  // bound — like wind bearing's 0-360° compass — rather than an arbitrary
  // data value that benefits from being rounded to a cleaner tick.
  firmMax?: boolean
  // Explicit spacing between axis ticks, in the metric's own units. d3's
  // automatic tick step is chosen to hit a target *count*, not to land on
  // the domain's exact endpoints — for wind bearing's 0-360 range it picks
  // a step of 50, whose ticks stop at 350 and never draw one at the firm
  // max itself. A step that evenly divides the range (90, one per compass
  // point) guarantees a tick lands exactly on it.
  tickStep?: number
}

const DEFAULT_START_AT_ZERO = true

export const METRICS: Record<string, MetricConfig> = {
  temperature: { unit: '°C' },
  dewpoint: { unit: '°C' },
  humidity: { unit: '%' },
  pressure: { unit: 'hPa', startAtZero: false },
  visibility: { unit: 'km' },
  wind_speed: { unit: 'km/h' },
  wind_gust: { unit: 'km/h' },
  wind_bearing: { unit: '°', initialMax: 360, firmMax: true, tickStep: 90 },
  pm25: { unit: 'µg/m³', label: 'PM2.5' },
  pm10: { unit: 'µg/m³', label: 'PM10' },
  precipitation_mm: { unit: 'mm', label: 'Precipitation' },
}

export function metricStartAtZero(metric: string): boolean {
  return METRICS[metric]?.startAtZero ?? DEFAULT_START_AT_ZERO
}

export function metricInitialMax(metric: string): number | undefined {
  return METRICS[metric]?.initialMax
}

export function metricFirmMax(metric: string): boolean {
  return METRICS[metric]?.firmMax ?? false
}

export function metricTickStep(metric: string): number | undefined {
  return METRICS[metric]?.tickStep
}

function prettifyMetric(metric: string): string {
  if (METRICS[metric]?.label) return METRICS[metric].label!
  return metric
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function yAxisLabel(metric: string): string {
  if (!metric) return ''
  const unit = METRICS[metric]?.unit
  const name = prettifyMetric(metric)
  return unit ? `${name} (${unit})` : name
}
