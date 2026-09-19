import { z } from "zod";
import { getRuntime, handle } from "@/server/flow";

const ApplyRequest = z.object({ mode: z.enum(["auto", "manual"]) });

/** Apply a validated proposal as a new, active, immutable version. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return handle(async () => {
    const { runId } = await params;
    const { mode } = ApplyRequest.parse(await request.json());
    return getRuntime().apply(runId, mode);
  });
}
