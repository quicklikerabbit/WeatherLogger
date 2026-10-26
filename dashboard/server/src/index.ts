import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const backupsDir = process.env.BACKUPS_DIR ? path.resolve(process.env.BACKUPS_DIR) : undefined;
// Resolves the same from src/ (tsx) and dist/ (built), like DEFAULT_BACKUPS_DIR.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");

const app = createApp(backupsDir);

// In dev, Vite serves the client and proxies /api here. Once the client has
// been built (npm run build in client/), serve it too, so the whole dashboard
// is reachable on this one port without Vite running.
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

app.listen(PORT, () => {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  console.log(`[${stamp}] weather-dashboard server listening on http://localhost:${PORT}`);
});
