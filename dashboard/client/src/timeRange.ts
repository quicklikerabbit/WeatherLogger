// The selected time window, shared by every chart and kept in the URL
// (?range=7d, or ?from=2026-10-01&to=2026-10-07 for a custom one) so a
// reload — or a link opened on another machine on the LAN — shows the same
// window.

export const PRESETS = ["24h", "3d", "7d", "30d", "all"] as const;
export type Preset = (typeof PRESETS)[number];

export type RangeSelection =
  | { kind: "preset"; preset: Preset }
  // Calendar dates (YYYY-MM-DD) in the viewer's local time, both inclusive.
  | { kind: "custom"; from: string; to: string };

export const DEFAULT_SELECTION: RangeSelection = { kind: "preset", preset: "7d" };

export const PRESET_LABELS: Record<Preset, string> = {
  "24h": "24h",
  "3d": "3 days",
  "7d": "7 days",
  "30d": "30 days",
  all: "All",
};

const PRESET_HOURS: Record<Exclude<Preset, "all">, number> = {
  "24h": 24,
  "3d": 72,
  "7d": 7 * 24,
  "30d": 30 * 24,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ResolvedRange = { from?: Date; to?: Date };

// Presets count back from `anchor` — the snapshot's latest reading — rather
// than from the wall clock. The dashboard reads a backup pulled from the Pi
// now and then, so "the last 24h" measured from now would show an empty
// tail whenever the snapshot is a few hours stale. `to` is exclusive, so
// it's nudged a second past the anchor to keep the anchor reading itself.
export function resolveRange(selection: RangeSelection, anchor: Date | null): ResolvedRange {
  if (selection.kind === "custom") {
    const from = localMidnight(selection.from);
    const to = localMidnight(selection.to);
    if (!from || !to) return {};
    // The end date is inclusive, so the exclusive bound is the next midnight.
    to.setDate(to.getDate() + 1);
    return { from, to };
  }
  if (selection.preset === "all" || !anchor) return {};
  const to = new Date(anchor.getTime() + 1000);
  const from = new Date(anchor.getTime() - PRESET_HOURS[selection.preset] * 3600 * 1000);
  return { from, to };
}

function localMidnight(date: string): Date | null {
  if (!DATE_RE.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function selectionFromSearch(search: string): RangeSelection {
  const params = new URLSearchParams(search);
  const from = params.get("from");
  const to = params.get("to");
  if (from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to) {
    return { kind: "custom", from, to };
  }
  const range = params.get("range");
  if (range && (PRESETS as readonly string[]).includes(range)) {
    return { kind: "preset", preset: range as Preset };
  }
  return DEFAULT_SELECTION;
}

// Rewrites only the range params, leaving any others in the query string
// alone.
export function searchWithSelection(search: string, selection: RangeSelection): string {
  const params = new URLSearchParams(search);
  params.delete("range");
  params.delete("from");
  params.delete("to");
  if (selection.kind === "custom") {
    params.set("from", selection.from);
    params.set("to", selection.to);
  } else {
    params.set("range", selection.preset);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

// The API compares against recorded_at as UTC; it normalizes the
// milliseconds toISOString() adds.
export function rangeQueryParams(range: ResolvedRange): Record<string, string> {
  const params: Record<string, string> = {};
  if (range.from) params.from = range.from.toISOString();
  if (range.to) params.to = range.to.toISOString();
  return params;
}

// YYYY-MM-DD for a Date in local time, for seeding the custom date inputs.
export function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
