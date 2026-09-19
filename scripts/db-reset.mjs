// Delete the local flow.js database. The schema is recreated automatically on
// the next request, and the dashboard returns to "No dashboard layout was written."
import { rmSync } from "node:fs";

const path = process.env.FLOW_DB_PATH || ".flow/flow.db";
for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
console.log(`Removed ${path}. Start the app to initialize a fresh database.`);
