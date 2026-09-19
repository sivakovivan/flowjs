import { getRuntime, handle } from "@/server/flow";

/** Activate any earlier version. */
export async function POST(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  return handle(async () => {
    const { versionId } = await params;
    return { version: getRuntime().restore(versionId) };
  });
}
