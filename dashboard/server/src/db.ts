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
  const files = fs
    .readdirSync(BACKUPS_DIR)
    .filter((name) => name.endsWith(".db"))
    .map((name) => path.join(BACKUPS_DIR, name));

  if (files.length === 0) {
    throw new Error(
      `No .db snapshots found in ${BACKUPS_DIR}. Run backup.sh first.`,
    );
  }

  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
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
