import cors from "cors";
import express from "express";
import path from "node:path";
import { getDb } from "./db.js";

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

app.get("/api/health", (_req, res) => {
  try {
    const { snapshotPath } = getDb();
    res.json({ ok: true, snapshot: path.basename(snapshotPath) });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
  }
});

// Distinct device/metric combinations present in the snapshot, so the client
// can populate a selector without hardcoding what a device has reported.
app.get("/api/series", (_req, res) => {
  const { db, snapshotPath } = getDb();
  const series = db
    .prepare(
      `SELECT device_id, metric, COUNT(*) as count,
              MIN(recorded_at) as first_recorded_at,
              MAX(recorded_at) as last_recorded_at
       FROM readings
       GROUP BY device_id, metric
       ORDER BY device_id, metric`,
    )
    .all();
  res.json({ snapshot: path.basename(snapshotPath), series });
});

app.get("/api/readings", (req, res) => {
  const { device_id, metric } = req.query;

  if (typeof device_id !== "string" || typeof metric !== "string") {
    res.status(400).json({ error: "device_id and metric query params are required" });
    return;
  }

  const { db, snapshotPath } = getDb();
  const readings = db
    .prepare(
      `SELECT recorded_at, value FROM readings
       WHERE device_id = ? AND metric = ?
       ORDER BY recorded_at ASC`,
    )
    .all(device_id, metric);

  res.json({ snapshot: path.basename(snapshotPath), readings });
});

app.listen(PORT, () => {
  console.log(`weather-dashboard server listening on http://localhost:${PORT}`);
});
