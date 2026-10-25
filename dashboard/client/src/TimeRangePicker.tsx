import { PRESET_LABELS, PRESETS, type RangeSelection, toLocalDateString } from "./timeRange";

const buttonBase = "px-3 py-1 text-sm border-gray-300 dark:border-gray-700";
const buttonIdle = "bg-white hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700";
const buttonActive = "bg-blue-600 text-white dark:bg-blue-600";
const dateInput =
  "rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:[color-scheme:dark]";

export function TimeRangePicker({
  selection,
  onChange,
  anchor,
}: {
  selection: RangeSelection;
  onChange: (selection: RangeSelection) => void;
  // The snapshot's latest reading, used to seed the custom range with the
  // last week of data instead of an empty pair of inputs.
  anchor: Date | null;
}) {
  const isCustom = selection.kind === "custom";

  function startCustom() {
    if (isCustom) return;
    const end = anchor ?? new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    onChange({ kind: "custom", from: toLocalDateString(start), to: toLocalDateString(end) });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        role="group"
        aria-label="Time range"
        className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700"
      >
        {PRESETS.map((preset, i) => {
          const active = selection.kind === "preset" && selection.preset === preset;
          return (
            <button
              key={preset}
              type="button"
              aria-pressed={active}
              className={`${buttonBase} ${i > 0 ? "border-l" : ""} ${active ? buttonActive : buttonIdle}`}
              onClick={() => onChange({ kind: "preset", preset })}
            >
              {PRESET_LABELS[preset]}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={isCustom}
          className={`${buttonBase} border-l ${isCustom ? buttonActive : buttonIdle}`}
          onClick={startCustom}
        >
          Custom
        </button>
      </div>

      {isCustom && (
        <div className="flex items-center gap-2 text-sm">
          <input
            type="date"
            aria-label="From date"
            className={dateInput}
            value={selection.from}
            max={selection.to}
            onChange={(e) => e.target.value && onChange({ ...selection, from: e.target.value })}
          />
          <span>to</span>
          <input
            type="date"
            aria-label="To date"
            className={dateInput}
            value={selection.to}
            min={selection.from}
            onChange={(e) => e.target.value && onChange({ ...selection, to: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
