import { z } from "zod";
import { getRuntime, handle } from "@/server/flow";

const SeedRequest = z.object({ sessions: z.number().int().min(1).max(20).default(6) });

/** Add clearly flagged synthetic sessions for the active version. */
export async function POST(request: Request) {
  return handle(async () => {
    const { sessions } = SeedRequest.parse(await request.json().catch(() => ({})));
    return getRuntime().seedDemoSessions(sessions);
  });
}

/** Remove all seeded telemetry, keeping live data. */
export async function DELETE() {
  return handle(() => {
    getRuntime().clearSeeded();
    return { cleared: true };
  });
}
