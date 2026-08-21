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
    CREATE TABLE readings (device_id TEXT, metric TEXT, recorded_at TEXT, value REAL);
    INSERT INTO readings (device_id, metric, recorded_at, value)
    VALUES ('dev1', 'temperature', '2024-01-01T00:00:00Z', 5.2);
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

  it("GET /api/readings returns 400 when device_id or metric is missing", async () => {
    const app = createApp(tmpDir);

    const res = await request(app).get("/api/readings");
    expect(res.status).toBe(400);
  });

  it("GET /api/series and /api/readings return the snapshot's data", async () => {
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
    expect(readingsRes.body.readings).toEqual([
      { recorded_at: "2024-01-01T00:00:00Z", value: 5.2 },
    ]);
  });
});
