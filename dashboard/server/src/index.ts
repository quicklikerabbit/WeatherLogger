import path from "node:path";
import { createApp } from "./app.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const backupsDir = process.env.BACKUPS_DIR ? path.resolve(process.env.BACKUPS_DIR) : undefined;

const app = createApp(backupsDir);

app.listen(PORT, () => {
  console.log(`weather-dashboard server listening on http://localhost:${PORT}`);
});
