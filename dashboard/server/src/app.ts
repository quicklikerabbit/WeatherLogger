import cors from "cors";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { createDb, DEFAULT_BACKUPS_DIR } from "./db.js";

// getDb() throws when no snapshot exists yet (e.g. before backup.sh has ever
// run); every route below reads through it, so route bodies can stay
// focused on their own query and let this turn that into a 503.
function withDbErrorHandling(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response) => {
    try {
      handler(req, res);
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  };
}

export function createApp(backupsDir: string = DEFAULT_BACKUPS_DIR) {
  const app = express();
  app.use(cors());
  const getDb = createDb(backupsDir);

  app.get(
    "/api/health",
    withDbErrorHandling((_req, res) => {
      const { snapshotPath } = getDb();
      res.json({ ok: true, snapshot: path.basename(snapshotPath) });
    }),
  );

  // Distinct device/metric combinations present in the snapshot, so the
  // client can populate a selector without hardcoding what a device has
  // reported. Devices prefixed "fake-" are the simulated stand-ins used
  // before real hardware existed and are excluded — they're test data,
  // not readings anyone dashboards over.
  app.get(
    "/api/series",
    withDbErrorHandling((_req, res) => {
      const { db, snapshotPath } = getDb();
      const series = db
        .prepare(
          `SELECT device_id, metric, COUNT(*) as count,
                  MIN(recorded_at) as first_recorded_at,
                  MAX(recorded_at) as last_recorded_at
           FROM readings
           WHERE device_id NOT LIKE 'fake%'
           GROUP BY device_id, metric
           ORDER BY device_id, metric`,
        )
        .all();
      res.json({ snapshot: path.basename(snapshotPath), series });
    }),
  );

  app.get(
    "/api/readings",
    withDbErrorHandling((req, res) => {
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
    }),
  );

  return app;
}
