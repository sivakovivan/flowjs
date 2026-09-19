// Delete the local flow.js database and, when BackBoard is configured, the
// application's remembered decisions (they describe versions that no longer exist).
// The schema is recreated on the next request.
import { existsSync, rmSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const path = process.env.FLOW_DB_PATH || ".flow/flow.db";
for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
console.log(`Removed ${path}. Start the app to initialize a fresh database.`);

const apiKey = process.env.BACKBOARD_API_KEY;
if (apiKey) {
  const base = "https://app.backboard.io/api";
  const headers = { "X-API-Key": apiKey };
  try {
    const assistants = await (await fetch(`${base}/assistants`, { headers })).json();
    const assistant = assistants.find((a) => a.name === "flowjs-sales-demo");
    if (assistant) {
      const response = await fetch(`${base}/assistants/${assistant.assistant_id}/memories`, { method: "DELETE", headers });
      console.log(response.ok ? "Cleared BackBoard decision memory." : `Could not clear BackBoard memory (${response.status}).`);
    }
  } catch (error) {
    console.log(`Could not reach BackBoard to clear memory: ${error.message}`);
  }
}
