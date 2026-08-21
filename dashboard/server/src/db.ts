import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BACKUPS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../backups",
);

const BACKUPS_DIR = process.env.BACKUPS_DIR
  ? path.resolve(process.env.BACKUPS_DIR)
  : DEFAULT_BACKUPS_DIR;

let cachedPath: string | null = null;
let cachedDb: Database.Database | null = null;

function findLatestSnapshot(): string {
  const entries = fs
    .readdirSync(BACKUPS_DIR)
    .filter((name) => name.endsWith(".db"))
    .map((name) => {
      const filePath = path.join(BACKUPS_DIR, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    });

  if (entries.length === 0) {
    throw new Error(
      `No .db snapshots found in ${BACKUPS_DIR}. Run backup.sh first.`,
    );
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0].filePath;
}

// Re-checks for a newer snapshot on every call (cheap directory scan) so a
// fresh backup.sh pull shows up without restarting the server.
export function getDb(): { db: Database.Database; snapshotPath: string } {
  const latest = findLatestSnapshot();

  if (latest !== cachedPath) {
    cachedDb?.close();
    cachedDb = new Database(latest, { readonly: true, fileMustExist: true });
    cachedPath = latest;
  }

  return { db: cachedDb!, snapshotPath: cachedPath! };
}
