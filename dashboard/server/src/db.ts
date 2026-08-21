import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BACKUPS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../backups",
);

function findLatestSnapshot(backupsDir: string): string {
  const entries = fs
    .readdirSync(backupsDir)
    .filter((name) => name.endsWith(".db"))
    .map((name) => {
      const filePath = path.join(backupsDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    });

  if (entries.length === 0) {
    throw new Error(
      `No .db snapshots found in ${backupsDir}. Run backup.sh first.`,
    );
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0].filePath;
}

// Returns a getDb() bound to one backups directory, with its own cache —
// each call re-checks for a newer snapshot (cheap directory scan) so a
// fresh backup.sh pull shows up without restarting the server, but only
// reopens the sqlite connection when the latest snapshot actually changes.
export function createDb(backupsDir: string) {
  let cachedPath: string | null = null;
  let cachedDb: Database.Database | null = null;

  return function getDb(): { db: Database.Database; snapshotPath: string } {
    const latest = findLatestSnapshot(backupsDir);

    if (latest !== cachedPath) {
      cachedDb?.close();
      cachedDb = new Database(latest, { readonly: true, fileMustExist: true });
      cachedPath = latest;
    }

    return { db: cachedDb!, snapshotPath: cachedPath! };
  };
}
