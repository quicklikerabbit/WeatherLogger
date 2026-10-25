import { describe, expect, it } from "vitest";
import type { ReadingSeries } from "./panelData";
import { binWind, pairWind, percent, sectorIndex, speedBandIndex } from "./windRose";

function series(device_id: string, metric: string, values: [string, number][]): ReadingSeries {
  return {
    device_id,
    metric,
    readings: values.map(([recorded_at, value]) => ({ recorded_at, value })),
  };
}

describe("sectorIndex", () => {
  it("centers each sector on its compass point", () => {
    expect(sectorIndex(0)).toBe(0); // N
    expect(sectorIndex(11.24)).toBe(0); // still N
    expect(sectorIndex(11.25)).toBe(1); // NNE starts here
    expect(sectorIndex(90)).toBe(4); // E
    expect(sectorIndex(270)).toBe(12); // W
  });

  it("wraps bearings just west of north, and 360, back into N", () => {
    expect(sectorIndex(350)).toBe(0);
    expect(sectorIndex(360)).toBe(0);
  });
});

describe("speedBandIndex", () => {
  it("places speeds in their band, with the top band open-ended", () => {
    expect(speedBandIndex(4)).toBe(0);
    expect(speedBandIndex(10)).toBe(1);
    expect(speedBandIndex(29)).toBe(2);
    expect(speedBandIndex(85)).toBe(3);
  });
});

describe("pairWind", () => {
  it("joins bearing to speed per device on recorded_at, dropping unmatched readings", () => {
    const paired = pairWind([
      series("dev1", "wind_bearing", [
        ["t1", 270],
        ["t2", 90],
        ["t3", 180],
      ]),
      series("dev1", "wind_speed", [
        ["t1", 15],
        ["t3", 0],
      ]),
      series("dev2", "wind_bearing", [["t1", 45]]),
      series("dev2", "wind_speed", [["t1", 30]]),
    ]);
    expect(paired.get("dev1")).toEqual([
      { bearing: 270, speed: 15 },
      { bearing: 180, speed: 0 },
    ]);
    expect(paired.get("dev2")).toEqual([{ bearing: 45, speed: 30 }]);
  });
});

describe("binWind", () => {
  it("counts calm separately and stacks the rest by sector and speed band", () => {
    const rose = binWind([
      { bearing: 270, speed: 5 },
      { bearing: 268, speed: 25 },
      { bearing: 90, speed: 12 },
      { bearing: 0, speed: 0 }, // calm: its bearing is meaningless
    ]);
    expect(rose.total).toBe(4);
    expect(rose.calm).toBe(1);
    expect(rose.sectors[12]).toEqual({ label: "W", counts: [1, 0, 1, 0] });
    expect(rose.sectors[4]).toEqual({ label: "E", counts: [0, 1, 0, 0] });
    expect(rose.sectors[0].counts).toEqual([0, 0, 0, 0]);
  });

  it("makes the sectors plus calm account for every observation", () => {
    const rose = binWind([
      { bearing: 10, speed: 3 },
      { bearing: 200, speed: 40 },
      { bearing: 0, speed: 0 },
    ]);
    const placed = rose.sectors.flatMap((s) => s.counts).reduce((a, b) => a + b, 0);
    expect(placed + rose.calm).toBe(rose.total);
  });
});

describe("percent", () => {
  it("is 0 for an empty window rather than NaN", () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(1, 4)).toBe(25);
  });
});
