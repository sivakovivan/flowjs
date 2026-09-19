import { CallContext, runCapability } from "@/server/capabilities";
import { handle } from "@/server/flow";

/** Run a registered data capability with the current state. */
export async function POST(request: Request, { params }: { params: Promise<{ capability: string }> }) {
  return handle(async () => {
    const { capability } = await params;
    const context = CallContext.parse(await request.json());
    return runCapability("data", capability, { ...context, input: {} });
  });
}
