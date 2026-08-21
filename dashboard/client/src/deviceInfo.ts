// ec-victoria isn't physical hardware — it's Environment Canada's public
// MSC Datamart data for citypage site s0000775. The readings this
// dashboard shows (temperature/humidity/pressure/wind/visibility) come
// from currentConditions, which EC attributes to a specific station —
// Victoria Int'l Airport (YYJ), 48.65N 123.43W — not downtown Victoria.
const DEVICE_LOCATIONS: Record<string, string> = {
  'ec-victoria': "Victoria Int'l Airport (YYJ), BC, Canada — Environment Canada",
}

export function deviceLocation(deviceId: string): string | null {
  return DEVICE_LOCATIONS[deviceId] ?? null
}
