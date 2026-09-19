import { z } from "zod";
import { getRuntime, handle } from "@/server/flow";

const Batch = z.object({ events: z.array(z.unknown()).max(500) });

/** Ingest a batch of semantic telemetry events from the generated interface. */
export async function POST(request: Request) {
  return handle(async () => {
    // sendBeacon posts text/plain, so parse the body ourselves.
    const { events } = Batch.parse(JSON.parse(await request.text()));
    return getRuntime().recordTelemetry(events);
  });
}
