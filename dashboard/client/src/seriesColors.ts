// Color identifies a device, everywhere on the dashboard. Slots come from
// the full, sorted device list (not from whichever devices a given panel or
// time range happens to contain), so a device keeps its color as filters
// change instead of being repainted by rank.

const SLOT_COUNT = 8;

export type DeviceColors = (deviceId: string) => string;

export function deviceColors(deviceIds: string[]): DeviceColors {
  const order = [...new Set(deviceIds)].sort();
  return (deviceId) => {
    const slot = order.indexOf(deviceId);
    // Past the eighth device there's no ninth distinguishable hue — fold
    // into a neutral "other" rather than cycling back to slot 1, which
    // would give two devices the same color.
    if (slot < 0 || slot >= SLOT_COUNT) return "var(--series-other)";
    return `var(--series-${slot + 1})`;
  };
}
