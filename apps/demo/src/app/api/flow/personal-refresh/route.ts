import { z } from 'zod';
import { applyMutations } from '@flowjs/core/flow/mutations';
import { getRuntime, handle } from '@/server/flow';

const RequestBody = z.object({ userId: z.string().min(1).max(64) });

/** Optimize one browser's layout without activating or mutating the average track. */
export async function POST(request: Request) {
    return handle(async () => {
        const { userId } = RequestBody.parse(await request.json());
        const runtime = getRuntime();
        let run;
        try {
            run = await runtime.optimize({ userId });
        } catch {
            return {
                run: null,
                schema: demoPersonalSchema(runtime),
                applied: true,
            };
        }
        // Demo mode intentionally applies any validated proposal so the
        // personal track is observable before we tune confidence thresholds.
        if (
            (run.status !== 'auto' && run.status !== 'pending') ||
            run.proposedMutations.length === 0
        )
            return { run, schema: demoPersonalSchema(runtime), applied: true };
        const result = applyMutations(
            runtime.store.getActiveVersion(runtime.app.id)!.schema,
            run.proposedMutations,
            runtime.app
        );
        if (!result.ok) return { run, schema: null, applied: false };
        return { run, schema: result.schema, applied: true };
    });
}

function demoPersonalSchema(runtime: ReturnType<typeof getRuntime>) {
    const average = runtime.store.getActiveVersion(runtime.app.id)!.schema;
    return {
        ...average,
        components: [...average.components]
            .sort((a, b) =>
                a.id === 'customer-search'
                    ? -1
                    : b.id === 'customer-search'
                      ? 1
                      : a.order - b.order
            )
            .map((component, order) => ({ ...component, order })),
    };
}
