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

type ReadingRow = {
  device_id: string;
  metric: string;
  recorded_at: string;
  value: number;
  quality_flag: string | null;
};

type Series = {
  device_id: string;
  metric: string;
  readings: { recorded_at: string; value: number; quality_flag: string | null }[];
};

// Rows arrive ordered by device_id, metric, recorded_at, so each series is
// one contiguous run — a new series starts whenever the pair changes.
function groupSeries(rows: ReadingRow[]): Series[] {
  const series: Series[] = [];
  let current: Series | undefined;
  for (const { device_id, metric, recorded_at, value, quality_flag } of rows) {
    if (!current || current.device_id !== device_id || current.metric !== metric) {
      current = { device_id, metric, readings: [] };
      series.push(current);
    }
    current.readings.push({ recorded_at, value, quality_flag });
  }
  return series;
}

// Express parses a repeated query param (?metric=a&metric=b) into an array
// and a single one into a string; normalize both to a list of strings.
function queryList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((v): v is string => typeof v === "string" && v !== "");
}

const INVALID = Symbol("invalid");

// recorded_at is always stored as %Y-%m-%dT%H:%M:%SZ (see timeutils.py),
// and the range filter compares it as a string — which only orders
// correctly if both sides share that exact form. A client-sent
// toISOString() carries milliseconds (".000Z"), so reformat whatever
// parses rather than comparing the raw param.
function parseTimestampParam(value: unknown): string | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return INVALID;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return INVALID;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
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

  // Readings for one or more metrics (repeat the param: metric=temperature&
  // metric=dewpoint), grouped into one series per device/metric pair so a
  // chart can draw every device's stream for a measurement type together.
  // device_id narrows it to a single stream for troubleshooting; without
  // it, fake-* devices are excluded the same way /api/series excludes them.
  // from/to bound recorded_at (from inclusive, to exclusive).
  app.get(
    "/api/readings",
    withDbErrorHandling((req, res) => {
      const metrics = queryList(req.query.metric);
      const { device_id } = req.query;

      if (metrics.length === 0) {
        res.status(400).json({ error: "metric query param is required" });
        return;
      }
      if (device_id !== undefined && typeof device_id !== "string") {
        res.status(400).json({ error: "device_id must be a single value" });
        return;
      }

      const from = parseTimestampParam(req.query.from);
      const to = parseTimestampParam(req.query.to);
      if (from === INVALID || to === INVALID) {
        res.status(400).json({ error: "from/to must be ISO 8601 timestamps" });
        return;
      }

      const where = [`metric IN (${metrics.map(() => "?").join(", ")})`];
      const params: string[] = [...metrics];
      if (device_id !== undefined) {
        where.push("device_id = ?");
        params.push(device_id);
      } else {
        where.push("device_id NOT LIKE 'fake%'");
      }
      if (from) {
        where.push("recorded_at >= ?");
        params.push(from);
      }
      if (to) {
        where.push("recorded_at < ?");
        params.push(to);
      }

      const { db, snapshotPath } = getDb();
      const rows = db
        .prepare(
          `SELECT device_id, metric, recorded_at, value, quality_flag FROM readings
           WHERE ${where.join(" AND ")}
           ORDER BY device_id, metric, recorded_at ASC`,
        )
        .all(...params) as ReadingRow[];

      res.json({ snapshot: path.basename(snapshotPath), series: groupSeries(rows) });
    }),
  );

  return app;
}
