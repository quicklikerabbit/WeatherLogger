import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

function makeSnapshotWithReadings(filePath: string) {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE readings (device_id TEXT, metric TEXT, recorded_at TEXT, value REAL, quality_flag TEXT);
    INSERT INTO readings (device_id, metric, recorded_at, value)
    VALUES
      ('dev1', 'temperature', '2024-01-01T00:00:00Z', 5.2),
      ('fake-gw3002', 'temperature', '2024-01-01T00:00:00Z', 14.0);
  `);
  db.close();
}

function makeSnapshotWithManyReadings(filePath: string) {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE readings (device_id TEXT, metric TEXT, recorded_at TEXT, value REAL, quality_flag TEXT);
    INSERT INTO readings (device_id, metric, recorded_at, value, quality_flag)
    VALUES
      ('dev2', 'temperature', '2024-01-01T01:00:00Z', 7.0, NULL),
      ('dev1', 'temperature', '2024-01-01T02:00:00Z', 6.0, NULL),
      ('dev1', 'temperature', '2024-01-01T00:00:00Z', 5.0, NULL),
      ('dev1', 'temperature', '2024-01-01T01:00:00Z', 5.5, NULL),
      ('dev1', 'dewpoint', '2024-01-01T00:00:00Z', 3.0, NULL),
      ('dev1', 'humidity', '2024-01-01T00:00:00Z', 80.0, NULL),
      ('dev1', 'precipitation_mm', '2024-01-01T00:00:00Z', 0.0, 'T'),
      ('fake-gw3002', 'temperature', '2024-01-01T00:00:00Z', 14.0, NULL);
  `);
  db.close();
}

describe("app routes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weather-app-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/health returns 200 when a snapshot exists", async () => {
    makeSnapshotWithReadings(path.join(tmpDir, "sensors-1.db"));
    const app = createApp(tmpDir);

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, snapshot: "sensors-1.db" });
  });

  // Regression test: these three routes used to skip the try/catch that
  // /api/health had, so a missing snapshot crashed with an unstyled 500
  // instead of the same JSON error shape.
  it("returns a 503 JSON error (not a crash) on every route when no snapshot exists", async () => {
    const app = createApp(tmpDir);

    for (const url of [
      "/api/health",
      "/api/series",
      "/api/readings?device_id=dev1&metric=temperature",
    ]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/No \.db snapshots found/);
    }
  });

  it("GET /api/readings returns 400 when metric is missing", async () => {
    const app = createApp(tmpDir);

    const res = await request(app).get("/api/readings");
    expect(res.status).toBe(400);
  });

  it("GET /api/readings returns 400 for an unparseable from/to", async () => {
    makeSnapshotWithReadings(path.join(tmpDir, "sensors-1.db"));
    const app = createApp(tmpDir);

    const res = await request(app).get("/api/readings?metric=temperature&from=yesterday-ish");
    expect(res.status).toBe(400);
  });

  describe("GET /api/readings grouping and filtering", () => {
    beforeEach(() => {
      makeSnapshotWithManyReadings(path.join(tmpDir, "sensors-1.db"));
    });

    function seriesKeys(body: { series: { device_id: string; metric: string }[] }) {
      return body.series.map((s) => `${s.device_id}/${s.metric}`);
    }

    it("returns one series per device for a metric, excluding fake-* devices, readings in time order", async () => {
      const res = await request(createApp(tmpDir)).get("/api/readings?metric=temperature");
      expect(res.status).toBe(200);
      expect(seriesKeys(res.body)).toEqual(["dev1/temperature", "dev2/temperature"]);
      expect(res.body.series[0].readings.map((r: { value: number }) => r.value)).toEqual([5.0, 5.5, 6.0]);
    });

    it("accepts a repeated metric param for a combined panel", async () => {
      const res = await request(createApp(tmpDir)).get(
        "/api/readings?metric=temperature&metric=dewpoint",
      );
      expect(seriesKeys(res.body)).toEqual(["dev1/dewpoint", "dev1/temperature", "dev2/temperature"]);
    });

    it("narrows to one device with device_id, which can also reach a fake-* device", async () => {
      const app = createApp(tmpDir);
      const real = await request(app).get("/api/readings?metric=temperature&device_id=dev2");
      expect(seriesKeys(real.body)).toEqual(["dev2/temperature"]);

      const fake = await request(app).get("/api/readings?metric=temperature&device_id=fake-gw3002");
      expect(seriesKeys(fake.body)).toEqual(["fake-gw3002/temperature"]);
    });

    it("bounds recorded_at by from (inclusive) and to (exclusive), tolerating milliseconds", async () => {
      const res = await request(createApp(tmpDir)).get(
        "/api/readings?metric=temperature&device_id=dev1" +
          "&from=2024-01-01T01:00:00.000Z&to=2024-01-01T02:00:00.000Z",
      );
      expect(res.body.series[0].readings).toEqual([
        { recorded_at: "2024-01-01T01:00:00Z", value: 5.5, quality_flag: null },
      ]);
    });

    it("includes the quality flag", async () => {
      const res = await request(createApp(tmpDir)).get("/api/readings?metric=precipitation_mm");
      expect(res.body.series[0].readings[0].quality_flag).toBe("T");
    });

    it("returns an empty series list when nothing matches", async () => {
      const res = await request(createApp(tmpDir)).get(
        "/api/readings?metric=temperature&from=2030-01-01T00:00:00Z",
      );
      expect(res.status).toBe(200);
      expect(res.body.series).toEqual([]);
    });
  });

  it("GET /api/series and /api/readings return the snapshot's data, excluding fake-* test devices", async () => {
    makeSnapshotWithReadings(path.join(tmpDir, "sensors-1.db"));
    const app = createApp(tmpDir);

    const seriesRes = await request(app).get("/api/series");
    expect(seriesRes.status).toBe(200);
    expect(seriesRes.body.series).toEqual([
      {
        device_id: "dev1",
        metric: "temperature",
        count: 1,
        first_recorded_at: "2024-01-01T00:00:00Z",
        last_recorded_at: "2024-01-01T00:00:00Z",
      },
    ]);

    const readingsRes = await request(app).get(
      "/api/readings?device_id=dev1&metric=temperature",
    );
    expect(readingsRes.status).toBe(200);
    expect(readingsRes.body.series).toEqual([
      {
        device_id: "dev1",
        metric: "temperature",
        readings: [{ recorded_at: "2024-01-01T00:00:00Z", value: 5.2, quality_flag: null }],
      },
    ]);
  });
});
