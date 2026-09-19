import { z } from "zod";
import { getRuntime, handle } from "@/server/flow";

const Settings = z.object({ mutationRate: z.number().min(0).max(1) });

/** Update the application's mutation rate (0 disables automatic mutation). */
export async function PATCH(request: Request) {
  return handle(async () => {
    const { mutationRate } = Settings.parse(await request.json());
    return { application: getRuntime().setMutationRate(mutationRate) };
  });
}
