import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./db.js";

function makeEmptyDb(filePath: string) {
  new Database(filePath).close();
}

describe("createDb", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weather-db-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when no .db snapshots exist", () => {
    const getDb = createDb(tmpDir);
    expect(() => getDb()).toThrow(/No \.db snapshots found/);
  });

  it("ignores non-.db files and in-progress .partial transfers", () => {
    makeEmptyDb(path.join(tmpDir, "sensors-1.db"));
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "not a db");
    fs.writeFileSync(path.join(tmpDir, "sensors-2.db.partial"), "in progress");

    const getDb = createDb(tmpDir);
    const { snapshotPath } = getDb();
    expect(path.basename(snapshotPath)).toBe("sensors-1.db");
  });

  it("picks the most recently modified .db file", () => {
    const older = path.join(tmpDir, "sensors-older.db");
    const newer = path.join(tmpDir, "sensors-newer.db");
    makeEmptyDb(older);
    makeEmptyDb(newer);

    const now = Date.now() / 1000;
    fs.utimesSync(older, now - 60, now - 60);
    fs.utimesSync(newer, now, now);

    const getDb = createDb(tmpDir);
    const { snapshotPath } = getDb();
    expect(path.basename(snapshotPath)).toBe("sensors-newer.db");
  });
});
