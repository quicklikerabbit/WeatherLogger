// Plot-area inset shared by the cartesian charts, so their axes line up
// when panels stack. Exported so tests can translate a target data point
// into the client coordinates a real pointer event would carry, without
// duplicating a chart's internal layout math.
export const margin = { top: 16, right: 24, bottom: 48, left: 56 };
