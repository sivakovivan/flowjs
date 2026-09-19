import { ActionRequest, runCapability } from "@/server/capabilities";
import { handle } from "@/server/flow";

/** Execute a registered action with validated inputs. */
export async function POST(request: Request, { params }: { params: Promise<{ capability: string }> }) {
  return handle(async () => {
    const { capability } = await params;
    return runCapability("action", capability, ActionRequest.parse(await request.json()));
  });
}
