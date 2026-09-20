import { z } from 'zod';
import { applyMutations } from '@flowjs/core/flow/mutations';
import { getRuntime, handle } from '@/server/flow';

const RequestBody = z.object({ userId: z.string().min(1).max(64) });

/** Optimize one browser's layout without activating or mutating the average track. */
export async function POST(request: Request) {
    return handle(async () => {
        const { userId } = RequestBody.parse(await request.json());
        const runtime = getRuntime();
        const run = await runtime.optimize({ userId });
        if (run.status !== 'auto') return { run, schema: null, applied: false };
        const result = applyMutations(
            runtime.store.getActiveVersion(runtime.app.id)!.schema,
            run.proposedMutations,
            runtime.app
        );
        if (!result.ok) return { run, schema: null, applied: false };
        return { run, schema: result.schema, applied: true };
    });
}
